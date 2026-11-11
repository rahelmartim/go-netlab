/* NetLab front end. The Go simulator (netsim, in WebAssembly) computes every
   packet. This file only animates the result. */

const $ = (selector) => document.querySelector(selector);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const PRESETS = {
  flaky: { name: "Flaky DSL", delay: 60, jitter: 25, loss: 12, bandwidth: 1000 },
  lan: { name: "Office LAN", delay: 2, jitter: 0, loss: 0, bandwidth: 100000 },
  wifi: { name: "Home Wi-Fi", delay: 15, jitter: 6, loss: 1, bandwidth: 10000 },
  mobile: { name: "4G on a train", delay: 70, jitter: 45, loss: 6, bandwidth: 10000 },
  satellite: { name: "Satellite", delay: 300, jitter: 20, loss: 2, bandwidth: 1000 },
  dialup: { name: "Dial-up 56k", delay: 120, jitter: 15, loss: 3, bandwidth: 56 },
  chaos: { name: "Total chaos", delay: 90, jitter: 90, loss: 35, bandwidth: 256 },
};

const COLORS = {
  DGRAM: "#33d6ff",
  DATA: "#b6ff3b",
  ACK: "#ffcc33",
  SYN: "#ff66cc",
  "SYN-ACK": "#ff66cc",
  FIN: "#ff66cc",
  "FIN-ACK": "#ff66cc",
  retx: "#ff9933",
  lost: "#ff4d4d",
};

