package netsim

import (
	"bytes"
	"math"
	"testing"
)

var bottleneck = Conditions{DelayMs: 30, JitterMs: 2, BandwidthKbps: 4000, QueuePackets: 12}

func bulk(n int) []Message {
	data := make([]byte, n)
	for i := range data {
		data[i] = byte(i * 7)
	}
	return []Message{{Data: data}}
}

func average(t *testing.T, seeds int, opts Options, metric func(*Result) float64) float64 {
	t.Helper()
	sum := 0.0
	for seed := int64(1); seed <= int64(seeds); seed++ {
		opts.Seed = seed
		sum += metric(simulate(t, opts))
	}
	return sum / float64(seeds)
}

func completion(r *Result) float64 { return r.Stats.CompletedAtMs }

func TestFlavorsDeliverOverABottleneck(t *testing.T) {
	msgs := bulk(150_000)
	for _, flavor := range []string{"fixed", "tahoe", "reno", "newreno", "cubic", "bbr"} {
		r := simulate(t, Options{Protocol: TCP, Conditions: bottleneck, Messages: msgs, TCP: TCPOptions{Flavor: flavor}, Seed: 3})
		if !r.Stats.Complete || !bytes.Equal(received(r), msgs[0].Data) {
			t.Fatalf("%s: did not deliver the data", flavor)
		}
		if flavor != "fixed" && r.Stats.QueueDrops == 0 && flavor != "bbr" {
			t.Errorf("%s: no queue drops, want the window to fill the queue", flavor)
		}
		if len(r.Window) < 3 {
			t.Errorf("%s: %d window samples, want a history", flavor, len(r.Window))
		}
	}
}

func TestLossReactions(t *testing.T) {
	states := func(r *Result) map[string]bool {
		seen := map[string]bool{}
		for _, w := range r.Window {
			seen[w.State] = true
		}
		return seen
	}
	opts := Options{Protocol: TCP, Conditions: bottleneck, Messages: bulk(150_000), Seed: 3}

	opts.TCP.Flavor = "tahoe"
	tahoe := simulate(t, opts)
	if states(tahoe)["fast recovery"] {
		t.Error("tahoe: has fast recovery, want none")
	}
	droppedToOne := false
	for i := 1; i < len(tahoe.Window); i++ {
		if tahoe.Window[i].Cwnd == 1 && tahoe.Window[i-1].Cwnd > 4 {
			droppedToOne = true
		}
	}
	if !droppedToOne {
		t.Error("tahoe: the window never fell to 1 after a loss")
	}

	for _, flavor := range []string{"reno", "newreno", "cubic"} {
		opts.TCP.Flavor = flavor
		r := simulate(t, opts)
		seen := states(r)
		if !seen["fast recovery"] || !seen["slow start"] || !seen["congestion avoidance"] {
			t.Errorf("%s: states %v, want slow start, congestion avoidance and fast recovery", flavor, seen)
		}
	}

	opts.TCP.Flavor = "bbr"
	if seen := states(simulate(t, opts)); !seen["probe bandwidth"] {
		t.Errorf("bbr: states %v, want probe bandwidth", seen)
	}
}

func TestCubicReducesBy30Percent(t *testing.T) {
	c := newCongestion("cubic", 3)
	c.cwnd = 100
	c.onFastLoss(100, 3, true, 0)
	if math.Abs(c.cwnd-70) > 1e-9 || c.wMax != 100 {
		t.Errorf("cwnd = %v, wMax = %v; want 70 and 100", c.cwnd, c.wMax)
	}
}

func TestNewRenoBeatsRenoWithManyLosses(t *testing.T) {
	opts := Options{
		Protocol:   TCP,
		Conditions: Conditions{DelayMs: 40, BandwidthKbps: 8000, LossPct: 3, LossBurst: 3},
		Messages:   bulk(120_000),
	}
	opts.TCP.Flavor = "reno"
	reno := average(t, 15, opts, completion)
	opts.TCP.Flavor = "newreno"
	newreno := average(t, 15, opts, completion)
	if newreno >= reno {
		t.Errorf("NewReno %.0f ms, Reno %.0f ms; want NewReno faster with burst loss", newreno, reno)
	}
}

