package netsim

import "math"

// congestion is the TCP congestion control. Windows are in segments.
//
// The flavors are simplified versions of:
//
//   - Tahoe: slow start, congestion avoidance, and a window of 1 after
//     every loss.
//   - Reno (RFC 5681): fast recovery that halves the window. It leaves
//     recovery on the first new ACK.
//   - NewReno (RFC 6582): stays in fast recovery until every segment that
//     was in flight at the loss is acknowledged.
//   - CUBIC (RFC 9438): grows the window as a cubic function of the time
//     since the last loss, and multiplies it by 0.7 on a loss.
//   - BBR: measures the bottleneck bandwidth and the minimum RTT, paces
//     the packets at that rate, and does not react to loss.
type congestion struct {
	flavor   string
	cwnd     float64
	ssthresh float64

	// CUBIC
	wMax       float64
	k          float64
	origin     float64
	epochStart float64
	epochValid bool
	renoWindow float64

	// BBR
	bbrState    string
	btlBw       float64 // bytes per ms
	rtProp      float64 // ms
	samples     []rateSample
	fullBw      float64
	fullBwCount int
	roundEnd    int
	cycleIndex  int
	cycleStart  float64
	inflight    int
	mss         int
}

type rateSample struct {
	t, bw float64
}

const (
	cubicC      = 0.4 // segments per second³
	cubicBeta   = 0.7
	bbrHighGain = 2.885
	maxCwnd     = 10000
)

var bbrCycle = []float64{1.25, 0.75, 1, 1, 1, 1, 1, 1}

func newCongestion(flavor string, initialWindow int) congestion {
	return congestion{
		flavor:   flavor,
		cwnd:     float64(initialWindow),
		ssthresh: math.Inf(1),
		bbrState: "startup",
		rtProp:   math.Inf(1),
	}
}

func (c *congestion) window() float64 {
	if c.flavor == "bbr" {
		return c.bbrWindow()
	}
	return c.cwnd
}

func (c *congestion) ssthreshValue() float64 {
	if math.IsInf(c.ssthresh, 1) || c.flavor == "fixed" || c.flavor == "bbr" {
		return -1
	}
	return c.ssthresh
}

func (c *congestion) stateName(inRecovery bool) string {
	switch {
	case c.flavor == "fixed":
		return "fixed window"
	case c.flavor == "bbr":
		return c.bbrState
	case inRecovery && c.flavor != "tahoe":
		return "fast recovery"
	case c.cwnd < c.ssthresh:
		return "slow start"
	default:
		return "congestion avoidance"
	}
}

// onAck grows the window for newly acknowledged segments.
func (c *congestion) onAck(segments, rtt, now float64) {
	switch c.flavor {
	case "tahoe", "reno", "newreno":
		if c.cwnd < c.ssthresh {
			c.cwnd += segments // slow start
		} else {
			c.cwnd += segments / c.cwnd // about 1 segment per RTT
		}
	case "cubic":
		if c.cwnd < c.ssthresh {
			c.cwnd += segments
		} else {
			c.cubicGrow(segments, rtt, now)
		}
	}
	c.cwnd = math.Min(c.cwnd, maxCwnd)
}

func (c *congestion) cubicGrow(segments, rtt, now float64) {
	if !c.epochValid {
		c.epochValid = true
		c.epochStart = now
		if c.cwnd < c.wMax {
			c.k = math.Cbrt((c.wMax - c.cwnd) / cubicC)
			c.origin = c.wMax
		} else {
			c.k, c.origin = 0, c.cwnd
		}
		c.renoWindow = c.cwnd
	}
	seconds := (now - c.epochStart + rtt) / 1000
	target := cubicC*math.Pow(seconds-c.k, 3) + c.origin
	// The TCP-friendly region: never grow slower than Reno would.
	c.renoWindow += 3 * (1 - cubicBeta) / (1 + cubicBeta) * segments / c.cwnd
	target = math.Max(target, c.renoWindow)
	if target > c.cwnd {
		c.cwnd += (target - c.cwnd) / c.cwnd * segments
	} else {
		c.cwnd += 0.01 * segments / c.cwnd
	}
}