/* Helpers */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text) {
  if (!text) return new Uint8Array();
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`);
const pct = (value) => `${Math.round(value)}%`;

function setStatus(text) {
  $("#status").textContent = text;
}

/* Network conditions */

const controls = {
  preset: $("#preset"),
  delay: $("#delay"),
  jitter: $("#jitter"),
  loss: $("#loss"),
  bandwidth: $("#bandwidth"),
  speed: $("#speed"),
  seed: $("#seed"),
  lockSeed: $("#lock-seed"),
};

function showConditionValues() {
  $("#delay-out").textContent = `${controls.delay.value} ms`;
  $("#jitter-out").textContent = `±${controls.jitter.value} ms`;
  $("#loss-out").textContent = `${controls.loss.value}%`;
}

function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  controls.delay.value = preset.delay;
  controls.jitter.value = preset.jitter;
  controls.loss.value = preset.loss;
  controls.bandwidth.value = String(preset.bandwidth);
  showConditionValues();
}

function setupConditions() {
  for (const [key, preset] of Object.entries(PRESETS)) {
    controls.preset.append(new Option(preset.name, key));
  }
  controls.preset.append(new Option("Custom", "custom"));
  controls.preset.addEventListener("change", () => applyPreset(controls.preset.value));
  for (const input of [controls.delay, controls.jitter, controls.loss, controls.bandwidth]) {
    input.addEventListener("input", () => {
      controls.preset.value = "custom";
      showConditionValues();
    });
  }
  controls.preset.value = "flaky";
  applyPreset("flaky");
  controls.seed.value = String(1 + Math.floor(Math.random() * 99999));
}

function conditions() {
  return {
    delayMs: Number(controls.delay.value),
    jitterMs: Number(controls.jitter.value),
    lossPct: Number(controls.loss.value),
    bandwidthKbps: Number(controls.bandwidth.value),
  };
}

function nextSeed() {
  if (!controls.lockSeed.checked) {
    controls.seed.value = String(1 + Math.floor(Math.random() * 99999));
  }
  const seed = Number(controls.seed.value) || 1;
  $("#status-seed").textContent = `seed ${seed}`;
  return seed;
}

/* Simulation */

function simulate(protocol, messages, extra = {}) {
  const options = {
    protocol,
    conditions: conditions(),
    messages: messages.map((m) => ({ atMs: m.atMs ?? 0, data: toBase64(m.data) })),
    ...extra,
  };
  const result = JSON.parse(window.netlab.simulate(JSON.stringify(options)));
  if (result.error) throw new Error(result.error);
  for (const delivery of result.deliveries) delivery.bytes = fromBase64(delivery.data);
  return result;
}

/* Playback clock */

class Player {
  constructor() {
    this.frameId = 0;
  }

  play(durationMs, onFrame, onDone) {
    this.stop();
    const choice = controls.speed.value;
    const rate = choice === "auto" ? Math.max(durationMs, 1) / 8000 : Number(choice);
    if (reducedMotion) {
      onFrame(durationMs);
      onDone?.();
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) * rate, durationMs);
      onFrame(t);
      if (t < durationMs) {
        this.frameId = requestAnimationFrame(tick);
      } else {
        this.frameId = 0;
        onDone?.();
      }
    };
    this.frameId = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.frameId);
    this.frameId = 0;
  }
}

/* Packet diagram: client on the left, server on the right, time goes down. */

class Ladder {
  constructor(container) {
    this.container = container;
    this.result = null;
    this.lastT = 0;
    this.showPlaceholder("Press Send to start.");
    new ResizeObserver(() => {
      if (this.result) {
        this.load(this.result);
        this.frame(this.lastT);
      }
    }).observe(container);
  }

  showPlaceholder(text) {
    this.container.replaceChildren(el("div", "placeholder", text));
  }

  load(result) {
    this.result = result;
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const top = 40;
    const bottom = 16;
    const xClient = Math.min(110, width * 0.18);
    const xServer = width - xClient;
    const duration = Math.max(result.durationMs, 1);
    const scale = (height - top - bottom) / duration;
    const y = (t) => top + t * scale;
    this.geometry = { xClient, xServer, y, width };

    const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
    const title = svg("title");
    title.textContent = `${result.protocol.toUpperCase()} packet diagram`;
    root.append(title);

    // Time grid
    const step = niceStep(duration / 8);
    for (let t = 0; t <= duration; t += step) {
      root.append(svg("line", { x1: xClient, x2: xServer, y1: y(t), y2: y(t), stroke: "#1e2f5c", "stroke-width": 1 }));
      const label = svg("text", { x: 6, y: y(t) + 4, fill: "#6f8fd8", "font-size": 15 });
      label.textContent = ms(t);
      root.append(label);
    }

    for (const [x, name] of [[xClient, "CLIENT"], [xServer, "SERVER"]]) {
      root.append(svg("line", { x1: x, x2: x, y1: top - 6, y2: height - 6, stroke: "#9fb6e8", "stroke-width": 2 }));
      const label = svg("text", { x, y: 22, fill: "#fff", "font-size": 20, "text-anchor": "middle" });
      label.textContent = name;
      root.append(label);
    }

    this.nowLine = svg("line", { x1: xClient, x2: xServer, stroke: "#ffffff66", "stroke-dasharray": "3 4" });
    root.append(this.nowLine);

    const showLabels = result.packets.length <= 70;
    this.items = result.packets.map((p) => {
      const fromX = p.from === "client" ? xClient : xServer;
      const toX = p.from === "client" ? xServer : xClient;
      const color = p.lost ? COLORS.lost : p.retransmit ? COLORS.retx : COLORS[p.kind] ?? "#fff";
      const group = svg("g", { visibility: "hidden" });
      const line = svg("line", {
        x1: fromX, y1: y(p.sentAt), x2: fromX, y2: y(p.sentAt),
        stroke: color, "stroke-width": p.kind === "ACK" ? 1.5 : 2.5,
        "stroke-dasharray": p.retransmit ? "6 4" : "none",
        "stroke-linecap": "round",
      });
      const head = svg("circle", { r: 4, fill: color });
      const tooltip = svg("title");
      tooltip.textContent = describe(p);
      group.append(tooltip, line, head);

      let cross = null;
      if (p.lost) {
        cross = svg("text", { fill: COLORS.lost, "font-size": 22, "text-anchor": "middle", visibility: "hidden" });
        cross.textContent = "✕";
        group.append(cross);
      }
      let label = null;
      if (showLabels) {
        label = svg("text", { fill: color, "font-size": 15, visibility: "hidden" });
        label.textContent = shortLabel(p);
        group.append(label);
      }
      root.append(group);
      return { p, fromX, toX, group, line, head, cross, label, state: "" };
    });

    this.container.replaceChildren(root);
  }

  frame(t) {
    if (!this.result) return;
    this.lastT = t;
    const { y } = this.geometry;
    this.nowLine.setAttribute("y1", y(t));
    this.nowLine.setAttribute("y2", y(t));

    for (const item of this.items) {
      const { p } = item;
      if (t < p.sentAt) {
        if (item.state !== "hidden") {
          item.group.setAttribute("visibility", "hidden");
          item.state = "hidden";
        }
        continue;
      }
      // A lost packet disappears halfway.
      const end = p.lost ? 0.55 : 1;
      const progress = Math.min((t - p.sentAt) / Math.max(p.arriveAt - p.sentAt, 0.001), end);
      const x = item.fromX + (item.toX - item.fromX) * progress;
      const py = y(p.sentAt) + (y(p.arriveAt) - y(p.sentAt)) * progress;
      const done = progress >= end;
      const state = done ? "done" : `${progress.toFixed(3)}`;
      if (state === item.state) continue;
      item.state = state;

      item.group.setAttribute("visibility", "visible");
      item.line.setAttribute("x2", x);
      item.line.setAttribute("y2", py);
      item.head.setAttribute("cx", x);
      item.head.setAttribute("cy", py);
      item.head.setAttribute("visibility", done ? "hidden" : "visible");
      if (item.cross) {
        item.cross.setAttribute("x", x);
        item.cross.setAttribute("y", py + 7);
        item.cross.setAttribute("visibility", done ? "visible" : "hidden");
      }
      if (item.label && done) {
        const midX = item.fromX + (item.toX - item.fromX) * (p.lost ? 0.3 : 0.5);
        const midY = y(p.sentAt) + (y(p.arriveAt) - y(p.sentAt)) * (p.lost ? 0.3 : 0.5);
        item.label.setAttribute("x", midX + 6);
        item.label.setAttribute("y", midY - 4);
        item.label.setAttribute("visibility", "visible");
      }
    }
  }
}

function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const factor of [1, 2, 5, 10]) {
    if (raw <= factor * power) return factor * power;
  }
  return 10 * power;
}

function shortLabel(p) {
  switch (p.kind) {
    case "DATA":
      return `${p.retransmit ? "RE " : ""}seq ${p.seq}`;
    case "DGRAM":
      return `#${p.seq}`;
    case "ACK":
      return p.from === "server" && p.ack ? `ack ${p.ack}` : "ACK";
    default:
      return p.kind;
  }
}

