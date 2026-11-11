package netsim

import (
	"bytes"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"
)

func text(s string) []Message { return []Message{{Data: []byte(s)}} }

func payload(n int) []Message {
	return []Message{{Data: bytes.Repeat([]byte("abcdefghij"), n/10)}}
}

func simulate(t *testing.T, opts Options) *Result {
	t.Helper()
	result, err := Simulate(opts)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// received rebuilds the bytes that the application got, in stream order.
func received(r *Result) []byte {
	out := make([]byte, r.Stats.BytesTotal)
	for _, d := range r.Deliveries {
		copy(out[d.Offset:], d.Data)
	}
	return out
}

func TestUDPPerfectLink(t *testing.T) {
	r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{DelayMs: 20}, Messages: payload(2000)})

	if r.Stats.PacketsSent != 4 || r.Stats.PacketsLost != 0 || !r.Stats.Complete {
		t.Errorf("stats = %+v, want 4 packets, no loss, complete", r.Stats)
	}
	if r.Stats.AvgLatencyMs != 20 {
		t.Errorf("AvgLatencyMs = %v, want 20", r.Stats.AvgLatencyMs)
	}
	for _, p := range r.Packets {
		if p.Kind != "DGRAM" || p.From != "client" {
			t.Errorf("packet %+v, want only client datagrams", p)
		}
	}
}

func TestUDPDoesNotRecoverLoss(t *testing.T) {
	r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{LossPct: 100}, Messages: payload(2000)})
	if r.Stats.BytesDelivered != 0 || r.Stats.Complete || r.Stats.Retransmissions != 0 {
		t.Errorf("stats = %+v, want nothing delivered and no retransmissions", r.Stats)
	}
}

func TestUDPJitterReorders(t *testing.T) {
	r := simulate(t, Options{
		Protocol:   UDP,
		Conditions: Conditions{DelayMs: 50, JitterMs: 40, BandwidthKbps: 10_000},
		Messages:   payload(20_000),
		Seed:       7,
	})
	if r.Stats.OutOfOrder == 0 {
		t.Error("OutOfOrder = 0, want reordering with a large jitter")
	}
	if r.Stats.JitterMs == 0 {
		t.Error("JitterMs = 0, want a jitter")
	}
}

func TestTCPPerfectLink(t *testing.T) {
	r := simulate(t, Options{Protocol: TCP, Conditions: Conditions{DelayMs: 10}, Messages: text("hello")})

	kinds := []string{}
	for _, p := range r.Packets {
		kinds = append(kinds, p.Kind)
	}
	want := "SYN SYN-ACK ACK DATA ACK FIN FIN-ACK ACK"
	if got := strings.Join(kinds, " "); got != want {
		t.Errorf("packets = %s, want %s", got, want)
	}
	if r.Stats.HandshakeMs != 20 || !r.Stats.Complete || string(received(r)) != "hello" {
		t.Errorf("stats = %+v, received %q", r.Stats, received(r))
	}
}

func TestTCPRecoversLossInOrder(t *testing.T) {
	msgs := payload(20_000)
	for seed := int64(1); seed <= 20; seed++ {
		r := simulate(t, Options{
			Protocol:   TCP,
			Conditions: Conditions{DelayMs: 30, JitterMs: 20, LossPct: 25, BandwidthKbps: 5_000},
			Messages:   msgs,
			Seed:       seed,
		})
		if !r.Stats.Complete || !bytes.Equal(received(r), msgs[0].Data) {
			t.Fatalf("seed %d: complete=%v, data differs", seed, r.Stats.Complete)
		}
		if r.Stats.Retransmissions == 0 {
			t.Errorf("seed %d: no retransmissions with 25%% loss", seed)
		}
		// The application must get the bytes in order.
		next := 0
		for _, d := range r.Deliveries {
			if d.Offset != next {
				t.Fatalf("seed %d: delivery at offset %d, want %d", seed, d.Offset, next)
			}
			next += len(d.Data)
		}
	}
}

func TestTCPFastRetransmit(t *testing.T) {
	// Find a seed where the timeout is not needed: duplicate ACKs trigger
	// the retransmission before the timer.
	found := false
	for seed := int64(1); seed <= 50 && !found; seed++ {
		r := simulate(t, Options{
			Protocol:   TCP,
			Conditions: Conditions{DelayMs: 40, LossPct: 10, BandwidthKbps: 20_000},
			Messages:   payload(40_000),
			Window:     8,
			Seed:       seed,
		})
		for i, p := range r.Packets {
			if !p.Retransmit {
				continue
			}
			dup := 0
			for _, q := range r.Packets[:i] {
				if q.Kind == "ACK" && q.From == "server" && q.Ack == p.Seq && !q.Lost && q.ArriveAt <= p.SentAt {
					dup++
				}
			}
			if dup >= 4 { // 1 normal ACK + 3 duplicates
				found = true
				break
			}
		}
	}
	if !found {
		t.Error("no fast retransmit after 3 duplicate ACKs in 50 seeds")
	}
}

