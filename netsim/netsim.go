// Package netsim simulates UDP and TCP transfers over an unreliable link.
//
// The simulation runs in virtual time, so it is fast and deterministic: the
// same Options, including the seed, always give the same Result. The link
// has a delay, a jitter, a loss rate, and a bandwidth. The TCP model is
// simplified, but it has the main parts of real TCP: the 3-way handshake,
// a sliding window, cumulative ACKs, an adaptive retransmission timeout,
// fast retransmit, in-order delivery, and connection close.
package netsim

import (
	"container/heap"
	"errors"
	"math"
	"math/rand"
	"sort"
)

// Protocol is "udp" or "tcp".
type Protocol string

const (
	UDP Protocol = "udp"
	TCP Protocol = "tcp"
)

// Header sizes in bytes, used to compute the transmission time of a packet.
const (
	udpHeader = 28 // IPv4 + UDP
	tcpHeader = 40 // IPv4 + TCP
)

// Limits that keep one simulation small enough for a browser.
const (
	MaxPayloadBytes = 256 * 1024
	maxPackets      = 20000
	defaultMaxTime  = 120_000
)

// Conditions describe the link between the client and the server. Both
// directions use the same conditions.
type Conditions struct {
	// DelayMs is the one-way delay.
	DelayMs float64 `json:"delayMs"`
	// JitterMs is the maximum random change of the delay, up or down.
	JitterMs float64 `json:"jitterMs"`
	// LossPct is the chance, from 0 to 100, that a packet is lost.
	LossPct float64 `json:"lossPct"`
	// BandwidthKbps is the link speed. 0 means no limit.
	BandwidthKbps float64 `json:"bandwidthKbps"`
}

// Message is application data that the client sends at a given time.
type Message struct {
	AtMs float64 `json:"atMs"`
	Data []byte  `json:"data"`
}

// Options configure one simulation.
type Options struct {
	Protocol   Protocol   `json:"protocol"`
	Conditions Conditions `json:"conditions"`
	Messages   []Message  `json:"messages"`
	// Seed makes the random loss and jitter repeatable.
	Seed int64 `json:"seed"`
	// MSS is the maximum payload of one packet. The default is 512 bytes.
	MSS int `json:"mss"`
	// Window is the number of TCP segments in flight. The default is 4.
	Window int `json:"window"`
	// MaxTimeMs stops the simulation. The default is 120 000 ms.
	MaxTimeMs float64 `json:"maxTimeMs"`
}

// Packet is one transmission on the link.
type Packet struct {
	ID       int     `json:"id"`
	Kind     string  `json:"kind"` // DGRAM, SYN, SYN-ACK, ACK, DATA, FIN, FIN-ACK
	From     string  `json:"from"` // client or server
	SentAt   float64 `json:"sentAt"`
	ArriveAt float64 `json:"arriveAt"`
	Lost     bool    `json:"lost"`
	// Seq is the stream offset of a DATA segment or of a datagram.
	Seq int `json:"seq"`
	// Ack is the next byte that the receiver expects. Only for ACK packets.
	Ack        int    `json:"ack"`
	Len        int    `json:"len"`
	Retransmit bool   `json:"retransmit"`
	Message    int    `json:"message"` // index of the message, or -1
	Preview    string `json:"preview"`
}

// Delivery is data that the receiving application gets.
type Delivery struct {
	At       float64 `json:"at"`
	Offset   int     `json:"offset"` // offset in the concatenated messages
	Data     []byte  `json:"data"`
	Message  int     `json:"message"`
	PacketID int     `json:"packetId"`
}