function describe(p) {
  const parts = [`${p.kind} from ${p.from}`];
  if (p.kind === "DATA" || p.kind === "DGRAM") parts.push(`seq ${p.seq}, ${p.len} bytes "${p.preview}"`);
  if (p.kind === "ACK" && p.from === "server") parts.push(`ack ${p.ack}`);
  parts.push(`sent ${ms(p.sentAt)}`);
  parts.push(p.lost ? "LOST" : `arrived ${ms(p.arriveAt)}`);
  if (p.retransmit) parts.push("retransmission");
  return parts.join(" · ");
}

/* Receiver views */

// rebuild returns the bytes that arrived until time t, and a mask of them.
function rebuild(result, t) {
  const bytes = new Uint8Array(result.stats.bytesTotal);
  const have = new Uint8Array(result.stats.bytesTotal);
  for (const d of result.deliveries) {
    if (d.at > t) continue;
    bytes.set(d.bytes, d.offset);
    have.fill(1, d.offset, d.offset + d.bytes.length);
  }
  return { bytes, have };
}

// renderText writes the received text. Missing bytes become ▒.
function renderText(target, bytes, have, from = 0, to = bytes.length) {
  target.replaceChildren();
  let i = from;
  while (i < to) {
    const filled = have[i];
    let j = i;
    while (j < to && have[j] === filled) j++;
    if (filled) {
      target.append(document.createTextNode(decoder.decode(bytes.subarray(i, j))));
    } else {
      target.append(el("span", "hole", "▒".repeat(j - i)));
    }
    i = j;
  }
}

function renderStats(target, rows) {
  target.replaceChildren();
  for (const [name, value] of rows) {
    target.append(el("dt", "", name), el("dd", "", value));
  }
}

function dataStats(result) {
  const s = result.stats;
  const rows = [
    ["Packets sent", String(s.packetsSent)],
    ["Packets lost", `${s.packetsLost} (${pct((100 * s.packetsLost) / Math.max(s.packetsSent, 1))})`],
    ["Delivered", `${s.bytesDelivered} / ${s.bytesTotal} bytes`],
    ["Out of order", String(s.outOfOrder)],
    ["Avg latency", ms(s.avgLatencyMs)],
    ["Jitter", ms(s.jitterMs)],
  ];
  if (result.protocol === "tcp") {
    rows.splice(2, 0, ["Retransmissions", String(s.retransmissions)]);
    rows.push(["Handshake", s.handshakeMs ? ms(s.handshakeMs) : "failed"]);
  }
  rows.push(["Complete", s.complete ? `yes, at ${ms(s.completedAtMs)}` : "no"]);
  return rows;
}

function summary(result) {
  const s = result.stats;
  const name = result.protocol.toUpperCase();
  return `${name}: ${s.packetsSent} packets, ${s.packetsLost} lost, ${s.complete ? "complete" : "incomplete"}`;
}

/* Tabs */

const tabs = [...document.querySelectorAll('[role="tab"]')];
const tabStarted = new Set();
const players = new Map();

function playerFor(name) {
  if (!players.has(name)) players.set(name, new Player());
  return players.get(name);
}

function selectTab(tab) {
  for (const other of tabs) {
    const selected = other === tab;
    other.setAttribute("aria-selected", String(selected));
    other.tabIndex = selected ? 0 : -1;
    $(`#${other.getAttribute("aria-controls")}`).hidden = !selected;
  }
  const name = tab.id.replace("tab-", "");
  // Run each experiment once when its tab opens for the first time.
  if (!tabStarted.has(name) && window.netlab) {
    tabStarted.add(name);
    runners[name]?.();
  }
}

function setupTabs() {
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      next.focus();
      selectTab(next);
    });
  });
}

function guard(fn) {
  return () => {
    try {
      fn();
    } catch (error) {
      console.error(error);
      setStatus(`Error: ${error.message}`);
    }
  };
}

/* Tab: UDP */

const udpLadder = new Ladder($("#udp-ladder"));

