package netsim

import "math"

// The custom protocol numbers its data packets 0, 1, 2… ACKs carry packet
// numbers, not byte offsets:
//
//   - none: each packet is sent once, and no ACKs exist.
//   - stop-and-wait: one packet in flight, one ACK per packet.
//   - go-back-n: a window of packets and cumulative ACKs. The receiver
//     drops packets that arrive out of order, and a timeout resends the
//     whole window.
//   - selective-repeat: a window of packets and one ACK per packet. The
//     receiver keeps early packets, and each packet has its own timer.
//
// With FEC, the sender adds one parity packet (the XOR of the group) after
// every FECGroup data packets. The receiver rebuilds a lost packet when it
// has the parity and all the other packets of the group.

type customPacket struct {
	idx, offset int
	data        []byte
	acked       bool
	timer       timer
}

type fecGroup struct {
	members []int
	parity  []byte
	have    bool // the parity packet arrived
	sent    bool
}

type custom struct {
	s *sim
	o CustomOptions

	established bool
	helloTimer  timer
	helloSentAt float64
	rto         rtoEstimator
	windowTimer timer // go-back-n has one timer for the whole window

	pkts          []*customPacket
	base, next    int
	written       int // messages written so far
	lastMessageAt float64

	// Receiver
	received      map[int][]byte
	delivered     map[int]bool
	expected      int
	lastDelivered int
	groups        map[int]*fecGroup
}

func (s *sim) runCustom() {
	o := s.opts.Custom
	c := &custom{
		s:             s,
		o:             o,
		helloTimer:    timer{s: s},
		windowTimer:   timer{s: s},
		rto:           newRTOEstimator(s.opts.Conditions, 0, 20, 8000),
		received:      map[int][]byte{},
		delivered:     map[int]bool{},
		lastDelivered: -1,
		groups:        map[int]*fecGroup{},
		established:   !o.Handshake,
	}
	for i, m := range s.opts.Messages {
		base := s.result.MessageOffsets[i]
		data := m.Data
		c.lastMessageAt = math.Max(c.lastMessageAt, m.AtMs)
		s.at(m.AtMs, func() {
			for off := 0; off < len(data); off += s.opts.MSS {
				end := min(off+s.opts.MSS, len(data))
				c.pkts = append(c.pkts, &customPacket{idx: len(c.pkts), offset: base + off, data: data[off:end], timer: timer{s: s}})
			}
			c.written++
			c.trySend()
		})
	}
	if o.Handshake {
		s.at(0, c.sendHello)
	}
	s.run()
	s.result.Stats.Complete = s.result.Stats.BytesDelivered == len(s.stream)
}

func (c *custom) timeout() float64 {
	if c.o.TimeoutMs > 0 {
		return c.o.TimeoutMs
	}
	return c.rto.rto
}

func (c *custom) reliable() bool { return c.o.Reliability != "none" }

/* Handshake */

func (c *custom) sendHello() {
	c.helloSentAt = c.s.now
	c.s.send(Packet{Kind: "HELLO", From: "client", Message: -1}, customHeader, func(Packet) {
		c.s.send(Packet{Kind: "HELLO-ACK", From: "server", Message: -1}, customHeader, func(Packet) {
			if c.established {
				return
			}
			c.established = true
			c.s.result.Stats.HandshakeMs = c.s.now
			c.rto.sample(c.s.now - c.helloSentAt)
			c.helloTimer.stop()
			c.trySend()
		})
	})
	c.helloTimer.start(c.timeout(), func() {
		c.rto.backoff()
		c.sendHello()
	})
}

/* Sender */

func (c *custom) trySend() {
	if !c.established {
		return
	}
	window := c.o.Window
	for c.next < len(c.pkts) && (!c.reliable() || c.next < c.base+window) {
		c.sendData(c.pkts[c.next], false)
		c.next++
		c.maybeSendParity()
	}
}

func (c *custom) sendData(pkt *customPacket, retransmit bool) {
	if retransmit {
		c.s.result.Stats.Retransmissions++
	}
	p := Packet{
		Kind: "DATA", From: "client", Seq: pkt.offset, Ack: pkt.idx, Len: len(pkt.data),
		Retransmit: retransmit, Message: c.s.messageAt(pkt.offset), Preview: preview(pkt.data),
	}
	sentAt := c.s.now
	c.s.send(p, customHeader, func(p Packet) { c.onData(p, pkt.idx, pkt.data, sentAt) })

	switch c.o.Reliability {
	case "stop-and-wait", "selective-repeat":
		pkt.timer.start(c.timeout(), func() {
			if !pkt.acked {
				c.rto.backoff()
				c.sendData(pkt, true)
			}
		})
	case "go-back-n":
		if !c.windowTimer.running {
			c.windowTimer.start(c.timeout(), c.onWindowTimeout)
		}
	}
}

func (c *custom) onWindowTimeout() {
	if c.base >= c.next {
		return
	}
	c.rto.backoff()
	// Go-back-N: send every packet of the window again.
	for i := c.base; i < c.next; i++ {
		c.sendData(c.pkts[i], true)
	}
	c.windowTimer.stop()
	c.windowTimer.start(c.timeout(), c.onWindowTimeout)
}