// Stats summarize a simulation.
type Stats struct {
	PacketsSent     int     `json:"packetsSent"`
	PacketsLost     int     `json:"packetsLost"`
	DataPackets     int     `json:"dataPackets"`
	Retransmissions int     `json:"retransmissions"`
	BytesTotal      int     `json:"bytesTotal"`
	BytesDelivered  int     `json:"bytesDelivered"`
	Complete        bool    `json:"complete"`
	CompletedAtMs   float64 `json:"completedAtMs"`
	HandshakeMs     float64 `json:"handshakeMs"`
	OutOfOrder      int     `json:"outOfOrder"`
	AvgLatencyMs    float64 `json:"avgLatencyMs"`
	MinLatencyMs    float64 `json:"minLatencyMs"`
	MaxLatencyMs    float64 `json:"maxLatencyMs"`
	JitterMs        float64 `json:"jitterMs"`
}

// Result is the full timeline of a simulation.
type Result struct {
	Protocol       Protocol   `json:"protocol"`
	Packets        []Packet   `json:"packets"`
	Deliveries     []Delivery `json:"deliveries"`
	MessageOffsets []int      `json:"messageOffsets"`
	Stats          Stats      `json:"stats"`
	DurationMs     float64    `json:"durationMs"`
}

// Errors returned by Simulate.
var (
	ErrProtocol = errors.New("netsim: protocol must be udp or tcp")
	ErrTooLarge = errors.New("netsim: payload is too large")
	ErrBadValue = errors.New("netsim: conditions must not be negative")
)

// Simulate runs one transfer from the client to the server.
func Simulate(opts Options) (*Result, error) {
	if err := normalize(&opts); err != nil {
		return nil, err
	}
	s := newSim(opts)
	switch opts.Protocol {
	case UDP:
		s.runUDP()
	case TCP:
		s.runTCP()
	}
	s.finish()
	return s.result, nil
}

func normalize(opts *Options) error {
	if opts.Protocol != UDP && opts.Protocol != TCP {
		return ErrProtocol
	}
	c := opts.Conditions
	if c.DelayMs < 0 || c.JitterMs < 0 || c.LossPct < 0 || c.BandwidthKbps < 0 {
		return ErrBadValue
	}
	opts.Conditions.LossPct = math.Min(c.LossPct, 100)
	total := 0
	for _, m := range opts.Messages {
		total += len(m.Data)
	}
	if total > MaxPayloadBytes {
		return ErrTooLarge
	}
	if opts.MSS <= 0 {
		opts.MSS = 512
	}
	if opts.Window <= 0 {
		opts.Window = 4
	}
	if opts.MaxTimeMs <= 0 {
		opts.MaxTimeMs = defaultMaxTime
	}
	return nil
}

/* Event queue */

type event struct {
	at  float64
	seq int // keeps the order of events at the same time
	fn  func()
}

type eventQueue []*event

func (q eventQueue) Len() int { return len(q) }
func (q eventQueue) Less(i, j int) bool {
	if q[i].at != q[j].at {
		return q[i].at < q[j].at
	}
	return q[i].seq < q[j].seq
}
func (q eventQueue) Swap(i, j int) { q[i], q[j] = q[j], q[i] }
func (q *eventQueue) Push(x any)   { *q = append(*q, x.(*event)) }
func (q *eventQueue) Pop() any {
	old := *q
	e := old[len(old)-1]
	*q = old[:len(old)-1]
	return e
}

/* Simulation */

type sim struct {
	opts    Options
	rng     *rand.Rand
	now     float64
	events  eventQueue
	nextSeq int
	// busyUntil is the time when each direction of the link is free again.
	busyUntil map[string]float64
	stream    []byte
	result    *Result
	stopped   bool
}

func newSim(opts Options) *sim {
	s := &sim{
		opts:      opts,
		rng:       rand.New(rand.NewSource(opts.Seed)),
		busyUntil: map[string]float64{"client": 0, "server": 0},
		result:    &Result{Protocol: opts.Protocol, Packets: []Packet{}, Deliveries: []Delivery{}},
	}
	for _, m := range opts.Messages {
		s.result.MessageOffsets = append(s.result.MessageOffsets, len(s.stream))
		s.stream = append(s.stream, m.Data...)
	}
	s.result.Stats.BytesTotal = len(s.stream)
	return s
}

