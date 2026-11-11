package netsim

import (
	"math"
	"sort"
)

func isData(p Packet) bool { return p.Kind == "DATA" || p.Kind == "DGRAM" }

func (s *sim) finish() {
	st := &s.result.Stats
	st.PacketsSent = len(s.result.Packets)

	var latencies []float64
	transit := 0.0
	first := true
	maxSeen := -1
	for _, p := range s.arrivalOrder() {
		if !isData(p) || p.Duplicate {
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
			if p.Reason == "queue" {
				st.QueueDrops++
			}
		}
		if isData(p) && !p.Duplicate {
			st.DataPackets++
		}
		s.result.DurationMs = math.Max(s.result.DurationMs, p.ArriveAt)
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
	if !st.Complete {
		st.CompletedAtMs = 0
	} else if st.CompletedAtMs > 0 {
		st.GoodputKbps = float64(st.BytesTotal*8) / st.CompletedAtMs
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