// onFastLoss reacts to duplicate ACKs.
func (c *congestion) onFastLoss(flight float64, dupThreshold int, sack bool, now float64) {
	inflate := float64(dupThreshold)
	if sack {
		inflate = 0 // SACK counts the data in flight instead (RFC 6675).
	}
	switch c.flavor {
	case "tahoe":
		c.ssthresh = math.Max(flight/2, 2)
		c.cwnd = 1
	case "reno", "newreno":
		c.ssthresh = math.Max(flight/2, 2)
		c.cwnd = c.ssthresh + inflate
	case "cubic":
		c.cubicReduce()
		c.cwnd = c.ssthresh + inflate
	}
}

func (c *congestion) cubicReduce() {
	c.wMax = c.cwnd
	c.ssthresh = math.Max(c.cwnd*cubicBeta, 2)
	c.cwnd = c.ssthresh
	c.epochValid = false
}

func (c *congestion) onDupAckInRecovery() {
	switch c.flavor {
	case "reno", "newreno", "cubic":
		c.cwnd++ // Each duplicate ACK means one segment left the network.
	}
}

func (c *congestion) onPartialAck(segments float64) {
	switch c.flavor {
	case "newreno", "cubic":
		c.cwnd = math.Max(c.cwnd-segments+1, c.ssthresh)
	case "tahoe":
		c.cwnd += segments // Tahoe keeps its slow start.
	}
}

func (c *congestion) onRecoveryExit() {
	switch c.flavor {
	case "reno", "newreno", "cubic":
		c.cwnd = c.ssthresh
	}
}

func (c *congestion) onTimeout(flight, now float64) {
	switch c.flavor {
	case "tahoe", "reno", "newreno":
		c.ssthresh = math.Max(flight/2, 2)
		c.cwnd = 1
	case "cubic":
		c.cubicReduce()
		c.cwnd = 1
	}
}

/* BBR */

func (c *congestion) pacingRate() float64 {
	if c.flavor != "bbr" || c.btlBw <= 0 {
		return 0
	}
	return c.pacingGain() * c.btlBw
}

func (c *congestion) pacingGain() float64 {
	switch c.bbrState {
	case "startup":
		return bbrHighGain
	case "drain":
		return 1 / bbrHighGain
	default:
		return bbrCycle[c.cycleIndex]
	}
}

func (c *congestion) bdp() float64 {
	if c.btlBw <= 0 || math.IsInf(c.rtProp, 1) || c.mss == 0 {
		return 0
	}
	return c.btlBw * c.rtProp / float64(c.mss)
}

func (c *congestion) bbrWindow() float64 {
	bdp := c.bdp()
	if bdp == 0 {
		return c.cwnd
	}
	gain := 2.0
	if c.bbrState == "startup" || c.bbrState == "drain" {
		gain = bbrHighGain
	}
	return math.Min(math.Max(gain*bdp, 4), maxCwnd)
}

// onRateSample updates the BBR model after a new ACK.
func (c *congestion) onRateSample(rate, rtt, now float64, ack, sndNxt, pipe, mss int) {
	if c.flavor != "bbr" {
		return
	}
	c.mss = mss
	c.inflight = pipe
	if rtt > 0 {
		c.rtProp = math.Min(c.rtProp, rtt)
	}
	window := 10 * c.rtProp
	if math.IsInf(window, 1) {
		window = 1000
	}
	if rate > 0 {
		c.samples = append(c.samples, rateSample{now, rate})
	}
	kept := c.samples[:0]
	c.btlBw = 0
	for _, s := range c.samples {
		if now-s.t <= window {
			kept = append(kept, s)
			c.btlBw = math.Max(c.btlBw, s.bw)
		}
	}
	c.samples = kept

	roundDone := ack >= c.roundEnd
	if roundDone {
		c.roundEnd = sndNxt
	}
	switch c.bbrState {
	case "startup":
		if roundDone {
			// The pipe is full when the bandwidth stops growing by 25% for
			// 3 rounds.
			if c.btlBw >= c.fullBw*1.25 {
				c.fullBw, c.fullBwCount = c.btlBw, 0
			} else {
				c.fullBwCount++
			}
			if c.fullBwCount >= 3 {
				c.bbrState = "drain"
			}
		}
	case "drain":
		if float64(pipe)/float64(mss) <= c.bdp() {
			c.bbrState = "probe bandwidth"
			c.cycleIndex, c.cycleStart = 2, now
		}
	case "probe bandwidth":
		if now-c.cycleStart > c.rtProp {
			c.cycleIndex = (c.cycleIndex + 1) % len(bbrCycle)
			c.cycleStart = now
		}
	}
}