func TestTCPMessagesLater(t *testing.T) {
	r := simulate(t, Options{
		Protocol:   TCP,
		Conditions: Conditions{DelayMs: 5},
		Messages:   []Message{{AtMs: 0, Data: []byte("a")}, {AtMs: 500, Data: []byte("b")}},
	})
	if string(received(r)) != "ab" || r.Stats.CompletedAtMs < 500 {
		t.Errorf("received %q at %v ms, want \"ab\" after 500 ms", received(r), r.Stats.CompletedAtMs)
	}
	if r.Deliveries[1].Message != 1 {
		t.Errorf("second delivery message = %d, want 1", r.Deliveries[1].Message)
	}
}

func TestBandwidthSpacesPackets(t *testing.T) {
	// The payload has 1020 bytes: packets of 512 and 508 bytes. The second
	// one arrives one transmission time later: (508 + 28) × 8 / 1000 ms.
	r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{BandwidthKbps: 1000}, Messages: payload(1024)})
	if gap := r.Packets[1].ArriveAt - r.Packets[0].ArriveAt; math.Abs(gap-4.288) > 0.001 {
		t.Errorf("gap between arrivals = %v ms, want 4.288", gap)
	}
}

func TestSameSeedSameResult(t *testing.T) {
	opts := Options{Protocol: TCP, Conditions: Conditions{DelayMs: 20, JitterMs: 15, LossPct: 20}, Messages: payload(5000), Seed: 42}
	if !reflect.DeepEqual(simulate(t, opts), simulate(t, opts)) {
		t.Error("two runs with the same seed differ")
	}
}

func TestEmptyMessages(t *testing.T) {
	for _, protocol := range []Protocol{UDP, TCP} {
		r := simulate(t, Options{Protocol: protocol, Messages: []Message{{Data: nil}, {Data: []byte("x")}}})
		if !r.Stats.Complete || string(received(r)) != "x" {
			t.Errorf("%s: complete=%v received %q", protocol, r.Stats.Complete, received(r))
		}
	}
}

func TestValidation(t *testing.T) {
	cases := []struct {
		opts Options
		err  error
	}{
		{Options{Protocol: "sctp"}, ErrProtocol},
		{Options{Protocol: UDP, Conditions: Conditions{DelayMs: -1}}, ErrBadValue},
		{Options{Protocol: UDP, Messages: []Message{{Data: make([]byte, MaxPayloadBytes+1)}}}, ErrTooLarge},
	}
	for _, c := range cases {
		if _, err := Simulate(c.opts); !errors.Is(err, c.err) {
			t.Errorf("Simulate(%+v) error = %v, want %v", c.opts.Protocol, err, c.err)
		}
	}
}

func TestTotalLossStops(t *testing.T) {
	r := simulate(t, Options{Protocol: TCP, Conditions: Conditions{DelayMs: 50, LossPct: 100}, Messages: text("x")})
	if r.Stats.Complete || r.Stats.HandshakeMs != 0 {
		t.Errorf("stats = %+v, want no connection", r.Stats)
	}
	if r.DurationMs > defaultMaxTime+10_000 {
		t.Errorf("DurationMs = %v, want the simulation to stop near the time limit", r.DurationMs)
	}
}

func TestRandomConditions(t *testing.T) {
	rng := newTestRand(99)
	for i := 0; i < 300; i++ {
		size := 1 + rng.Intn(30_000)
		data := make([]byte, size)
		rng.Read(data)
		opts := Options{
			Protocol: TCP,
			Conditions: Conditions{
				DelayMs:       rng.Float64() * 300,
				JitterMs:      rng.Float64() * 150,
				LossPct:       rng.Float64() * 40,
				BandwidthKbps: []float64{0, 256, 2000, 50_000}[rng.Intn(4)],
			},
			Messages: []Message{{Data: data}},
			MSS:      []int{0, 200, 1460}[rng.Intn(3)],
			Window:   1 + rng.Intn(10),
			Seed:     int64(i),
			// Bad links with much data need more than the default limit.
			MaxTimeMs: 10_000_000,
		}
		r := simulate(t, opts)
		if !r.Stats.Complete || !bytes.Equal(received(r), data) {
			t.Fatalf("case %d (%+v, %d bytes): TCP did not deliver the data", i, opts.Conditions, size)
		}
		opts.Protocol = UDP
		simulate(t, opts)
	}
}
