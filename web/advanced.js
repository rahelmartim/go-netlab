/* NetLab version 2 tabs: TCP flavors, optimizations, workbench, send your
   own file, and build a protocol. */

import {
  $,
  Ladder,
  conditions,
  dataStats,
  describe,
  el,
  encoder,
  lineChart,
  ms,
  nextSeed,
  packetStates,
  pattern,
  pct,
  playerFor,
  rebuild,
  renderStats,
  renderText,
  setStatus,
  setupCanvas,
  simulate,
  usePreset,
} from "./core.js";

const kbps = (value) => (value >= 1000 ? `${(value / 1000).toFixed(2)} Mbps` : `${Math.round(value)} kbps`);

// markBest adds the "win" class to the best cell of each column.
function markBest(rows, columns) {
  columns.forEach(({ index, better }) => {
    const values = rows.map((row) => row.values[index]);
    const valid = values.filter((v) => Number.isFinite(v));
    // No star when every value is the same: nobody wins.
    if (valid.length < 2 || valid.every((v) => v === valid[0])) return;
    const best = better === "high" ? Math.max(...valid) : Math.min(...valid);
    rows.forEach((row) => {
      if (row.values[index] === best) row.cells[index].classList.add("win");
    });
  });
}

function table(target, headers, rows) {
  target.replaceChildren();
  const head = el("thead");
  const headRow = el("tr");
  for (const h of headers) headRow.append(el("th", "", h));
  head.append(headRow);
  const body = el("tbody");
  for (const row of rows) body.append(row.element);
  target.append(head, body);
}

/* TCP flavors */

const FLAVORS = [
  { key: "tahoe", name: "Tahoe", color: "#ff66cc", note: "1988. After any loss, the window falls to 1 segment and slow start begins again." },
  { key: "reno", name: "Reno", color: "#ffcc33", note: "1990. Fast recovery halves the window instead. It struggles when one window loses several segments." },
  { key: "newreno", name: "NewReno", color: "#b6ff3b", note: "1999. Stays in fast recovery until all lost segments of the window are repaired." },
  { key: "cubic", name: "CUBIC", color: "#33d6ff", note: "2008. Grows the window as a cubic curve of the time since the last loss. The Linux default." },
  { key: "bbr", name: "BBR", color: "#ff9933", note: "2016. Measures the bottleneck bandwidth and the shortest RTT, and paces packets. Loss does not cut its window." },
  { key: "fixed", name: "Fixed window", color: "#9fb6e8", note: "No congestion control: always 4 segments in flight." },
];

export function setupFlavors() {
  const list = $("#flavors-list");
  const notes = $("#flavors-notes");
  for (const f of FLAVORS) {
    const label = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.value = f.key;
    box.checked = f.key !== "fixed";
    label.append(box, document.createTextNode(` ${f.name}`));
    list.append(label);

    const card = el("div", "card");
    const title = el("b");
    const swatch = el("i", "swatch");
    swatch.style.background = f.color;
    title.append(swatch, document.createTextNode(f.name));
    card.append(title, document.createTextNode(f.note));
    notes.append(card);
  }
  $("#flavors-preset").addEventListener("click", () => {
    usePreset("bottleneck");
    updateFlavorsHint();
  });
  updateFlavorsHint();
}

function updateFlavorsHint() {
  const c = conditions();
  $("#flavors-hint").textContent =
    c.queuePackets > 0 && c.bandwidthKbps < 100000
      ? `The router queue holds ${c.queuePackets} packets in front of a ${kbps(c.bandwidthKbps)} link.`
      : "Tip: congestion control reacts to a full router queue. Press “Use the bottleneck network”, or set a router queue under More ▾.";
}

