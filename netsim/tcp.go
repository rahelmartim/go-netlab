package netsim

import (
	"math"
	"sort"
)

type segment struct {
	seq, len int
	sacked   bool
	// retransmitted is set when the segment was sent again during the
	// current loss recovery, so that SACK recovery sends it only once.
	retransmitted bool
	// delivered and deliveredAt record the progress when the segment was
	// sent. BBR uses them to measure the delivery rate.
	delivered   int
	deliveredAt float64
}

type tcpState int

const (
	synSent tcpState = iota
	established
	finWait
	closed
)

type tcp struct {
	s     *sim
	o     TCPOptions
	state tcpState
	rtx   timer
	rto   rtoEstimator
	cc    congestion

	// Sender (client)
	sndUna, sndNxt int
	segments       map[int]*segment
	dupAcks        int
	available      int // bytes that the application has written so far
	lastMessageAt  float64
	inRecovery     bool
	recover        int // sndNxt when the recovery started
	highSacked     int
	delivered      int // bytes acknowledged so far
	deliveredAt    float64
	nextSendAt     float64 // pacing
	pacingWait     bool
	synSentAt      float64
	synRetried     bool

	// Receiver (server)
	rcvNxt     int
	outOfSeq   map[int][]byte
	ackPending int
	ackEcho    float64
	ackTimer   timer
}

func (s *sim) runTCP() {
	o := s.opts.TCP
	t := &tcp{
		s:        s,
		o:        o,
		rtx:      timer{s: s},
		ackTimer: timer{s: s},
		rto:      newRTOEstimator(s.opts.Conditions, o.InitialRTOMs, o.MinRTOMs, o.MaxRTOMs),
		segments: map[int]*segment{},
		outOfSeq: map[int][]byte{},
	}
	t.cc = newCongestion(o.Flavor, o.InitialWindow)
	for i, m := range s.opts.Messages {
		end := s.result.MessageOffsets[i] + len(m.Data)
		t.lastMessageAt = math.Max(t.lastMessageAt, m.AtMs)
		s.at(m.AtMs, func() {
			t.available = max(t.available, end)
			t.trySend()
		})
	}
	s.at(0, t.sendSYN)
	s.run()
	s.result.Stats.Complete = t.rcvNxt == len(s.stream)
}

func (t *tcp) mss() int { return t.s.opts.MSS }

/* Connection setup */

func (t *tcp) sendSYN() {
	p := Packet{Kind: "SYN", From: "client", Message: -1, Retransmit: t.synRetried}
	var data []byte
	if t.o.FastOpen && t.available > 0 && t.sndUna == 0 {
		// TCP Fast Open: the first segment travels with the SYN.
		size := min(t.mss(), t.available)
		data = t.s.stream[:size]
		p.Len, p.Message, p.Preview = size, t.s.messageAt(0), preview(data)
		if _, ok := t.segments[0]; !ok {
			t.segments[0] = &segment{seq: 0, len: size}
		}
		t.sndNxt = max(t.sndNxt, size)
	}
	t.synSentAt = t.s.now
	t.s.send(p, tcpHeader, func(p Packet) { t.serverOnSYN(p, data) })
	t.rtx.start(t.rto.rto, t.onTimeout)
}

func (t *tcp) serverOnSYN(p Packet, data []byte) {
	if len(data) > 0 && t.rcvNxt == 0 {
		t.s.deliver(p, 0, data)
		t.rcvNxt = len(data)
	}
	ack := t.rcvNxt
	t.s.send(Packet{Kind: "SYN-ACK", From: "server", Ack: ack, Message: -1}, tcpHeader, func(Packet) {
		t.clientOnSYNACK(ack)
	})
}

func (t *tcp) clientOnSYNACK(ack int) {
	if t.state == synSent {
		t.state = established
		t.s.result.Stats.HandshakeMs = t.s.now
		t.rtx.stop()
		if !t.synRetried {
			t.rto.sample(t.s.now - t.synSentAt)
		}
		t.record()
	}
	// Send the ACK again if the server sent its SYN-ACK again.
	t.s.send(Packet{Kind: "ACK", From: "client", Message: -1}, tcpHeader, func(Packet) {})
	if ack > t.sndUna {
		t.clientOnACK(ack, t.synSentAt, nil)
		return
	}
	t.trySend()
}