function runUDP() {
  const data = encoder.encode($("#udp-text").value);
  const result = simulate("udp", [{ data }], { mss: Number($("#udp-mss").value), seed: nextSeed() });
  udpLadder.load(result);
  setStatus(`${summary(result)}. Playing…`);

  const datagrams = result.packets;
  const byArrival = datagrams.filter((p) => !p.lost).sort((a, b) => a.arriveAt - b.arriveAt);
  const index = new Map(datagrams.map((p, i) => [p.id, i + 1]));
  const rebuilt = $("#udp-rebuilt");
  const order = $("#udp-order");
  renderStats($("#udp-stats"), [["Status", "sending…"]]);

  playerFor("udp").play(
    result.durationMs,
    (t) => {
      udpLadder.frame(t);
      const { bytes, have } = rebuild(result, t);
      renderText(rebuilt, bytes, have);
      order.replaceChildren();
      let highest = 0;
      for (const p of byArrival) {
        if (p.arriveAt > t) break;
        const n = index.get(p.id);
        order.append(el("span", `chip${n < highest ? " swapped" : ""}`, String(n)));
        highest = Math.max(highest, n);
      }
    },
    () => {
      for (const p of datagrams) {
        if (p.lost) order.append(el("span", "chip missing", String(index.get(p.id))));
      }
      renderStats($("#udp-stats"), dataStats(result));
      setStatus(`${summary(result)}. Yellow chips arrived out of order.`);
    },
  );
}

/* Tab: TCP */

const tcpLadder = new Ladder($("#tcp-ladder"));

function tcpEvents(result) {
  const events = [];
  let lastAck = -1;
  for (const p of result.packets) {
    if (p.kind === "SYN") events.push([p.sentAt, `${p.retransmit ? "SYN sent again" : "Client sends SYN"}`]);
    if (p.lost) events.push([p.sentAt + (p.arriveAt - p.sentAt) * 0.55, `${shortLabel(p)} (${p.kind}) was lost`, true]);
    if (p.retransmit) events.push([p.sentAt, `Retransmits seq ${p.seq}`, true]);
    if (p.kind === "ACK" && p.from === "server" && !p.lost) {
      if (p.ack === lastAck) events.push([p.arriveAt, `Duplicate ACK ${p.ack}`]);
      lastAck = p.ack;
    }
    if (p.kind === "FIN" && !p.retransmit) events.push([p.sentAt, "Client closes the connection"]);
  }
  if (result.stats.handshakeMs) events.push([result.stats.handshakeMs, "Handshake complete"]);
  if (result.stats.complete) events.push([result.stats.completedAtMs, "App has every byte"]);
  return events.sort((a, b) => a[0] - b[0]);
}

function runTCP() {
  const data = encoder.encode($("#tcp-text").value);
  const result = simulate("tcp", [{ data }], {
    mss: Number($("#tcp-mss").value),
    window: Number($("#tcp-window").value),
    seed: nextSeed(),
  });
  tcpLadder.load(result);
  setStatus(`${summary(result)}. Playing…`);

  const events = tcpEvents(result);
  const list = $("#tcp-events");
  const rebuilt = $("#tcp-rebuilt");
  let shown = 0;
  list.replaceChildren();
  renderStats($("#tcp-stats"), [["Status", "connecting…"]]);

  playerFor("tcp").play(
    result.durationMs,
    (t) => {
      tcpLadder.frame(t);
      const { bytes, have } = rebuild(result, t);
      renderText(rebuilt, bytes, have);
      while (shown < events.length && events[shown][0] <= t) {
        const [, text, bad] = events[shown++];
        list.append(el("li", bad ? "bad" : "", text));
        list.scrollTop = list.scrollHeight;
      }
    },
    () => {
      renderStats($("#tcp-stats"), dataStats(result));
      setStatus(`${summary(result)}, ${result.stats.retransmissions} retransmissions.`);
    },
  );
}

/* Tab: UDP x TCP */

const versusLadders = { udp: new Ladder($("#versus-udp-ladder")), tcp: new Ladder($("#versus-tcp-ladder")) };

function wireBytes(result) {
  return result.packets.reduce((sum, p) => sum + p.len + (result.protocol === "udp" ? 28 : 40), 0);
}

function runVersus() {
  const data = encoder.encode($("#versus-text").value);
  const seed = nextSeed();
  const results = {
    udp: simulate("udp", [{ data }], { mss: 12, seed }),
    tcp: simulate("tcp", [{ data }], { mss: 12, seed }),
  };
  for (const key of ["udp", "tcp"]) versusLadders[key].load(results[key]);
  const duration = Math.max(results.udp.durationMs, results.tcp.durationMs);

  playerFor("versus").play(
    duration,
    (t) => {
      for (const key of ["udp", "tcp"]) {
        versusLadders[key].frame(t);
        const { bytes, have } = rebuild(results[key], t);
        renderText($(`#versus-${key}-rebuilt`), bytes, have);
      }
    },
    () => renderComparison(results),
  );
  renderComparison(null);
}