func TestSACKHelpsWithBurstLoss(t *testing.T) {
	opts := Options{
		Protocol:   TCP,
		Conditions: Conditions{DelayMs: 40, BandwidthKbps: 8000, LossPct: 4, LossBurst: 4},
		Messages:   bulk(120_000),
		TCP:        TCPOptions{Flavor: "newreno"},
	}
	plain := average(t, 15, opts, completion)
	opts.TCP.SACK = true
	sack := average(t, 15, opts, completion)
	if sack >= plain {
		t.Errorf("SACK %.0f ms, without SACK %.0f ms; want SACK faster", sack, plain)
	}
	r := simulate(t, opts)
	found := false
	for _, p := range r.Packets {
		if p.Kind == "ACK" && len(p.Sack) > 0 {
			found = true
		}
	}
	if !found {
		t.Error("no ACK carries SACK blocks")
	}
}

func countKind(r *Result, kind, from string) int {
	n := 0
	for _, p := range r.Packets {
		if p.Kind == kind && p.From == from {
			n++
		}
	}
	return n
}

func TestDelayedACKSendsFewerACKs(t *testing.T) {
	opts := Options{Protocol: TCP, Conditions: Conditions{DelayMs: 20, BandwidthKbps: 10000}, Messages: bulk(50_000), TCP: TCPOptions{Flavor: "newreno"}}
	normal := countKind(simulate(t, opts), "ACK", "server")
	opts.TCP.DelayedACK = true
	delayed := simulate(t, opts)
	if got := countKind(delayed, "ACK", "server"); got > normal*2/3 {
		t.Errorf("delayed ACKs: %d ACKs, without: %d; want about half", got, normal)
	}
	if !delayed.Stats.Complete {
		t.Error("delayed ACKs: transfer incomplete")
	}
}

func TestNagleCombinesSmallWrites(t *testing.T) {
	var msgs []Message
	// Keystrokes every 2 ms, after the handshake (60 ms).
	for i := 0; i < 50; i++ {
		msgs = append(msgs, Message{AtMs: 100 + float64(2*i), Data: []byte("key")})
	}
	opts := Options{Protocol: TCP, Conditions: Conditions{DelayMs: 30}, Messages: msgs, TCP: TCPOptions{Flavor: "newreno"}}
	plain := simulate(t, opts).Stats.DataPackets
	opts.TCP.Nagle = true
	nagle := simulate(t, opts)
	if nagle.Stats.DataPackets >= plain/2 || !nagle.Stats.Complete {
		t.Errorf("Nagle: %d data packets, without: %d; want far fewer", nagle.Stats.DataPackets, plain)
	}
}

func TestFastOpenSavesARoundTrip(t *testing.T) {
	opts := Options{Protocol: TCP, Conditions: Conditions{DelayMs: 50}, Messages: text("GET / HTTP/1.1"), TCP: TCPOptions{Flavor: "cubic"}}
	normal := simulate(t, opts)
	opts.TCP.FastOpen = true
	fast := simulate(t, opts)
	if fast.Packets[0].Len == 0 || !fast.Stats.Complete {
		t.Fatalf("the SYN carries %d bytes, want the request", fast.Packets[0].Len)
	}
	if saved := normal.Stats.CompletedAtMs - fast.Stats.CompletedAtMs; math.Abs(saved-100) > 1 {
		t.Errorf("Fast Open saved %.1f ms, want one round trip (100 ms)", saved)
	}
}

func TestInitialWindow(t *testing.T) {
	opts := Options{Protocol: TCP, Conditions: Conditions{DelayMs: 50}, Messages: bulk(14_000), MSS: 1400, TCP: TCPOptions{Flavor: "newreno", InitialWindow: 3}}
	small := simulate(t, opts).Stats.CompletedAtMs
	opts.TCP.InitialWindow = 10
	large := simulate(t, opts).Stats.CompletedAtMs
	if large >= small-90 {
		t.Errorf("IW10 %.0f ms, IW3 %.0f ms; want at least one round trip saved", large, small)
	}
}