/* Sending */

// pipe estimates the bytes in flight. With SACK, it leaves out the bytes
// that the receiver holds and the segments that are known to be lost.
func (t *tcp) pipe() int {
	if !t.o.SACK {
		return t.sndNxt - t.sndUna
	}
	bytes := 0
	for _, seg := range t.segments {
		if seg.sacked || (t.lostBySACK(seg) && !seg.retransmitted) {
			continue
		}
		bytes += seg.len
	}
	return bytes
}

func (t *tcp) lostBySACK(seg *segment) bool {
	return t.o.SACK && !seg.sacked && seg.seq+seg.len <= t.highSacked
}

func (t *tcp) windowBytes() float64 {
	if t.cc.flavor == "fixed" {
		return float64(t.s.opts.Window * t.mss())
	}
	return math.Max(t.cc.window(), 1) * float64(t.mss())
}

// trySend sends retransmissions and new segments while the window has space.
func (t *tcp) trySend() {
	if t.state != established {
		return
	}
	mss := t.mss()
	receiveWindow := t.s.opts.Window * mss

	for {
		if t.paced() {
			return
		}
		pipe := float64(t.pipe())
		// SACK recovery: send the holes before new data.
		if t.inRecovery && t.o.SACK {
			if hole := t.nextHole(); hole != nil {
				if pipe+float64(hole.len) > t.windowBytes()+0.5 {
					break
				}
				hole.retransmitted = true
				t.sendSegment(hole.seq, hole.len, true)
				continue
			}
		}
		if t.sndNxt >= t.available || t.sndNxt-t.sndUna >= receiveWindow {
			break
		}
		size := min(mss, t.available-t.sndNxt, receiveWindow-(t.sndNxt-t.sndUna))
		if t.cc.flavor == "fixed" {
			size = min(size, int(t.windowBytes())-(t.sndNxt-t.sndUna))
			if size <= 0 {
				break
			}
		} else if pipe+float64(size) > t.windowBytes()+0.5 {
			break
		}
		// Nagle: keep a small segment while data is in flight.
		if t.o.Nagle && size < mss && t.sndNxt > t.sndUna {
			break
		}
		t.sendSegment(t.sndNxt, size, false)
		t.sndNxt += size
	}
	t.maybeClose()
}

// paced reports whether BBR pacing must wait, and schedules the next try.
func (t *tcp) paced() bool {
	rate := t.cc.pacingRate()
	if rate <= 0 || t.s.now >= t.nextSendAt {
		return false
	}
	if !t.pacingWait {
		t.pacingWait = true
		t.s.at(t.nextSendAt, func() {
			t.pacingWait = false
			t.trySend()
		})
	}
	return true
}

func (t *tcp) nextHole() *segment {
	var best *segment
	for _, seg := range t.segments {
		if t.lostBySACK(seg) && !seg.retransmitted && (best == nil || seg.seq < best.seq) {
			best = seg
		}
	}
	return best
}

func (t *tcp) sendSegment(seq, size int, retransmit bool) {
	data := t.s.stream[seq : seq+size]
	seg, ok := t.segments[seq]
	if !ok {
		seg = &segment{seq: seq, len: size}
		t.segments[seq] = seg
	}
	seg.delivered, seg.deliveredAt = t.delivered, t.s.now
	if t.deliveredAt == 0 {
		t.deliveredAt = t.s.now
	}
	if retransmit {
		t.s.result.Stats.Retransmissions++
	}
	if rate := t.cc.pacingRate(); rate > 0 {
		t.nextSendAt = math.Max(t.s.now, t.nextSendAt) + float64(size+tcpHeader)/rate
	}
	p := Packet{
		Kind: "DATA", From: "client", Seq: seq, Len: size, Retransmit: retransmit,
		Message: t.s.messageAt(seq), Preview: preview(data),
	}
	sentAt := t.s.now
	t.s.send(p, tcpHeader, func(p Packet) { t.serverOnData(p, data, sentAt) })
	if !t.rtx.running {
		t.rtx.start(t.rto.rto, t.onTimeout)
	}
	t.record()
}