// maybeSendParity sends the parity packet of a full group, or of the last
// group when the application has written everything.
func (c *custom) maybeSendParity() {
	size := c.o.FECGroup
	if size <= 0 || c.next == 0 {
		return
	}
	last := c.next - 1
	group := last / size
	full := (last+1)%size == 0
	done := c.written == len(c.s.opts.Messages) && c.next == len(c.pkts)
	if !full && !done {
		return
	}
	g := c.groups[group]
	if g == nil {
		g = &fecGroup{}
		c.groups[group] = g
	}
	if g.sent {
		return
	}
	g.sent = true
	g.members = nil
	for i := group * size; i <= last; i++ {
		g.members = append(g.members, i)
	}
	parity := c.parityOf(g.members)
	members := g.members
	p := Packet{Kind: "PARITY", From: "client", Seq: group, Len: len(parity), Message: -1, Preview: "XOR"}
	c.s.send(p, customHeader, func(p Packet) { c.onParity(p, group, members, parity) })
}

func (c *custom) parityOf(members []int) []byte {
	size := 0
	for _, i := range members {
		size = max(size, len(c.pkts[i].data))
	}
	parity := make([]byte, size)
	for _, i := range members {
		for j, b := range c.pkts[i].data {
			parity[j] ^= b
		}
	}
	return parity
}

// onAck handles an ACK. echo is NaN for an ACK of a rebuilt packet, which
// gives no RTT sample.
func (c *custom) onAck(ack int, echo float64) {
	if !math.IsNaN(echo) {
		c.rto.sample(c.s.now - echo)
	}
	switch c.o.Reliability {
	case "go-back-n":
		if ack <= c.base {
			return
		}
		for i := c.base; i < ack && i < len(c.pkts); i++ {
			c.pkts[i].acked = true
		}
		c.base = ack
		c.windowTimer.stop()
		if c.base < c.next {
			c.windowTimer.start(c.timeout(), c.onWindowTimeout)
		}
	default:
		if ack < len(c.pkts) {
			pkt := c.pkts[ack]
			pkt.acked = true
			pkt.timer.stop()
		}
		for c.base < len(c.pkts) && c.pkts[c.base].acked {
			c.base++
		}
	}
	c.trySend()
}

/* Receiver */

func (c *custom) onData(p Packet, idx int, data []byte, echo float64) {
	c.receive(p, idx, data, false)
	if c.reliable() {
		c.sendAck(idx, echo)
	}
}

func (c *custom) sendAck(idx int, echo float64) {
	ack := idx
	if c.o.Reliability == "go-back-n" {
		ack = c.expected // cumulative: the next packet that it expects
	}
	c.s.send(Packet{Kind: "ACK", From: "server", Ack: ack, Message: -1}, customHeader, func(Packet) {
		c.onAck(ack, echo)
	})
}

func (c *custom) receive(p Packet, idx int, data []byte, recovered bool) {
	if _, ok := c.received[idx]; ok {
		return
	}
	offset := c.pkts[idx].offset
	switch {
	case c.o.Reliability == "go-back-n":
		if idx != c.expected {
			return // Go-back-N drops packets that arrive out of order.
		}
		c.received[idx] = data
		c.deliverPacket(p, idx, offset, data, recovered)
		c.expected++
	case !c.reliable() && c.o.Ordered:
		c.received[idx] = data
		if idx > c.lastDelivered {
			c.deliverPacket(p, idx, offset, data, recovered)
			c.lastDelivered = idx
		}
	case c.o.Ordered:
		c.received[idx] = data
		for {
			next, ok := c.received[c.expected]
			if !ok {
				break
			}
			c.deliverPacket(p, c.expected, c.pkts[c.expected].offset, next, recovered && c.expected == idx)
			c.expected++
		}
	default:
		c.received[idx] = data
		c.deliverPacket(p, idx, offset, data, recovered)
		for c.received[c.expected] != nil {
			c.expected++
		}
	}
	if c.o.FECGroup > 0 {
		c.tryRecover(p, idx/c.o.FECGroup)
	}
}

func (c *custom) deliverPacket(p Packet, idx, offset int, data []byte, recovered bool) {
	if c.delivered[idx] {
		return
	}
	c.delivered[idx] = true
	c.s.deliver(p, offset, data)
	if recovered {
		c.s.result.Deliveries[len(c.s.result.Deliveries)-1].Recovered = true
	}
}

func (c *custom) onParity(p Packet, group int, members []int, parity []byte) {
	g := c.groups[group]
	g.have = true
	g.parity = parity
	g.members = members
	c.tryRecover(p, group)
}

// tryRecover rebuilds the only missing packet of a group from its parity.
// p is the packet whose arrival made the recovery possible.
func (c *custom) tryRecover(p Packet, group int) {
	g := c.groups[group]
	if g == nil || !g.have {
		return
	}
	missing := -1
	for _, i := range g.members {
		if _, ok := c.received[i]; !ok {
			if missing >= 0 {
				return // Two or more packets are missing: XOR cannot help.
			}
			missing = i
		}
	}
	if missing < 0 {
		return
	}
	data := make([]byte, len(g.parity))
	copy(data, g.parity)
	for _, i := range g.members {
		if i != missing {
			for j, b := range c.received[i] {
				data[j] ^= b
			}
		}
	}
	data = data[:len(c.pkts[missing].data)]
	if c.o.Reliability == "go-back-n" && missing != c.expected {
		return // Go-back-N cannot use a packet that is not the next one.
	}
	c.s.result.Stats.FECRecovered++
	c.receive(p, missing, data, true)
	if c.reliable() {
		c.sendAck(missing, math.NaN())
	}
}