func (s *sim) at(t float64, fn func()) {
	s.nextSeq++
	heap.Push(&s.events, &event{at: t, seq: s.nextSeq, fn: fn})
}

func (s *sim) run() {
	for s.events.Len() > 0 && !s.stopped {
		e := heap.Pop(&s.events).(*event)
		if e.at > s.opts.MaxTimeMs || len(s.result.Packets) >= maxPackets {
			break
		}
		s.now = e.at
		e.fn()
	}
}

// send puts a packet on the link and schedules its arrival. onArrive does
// not run when the packet is lost.
func (s *sim) send(p Packet, header int, onArrive func(Packet)) {
	c := s.opts.Conditions
	start := math.Max(s.now, s.busyUntil[p.From])
	transmit := 0.0
	if c.BandwidthKbps > 0 {
		transmit = float64((p.Len+header)*8) / c.BandwidthKbps // bits / (bits per ms)
	}
	s.busyUntil[p.From] = start + transmit

	jitter := 0.0
	if c.JitterMs > 0 {
		jitter = (s.rng.Float64()*2 - 1) * c.JitterMs
	}
	latency := math.Max(transmit+c.DelayMs+jitter, transmit+0.1)

	p.ID = len(s.result.Packets)
	p.SentAt = start
	p.ArriveAt = start + latency
	p.Lost = s.rng.Float64()*100 < c.LossPct
	s.result.Packets = append(s.result.Packets, p)

	if !p.Lost {
		s.at(p.ArriveAt, func() { onArrive(p) })
	}
}

func (s *sim) deliver(p Packet, offset int, data []byte) {
	s.result.Deliveries = append(s.result.Deliveries, Delivery{
		At: s.now, Offset: offset, Data: data, Message: s.messageAt(offset), PacketID: p.ID,
	})
	s.result.Stats.BytesDelivered += len(data)
	s.result.Stats.CompletedAtMs = s.now
}

// messageAt returns the index of the message that contains a stream offset.
func (s *sim) messageAt(offset int) int {
	index := -1
	for i, start := range s.result.MessageOffsets {
		if offset >= start {
			index = i
		}
	}
	return index
}

func preview(data []byte) string {
	const max = 24
	text := make([]rune, 0, max)
	for _, r := range string(data) {
		if len(text) == max {
			return string(text) + "…"
		}
		if r < 32 || r == 0xFFFD {
			r = '·'
		}
		text = append(text, r)
	}
	return string(text)
}

/* UDP */

func (s *sim) runUDP() {
	type chunkKey struct{ message, seq int }
	delivered := map[chunkKey]bool{}
	for i, m := range s.opts.Messages {
		base := s.result.MessageOffsets[i]
		data := m.Data
		s.at(m.AtMs, func() {
			// A large message becomes several datagrams. An empty one is one
			// empty datagram.
			for off := 0; off == 0 || off < len(data); off += s.opts.MSS {
				chunk := data[off:min(off+s.opts.MSS, len(data))]
				p := Packet{
					Kind: "DGRAM", From: "client", Seq: base + off, Len: len(chunk),
					Message: i, Preview: preview(chunk),
				}
				s.send(p, udpHeader, func(p Packet) {
					key := chunkKey{p.Message, p.Seq}
					if !delivered[key] {
						delivered[key] = true
						s.deliver(p, p.Seq, chunk)
					}
				})
			}
		})
	}
	s.run()
	s.result.Stats.Complete = s.result.Stats.BytesDelivered == len(s.stream)
}

/* TCP */

type segment struct {
	seq, len int
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
	state tcpState

	// Sender (client)
	sndUna, sndNxt int
	segments       map[int]*segment
	dupAcks        int
	srtt, rttvar   float64
	rto            float64
	hasRTT         bool
	timerGen       int
	timerRunning   bool
	available      int // bytes that the application has written so far
	lastMessageAt  float64

	// Receiver (server)
	rcvNxt   int
	outOfSeq map[int][]byte
}