export function runFlavors() {
  updateFlavorsHint();
  const size = Number($("#flavors-size").value);
  const chosen = FLAVORS.filter((f) => $(`#flavors-list input[value="${f.key}"]`).checked);
  if (chosen.length === 0) return;
  const data = pattern(size);
  const seed = nextSeed();
  const sack = $("#flavors-sack").checked;
  const runs = chosen.map((f) => ({
    flavor: f,
    result: simulate("tcp", [{ data }], { seed, tcp: { flavor: f.key, sack }, maxTimeMs: 600000 }),
  }));

  const xMax = Math.max(...runs.map((r) => r.result.stats.completedAtMs || r.result.durationMs));
  const yMax = Math.max(...runs.flatMap((r) => r.result.window.map((w) => w.cwnd)));
  const series = runs.map(({ flavor, result }) => ({
    color: flavor.color,
    points: result.window.map((w) => ({ x: w.t, y: w.cwnd })),
    end: result.stats.completedAtMs || result.durationMs,
  }));
  const legend = $("#flavors-legend");
  legend.replaceChildren();
  for (const { flavor } of runs) {
    const item = el("span");
    const key = el("i", "key");
    key.style.background = flavor.color;
    item.append(key, document.createTextNode(flavor.name));
    legend.append(item);
  }

  $("#flavors-table").replaceChildren();
  playerFor("flavors").play(
    xMax,
    (t) => lineChart($("#flavors-chart"), series, { xMax, yMax, t }),
    () => {
      const rows = runs.map(({ flavor, result }) => {
        const s = result.stats;
        const values = [
          s.complete ? s.completedAtMs : NaN,
          s.goodputKbps || NaN,
          s.retransmissions,
          s.queueDrops,
          s.avgLatencyMs,
          Math.max(...result.window.map((w) => w.cwnd)),
        ];
        const texts = [
          s.complete ? ms(s.completedAtMs) : "incomplete",
          s.goodputKbps ? kbps(s.goodputKbps) : "—",
          String(s.retransmissions),
          String(s.queueDrops),
          ms(s.avgLatencyMs),
          values[5].toFixed(1),
        ];
        const element = el("tr");
        element.append(el("th", "", flavor.name));
        const cells = texts.map((text) => element.appendChild(el("td", "", text)));
        return { element, values, cells };
      });
      markBest(rows, [
        { index: 0, better: "low" },
        { index: 1, better: "high" },
        { index: 2, better: "low" },
        { index: 3, better: "low" },
        { index: 4, better: "low" },
      ]);
      table($("#flavors-table"), ["Flavor", "Time", "Goodput", "Retransmissions", "Queue drops", "Avg latency", "Largest cwnd"], rows);
      const best = rows.reduce((a, b) => ((b.values[0] || Infinity) < (a.values[0] || Infinity) ? b : a));
      setStatus(`Flavors done. Fastest: ${best.element.firstChild.textContent}.`);
    },
  );
}

/* Optimizations */

const SCENARIOS = {
  request: () => [{ data: pattern(2000) }],
  page: () => [{ data: pattern(100_000) }],
  // A fast typist: one key every 15 ms.
  typing: () => Array.from({ length: 60 }, (_, i) => ({ atMs: i * 15, data: encoder.encode("k") })),
  download: () => [{ data: pattern(250_000) }],
};

const VARIANTS = [
  { name: "Baseline", tcp: {} },
  { name: "+ SACK", tcp: { sack: true } },
  { name: "+ Delayed ACK", tcp: { delayedAck: true } },
  { name: "+ Nagle", tcp: { nagle: true } },
  { name: "+ Nagle and delayed ACK", tcp: { nagle: true, delayedAck: true } },
  { name: "+ Initial window 10", tcp: { initialWindow: 10 } },
  { name: "+ Fast Open", tcp: { fastOpen: true } },
  { name: "All the good ones", tcp: { sack: true, initialWindow: 10, fastOpen: true } },
];

const OPTIMIZATION_NOTES = [
  ["SACK", "Selective ACKs tell the sender which blocks arrived, so it resends only the holes."],
  ["Delayed ACK", "The receiver acknowledges every second segment, or after 40 ms. Fewer ACKs, but the sender waits more."],
  ["Nagle", "The sender holds small segments while data is in flight, and sends them together. Fewer packets for typing."],
  ["Nagle + delayed ACK", "A classic trap: Nagle waits for an ACK, and the receiver delays it. Each small write can wait 40 ms."],
  ["Initial window 10", "RFC 6928: start with 10 segments instead of 3. Small pages finish in fewer round trips."],
  ["Fast Open", "RFC 7413: the first data travels with the SYN, which saves one round trip. It needs a cookie from an earlier visit."],
];

export function setupOptimizations() {
  const notes = $("#optim-notes");
  for (const [name, text] of OPTIMIZATION_NOTES) {
    const card = el("div", "card");
    card.append(el("b", "", name), document.createTextNode(text));
    notes.append(card);
  }
}