function renderComparison(results) {
  const table = $("#versus-table");
  table.replaceChildren();
  const head = el("thead");
  const headRow = el("tr");
  headRow.append(el("th", "", ""), el("th", "", "UDP"), el("th", "", "TCP"));
  head.append(headRow);
  table.append(head);
  if (!results) return;

  const { udp, tcp } = results;
  // NaN when nothing arrived, so that an empty result never wins on time.
  const lastArrival = (r) => (r.deliveries.length ? Math.max(...r.deliveries.map((d) => d.at)) : NaN);
  const time = (value) => (Number.isNaN(value) ? "—" : ms(value));
  const rows = [
    ["Data delivered", pct((100 * udp.stats.bytesDelivered) / udp.stats.bytesTotal), pct((100 * tcp.stats.bytesDelivered) / tcp.stats.bytesTotal), "high"],
    ["Time of the last data", time(lastArrival(udp)), time(lastArrival(tcp)), "low", lastArrival(udp), lastArrival(tcp)],
    ["Packets sent", udp.stats.packetsSent, tcp.stats.packetsSent, "low"],
    ["Bytes on the wire", wireBytes(udp), wireBytes(tcp), "low"],
    ["Retransmissions", "—", tcp.stats.retransmissions, ""],
    ["Order guaranteed", "no", "yes", ""],
  ];
  const body = el("tbody");
  for (const [name, a, b, better, rawA, rawB] of rows) {
    const row = el("tr");
    const cellA = el("td", "", String(a));
    const cellB = el("td", "", String(b));
    const numA = rawA ?? parseFloat(a);
    const numB = rawB ?? parseFloat(b);
    if (better && !Number.isNaN(numA) && !Number.isNaN(numB) && numA !== numB) {
      const aWins = better === "high" ? numA > numB : numA < numB;
      (aWins ? cellA : cellB).classList.add("win");
    }
    row.append(el("th", "", name), cellA, cellB);
    body.append(row);
  }
  table.append(body);
  setStatus(`Race done. UDP: ${pct((100 * udp.stats.bytesDelivered) / udp.stats.bytesTotal)} delivered. TCP: ${tcp.stats.complete ? "complete" : "incomplete"}.`);
}

/* Tab: Text (chat) */

function runChat() {
  const lines = $("#chat-text").value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 20);
  if (lines.length === 0) return;
  const interval = Number($("#chat-interval").value);
  const messages = lines.map((line, i) => ({ atMs: i * interval, data: encoder.encode(line) }));
  const seed = nextSeed();
  const udp = simulate("udp", messages, { mss: 1400, seed });
  const tcp = simulate("tcp", messages, { mss: 1400, seed, window: 8 });

  // UDP: one datagram per message.
  const udpArrivals = udp.deliveries.map((d) => ({ at: d.at, message: d.message })).sort((a, b) => a.at - b.at);
  // TCP: a message is ready when all of its bytes are delivered, in order.
  const tcpReady = lines.map((_, i) => {
    const end = tcp.messageOffsets[i] + messages[i].data.length;
    const delivery = tcp.deliveries.find((d) => d.offset + d.bytes.length >= end);
    return delivery ? delivery.at : Infinity;
  });

  const sender = $("#chat-sender");
  const udpList = $("#chat-udp");
  const tcpList = $("#chat-tcp");
  for (const list of [sender, udpList, tcpList]) list.replaceChildren();
  const counts = { sent: 0, udp: 0, tcp: 0 };
  let udpHighest = -1;
  const duration = Math.max(udp.durationMs, tcp.durationMs);

  const bubble = (i, meta, className = "") => {
    const item = el("li", `bubble ${className}`);
    item.append(document.createTextNode(lines[i]), el("span", "meta", meta));
    return item;
  };

  playerFor("chat").play(
    duration,
    (t) => {
      $("#chat-clock").textContent = `t = ${ms(t)}`;
      while (counts.sent < lines.length && messages[counts.sent].atMs <= t) {
        sender.append(bubble(counts.sent, `#${counts.sent + 1} sent at ${ms(messages[counts.sent].atMs)}`));
        counts.sent++;
      }
      while (counts.udp < udpArrivals.length && udpArrivals[counts.udp].at <= t) {
        const { at, message } = udpArrivals[counts.udp++];
        const swapped = message < udpHighest;
        udpHighest = Math.max(udpHighest, message);
        udpList.append(bubble(message, `#${message + 1} · ${ms(at - messages[message].atMs)}${swapped ? " · out of order" : ""}`, swapped ? "swapped" : ""));
        udpList.scrollTop = udpList.scrollHeight;
      }
      while (counts.tcp < lines.length && tcpReady[counts.tcp] <= t) {
        const i = counts.tcp++;
        tcpList.append(bubble(i, `#${i + 1} · ${ms(tcpReady[i] - messages[i].atMs)}`));
        tcpList.scrollTop = tcpList.scrollHeight;
      }
    },
    () => {
      const arrived = new Set(udpArrivals.map((a) => a.message));
      lines.forEach((_, i) => {
        if (!arrived.has(i)) udpList.append(bubble(i, `#${i + 1} · lost`, "lost"));
      });
      setStatus(`Chat done. UDP lost ${lines.length - arrived.size} of ${lines.length} messages. TCP delivered ${counts.tcp}.`);
    },
  );
}

/* Tab: Text + content */