func TestQueueDropsAndBurstLoss(t *testing.T) {
	r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{BandwidthKbps: 1000, QueuePackets: 5}, Messages: bulk(20_000)})
	if r.Stats.QueueDrops == 0 || r.Stats.QueueDrops != r.Stats.PacketsLost {
		t.Errorf("stats %+v, want only queue drops", r.Stats)
	}

	runs := func(burst float64) (loss, length float64) {
		var probes []Message
		for i := 0; i < 5000; i++ {
			probes = append(probes, Message{AtMs: float64(i), Data: []byte("p")})
		}
		r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{LossPct: 10, LossBurst: burst}, Messages: probes, Seed: 11})
		lost, bursts := 0, 0
		for i, p := range r.Packets {
			if p.Lost {
				lost++
				if i == 0 || !r.Packets[i-1].Lost {
					bursts++
				}
			}
		}
		return float64(lost) / float64(len(r.Packets)) * 100, float64(lost) / float64(bursts)
	}
	loss, length := runs(5)
	if loss < 7 || loss > 13 || length < 3.5 {
		t.Errorf("burst 5: loss %.1f%%, average burst %.1f; want about 10%% and 5", loss, length)
	}
	if _, length := runs(0); length > 1.3 {
		t.Errorf("independent loss: average burst %.1f, want about 1", length)
	}
}

func TestDuplicatesAndReverseLink(t *testing.T) {
	r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{DuplicatePct: 50}, Messages: bulk(5000), Seed: 2})
	if r.Stats.Duplicates == 0 || !r.Stats.Complete || r.Stats.BytesDelivered != 5000 {
		t.Errorf("stats %+v, want duplicates and each byte once", r.Stats)
	}

	slowBack := Conditions{DelayMs: 100}
	tcp := simulate(t, Options{Protocol: TCP, Conditions: Conditions{DelayMs: 10}, Reverse: &slowBack, Messages: text("x")})
	if tcp.Stats.HandshakeMs != 110 {
		t.Errorf("handshake %.0f ms, want 10 + 100", tcp.Stats.HandshakeMs)
	}
}

func TestCustomReliabilityModes(t *testing.T) {
	msgs := bulk(30_000)
	lossy := Conditions{DelayMs: 20, JitterMs: 10, LossPct: 15, BandwidthKbps: 20000}
	for _, mode := range []string{"stop-and-wait", "go-back-n", "selective-repeat"} {
		for _, ordered := range []bool{false, true} {
			r := simulate(t, Options{Protocol: Custom, Conditions: lossy, Messages: msgs, Seed: 4,
				Custom: CustomOptions{Reliability: mode, Ordered: ordered, Handshake: true}})
			if !r.Stats.Complete || !bytes.Equal(received(r), msgs[0].Data) {
				t.Fatalf("%s ordered=%v: incomplete", mode, ordered)
			}
			if ordered || mode == "go-back-n" {
				next := 0
				for _, d := range r.Deliveries {
					if d.Offset != next {
						t.Fatalf("%s ordered=%v: delivery at %d, want %d", mode, ordered, d.Offset, next)
					}
					next += len(d.Data)
				}
			}
		}
	}

	opts := Options{Protocol: Custom, Conditions: lossy, Messages: msgs, Custom: CustomOptions{Reliability: "go-back-n"}}
	gbn := average(t, 10, opts, func(r *Result) float64 { return float64(r.Stats.Retransmissions) })
	opts.Custom.Reliability = "selective-repeat"
	sr := average(t, 10, opts, func(r *Result) float64 { return float64(r.Stats.Retransmissions) })
	if gbn <= sr {
		t.Errorf("go-back-n %.0f retransmissions, selective repeat %.0f; want go-back-n higher", gbn, sr)
	}
}

func TestCustomFEC(t *testing.T) {
	msgs := bulk(30_000)
	opts := Options{Protocol: Custom, Conditions: Conditions{DelayMs: 20, LossPct: 5}, Messages: msgs, Custom: CustomOptions{Reliability: "none"}}
	plain := average(t, 10, opts, func(r *Result) float64 { return float64(r.Stats.BytesDelivered) })
	opts.Custom.FECGroup = 4
	fec := average(t, 10, opts, func(r *Result) float64 { return float64(r.Stats.BytesDelivered) })
	if fec <= plain {
		t.Errorf("FEC delivered %.0f bytes, without %.0f; want more", fec, plain)
	}
	opts.Seed = 1
	r := simulate(t, opts)
	if r.Stats.FECRecovered == 0 {
		t.Fatal("no packet was rebuilt")
	}
	// Rebuilt data must equal the original bytes.
	got := received(r)
	for _, d := range r.Deliveries {
		if !bytes.Equal(got[d.Offset:d.Offset+len(d.Data)], msgs[0].Data[d.Offset:d.Offset+len(d.Data)]) {
			t.Fatalf("delivery at %d differs from the original", d.Offset)
		}
	}
	retransmissions := func(r *Result) float64 { return float64(r.Stats.Retransmissions) }
	opts.Custom.Reliability = "selective-repeat"
	withFEC := average(t, 20, opts, retransmissions)
	opts.Custom.FECGroup = 0
	withoutFEC := average(t, 20, opts, retransmissions)
	if withFEC >= withoutFEC {
		t.Errorf("selective repeat with FEC: %.1f retransmissions, without: %.1f; want fewer", withFEC, withoutFEC)
	}
}