export function runOptimizations() {
  const scenario = SCENARIOS[$("#optim-scenario").value];
  const flavor = $("#optim-flavor").value;
  const seed = nextSeed();
  const SEEDS = 5;
  const results = VARIANTS.map((variant) => {
    let time = 0;
    let packets = 0;
    let complete = true;
    for (let i = 0; i < SEEDS; i++) {
      const r = simulate("tcp", scenario(), { seed: seed + i, tcp: { flavor, ...variant.tcp }, maxTimeMs: 600000 });
      complete &&= r.stats.complete;
      time += r.stats.completedAtMs;
      packets += r.stats.packetsSent;
    }
    return { variant, time: time / SEEDS, packets: packets / SEEDS, complete };
  });

  const baseline = results[0].time;
  const longest = Math.max(...results.map((r) => r.time), 1);
  const bars = $("#optim-bars");
  bars.replaceChildren();
  for (const r of results) {
    const row = el("div", "bar-row");
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    const change = baseline ? (r.time - baseline) / baseline : 0;
    if (r.variant.name !== "Baseline") {
      if (change < -0.03) fill.classList.add("better");
      if (change > 0.03) fill.classList.add("worse");
    }
    track.append(fill);
    const value = el("span", "bar-value", r.complete ? ms(r.time) : "incomplete");
    if (r.variant.name !== "Baseline" && r.complete) {
      const delta = el("span", `delta ${change < -0.03 ? "better" : change > 0.03 ? "worse" : ""}`,
        ` ${change > 0 ? "+" : ""}${Math.round(change * 100)}%`);
      value.append(delta);
    }
    value.title = `${Math.round(r.packets)} packets on average`;
    row.append(el("span", "bar-label", r.variant.name), track, value);
    bars.append(row);
    requestAnimationFrame(() => {
      fill.style.width = `${(100 * r.time) / longest}%`;
    });
  }
  setStatus(`Optimizations: each bar is the average of ${SEEDS} runs, seeds ${seed} to ${seed + SEEDS - 1}.`);
}

/* Workbench */

const benchLadder = new Ladder($("#bench-ladder"));
let lastCapture = null;

function benchOptions() {
  const num = (id) => Number($(id).value);
  return {
    mss: Math.min(Math.max(num("#bench-mss"), 8), 9000),
    window: num("#bench-window"),
    tcp: {
      flavor: $("#bench-flavor").value,
      initialWindow: num("#bench-iw"),
      dupAckThreshold: num("#bench-dupthresh"),
      minRtoMs: num("#bench-minrto"),
      maxRtoMs: num("#bench-maxrto"),
      initialRtoMs: num("#bench-initrto"),
      sack: $("#bench-sack").checked,
      delayedAck: $("#bench-delack").checked,
      nagle: $("#bench-nagle").checked,
      fastOpen: $("#bench-tfo").checked,
    },
  };
}

const HOSTS = { client: "10.0.0.2:51515", server: "93.184.0.80:80" };

function captureInfo(p, protocol) {
  if (protocol === "udp") return `Len=${p.len} "${p.preview}"`;
  const flags = { SYN: "[SYN]", "SYN-ACK": "[SYN, ACK]", ACK: "[ACK]", DATA: "[PSH, ACK]", FIN: "[FIN, ACK]", "FIN-ACK": "[FIN, ACK]" }[p.kind] ?? `[${p.kind}]`;
  const parts = [flags];
  if (p.kind === "DATA" || (p.kind === "SYN" && p.len)) parts.push(`Seq=${p.seq} Len=${p.len}`);
  if (p.from === "server" && p.ack) parts.push(`Ack=${p.ack}`);
  if (p.sack?.length) parts.push(`SACK=${p.sack.map(([a, b]) => `${a}-${b}`).join(",")}`);
  if (p.retransmit) parts.push("[TCP Retransmission]");
  if (p.duplicate) parts.push("[Duplicate]");
  if (p.lost) parts.push(p.reason === "queue" ? "LOST: router queue full" : "LOST on the link");
  return parts.join(" ");
}

function captureClass(p) {
  if (p.lost) return "k-lost";
  if (p.retransmit) return "k-retx";
  if (p.kind === "DGRAM") return "k-dgram";
  if (p.kind === "PARITY") return "k-parity";
  if (p.kind === "ACK") return "k-ack";
  if (p.kind === "DATA") return "k-data";
  return "k-ctrl";
}