const IMAGE_SIZE = 48;
const PICTURES = {
  globe(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 48);
    g.addColorStop(0, "#1a1a6e");
    g.addColorStop(1, "#6a2c91");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 48, 48);
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = i % 3 ? "#ffffff" : "#ffccff";
      ctx.fillRect((i * 37) % 48, (i * 23) % 48, 1, 1);
    }
    ctx.fillStyle = "#1f7ae0";
    ctx.beginPath();
    ctx.arc(24, 24, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#7fe3ff";
    ctx.lineWidth = 1;
    for (const r of [15, 10, 5]) {
      ctx.beginPath();
      ctx.ellipse(24, 24, r, 15, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const yy of [16, 24, 32]) {
      ctx.beginPath();
      ctx.moveTo(10, yy);
      ctx.lineTo(38, yy);
      ctx.stroke();
    }
    ctx.strokeStyle = "#ffcc33";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(24, 24, 22, 6, -0.4, 0, Math.PI * 2);
    ctx.stroke();
  },
  smiley(ctx) {
    ctx.fillStyle = "#33d6ff";
    ctx.fillRect(0, 0, 48, 48);
    ctx.fillStyle = "#ffe14d";
    ctx.beginPath();
    ctx.arc(24, 24, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.fillRect(16, 16, 4, 6);
    ctx.fillRect(28, 16, 4, 6);
    ctx.fillRect(14, 29, 2, 2);
    ctx.fillRect(32, 29, 2, 2);
    ctx.fillRect(16, 31, 16, 3);
  },
  sunset(ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 30);
    g.addColorStop(0, "#2b1055");
    g.addColorStop(1, "#ff6ec7");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 48, 30);
    ctx.fillStyle = "#ffcc33";
    ctx.beginPath();
    ctx.arc(24, 30, 11, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = "#2b1055";
    for (const yy of [21, 25, 28]) ctx.fillRect(12, yy, 24, 1);
    ctx.fillStyle = "#120428";
    ctx.fillRect(0, 30, 48, 18);
    ctx.strokeStyle = "#ff66cc";
    ctx.lineWidth = 1;
    for (let x = -48; x <= 96; x += 8) {
      ctx.beginPath();
      ctx.moveTo(24, 30);
      ctx.lineTo(x, 48);
      ctx.stroke();
    }
    for (const yy of [32, 35, 39, 44]) {
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(48, yy);
      ctx.stroke();
    }
  },
};

let uploadedImage = null;