func (s *sim) runTCP() {
	c := s.opts.Conditions
	t := &tcp{
		s:        s,
		segments: map[int]*segment{},
		outOfSeq: map[int][]byte{},
		// Before the first RTT sample, wait about 3 round trips.
		rto: math.Max(3*2*(c.DelayMs+c.JitterMs)+20, 50),
	}
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

func (t *tcp) sendSYN() {
	t.s.send(Packet{Kind: "SYN", From: "client", Message: -1}, tcpHeader, t.serverOnSYN)
	t.startTimer()
}

func (t *tcp) serverOnSYN(Packet) {
	t.s.send(Packet{Kind: "SYN-ACK", From: "server", Message: -1}, tcpHeader, t.clientOnSYNACK)
}

func (t *tcp) clientOnSYNACK(Packet) {
	if t.state == synSent {
		t.state = established
		t.s.result.Stats.HandshakeMs = t.s.now
		t.stopTimer()
	}
	// Send the ACK again if the server sent its SYN-ACK again.
	t.s.send(Packet{Kind: "ACK", From: "client", Message: -1}, tcpHeader, func(Packet) {})
	t.trySend()
}

// trySend sends new segments while the window has space.
func (t *tcp) trySend() {
	if t.state != established {
		return
	}
	limit := t.s.opts.Window * t.s.opts.MSS
	for t.sndNxt < t.available && t.sndNxt-t.sndUna < limit {
		size := min(t.s.opts.MSS, t.available-t.sndNxt, limit-(t.sndNxt-t.sndUna))
		t.sendSegment(t.sndNxt, size, false)
		t.sndNxt += size
	}
	t.maybeClose()
}

func (t *tcp) sendSegment(seq, size int, retransmit bool) {
	data := t.s.stream[seq : seq+size]
	seg, ok := t.segments[seq]
	if !ok {
		seg = &segment{seq: seq, len: size}
		t.segments[seq] = seg
	}
	if retransmit {
		t.s.result.Stats.Retransmissions++
	}
	p := Packet{
		Kind: "DATA", From: "client", Seq: seq, Len: size, Retransmit: retransmit,
		Message: t.s.messageAt(seq), Preview: preview(data),
	}
	sentAt := t.s.now
	t.s.send(p, tcpHeader, func(p Packet) { t.serverOnData(p, data, sentAt) })
	t.ensureTimer()
}

// serverOnData receives a segment. echo is the send time of the segment,
// which the ACK carries back, like the TCP timestamp option (RFC 7323).
func (t *tcp) serverOnData(p Packet, data []byte, echo float64) {
	switch {
	case p.Seq == t.rcvNxt:
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
	ack := t.rcvNxt
	t.s.send(Packet{Kind: "ACK", From: "server", Ack: ack, Message: -1}, tcpHeader, func(Packet) {
		t.clientOnACK(ack, echo)
	})
}

func (t *tcp) clientOnACK(ack int, echo float64) {
	if t.state != established {
		return
	}
	if ack > t.sndUna {
		// The echoed send time gives a correct RTT, also for retransmitted
		// segments. A new RTT also ends the exponential backoff.
		t.updateRTO(t.s.now - echo)
		for seq := range t.segments {
			if seq < ack {
				delete(t.segments, seq)
			}
		}
		t.sndUna = ack
		t.dupAcks = 0
		t.stopTimer()
		if t.sndUna < t.sndNxt {
			t.startTimer()
		}
		t.trySend()
		return
	}
	if ack == t.sndUna && t.sndUna < t.sndNxt {
		t.dupAcks++
		if t.dupAcks == 3 {
			// Fast retransmit: 3 duplicate ACKs mean that a segment is lost.
			seg := t.segments[t.sndUna]
			t.sendSegment(seg.seq, seg.len, true)
			t.stopTimer()
			t.startTimer()
		}
	}
}

// updateRTO follows RFC 6298.
func (t *tcp) updateRTO(sample float64) {
	if !t.hasRTT {
		t.srtt, t.rttvar, t.hasRTT = sample, sample/2, true
	} else {
		t.rttvar = 0.75*t.rttvar + 0.25*math.Abs(t.srtt-sample)
		t.srtt = 0.875*t.srtt + 0.125*sample
	}
	t.rto = math.Min(math.Max(t.srtt+4*t.rttvar, minRTO), maxRTO)
}

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
				t.stopTimer()
				t.s.send(Packet{Kind: "ACK", From: "client", Message: -1}, tcpHeader, func(Packet) {})
			}
		})
	})
	t.startTimer()
}

