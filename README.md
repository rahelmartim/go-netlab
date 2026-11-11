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

A control panel sets the network for every tab: delay, jitter, loss, and bandwidth. Presets go from an office LAN to a 56k dial-up modem. A seed makes each run repeatable.

## How the simulator works

The `netsim` package runs in virtual time. It does not open sockets or wait, so one run takes milliseconds. With the same options and seed, it always gives the same packets.

The link adds a delay to each packet, plus a random jitter between `-jitter` and `+jitter`. It drops each packet with the loss probability. With a bandwidth limit, each packet waits in a queue until the link is free.

UDP sends each datagram once, and the receiver gets what arrives.

TCP is simplified, but it has the main parts of real TCP:

- the 3-way handshake (SYN, SYN-ACK, ACK) and connection close (FIN, FIN-ACK, ACK)
- a sliding window of segments in flight
- cumulative ACKs, and a receive buffer for segments that arrive out of order
- a retransmission timeout that adapts to the round-trip time ([RFC 6298](https://www.rfc-editor.org/rfc/rfc6298)), with exponential backoff
- RTT measurement with echoed send times, as with the TCP timestamp option ([RFC 7323](https://www.rfc-editor.org/rfc/rfc7323))
- fast retransmit after 3 duplicate ACKs

It does not model congestion control, selective ACKs, or flow control.

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

`Result.Packets` has every transmission, with its send time, arrival time, and whether it was lost. `Result.Deliveries` has the data that the receiving application got, and when.

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
netsim/            # Network simulator: link, UDP, TCP, statistics, tests
web/               # Browser demo: HTML, CSS, and JavaScript
```

## Deployment

The `Deploy demo to GitHub Pages` workflow builds the demo and publishes it on every push to `master`. The demo is a static site, so it needs no server.

## License

This project uses the MIT license. Read the [LICENSE](LICENSE) file for the full text.