function renderCapture(result) {
  const body = $("#bench-capture tbody");
  body.replaceChildren();
  const protocol = result.protocol === "udp" ? "UDP" : "TCP";
  const rows = [];
  result.packets.slice(0, 3000).forEach((p, i) => {
    const header = result.protocol === "udp" ? 28 : 40;
    const cells = [
      String(i + 1),
      (p.sentAt / 1000).toFixed(6),
      HOSTS[p.from],
      HOSTS[p.from === "client" ? "server" : "client"],
      protocol,
      String(p.len + header),
      captureInfo(p, result.protocol),
    ];
    rows.push(cells);
    const row = el("tr", captureClass(p));
    for (const cell of cells) row.append(el("td", "", cell));
    row.title = describe(p);
    body.append(row);
  });
  lastCapture = rows;
  $("#bench-csv").disabled = false;
}

export function setupBench() {
  $("#bench-text").value = "Hello from the workbench! ";
  const update = () => {
    for (const node of document.querySelectorAll("#panel-bench .tcp-only")) {
      node.hidden = $("#bench-protocol").value !== "tcp";
    }
  };
  $("#bench-protocol").addEventListener("change", update);
  update();
  $("#bench-form").addEventListener("submit", (event) => event.preventDefault());
  $("#bench-csv").addEventListener("click", () => {
    if (!lastCapture) return;
    const header = ["No.", "Time", "Source", "Destination", "Protocol", "Length", "Info"];
    const csv = [header, ...lastCapture]
      .map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    download(new Blob([csv], { type: "text/csv" }), "netlab-capture.csv");
  });
}

export function runBench() {
  const protocol = $("#bench-protocol").value;
  const text = $("#bench-text").value || " ";
  const repeat = Number($("#bench-repeat").value);
  const data = encoder.encode(text.repeat(repeat).slice(0, 256 * 1024));
  const result = simulate(protocol, [{ data }], { seed: nextSeed(), maxTimeMs: 600000, ...benchOptions() });

  benchLadder.load(result);
  renderCapture(result);
  const s = result.stats;
  renderStats($("#bench-stats"), [
    ...dataStats(result),
    ["Queue drops", String(s.queueDrops)],
    ["Duplicates", String(s.duplicates)],
    ["Bytes on the wire", String(s.wireBytes)],
    ["Goodput", s.goodputKbps ? kbps(s.goodputKbps) : "—"],
  ]);

  const series = [
    { color: "#b6ff3b", points: result.window.map((w) => ({ x: w.t, y: w.cwnd })) },
    { color: "#ffcc33", dash: [5, 4], width: 1.5, points: result.window.filter((w) => w.ssthresh > 0).map((w) => ({ x: w.t, y: w.ssthresh })) },
    { color: "#33d6ff", width: 1, points: result.window.map((w) => ({ x: w.t, y: w.inflight })) },
  ];
  const yMax = Math.max(1, ...result.window.map((w) => Math.max(w.cwnd, w.inflight)));
  const duration = result.durationMs;
  // Very large captures are drawn once, without animation.
  const animate = result.packets.length <= 1500;
  const draw = (t) => {
    benchLadder.frame(t);
    if (protocol === "tcp") lineChart($("#bench-chart"), series, { xMax: duration, yMax, t });
  };
  if (animate) {
    playerFor("bench").play(duration, draw, () => setStatus(`Workbench: ${result.packets.length} packets. Green: cwnd, yellow: ssthresh, blue: in flight.`));
  } else {
    draw(duration);
    setStatus(`Workbench: ${result.packets.length} packets, shown without animation.`);
  }
}

/* Send your own */

