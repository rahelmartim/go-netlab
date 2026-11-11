//go:build js && wasm

// Command netlab-wasm runs the netsim package in the browser. It exposes
// one function to JavaScript:
//
//	netlab.simulate(optionsJSON) -> resultJSON
//
// The options and the result use the JSON form of netsim.Options and
// netsim.Result. Byte fields are base64 strings. On error, the result is
// {"error": "..."}.
package main

import (
	"encoding/json"
	"syscall/js"

	"github.com/rahelmartim/go-netlab/netsim"
)

// maxInputBytes limits the JSON input: the payload limit plus base64 overhead.
const maxInputBytes = netsim.MaxPayloadBytes*2 + 64*1024

func main() {
	api := js.Global().Get("Object").New()
	api.Set("simulate", js.FuncOf(func(_ js.Value, args []js.Value) any {
		return simulate(args[0].String())
	}))
	js.Global().Set("netlab", api)
	js.Global().Call("dispatchEvent", js.Global().Get("Event").New("netlab-ready"))
	select {}
}

func simulate(input string) string {
	if len(input) > maxInputBytes {
		return errorJSON(netsim.ErrTooLarge)
	}
	var opts netsim.Options
	if err := json.Unmarshal([]byte(input), &opts); err != nil {
		return errorJSON(err)
	}
	result, err := netsim.Simulate(opts)
	if err != nil {
		return errorJSON(err)
	}
	out, err := json.Marshal(result)
	if err != nil {
		return errorJSON(err)
	}
	return string(out)
}

func errorJSON(err error) string {
	out, _ := json.Marshal(map[string]string{"error": err.Error()})
	return string(out)
}