/* Retransmission timer */

// Bounds of the retransmission timeout, in milliseconds.
const (
	minRTO = 20
	maxRTO = 8000
)

func (t *tcp) ensureTimer() {
	if !t.timerRunning {
		t.startTimer()
	}
}

func (t *tcp) startTimer() {
	t.timerGen++
	t.timerRunning = true
	gen := t.timerGen
	t.s.at(t.s.now+t.rto, func() {
		if gen == t.timerGen && t.timerRunning {
			t.onTimeout()
		}
	})
}

// stopTimer cancels the pending timeout: its generation no longer matches.
func (t *tcp) stopTimer() {
	t.timerGen++
	t.timerRunning = false
}

func (t *tcp) onTimeout() {
	t.timerRunning = false
	t.rto = math.Min(t.rto*2, maxRTO) // Exponential backoff.
	switch t.state {
	case synSent:
		t.sendSYN()
	case established:
		if t.sndUna < t.sndNxt {
			seg := t.segments[t.sndUna]
			t.dupAcks = 0
			t.sendSegment(seg.seq, seg.len, true)
			t.startTimer()
		}
	case finWait:
		t.sendFIN()
	}
}

/* Statistics */

func (s *sim) finish() {
	st := &s.result.Stats
	st.PacketsSent = len(s.result.Packets)

	var latencies []float64
	transit := 0.0
	first := true
	maxSeen := -1
	for _, p := range s.arrivalOrder() {
		if p.Kind != "DATA" && p.Kind != "DGRAM" {
			continue
		}
		latency := p.ArriveAt - p.SentAt
		latencies = append(latencies, latency)
		// RFC 3550 interarrival jitter.
		if !first {
			st.JitterMs += (math.Abs(latency-transit) - st.JitterMs) / 16
		}
		transit, first = latency, false
		if p.Seq < maxSeen && !p.Retransmit {
			st.OutOfOrder++
		}
		maxSeen = max(maxSeen, p.Seq)
	}
	for _, p := range s.result.Packets {
		if p.Lost {
			st.PacketsLost++
		}
		if p.Kind == "DATA" || p.Kind == "DGRAM" {
			st.DataPackets++
		}
	}
	if len(latencies) > 0 {
		st.MinLatencyMs, st.MaxLatencyMs = math.Inf(1), 0
		sum := 0.0
		for _, l := range latencies {
			sum += l
			st.MinLatencyMs = math.Min(st.MinLatencyMs, l)
			st.MaxLatencyMs = math.Max(st.MaxLatencyMs, l)
		}
		st.AvgLatencyMs = sum / float64(len(latencies))
	}
	for _, p := range s.result.Packets {
		s.result.DurationMs = math.Max(s.result.DurationMs, p.ArriveAt)
	}
	if !st.Complete {
		st.CompletedAtMs = 0
	}
}

// arrivalOrder returns the packets that arrived, sorted by arrival time.
func (s *sim) arrivalOrder() []Packet {
	arrived := make([]Packet, 0, len(s.result.Packets))
	for _, p := range s.result.Packets {
		if !p.Lost {
			arrived = append(arrived, p)
		}
	}
	sort.SliceStable(arrived, func(i, j int) bool { return arrived[i].ArriveAt < arrived[j].ArriveAt })
	return arrived
}
