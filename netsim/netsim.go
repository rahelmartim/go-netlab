// Package netsim simulates data transfers over an unreliable link.
//
// The simulation runs in virtual time, so it is fast and deterministic: the
// same Options, including the seed, always give the same Result. The link
// has a delay, a jitter, random or burst loss, duplication, a bandwidth,
// and a router queue of limited size.
//
// Three protocols are available:
//
//   - UDP sends each datagram once.
//   - TCP is a simplified TCP with the 3-way handshake, a sliding window,
//     cumulative ACKs, an adaptive retransmission timeout, fast retransmit,
//     in-order delivery, and connection close. It has the congestion control
//     flavors Tahoe, Reno, NewReno, CUBIC, and a simplified BBR, and the
//     optimizations SACK, delayed ACKs, Nagle, a configurable initial window,
//     and Fast Open.
//   - Custom is a protocol that you build from parts: a handshake, a
//     reliability mode, ordering, and forward error correction.
package netsim

import (
	"errors"
	"math"
)

// Protocol is "udp", "tcp", or "custom".
type Protocol string

const (
	UDP    Protocol = "udp"
	TCP    Protocol = "tcp"
	Custom Protocol = "custom"
)

// Header sizes in bytes, used to compute the transmission time of a packet.
const (
	udpHeader    = 28 // IPv4 + UDP
	tcpHeader    = 40 // IPv4 + TCP
	customHeader = 32 // IPv4 + UDP + a 4-byte custom header
)

// Limits that keep one simulation small enough for a browser.
const (
	MaxPayloadBytes = 256 * 1024
	maxPackets      = 40000
	defaultMaxTime  = 120_000
)

// Conditions describe one direction of the link.
type Conditions struct {
	// DelayMs is the one-way delay.
	DelayMs float64 `json:"delayMs"`
	// JitterMs is the maximum random change of the delay, up or down.
	JitterMs float64 `json:"jitterMs"`
	// LossPct is the share of packets, from 0 to 100, that the link drops.
	LossPct float64 `json:"lossPct"`
	// LossBurst is the average number of packets in a row that are lost
	// together. 1 or less means that losses are independent.
	LossBurst float64 `json:"lossBurst"`
	// DuplicatePct is the chance, from 0 to 100, that the link delivers a
	// packet twice.
	DuplicatePct float64 `json:"duplicatePct"`
	// BandwidthKbps is the link speed. 0 means no limit.
	BandwidthKbps float64 `json:"bandwidthKbps"`
	// QueuePackets is the size of the router queue in front of the link.
	// When it is full, new packets are dropped. 0 means no limit.
	QueuePackets int `json:"queuePackets"`
}

// Message is application data that the client writes at a given time.
type Message struct {
	AtMs float64 `json:"atMs"`
	Data []byte  `json:"data"`
}

// TCPOptions configure the TCP protocol.
type TCPOptions struct {
	// Flavor is the congestion control: "fixed" (default, a fixed window of
	// Options.Window segments), "tahoe", "reno", "newreno", "cubic", or "bbr".
	Flavor string `json:"flavor"`
	// InitialWindow is the first congestion window, in segments. The
	// default is 3. It has no effect with the fixed flavor.
	InitialWindow int `json:"initialWindow"`
	// SACK makes the receiver report the blocks that it got out of order,
	// so that the sender retransmits only the holes.
	SACK bool `json:"sack"`
	// DelayedACK makes the receiver acknowledge every second segment, or
	// after 40 ms.
	DelayedACK bool `json:"delayedAck"`
	// Nagle makes the sender keep a small segment while data is in flight.
	Nagle bool `json:"nagle"`
	// FastOpen sends the first data with the SYN. It assumes a Fast Open
	// cookie from an earlier connection.
	FastOpen bool `json:"fastOpen"`
	// DupAckThreshold is the number of duplicate ACKs that start a fast
	// retransmit. The default is 3.
	DupAckThreshold int `json:"dupAckThreshold"`
	// Retransmission timeout bounds and first value, in milliseconds.
	MinRTOMs     float64 `json:"minRtoMs"`
	MaxRTOMs     float64 `json:"maxRtoMs"`
	InitialRTOMs float64 `json:"initialRtoMs"`
}