/* Receiver */

// serverOnData receives a segment. echo is the send time of the segment,
// which the ACK carries back, like the TCP timestamp option (RFC 7323).
func (t *tcp) serverOnData(p Packet, data []byte, echo float64) {
	inOrder := p.Seq == t.rcvNxt
	hadHoles := len(t.outOfSeq) > 0
	switch {
	case inOrder:
		t.s.deliver(p, p.Seq, data)
		t.rcvNxt += len(data)
		// Deliver the segments that were waiting for this one.
		for {
			next, ok := t.outOfSeq[t.rcvNxt]
			if !ok {
				break
			}
			delete(t.outOfSeq, t.rcvNxt)
			t.s.deliver(p, t.rcvNxt, next)
			t.rcvNxt += len(next)
		}
	case p.Seq > t.rcvNxt:
		if _, ok := t.outOfSeq[p.Seq]; !ok {
			t.outOfSeq[p.Seq] = data
		}
	}

	if t.ackPending == 0 {
		t.ackEcho = echo
	}
	// Delayed ACK (RFC 1122): wait for a second in-order segment, or 40 ms.
	// Out-of-order data and filled holes get an immediate ACK.
	if t.o.DelayedACK && inOrder && !hadHoles && len(t.outOfSeq) == 0 && t.ackPending == 0 {
		t.ackPending = 1
		t.ackTimer.start(40, t.sendACK)
		return
	}
	t.sendACK()
}

func (t *tcp) sendACK() {
	t.ackTimer.stop()
	t.ackPending = 0
	ack, echo := t.rcvNxt, t.ackEcho
	var blocks [][2]int
	if t.o.SACK {
		blocks = t.sackBlocks()
	}
	t.s.send(Packet{Kind: "ACK", From: "server", Ack: ack, Sack: blocks, Message: -1}, tcpHeader, func(Packet) {
		t.clientOnACK(ack, echo, blocks)
	})
}

// sackBlocks returns up to 4 ranges of data held out of order.
func (t *tcp) sackBlocks() [][2]int {
	starts := make([]int, 0, len(t.outOfSeq))
	for seq := range t.outOfSeq {
		starts = append(starts, seq)
	}
	sort.Ints(starts)
	var blocks [][2]int
	for _, seq := range starts {
		end := seq + len(t.outOfSeq[seq])
		if n := len(blocks); n > 0 && blocks[n-1][1] == seq {
			blocks[n-1][1] = end
		} else {
			blocks = append(blocks, [2]int{seq, end})
		}
	}
	if len(blocks) > 4 {
		blocks = blocks[len(blocks)-4:]
	}
	return blocks
}

/* ACK processing */

func (t *tcp) clientOnACK(ack int, echo float64, blocks [][2]int) {
	if t.state != established {
		return
	}
	for _, b := range blocks {
		for _, seg := range t.segments {
			if seg.seq >= b[0] && seg.seq+seg.len <= b[1] {
				seg.sacked = true
			}
		}
		t.highSacked = max(t.highSacked, b[1])
	}

	if ack > t.sndUna {
		t.onNewACK(ack, echo)
		return
	}
	if ack == t.sndUna && t.sndUna < t.sndNxt {
		t.dupAcks++
		switch {
		case t.cc.flavor == "fixed":
			if t.dupAcks == t.o.DupAckThreshold {
				t.retransmitOldest()
			}
		case !t.inRecovery && t.dupAcks == t.o.DupAckThreshold:
			t.enterRecovery()
		case t.inRecovery && !t.o.SACK:
			t.cc.onDupAckInRecovery()
			t.record()
		}
		t.trySend()
	}
}