func TestRandomEverything(t *testing.T) {
	rng := newTestRand(2024)
	flavorList := []string{"fixed", "tahoe", "reno", "newreno", "cubic", "bbr"}
	modes := []string{"stop-and-wait", "go-back-n", "selective-repeat"}
	for i := 0; i < 250; i++ {
		data := make([]byte, 1+rng.Intn(40_000))
		rng.Read(data)
		cond := Conditions{
			DelayMs:       rng.Float64() * 150,
			JitterMs:      rng.Float64() * 60,
			LossPct:       rng.Float64() * 25,
			LossBurst:     []float64{0, 2, 6}[rng.Intn(3)],
			DuplicatePct:  []float64{0, 5}[rng.Intn(2)],
			BandwidthKbps: []float64{0, 500, 5000}[rng.Intn(3)],
			QueuePackets:  []int{0, 8, 40}[rng.Intn(3)],
		}
		opts := Options{
			Protocol: TCP, Conditions: cond, Messages: []Message{{Data: data}}, Seed: int64(i),
			MSS: []int{0, 300, 1400}[rng.Intn(3)], MaxTimeMs: 50_000_000,
			TCP: TCPOptions{
				Flavor: flavorList[rng.Intn(len(flavorList))], SACK: rng.Intn(2) == 0,
				DelayedACK: rng.Intn(2) == 0, Nagle: rng.Intn(2) == 0, FastOpen: rng.Intn(2) == 0,
				InitialWindow: []int{0, 1, 10}[rng.Intn(3)],
			},
		}
		r := simulate(t, opts)
		if !r.Stats.Complete || !bytes.Equal(received(r), data) {
			t.Fatalf("case %d TCP %+v %+v: incomplete", i, cond, opts.TCP)
		}
		opts.Protocol = Custom
		opts.Custom = CustomOptions{
			Reliability: modes[rng.Intn(len(modes))], Ordered: rng.Intn(2) == 0, Handshake: rng.Intn(2) == 0,
			FECGroup: []int{0, 3, 8}[rng.Intn(3)], Window: 1 + rng.Intn(16),
		}
		r = simulate(t, opts)
		if !r.Stats.Complete || !bytes.Equal(received(r), data) {
			t.Fatalf("case %d custom %+v %+v: incomplete", i, cond, opts.Custom)
		}
	}
}

func TestLatencyIncludesQueueing(t *testing.T) {
	// 20 packets of 540 bytes at 1000 kbps: the last one waits about 82 ms.
	r := simulate(t, Options{Protocol: UDP, Conditions: Conditions{DelayMs: 10, BandwidthKbps: 1000}, Messages: bulk(10_240)})
	last := r.Packets[len(r.Packets)-1]
	if latency := last.ArriveAt - last.SentAt; latency < 90 {
		t.Errorf("latency of the last packet = %.1f ms, want the queueing time included", latency)
	}
}

func TestBBRKeepsQueuesShorter(t *testing.T) {
	deepQueue := Conditions{DelayMs: 30, BandwidthKbps: 4000, QueuePackets: 200}
	opts := Options{Protocol: TCP, Conditions: deepQueue, Messages: bulk(250_000)}
	latency := func(r *Result) float64 { return r.Stats.AvgLatencyMs }
	opts.TCP.Flavor = "cubic"
	cubic := average(t, 5, opts, latency)
	opts.TCP.Flavor = "bbr"
	bbr := average(t, 5, opts, latency)
	if bbr >= cubic {
		t.Errorf("average latency: BBR %.0f ms, CUBIC %.0f ms; want BBR lower with a deep queue", bbr, cubic)
	}
}