// CustomOptions configure the custom protocol.
type CustomOptions struct {
	// Handshake adds a HELLO and HELLO-ACK exchange before the data.
	Handshake bool `json:"handshake"`
	// Reliability is "none", "stop-and-wait", "go-back-n", or
	// "selective-repeat".
	Reliability string `json:"reliability"`
	// Window is the number of packets in flight. Stop-and-wait uses 1.
	Window int `json:"window"`
	// TimeoutMs is a fixed retransmission timeout. 0 means adaptive.
	TimeoutMs float64 `json:"timeoutMs"`
	// Ordered makes the receiver deliver data in order. With reliability,
	// it holds early packets. Without reliability, it drops late packets.
	Ordered bool `json:"ordered"`
	// FECGroup sends one XOR parity packet after every FECGroup data
	// packets. The receiver can rebuild one lost packet per group. 0 is off.
	FECGroup int `json:"fecGroup"`
}

// Options configure one simulation.
type Options struct {
	Protocol   Protocol   `json:"protocol"`
	Conditions Conditions `json:"conditions"`
	// Reverse, if set, describes the server-to-client direction. Without
	// it, both directions use Conditions.
	Reverse  *Conditions `json:"reverse"`
	Messages []Message   `json:"messages"`
	// Seed makes the random loss and jitter repeatable.
	Seed int64 `json:"seed"`
	// MSS is the maximum payload of one packet. The default is 512 bytes.
	MSS int `json:"mss"`
	// Window is the fixed TCP window, or the receive window for the other
	// flavors, in segments. The default is 4 for the fixed flavor and 64
	// for the others.
	Window int `json:"window"`
	// MaxTimeMs stops the simulation. The default is 120 000 ms.
	MaxTimeMs float64       `json:"maxTimeMs"`
	TCP       TCPOptions    `json:"tcp"`
	Custom    CustomOptions `json:"custom"`
}

// Packet is one transmission on the link.
type Packet struct {
	ID       int     `json:"id"`
	Kind     string  `json:"kind"` // DGRAM, SYN, SYN-ACK, ACK, DATA, FIN, FIN-ACK, HELLO, HELLO-ACK, PARITY
	From     string  `json:"from"` // client or server
	SentAt   float64 `json:"sentAt"`
	ArriveAt float64 `json:"arriveAt"`
	Lost     bool    `json:"lost"`
	// Reason tells why a packet was lost: "link" or "queue".
	Reason string `json:"reason,omitempty"`
	// Duplicate marks the second copy of a duplicated packet.
	Duplicate bool `json:"duplicate,omitempty"`
	// Seq is the stream offset of a DATA segment or of a datagram.
	Seq int `json:"seq"`
	// Ack is the next byte (TCP) or packet (custom) that the receiver expects.
	Ack int `json:"ack"`
	// Sack lists byte ranges [start, end) that the receiver holds out of order.
	Sack       [][2]int `json:"sack,omitempty"`
	Len        int      `json:"len"`
	Retransmit bool     `json:"retransmit"`
	Message    int      `json:"message"` // index of the message, or -1
	Preview    string   `json:"preview"`
}

// Delivery is data that the receiving application gets.
type Delivery struct {
	At       float64 `json:"at"`
	Offset   int     `json:"offset"` // offset in the concatenated messages
	Data     []byte  `json:"data"`
	Message  int     `json:"message"`
	PacketID int     `json:"packetId"`
	// Recovered marks data that forward error correction rebuilt.
	Recovered bool `json:"recovered,omitempty"`
}

// WindowSample is the state of the TCP congestion control at one time.
type WindowSample struct {
	T        float64 `json:"t"`
	Cwnd     float64 `json:"cwnd"`
	Ssthresh float64 `json:"ssthresh"` // -1 means no threshold yet
	Inflight float64 `json:"inflight"`
	State    string  `json:"state"`
}

// Stats summarize a simulation.
type Stats struct {
	PacketsSent     int     `json:"packetsSent"`
	PacketsLost     int     `json:"packetsLost"`
	QueueDrops      int     `json:"queueDrops"`
	Duplicates      int     `json:"duplicates"`
	DataPackets     int     `json:"dataPackets"`
	Retransmissions int     `json:"retransmissions"`
	FECRecovered    int     `json:"fecRecovered"`
	BytesTotal      int     `json:"bytesTotal"`
	BytesDelivered  int     `json:"bytesDelivered"`
	WireBytes       int     `json:"wireBytes"`
	Complete        bool    `json:"complete"`
	CompletedAtMs   float64 `json:"completedAtMs"`
	GoodputKbps     float64 `json:"goodputKbps"`
	HandshakeMs     float64 `json:"handshakeMs"`
	OutOfOrder      int     `json:"outOfOrder"`
	AvgLatencyMs    float64 `json:"avgLatencyMs"`
	MinLatencyMs    float64 `json:"minLatencyMs"`
	MaxLatencyMs    float64 `json:"maxLatencyMs"`
	JitterMs        float64 `json:"jitterMs"`
}