let ownFile = null; // { name, bytes }
let receivedFile = null;

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = el("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function sha256(bytes) {
  if (!crypto.subtle) return "not available on this page";
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function setupOwn() {
  $("#own-text").value = "Type anything here, or choose a file. Then press Send.";
  $("#own-file").addEventListener("change", async () => {
    const file = $("#own-file").files?.[0];
    if (!file) return;
    if (file.size > 256 * 1024) {
      setStatus(`The file has ${Math.round(file.size / 1024)} KB. The limit is 256 KB.`);
      ownFile = null;
      return;
    }
    ownFile = { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
    $("#own-name").textContent = `${file.name} · ${file.size} bytes`;
    setStatus(`Loaded ${file.name}. Press Send.`);
  });
  $("#own-text").addEventListener("input", () => {
    ownFile = null;
    $("#own-name").textContent = "Your text";
  });
  $("#own-download").addEventListener("click", () => {
    if (receivedFile) download(new Blob([receivedFile.bytes]), receivedFile.name);
  });
}

function drawStrip(canvas, states) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const n = Math.max(states.length, 1);
  const cell = Math.min(28, Math.max(3, Math.floor(Math.sqrt((width * height) / n))));
  const columns = Math.max(1, Math.floor(width / cell));
  const colors = { "": "#1a2546", sent: "#5d7cff", arrived: "#b6ff3b", lost: "#ff4d4d", retx: "#ff9933" };
  states.forEach((state, i) => {
    ctx.fillStyle = colors[state];
    ctx.fillRect((i % columns) * cell + 1, Math.floor(i / columns) * cell + 1, cell - 2, cell - 2);
  });
}

export function runOwn() {
  const bytes = ownFile?.bytes ?? encoder.encode($("#own-text").value);
  const name = ownFile?.name ?? "message.txt";
  if (bytes.length === 0) return;
  const choice = $("#own-protocol").value;
  const seed = nextSeed();
  const mss = 1000;
  let result;
  if (choice === "udp") result = simulate("udp", [{ data: bytes }], { seed, mss });
  else if (choice === "custom") result = simulate("custom", [{ data: bytes }], { seed, mss, custom: builderOptions().custom, maxTimeMs: 600000 });
  else result = simulate("tcp", [{ data: bytes }], { seed, mss, tcp: { flavor: choice, sack: true }, maxTimeMs: 600000 });

  $("#own-name").textContent = `${name} · ${bytes.length} bytes`;
  $("#own-download").disabled = true;
  $("#own-hashes").replaceChildren();
  renderStats($("#own-stats"), [["Status", "sending…"]]);
  const preview = $("#own-preview");
  let isText = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    isText = false;
  }
  preview.hidden = !isText || bytes.length > 20000;

  let lastCount = -1;
  playerFor("own").play(
    result.durationMs,
    (t) => {
      drawStrip($("#own-strip"), packetStates(result, t));
      const count = result.deliveries.filter((d) => d.at <= t).length;
      if (count !== lastCount) {
        lastCount = count;
        const { bytes: got, have } = rebuild(result, t);
        const done = have.reduce((sum, v) => sum + v, 0);
        $("#own-progress").style.width = `${(100 * done) / bytes.length}%`;
        $("#own-status").textContent = `${done} of ${bytes.length} bytes at ${ms(t)}`;
        if (!preview.hidden) renderText(preview, got, have);
      }
    },
    async () => {
      const { bytes: got } = rebuild(result, Infinity);
      receivedFile = { name: `received-${name}`, bytes: got };
      $("#own-download").disabled = false;
      renderStats($("#own-stats"), dataStats(result));
      const [sent, received] = await Promise.all([sha256(bytes), sha256(got)]);
      const hashes = $("#own-hashes");
      hashes.replaceChildren(
        el("dt", "", "Sent"), el("dd", "", sent),
        el("dt", "", "Received"), el("dd", sent === received ? "match" : "mismatch", received),
        el("dt", "", "Result"), el("dd", sent === received ? "match" : "mismatch", sent === received ? "✓ identical" : "✗ different: some bytes are missing"),
      );
      setStatus(`${name}: ${pct((100 * result.stats.bytesDelivered) / bytes.length)} delivered. Missing bytes are zeros in the downloaded file.`);
    },
  );
}

/* Build a protocol */

const builderLadder = new Ladder($("#builder-ladder"));

const RELIABILITY = {
  none: "No retransmission",
  "stop-and-wait": "Stop-and-wait",
  "go-back-n": "Go-Back-N",
  "selective-repeat": "Selective repeat",
};

export function builderOptions() {
  return {
    name: $("#builder-name").value.trim() || "MyProto",
    mss: Number($("#builder-mss").value),
    custom: {
      handshake: $("#builder-handshake").checked,
      reliability: $("#builder-reliability").value,
      window: Number($("#builder-window").value),
      timeoutMs: Number($("#builder-timeout").value),
      ordered: $("#builder-ordered").checked,
      fecGroup: Number($("#builder-fec").value),
    },
  };
}