func (t *tcp) onNewACK(ack int, echo float64) {
	acked := ack - t.sndUna
	// The echoed send time gives a correct RTT, also for retransmitted
	// segments. A new RTT also ends the exponential backoff.
	rtt := t.s.now - echo
	t.rto.sample(rtt)

	t.delivered += acked
	var rate float64
	var newest *segment
	for seq, seg := range t.segments {
		if seq < ack {
			if newest == nil || seg.seq > newest.seq {
				newest = seg
			}
			delete(t.segments, seq)
		}
	}
	if newest != nil && t.s.now > newest.deliveredAt {
		rate = float64(t.delivered-newest.delivered) / (t.s.now - newest.deliveredAt)
	}
	t.sndUna = ack
	t.dupAcks = 0
	segments := float64(acked) / float64(t.mss())

	if t.inRecovery {
		if ack >= t.recover {
			t.inRecovery = false
			t.cc.onRecoveryExit()
		} else if t.cc.flavor == "reno" {
			// Classic Reno leaves fast recovery on the first new ACK, even
			// when more segments of the same window are lost.
			t.inRecovery = false
			t.cc.onRecoveryExit()
		} else {
			// Partial ACK (NewReno, RFC 6582): the next hole is lost too.
			if seg := t.segments[t.sndUna]; seg != nil && !seg.retransmitted {
				t.retransmitOldest()
			}
			t.cc.onPartialAck(segments)
		}
	} else {
		t.cc.onAck(segments, rtt, t.s.now)
	}
	t.cc.onRateSample(rate, rtt, t.s.now, ack, t.sndNxt, t.pipe(), t.mss())
	t.record()

	t.rtx.stop()
	if t.sndUna < t.sndNxt {
		t.rtx.start(t.rto.rto, t.onTimeout)
	}
	t.trySend()
}

func (t *tcp) enterRecovery() {
	flight := float64(t.sndNxt-t.sndUna) / float64(t.mss())
	t.cc.onFastLoss(flight, t.o.DupAckThreshold, t.o.SACK, t.s.now)
	t.inRecovery = true
	t.recover = t.sndNxt
	for _, seg := range t.segments {
		seg.retransmitted = false
	}
	t.retransmitOldest()
	t.record()
}

func (t *tcp) retransmitOldest() {
	seg := t.segments[t.sndUna]
	if seg == nil {
		return
	}
	seg.retransmitted = true
	t.sendSegment(seg.seq, seg.len, true)
	t.rtx.stop()
	t.rtx.start(t.rto.rto, t.onTimeout)
}

func (t *tcp) onTimeout() {
	t.rto.backoff()
	switch t.state {
	case synSent:
		t.synRetried = true
		t.sendSYN()
	case established:
		if t.sndUna < t.sndNxt {
			flight := float64(t.sndNxt-t.sndUna) / float64(t.mss())
			t.cc.onTimeout(flight, t.s.now)
			t.inRecovery = false
			t.dupAcks = 0
			t.retransmitOldest()
			t.record()
		}
	case finWait:
		t.sendFIN()
	}
}

/* Close */

func (t *tcp) maybeClose() {
	done := t.sndUna == len(t.s.stream) && t.available == len(t.s.stream) && t.s.now >= t.lastMessageAt
	if t.state == established && done {
		t.state = finWait
		t.sendFIN()
	}
}

func (t *tcp) sendFIN() {
	t.s.send(Packet{Kind: "FIN", From: "client", Seq: len(t.s.stream), Message: -1}, tcpHeader, func(Packet) {
		t.s.send(Packet{Kind: "FIN-ACK", From: "server", Message: -1}, tcpHeader, func(Packet) {
			if t.state == finWait {
				t.state = closed
				t.rtx.stop()
				t.s.send(Packet{Kind: "ACK", From: "client", Message: -1}, tcpHeader, func(Packet) {})
			}
		})
	})
	t.rtx.start(t.rto.rto, t.onTimeout)
}

// record saves the congestion window when it changes.
func (t *tcp) record() {
	sample := WindowSample{
		T:        t.s.now,
		Cwnd:     t.windowBytes() / float64(t.mss()),
		Ssthresh: t.cc.ssthreshValue(),
		Inflight: float64(t.pipe()) / float64(t.mss()),
		State:    t.cc.stateName(t.inRecovery),
	}
	w := &t.s.result.Window
	if n := len(*w); n > 0 {
		last := (*w)[n-1]
		if last.Cwnd == sample.Cwnd && last.Ssthresh == sample.Ssthresh && last.Inflight == sample.Inflight && last.State == sample.State {
			return
		}
		if last.T == sample.T {
			(*w)[n-1] = sample
			return
		}
	}
	*w = append(*w, sample)
}
