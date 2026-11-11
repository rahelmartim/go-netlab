# NetLab

[![CI](https://github.com/rahelmartim/go-netlab/actions/workflows/ci.yml/badge.svg)](https://github.com/rahelmartim/go-netlab/actions/workflows/ci.yml)
[![Live demo](https://img.shields.io/badge/live%20demo-GitHub%20Pages-000080)](https://rahelmartim.github.io/go-netlab/)
[![Go](https://img.shields.io/badge/go-1.24%2B-00ADD8?logo=go&logoColor=white)](https://go.dev)

A visual lab for UDP and TCP. You send text and images over a simulated network with delay, jitter, and packet loss, and you watch every packet. The simulator is written in Go and runs in your browser with WebAssembly.

Live demo: https://rahelmartim.github.io/go-netlab/

## Tabs

| Tab | What you see |
| --- | --- |
| UDP | A message split into datagrams. Datagrams arrive late, out of order, or not at all, and nothing repairs them. |
| TCP | The 3-way handshake, data segments, ACKs, retransmissions, and connection close. The text appears only in order. |
| UDP × TCP | The same message over both protocols, side by side, with a comparison table. |
| Text | A chat: each line is one message. Over UDP, messages get lost or change order. Over TCP, all of them arrive, in order. |
| Text + content | A caption and a 48 × 48 image. Over UDP, lost packets leave holes in the picture. Over TCP, the picture fills from top to bottom. |
| Delay · jitter · loss | 120 probes on a chart: the latency of each probe, the distribution, and the measured jitter and loss. |
| TCP flavors | Tahoe, Reno, NewReno, CUBIC, and BBR send the same file. A chart shows each congestion window over time, and a table compares time, goodput, retransmissions, queue drops, and latency. |
| Optimizations | One TCP optimization at a time: SACK, delayed ACK, Nagle, Nagle with delayed ACK, an initial window of 10, and Fast Open. Bars show what each one saves or costs. |
| Workbench | Every protocol setting, a packet diagram, the congestion window, and a packet capture table that you can download as CSV. |
| Send your own | Send any file up to 256 KB, or a text. Download what arrived, and compare the SHA-256 checksums. The file never leaves your browser. |
| Build a protocol | Combine a handshake, a reliability mode, a window, a timeout, ordering, and forward error correction. Then race your protocol against UDP and TCP. |

A control panel sets the network for every tab: delay, jitter, loss, and bandwidth. Under **More**, you can also set burst loss, duplication, a router queue, and a different delay for the return direction. Presets go from an office LAN to a 56k dial-up modem, and include a bottleneck router and bufferbloat. A seed makes each run repeatable.

The address bar always holds a link to the last run, with the tab, the network, the seed, and the inputs. The **Copy link** button copies it, so that another person sees exactly the same packets.

## How the simulator works

The `netsim` package runs in virtual time. It does not open sockets or wait, so one run takes milliseconds. With the same options and seed, it always gives the same packets.

The link adds a delay to each packet, plus a random jitter between `-jitter` and `+jitter`. It drops packets with the loss probability, either independently or in bursts with a Gilbert-Elliott model (a two-state model in which the link loses every packet in the "bad" state). It can also duplicate packets. With a bandwidth limit, each packet waits in the router queue until the link is free. When the queue is full, the router drops the packet (drop-tail). The measured latency includes the time in the queue, so a large queue shows bufferbloat.

UDP sends each datagram once, and the receiver gets what arrives.

TCP is simplified, but it has the main parts of real TCP:

- the 3-way handshake (SYN, SYN-ACK, ACK) and connection close (FIN, FIN-ACK, ACK)
- a sliding window of segments in flight, limited by the congestion window and the receive window
- cumulative ACKs, and a receive buffer for segments that arrive out of order
- a retransmission timeout that adapts to the round-trip time ([RFC 6298](https://www.rfc-editor.org/rfc/rfc6298)), with exponential backoff
- RTT measurement with echoed send times, as with the TCP timestamp option ([RFC 7323](https://www.rfc-editor.org/rfc/rfc7323))
- fast retransmit after a configurable number of duplicate ACKs

The congestion control flavors are simplified versions of these:

| Flavor | Behavior |
| --- | --- |
| Fixed | A fixed window, with no congestion control. |
| Tahoe | Slow start and congestion avoidance. After any loss, the window becomes 1 segment. |
| Reno ([RFC 5681](https://www.rfc-editor.org/rfc/rfc5681)) | Fast recovery halves the window. It leaves recovery on the first new ACK. |
| NewReno ([RFC 6582](https://www.rfc-editor.org/rfc/rfc6582)) | Stays in fast recovery until all the data that was in flight at the loss is acknowledged. |
| CUBIC ([RFC 9438](https://www.rfc-editor.org/rfc/rfc9438)) | Grows the window as a cubic function of the time since the last loss, and multiplies it by 0.7 on a loss. |
| BBR | Measures the bottleneck bandwidth and the shortest RTT, and paces the packets. It does not cut its window on loss. |

The optional TCP features are SACK ([RFC 2018](https://www.rfc-editor.org/rfc/rfc2018), with loss recovery as in [RFC 6675](https://www.rfc-editor.org/rfc/rfc6675)), delayed ACKs, the Nagle algorithm, a configurable initial window ([RFC 6928](https://www.rfc-editor.org/rfc/rfc6928)), and Fast Open ([RFC 7413](https://www.rfc-editor.org/rfc/rfc7413)).

The model does not include flow control from the free space in the receive buffer, the BBR ProbeRTT state, or the fast convergence of CUBIC.

The custom protocol numbers its packets and combines these parts:

- an optional HELLO handshake
- reliability: none, stop-and-wait, Go-Back-N, or selective repeat
- a window, and a fixed or adaptive timeout
- in-order delivery, or delivery on arrival
- forward error correction: one XOR parity packet per group of packets. The receiver rebuilds one lost packet per group.

Jitter is measured as in [RFC 3550](https://www.rfc-editor.org/rfc/rfc3550#appendix-A.8).

## Use the package

```go
result, err := netsim.Simulate(netsim.Options{
	Protocol:   netsim.TCP,
	Conditions: netsim.Conditions{DelayMs: 50, JitterMs: 20, LossPct: 10, BandwidthKbps: 1000},
	Messages:   []netsim.Message{{Data: []byte("hello, network")}},
	Seed:       42,
})
if err != nil {
	log.Fatal(err)
}
fmt.Println(result.Stats.Retransmissions, result.Stats.CompletedAtMs)
```

`Result.Packets` has every transmission, with its send time, arrival time, and whether it was lost. `Result.Deliveries` has the data that the receiving application got, and when. `Result.Window` has the congestion window over time.

Other options select the flavor and the optimizations, or the custom protocol:

```go
netsim.Options{
	Protocol: netsim.TCP,
	TCP:      netsim.TCPOptions{Flavor: "cubic", SACK: true, InitialWindow: 10},
	// ...
}

netsim.Options{
	Protocol: netsim.Custom,
	Custom:   netsim.CustomOptions{Reliability: "selective-repeat", Window: 8, Ordered: true, FECGroup: 4},
	// ...
}
```

## Original exercises

The `examples` folder has the UDP exercises that this repository started with, in 2019. They use real sockets on `localhost:10001`.

| Example | Description |
| --- | --- |
| `udp-client-sending` | A client sends numbered messages to a server. |
| `udp-server-resource` | A server answers client requests. |
| `udp-chat-simple` | A first UDP chat. |
| `udp-chat-v2` | A chat with nicknames. The server sends each message to the other clients. |

To run one, start the server and then one or more clients in other terminals:

```bash
go run ./examples/udp-chat-v2/server
go run ./examples/udp-chat-v2/client
```

## Getting started

You need Go 1.24 or later.

| Command | Description |
| --- | --- |
| `make test` | Runs `go vet` and the tests with the race detector. |
| `make web` | Builds the browser demo into `site/`. |
| `make serve` | Builds the browser demo and serves it on http://localhost:8080. It needs Python 3. To use another port, run `make serve PORT=8090`. |
| `make build` | Builds the original examples into `bin/`. |

## Project structure

```text
cmd/netlab-wasm/   # WebAssembly entry point: netlab.simulate(json) -> json
examples/          # Original UDP exercises with real sockets
netsim/            # Network simulator: link, UDP, TCP, congestion control, custom protocol, tests
web/               # Browser demo: HTML, CSS, and JavaScript modules
```

## Deployment

The `Deploy demo to GitHub Pages` workflow builds the demo and publishes it on every push to `master`. The demo is a static site, so it needs no server.

## License

This project uses the MIT license. Read the [LICENSE](LICENSE) file for the full text.