function drawOriginal() {
  const canvas = $("#media-original");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.clearRect(0, 0, IMAGE_SIZE, IMAGE_SIZE);
  const choice = $("#media-image").value;
  if (choice === "upload" && uploadedImage) {
    const side = Math.min(uploadedImage.width, uploadedImage.height);
    ctx.drawImage(
      uploadedImage,
      (uploadedImage.width - side) / 2, (uploadedImage.height - side) / 2, side, side,
      0, 0, IMAGE_SIZE, IMAGE_SIZE,
    );
  } else {
    (PICTURES[choice] ?? PICTURES.globe)(ctx);
  }
  $("#media-original-caption").textContent = $("#media-caption").value;
  const rgba = ctx.getImageData(0, 0, IMAGE_SIZE, IMAGE_SIZE).data;
  const rgb = new Uint8Array(IMAGE_SIZE * IMAGE_SIZE * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return rgb;
}

function paintReceived(canvas, bytes, have, offset) {
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(IMAGE_SIZE, IMAGE_SIZE);
  for (let px = 0; px < IMAGE_SIZE * IMAGE_SIZE; px++) {
    const src = offset + px * 3;
    const o = px * 4;
    if (have[src] && have[src + 1] && have[src + 2]) {
      image.data[o] = bytes[src];
      image.data[o + 1] = bytes[src + 1];
      image.data[o + 2] = bytes[src + 2];
    } else {
      // Missing pixels: a dark checkerboard, like a broken JPEG in 2000.
      const dark = ((px % IMAGE_SIZE) + Math.floor(px / IMAGE_SIZE)) % 2 === 0;
      image.data[o] = dark ? 40 : 90;
      image.data[o + 1] = 0;
      image.data[o + 2] = dark ? 50 : 100;
    }
    image.data[o + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

function packetStates(result, t) {
  // One square per data packet, in the order of the first send.
  const bySeq = new Map();
  for (const p of result.packets) {
    if (p.kind !== "DATA" && p.kind !== "DGRAM") continue;
    if (!bySeq.has(p.seq)) bySeq.set(p.seq, []);
    bySeq.get(p.seq).push(p);
  }
  return [...bySeq.values()].map((copies) => {
    const sent = copies.filter((p) => p.sentAt <= t);
    if (sent.length === 0) return "";
    if (sent.some((p) => !p.lost && p.arriveAt <= t)) return "arrived";
    const last = sent[sent.length - 1];
    if (last.lost && t >= last.sentAt + (last.arriveAt - last.sentAt) * 0.55) return "lost";
    return sent.length > 1 ? "retx" : "sent";
  });
}

function runMedia() {
  const image = drawOriginal();
  const caption = encoder.encode($("#media-caption").value);
  const messages = [{ data: caption }, { data: image }];
  const seed = nextSeed();
  const results = {
    udp: simulate("udp", messages, { mss: 256, seed }),
    tcp: simulate("tcp", messages, { mss: 256, seed, window: 6 }),
  };
  const duration = Math.max(results.udp.durationMs, results.tcp.durationMs);
  const strips = {};
  for (const key of ["udp", "tcp"]) {
    const strip = $(`#media-${key}-strip`);
    strip.replaceChildren();
    const count = packetStates(results[key], Infinity).length;
    strips[key] = Array.from({ length: count }, () => strip.appendChild(el("i")));
    $(`#media-${key}-status`).textContent = "sending…";
  }
  const lastDeliveries = { udp: -1, tcp: -1 };

  playerFor("media").play(
    duration,
    (t) => {
      for (const key of ["udp", "tcp"]) {
        const result = results[key];
        const delivered = result.deliveries.filter((d) => d.at <= t).length;
        if (delivered !== lastDeliveries[key]) {
          lastDeliveries[key] = delivered;
          const { bytes, have } = rebuild(result, t);
          const imageOffset = result.messageOffsets[1];
          paintReceived($(`#media-${key}`), bytes, have, imageOffset);
          renderText($(`#media-${key}-caption`), bytes, have, 0, imageOffset);
          const got = have.reduce((sum, v) => sum + v, 0);
          $(`#media-${key}-progress`).style.width = `${(100 * got) / have.length}%`;
        }
        packetStates(result, t).forEach((state, i) => {
          strips[key][i].className = state;
        });
      }
    },
    () => {
      for (const key of ["udp", "tcp"]) {
        const s = results[key].stats;
        $(`#media-${key}-status`).textContent = s.complete
          ? `Complete at ${ms(s.completedAtMs)} · ${s.packetsSent} packets · ${s.retransmissions} retransmitted`
          : `${pct((100 * s.bytesDelivered) / s.bytesTotal)} delivered · ${s.packetsLost} packets lost`;
      }
      setStatus("Picture sent. Squares: blue in flight, green arrived, orange retransmitted, red lost.");
    },
  );
}

function setupMedia() {
  const file = $("#media-file");
  $("#media-image").addEventListener("change", () => {
    if ($("#media-image").value === "upload") file.click();
    else drawOriginal();
  });
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    if (!chosen) return;
    const image = new Image();
    image.onload = () => {
      uploadedImage = image;
      URL.revokeObjectURL(image.src);
      drawOriginal();
    };
    image.src = URL.createObjectURL(chosen);
  });
  $("#media-caption").addEventListener("input", () => {
    $("#media-original-caption").textContent = $("#media-caption").value;
  });
}

/* Tab: Delay, jitter, loss */

const PROBES = 120;
const PROBE_INTERVAL = 20;

function setupCanvas(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = Math.round((width * canvas.height) / canvas.width);
  if (canvas.dataset.width !== String(width)) {
    canvas.dataset.width = String(width);
    canvas.dataset.height = String(height);
    canvas.width = width * ratio;
    canvas.height = height * ratio;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width, height: Number(canvas.dataset.height) };
}

function drawScatter(canvas, probes, t, cond) {
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { left: 46, right: 10, top: 12, bottom: 22 };
  ctx.clearRect(0, 0, width, height);
  const maxLatency = Math.max(cond.delayMs + cond.jitterMs, ...probes.map((p) => p.latency)) * 1.15 + 1;
  const x = (i) => pad.left + (i / (PROBES - 1)) * (width - pad.left - pad.right);
  const y = (v) => height - pad.bottom - (v / maxLatency) * (height - pad.top - pad.bottom);

  ctx.font = "15px VT323, monospace";
  ctx.fillStyle = "#6f8fd8";
  ctx.strokeStyle = "#1e2f5c";
  const step = niceStep(maxLatency / 5);
  for (let v = 0; v <= maxLatency; v += step) {
    ctx.beginPath();
    ctx.moveTo(pad.left, y(v));
    ctx.lineTo(width - pad.right, y(v));
    ctx.stroke();
    ctx.fillText(ms(v), 4, y(v) + 4);
  }
  ctx.fillText("probe →", width - 60, height - 6);

  // Expected band: delay ± jitter.
  ctx.fillStyle = "rgba(51, 214, 255, 0.10)";
  const low = Math.max(cond.delayMs - cond.jitterMs, 0);
  ctx.fillRect(pad.left, y(cond.delayMs + cond.jitterMs), width - pad.left - pad.right, y(low) - y(cond.delayMs + cond.jitterMs));
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "#33d6ff";
  ctx.beginPath();
  ctx.moveTo(pad.left, y(cond.delayMs));
  ctx.lineTo(width - pad.right, y(cond.delayMs));
  ctx.stroke();
  ctx.setLineDash([]);

  for (const p of probes) {
    if (p.sentAt > t) continue;
    if (p.lost) {
      if (t < p.sentAt + p.latency * 0.55) continue;
      ctx.fillStyle = "#ff4d4d";
      ctx.fillText("✕", x(p.index) - 3, pad.top + 10);
    } else if (p.arriveAt <= t) {
      ctx.fillStyle = "#b6ff3b";
      ctx.fillRect(x(p.index) - 2, y(p.latency) - 2, 4, 4);
    }
  }
}

function drawHistogram(canvas, probes, t) {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const arrived = probes.filter((p) => !p.lost && p.arriveAt <= t).map((p) => p.latency);
  const all = probes.filter((p) => !p.lost).map((p) => p.latency);
  if (all.length === 0) return;
  const min = Math.min(...all);
  const max = Math.max(...all) + 0.001;
  const bins = new Array(16).fill(0);
  for (const v of arrived) bins[Math.min(15, Math.floor(((v - min) / (max - min)) * 16))]++;
  const top = Math.max(...bins, 1);
  const barWidth = (width - 20) / bins.length;
  bins.forEach((count, i) => {
    const h = (count / top) * (height - 40);
    ctx.fillStyle = "#33d6ff";
    ctx.fillRect(10 + i * barWidth + 1, height - 22 - h, barWidth - 2, h);
  });
  ctx.fillStyle = "#6f8fd8";
  ctx.font = "15px VT323, monospace";
  ctx.fillText(ms(min), 8, height - 6);
  ctx.fillText(ms(max), width - 52, height - 6);
}

function renderMeters(result) {
  const s = result.stats;
  const meters = [
    ["Avg latency", ms(s.avgLatencyMs)],
    ["Min / max", `${Math.round(s.minLatencyMs)} / ${Math.round(s.maxLatencyMs)}`],
    ["Jitter", ms(s.jitterMs)],
    ["Loss", pct((100 * s.packetsLost) / Math.max(s.packetsSent, 1))],
    ["Out of order", String(s.outOfOrder)],
  ];
  const target = $("#lab-meters");
  target.replaceChildren();
  for (const [name, value] of meters) {
    const meter = el("div", "meter", name);
    meter.prepend(el("b", "", value));
    target.append(meter);
  }
}

let lastLab = null;

function runLab() {
  const probe = encoder.encode("ping".padEnd(32, "."));
  const messages = Array.from({ length: PROBES }, (_, i) => ({ atMs: i * PROBE_INTERVAL, data: probe }));
  const result = simulate("udp", messages, { mss: 64, seed: nextSeed() });
  const cond = conditions();
  const probes = result.packets.map((p) => ({
    index: p.message,
    sentAt: p.sentAt,
    arriveAt: p.arriveAt,
    latency: p.arriveAt - p.sentAt,
    lost: p.lost,
  }));
  lastLab = { probes, cond, t: 0 };
  $("#lab-meters").replaceChildren();

  playerFor("lab").play(
    result.durationMs,
    (t) => {
      lastLab.t = t;
      drawScatter($("#lab-scatter"), probes, t, cond);
      drawHistogram($("#lab-histogram"), probes, t);
    },
    () => {
      renderMeters(result);
      setStatus(`${PROBES} probes: ${result.stats.packetsLost} lost, jitter ${ms(result.stats.jitterMs)}.`);
    },
  );
}

window.addEventListener("resize", () => {
  if (lastLab && !$("#panel-lab").hidden) {
    drawScatter($("#lab-scatter"), lastLab.probes, lastLab.t, lastLab.cond);
    drawHistogram($("#lab-histogram"), lastLab.probes, lastLab.t);
  }
});

/* Start */

const runners = {
  udp: guard(runUDP),
  tcp: guard(runTCP),
  versus: guard(runVersus),
  chat: guard(runChat),
  media: guard(runMedia),
  lab: guard(runLab),
};

function setupInputs() {
  $("#udp-text").value = "Hello! This message travels over UDP.";
  $("#tcp-text").value = "Hello! This message travels over TCP.";
  $("#versus-text").value = "Same bytes, two protocols. Who wins?";
  $("#chat-text").value = [
    "hi!",
    "are you there?",
    "the network is slow today",
    "sending you the photo now",
    "did you get it?",
    "ok, talk later",
  ].join("\n");
  $("#media-caption").value = "greetings from the year 2000";

  for (const [name, run] of Object.entries(runners)) {
    $(`#${name}-send`).addEventListener("click", () => {
      tabStarted.add(name);
      run();
    });
  }
  for (const id of ["udp-text", "tcp-text", "versus-text", "media-caption"]) {
    $(`#${id}`).addEventListener("keydown", (event) => {
      if (event.key === "Enter") $(`#${id.split("-")[0]}-send`).click();
    });
  }
}

function showStartError(error) {
  console.error(error);
  setStatus("Your browser could not start the Go runtime. Open the console for details.");
}

async function start() {
  setupConditions();
  setupTabs();
  setupInputs();
  setupMedia();
  drawOriginal();

  const go = new Go();
  const wasm = await WebAssembly.instantiateStreaming(fetch("netlab.wasm"), go.importObject);
  window.addEventListener(
    "netlab-ready",
    () => {
      setStatus("Ready. Pick a tab and press Send.");
      for (const button of document.querySelectorAll(".btn-go")) button.disabled = false;
      selectTab(tabs.find((tab) => tab.getAttribute("aria-selected") === "true"));
    },
    { once: true },
  );
  for (const button of document.querySelectorAll(".btn-go")) button.disabled = true;
  go.run(wasm.instance);
}

start().catch(showStartError);