function renderCard() {
  const { name, mss, custom: c } = builderOptions();
  const reliable = c.reliability !== "none";
  const card = $("#builder-card");
  card.replaceChildren();
  card.append(el("h3", "", name), el("span", "rfc", `RFC 2000-${Math.abs(hash(name)) % 9000 + 1000} · Experimental`));
  const features = el("ul");
  const chip = (text, on = true) => features.appendChild(el("li", on ? "" : "off", text));
  chip("Handshake", c.handshake);
  chip(RELIABILITY[c.reliability], reliable);
  if (reliable) chip(c.reliability === "stop-and-wait" ? "Window 1" : `Window ${c.window}`);
  if (reliable) chip(c.timeoutMs ? `Timeout ${c.timeoutMs} ms` : "Adaptive timeout");
  chip("In order", c.ordered);
  chip(c.fecGroup ? `FEC 1/${c.fecGroup}` : "FEC", c.fecGroup > 0);
  chip(`${mss} B payload`);
  const diagram = el("div", "header-diagram");
  diagram.append(el("span", "", "Type"));
  diagram.append(el("span", "", "Packet no."));
  if (reliable) diagram.append(el("span", "", "Ack no."));
  if (c.fecGroup) diagram.append(el("span", "", "FEC group"));
  diagram.append(el("span", "", "Payload"));
  card.append(features, diagram);
}

function hash(text) {
  let h = 0;
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) | 0;
  return h;
}

export function setupBuilder() {
  $("#builder-text").value = "My own protocol, built in NetLab. Every byte counts!";
  $("#builder-form").addEventListener("submit", (event) => event.preventDefault());
  $("#builder-form").addEventListener("input", renderCard);
  renderCard();
}

function inOrder(result) {
  let last = -1;
  for (const d of [...result.deliveries].sort((a, b) => a.at - b.at)) {
    if (d.offset < last) return false;
    last = d.offset;
  }
  return true;
}

export function runBuilder() {
  renderCard();
  const { name, mss, custom } = builderOptions();
  const data = encoder.encode($("#builder-text").value || " ");
  const seed = nextSeed();
  const runs = [
    { name, mine: true, result: simulate("custom", [{ data }], { seed, mss, custom, maxTimeMs: 600000 }) },
    { name: "UDP", result: simulate("udp", [{ data }], { seed, mss }) },
    { name: "TCP NewReno", result: simulate("tcp", [{ data }], { seed, mss, tcp: { flavor: "newreno" } }) },
  ];
  const mine = runs[0].result;
  builderLadder.load(mine);

  playerFor("builder").play(
    mine.durationMs,
    (t) => {
      builderLadder.frame(t);
      const { bytes, have } = rebuild(mine, t);
      renderText($("#builder-rebuilt"), bytes, have);
    },
    () => {
      const rows = runs.map(({ name: label, mine: isMine, result }) => {
        const s = result.stats;
        const last = result.deliveries.length ? Math.max(...result.deliveries.map((d) => d.at)) : NaN;
        const values = [
          (100 * s.bytesDelivered) / s.bytesTotal,
          last,
          s.packetsSent,
          s.wireBytes,
          s.retransmissions,
          s.fecRecovered,
        ];
        const texts = [
          pct(values[0]),
          Number.isNaN(last) ? "—" : ms(last),
          String(s.packetsSent),
          String(s.wireBytes),
          String(s.retransmissions),
          String(s.fecRecovered),
          inOrder(result) ? "yes" : "no",
        ];
        const element = el("tr", isMine ? "mine" : "");
        element.append(el("th", "", label));
        const cells = texts.map((text) => element.appendChild(el("td", "", text)));
        return { element, values, cells };
      });
      markBest(rows, [
        { index: 0, better: "high" },
        { index: 1, better: "low" },
        { index: 2, better: "low" },
        { index: 3, better: "low" },
      ]);
      table($("#builder-table"), ["Protocol", "Delivered", "Last data", "Packets", "Bytes on the wire", "Retransmissions", "FEC rebuilt", "In order"], rows);
      setStatus(`${name}: ${pct((100 * mine.stats.bytesDelivered) / mine.stats.bytesTotal)} delivered with ${mine.stats.packetsSent} packets.`);
    },
  );
}