// Result is the full timeline of a simulation.
type Result struct {
	Protocol       Protocol       `json:"protocol"`
	Packets        []Packet       `json:"packets"`
	Deliveries     []Delivery     `json:"deliveries"`
	MessageOffsets []int          `json:"messageOffsets"`
	Window         []WindowSample `json:"window"`
	Stats          Stats          `json:"stats"`
	DurationMs     float64        `json:"durationMs"`
}

// Errors returned by Simulate.
var (
	ErrProtocol = errors.New("netsim: protocol must be udp, tcp or custom")
	ErrTooLarge = errors.New("netsim: payload is too large")
	ErrBadValue = errors.New("netsim: a value is out of range")
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
	case Custom:
		s.runCustom()
	}
	s.finish()
	return s.result, nil
}

var flavors = map[string]bool{"fixed": true, "tahoe": true, "reno": true, "newreno": true, "cubic": true, "bbr": true}

var reliabilities = map[string]bool{"none": true, "stop-and-wait": true, "go-back-n": true, "selective-repeat": true}

func normalizeConditions(c *Conditions) error {
	values := []float64{c.DelayMs, c.JitterMs, c.LossPct, c.LossBurst, c.DuplicatePct, c.BandwidthKbps, float64(c.QueuePackets)}
	for _, v := range values {
		if v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return ErrBadValue
		}
	}
	c.LossPct = math.Min(c.LossPct, 100)
	c.DuplicatePct = math.Min(c.DuplicatePct, 100)
	return nil
}

func normalize(opts *Options) error {
	if opts.Protocol != UDP && opts.Protocol != TCP && opts.Protocol != Custom {
		return ErrProtocol
	}
	if err := normalizeConditions(&opts.Conditions); err != nil {
		return err
	}
	if opts.Reverse != nil {
		if err := normalizeConditions(opts.Reverse); err != nil {
			return err
		}
	}
	total := 0
	for _, m := range opts.Messages {
		total += len(m.Data)
		if m.AtMs < 0 || math.IsNaN(m.AtMs) {
			return ErrBadValue
		}
	}
	if total > MaxPayloadBytes {
		return ErrTooLarge
	}
	if opts.MSS <= 0 {
		opts.MSS = 512
	}
	opts.MSS = min(opts.MSS, 64*1024)

	t := &opts.TCP
	if t.Flavor == "" {
		t.Flavor = "fixed"
	}
	if !flavors[t.Flavor] {
		return ErrBadValue
	}
	if opts.Window <= 0 {
		opts.Window = 4
		if t.Flavor != "fixed" {
			opts.Window = 64
		}
	}
	opts.Window = min(opts.Window, 1024)
	if t.InitialWindow <= 0 {
		t.InitialWindow = 3
	}
	if t.DupAckThreshold <= 0 {
		t.DupAckThreshold = 3
	}
	if t.MinRTOMs <= 0 {
		t.MinRTOMs = 20
	}
	if t.MaxRTOMs <= 0 {
		t.MaxRTOMs = 8000
	}
	t.MaxRTOMs = math.Max(t.MaxRTOMs, t.MinRTOMs)

	c := &opts.Custom
	if c.Reliability == "" {
		c.Reliability = "selective-repeat"
	}
	if !reliabilities[c.Reliability] {
		return ErrBadValue
	}
	if c.Window <= 0 {
		c.Window = 8
	}
	if c.Reliability == "stop-and-wait" {
		c.Window = 1
	}
	c.Window = min(c.Window, 1024)
	c.FECGroup = max(c.FECGroup, 0)
	if c.TimeoutMs < 0 {
		return ErrBadValue
	}

	if opts.MaxTimeMs <= 0 {
		opts.MaxTimeMs = defaultMaxTime
	}
	return nil
}
