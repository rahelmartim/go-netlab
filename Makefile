SITE := site
PORT ?= 8080

.PHONY: test build web serve clean

## test: run the tests with the race detector
test:
	go vet ./...
	go test -race ./...

## build: build the original UDP examples into bin/, for example bin/udp-chat-v2-server
build:
	@for dir in examples/*/*/; do \
		name=$$(basename $$(dirname $$dir))-$$(basename $$dir); \
		go build -o bin/$$name ./$$dir && echo bin/$$name; \
	done

## web: build the browser demo into site/
web:
	rm -rf $(SITE) && mkdir -p $(SITE)
	cp web/* $(SITE)/
	cp "$$(go env GOROOT)/lib/wasm/wasm_exec.js" $(SITE)/
	GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o $(SITE)/netlab.wasm ./cmd/netlab-wasm

## serve: build the browser demo and serve it on http://localhost:$(PORT)
serve: web
	python3 -m http.server $(PORT) --directory $(SITE)

clean:
	rm -rf bin $(SITE)
