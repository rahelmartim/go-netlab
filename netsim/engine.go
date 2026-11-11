package netsim

import (
	"container/heap"
	"math"
	"math/rand"
)

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

/* Link */

// direction is one side of the link, with its own queue and loss state.
type direction struct {
	cond      Conditions
	busyUntil float64
	// queued holds the times when the packets in the queue finish their
	// transmission. It is used to know how full the router queue is.
	queued []float64
	// inBurst is the state of the Gilbert-Elliott loss model.
	inBurst bool
}

// lose decides if the link drops the next packet. With a burst length
// above 1, it uses a two-state Gilbert-Elliott model: the link loses every
// packet in the bad state, and the average loss stays LossPct.
func (d *direction) lose(rng *rand.Rand) bool {
	loss := d.cond.LossPct / 100
	if loss <= 0 {
		return false
	}
	if loss >= 1 {
		return true
	}
	if d.cond.LossBurst <= 1 {
		return rng.Float64() < loss
	}
	leave := 1 / d.cond.LossBurst      // bad -> good
	enter := loss * leave / (1 - loss) // good -> bad
	if d.inBurst {
		d.inBurst = rng.Float64() >= leave
	} else {
		d.inBurst = rng.Float64() < enter
	}
	return d.inBurst
}

/* Simulation */

type sim struct {
	opts    Options
	rng     *rand.Rand
	now     float64
	events  eventQueue
	nextSeq int
	link    map[string]*direction // keyed by sender: client or server
	stream  []byte
	result  *Result
}

func newSim(opts Options) *sim {
	reverse := opts.Conditions
	if opts.Reverse != nil {
		reverse = *opts.Reverse
	}
	s := &sim{
		opts: opts,
		rng:  rand.New(rand.NewSource(opts.Seed)),
		link: map[string]*direction{
			"client": {cond: opts.Conditions},
			"server": {cond: reverse},
		},
		result: &Result{Protocol: opts.Protocol, Packets: []Packet{}, Deliveries: []Delivery{}, Window: []WindowSample{}},
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
	for s.events.Len() > 0 {
		e := heap.Pop(&s.events).(*event)
		if e.at > s.opts.MaxTimeMs || len(s.result.Packets) >= maxPackets {
			break
		}
		s.now = e.at
		e.fn()
	}
}

// send puts a packet on the link and schedules its arrival. onArrive runs
// once for each copy that arrives, so it can run twice for a duplicate.
func (s *sim) send(p Packet, header int, onArrive func(Packet)) {
	d := s.link[p.From]
	c := d.cond
	s.result.Stats.WireBytes += p.Len + header

	// Packets that finished their transmission have left the queue.
	waiting := d.queued[:0]
	for _, end := range d.queued {
		if end > s.now {
			waiting = append(waiting, end)
		}
	}
	d.queued = waiting

	p.ID = len(s.result.Packets)
	p.SentAt = s.now
	if c.QueuePackets > 0 && len(d.queued) >= c.QueuePackets {
		// Drop-tail: the router has no space for this packet.
		p.ArriveAt = s.now + math.Max(c.DelayMs, 1)
		p.Lost, p.Reason = true, "queue"
		s.result.Packets = append(s.result.Packets, p)
		return
	}

	start := math.Max(s.now, d.busyUntil)
	transmit := 0.0
	if c.BandwidthKbps > 0 {
		transmit = float64((p.Len+header)*8) / c.BandwidthKbps // bits / (bits per ms)
	}
	d.busyUntil = start + transmit
	d.queued = append(d.queued, d.busyUntil)

	// SentAt stays the time when the packet entered the queue, so the
	// latency includes the time that it waited (bufferbloat).
	p.ArriveAt = start + s.latency(c, transmit)
	if d.lose(s.rng) {
		p.Lost, p.Reason = true, "link"
	}
	s.result.Packets = append(s.result.Packets, p)
	if !p.Lost {
		s.at(p.ArriveAt, func() { onArrive(p) })
	}

	if c.DuplicatePct > 0 && !p.Lost && s.rng.Float64()*100 < c.DuplicatePct {
		dup := p
		dup.ID = len(s.result.Packets)
		dup.Duplicate = true
		dup.ArriveAt = start + s.latency(c, transmit)
		s.result.Packets = append(s.result.Packets, dup)
		s.result.Stats.Duplicates++
		s.at(dup.ArriveAt, func() { onArrive(dup) })
	}
}

func (s *sim) latency(c Conditions, transmit float64) float64 {
	jitter := 0.0
	if c.JitterMs > 0 {
		jitter = (s.rng.Float64()*2 - 1) * c.JitterMs
	}
	return math.Max(transmit+c.DelayMs+jitter, transmit+0.1)
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

/* Retransmission timeout estimator, RFC 6298 */

type rtoEstimator struct {
	srtt, rttvar float64
	rto          float64
	hasRTT       bool
	min, max     float64
}

func newRTOEstimator(c Conditions, initial, minRTO, maxRTO float64) rtoEstimator {
	if initial <= 0 {
		// Before the first RTT sample, wait about 3 round trips.
		initial = math.Max(3*2*(c.DelayMs+c.JitterMs)+20, 50)
	}
	return rtoEstimator{rto: math.Min(math.Max(initial, minRTO), maxRTO), min: minRTO, max: maxRTO}
}

func (e *rtoEstimator) sample(rtt float64) {
	if !e.hasRTT {
		e.srtt, e.rttvar, e.hasRTT = rtt, rtt/2, true
	} else {
		e.rttvar = 0.75*e.rttvar + 0.25*math.Abs(e.srtt-rtt)
		e.srtt = 0.875*e.srtt + 0.125*rtt
	}
	e.rto = math.Min(math.Max(e.srtt+4*e.rttvar, e.min), e.max)
}

func (e *rtoEstimator) backoff() {
	e.rto = math.Min(e.rto*2, e.max)
}

/* Timer */

// timer is a cancellable timeout. A newer start or a stop makes the
// pending event do nothing.
type timer struct {
	s       *sim
	gen     int
	running bool
}

func (t *timer) start(after float64, fn func()) {
	t.gen++
	t.running = true
	gen := t.gen
	t.s.at(t.s.now+after, func() {
		if gen == t.gen && t.running {
			t.running = false
			fn()
		}
	})
}

func (t *timer) stop() {
	t.gen++
	t.running = false
}
