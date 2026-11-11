/* Shared code of the NetLab front end. The Go simulator (netsim, in
   WebAssembly) computes every packet. This code only animates the result. */

export const $ = (selector) => document.querySelector(selector);
export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// burst: average loss burst length (0 = independent). queue: router queue in
// packets (0 = unlimited).
export const PRESETS = {
  flaky: { name: "Flaky DSL", delay: 60, jitter: 25, loss: 12, bandwidth: 1000 },
  lan: { name: "Office LAN", delay: 2, jitter: 0, loss: 0, bandwidth: 100000 },
  wifi: { name: "Home Wi-Fi", delay: 15, jitter: 6, loss: 1, bandwidth: 10000, burst: 2 },
  mobile: { name: "4G on a train", delay: 70, jitter: 45, loss: 6, bandwidth: 10000, burst: 4 },
  satellite: { name: "Satellite", delay: 300, jitter: 20, loss: 2, bandwidth: 1000 },
  dialup: { name: "Dial-up 56k", delay: 120, jitter: 15, loss: 3, bandwidth: 56 },
  bottleneck: { name: "Bottleneck router", delay: 30, jitter: 2, loss: 0, bandwidth: 10000, queue: 16 },
  bufferbloat: { name: "Bufferbloat", delay: 30, jitter: 2, loss: 0, bandwidth: 10000, queue: 200 },
  chaos: { name: "Total chaos", delay: 90, jitter: 90, loss: 35, bandwidth: 256, burst: 3, duplicate: 5 },
};

export const COLORS = {
  DGRAM: "#33d6ff",
  DATA: "#b6ff3b",
  ACK: "#ffcc33",
  SYN: "#ff66cc",
  "SYN-ACK": "#ff66cc",
  FIN: "#ff66cc",
  "FIN-ACK": "#ff66cc",
  HELLO: "#ff66cc",
  "HELLO-ACK": "#ff66cc",
  PARITY: "#c77dff",
  retx: "#ff9933",
  lost: "#ff4d4d",
};

/* Helpers */

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function svg(tag, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export function toBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  if (!text) return new Uint8Array();
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const ms = (value) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`);
export const pct = (value) => `${Math.round(value)}%`;

export function setStatus(text) {
  $("#status").textContent = text;
}

/* Network conditions */

export const controls = {
  preset: $("#preset"),
  delay: $("#delay"),
  jitter: $("#jitter"),
  loss: $("#loss"),
  bandwidth: $("#bandwidth"),
  burst: $("#burst"),
  duplicate: $("#duplicate"),
  queue: $("#queue"),
  asymmetric: $("#asymmetric"),
  reverseDelay: $("#reverse-delay"),
  speed: $("#speed"),
  seed: $("#seed"),
  lockSeed: $("#lock-seed"),
};

const conditionInputs = () => [
  controls.delay, controls.jitter, controls.loss, controls.bandwidth, controls.burst,
  controls.duplicate, controls.queue, controls.asymmetric, controls.reverseDelay,
];

export function showConditionValues() {
  $("#delay-out").textContent = `${controls.delay.value} ms`;
  $("#jitter-out").textContent = `±${controls.jitter.value} ms`;
  $("#loss-out").textContent = `${controls.loss.value}%`;
  $("#duplicate-out").textContent = `${controls.duplicate.value}%`;
  $("#reverse-delay-out").textContent = `${controls.reverseDelay.value} ms`;
  controls.reverseDelay.disabled = !controls.asymmetric.checked;
}

export function applyPreset(key) {
  const preset = PRESETS[key];
  if (!preset) return;
  controls.delay.value = preset.delay;
  controls.jitter.value = preset.jitter;
  controls.loss.value = preset.loss;
  controls.bandwidth.value = String(preset.bandwidth);
  controls.burst.value = String(preset.burst ?? 0);
  controls.duplicate.value = preset.duplicate ?? 0;
  controls.queue.value = String(preset.queue ?? 0);
  controls.asymmetric.checked = false;
  controls.reverseDelay.value = preset.delay;
  showConditionValues();
}

export function setupConditions() {
  for (const [key, preset] of Object.entries(PRESETS)) {
    controls.preset.append(new Option(preset.name, key));
  }
  controls.preset.append(new Option("Custom", "custom"));
  controls.preset.addEventListener("change", () => applyPreset(controls.preset.value));
  for (const input of conditionInputs()) {
    input.addEventListener("input", () => {
      controls.preset.value = "custom";
      showConditionValues();
    });
  }
  const more = $("#more-conditions");
  more.addEventListener("click", () => {
    const open = more.getAttribute("aria-expanded") !== "true";
    more.setAttribute("aria-expanded", String(open));
    $("#advanced-conditions").hidden = !open;
  });
  controls.preset.value = "flaky";
  applyPreset("flaky");
  controls.seed.value = String(1 + Math.floor(Math.random() * 99999));
}

// usePreset switches to a preset, for tabs that need a special network.
export function usePreset(key) {
  controls.preset.value = key;
  applyPreset(key);
}

export function conditions() {
  const forward = {
    delayMs: Number(controls.delay.value),
    jitterMs: Number(controls.jitter.value),
    lossPct: Number(controls.loss.value),
    lossBurst: Number(controls.burst.value),
    duplicatePct: Number(controls.duplicate.value),
    bandwidthKbps: Number(controls.bandwidth.value),
    queuePackets: Number(controls.queue.value),
  };
  return forward;
}

// reverseConditions returns the server-to-client link, or null when it is
// the same as the forward link.
export function reverseConditions() {
  if (!controls.asymmetric.checked) return null;
  return { ...conditions(), delayMs: Number(controls.reverseDelay.value) };
}

export function nextSeed() {
  if (!controls.lockSeed.checked) {
    controls.seed.value = String(1 + Math.floor(Math.random() * 99999));
  }
  const seed = Number(controls.seed.value) || 1;
  $("#status-seed").textContent = `seed ${seed}`;
  return seed;
}

/* Simulation */

export function simulate(protocol, messages, extra = {}) {
  const options = {
    protocol,
    conditions: conditions(),
    reverse: reverseConditions(),
    messages: messages.map((m) => ({ atMs: m.atMs ?? 0, data: toBase64(m.data) })),
    ...extra,
  };
  const result = JSON.parse(window.netlab.simulate(JSON.stringify(options)));
  if (result.error) throw new Error(result.error);
  for (const delivery of result.deliveries) delivery.bytes = fromBase64(delivery.data);
  return result;
}

/* Playback clock */

export class Player {
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

export class Ladder {
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

export function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  for (const factor of [1, 2, 5, 10]) {
    if (raw <= factor * power) return factor * power;
  }
  return 10 * power;
}

export function shortLabel(p) {
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

export function describe(p) {
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
export function rebuild(result, t) {
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
export function renderText(target, bytes, have, from = 0, to = bytes.length) {
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

export function renderStats(target, rows) {
  target.replaceChildren();
  for (const [name, value] of rows) {
    target.append(el("dt", "", name), el("dd", "", value));
  }
}

export function dataStats(result) {
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

export function summary(result) {
  const s = result.stats;
  const name = result.protocol.toUpperCase();
  return `${name}: ${s.packetsSent} packets, ${s.packetsLost} lost, ${s.complete ? "complete" : "incomplete"}`;
}

export const players = new Map();

export function playerFor(name) {
  if (!players.has(name)) players.set(name, new Player());
  return players.get(name);
}

export function setupCanvas(canvas) {
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

export function packetStates(result, t) {
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

/* Charts */

// lineChart draws step lines, for values that change at points in time,
// such as a congestion window. Only the part before time t is drawn.
export function lineChart(canvas, series, { xMax, yMax, t = Infinity }) {
  const { ctx, width, height } = setupCanvas(canvas);
  const pad = { left: 42, right: 12, top: 10, bottom: 22 };
  ctx.clearRect(0, 0, width, height);
  const top = Math.max(yMax, 1) * 1.08;
  const x = (v) => pad.left + (v / Math.max(xMax, 1)) * (width - pad.left - pad.right);
  const y = (v) => height - pad.bottom - (Math.min(v, top) / top) * (height - pad.top - pad.bottom);

  ctx.font = "15px VT323, monospace";
  ctx.fillStyle = "#6f8fd8";
  ctx.strokeStyle = "#1e2f5c";
  ctx.lineWidth = 1;
  const yStep = niceStep(top / 5);
  for (let v = 0; v <= top; v += yStep) {
    ctx.beginPath();
    ctx.moveTo(pad.left, y(v));
    ctx.lineTo(width - pad.right, y(v));
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 6, y(v) + 4);
  }
  const xStep = niceStep(xMax / 6);
  for (let v = 0; v <= xMax; v += xStep) {
    ctx.fillText(ms(v), x(v) - 10, height - 5);
  }

  for (const s of series) {
    if (s.points.length === 0) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 2;
    ctx.setLineDash(s.dash ?? []);
    ctx.beginPath();
    let prev = s.points[0];
    if (prev.x > t) continue;
    ctx.moveTo(x(prev.x), y(prev.y));
    for (const point of s.points.slice(1)) {
      if (point.x > t) break;
      ctx.lineTo(x(point.x), y(prev.y));
      ctx.lineTo(x(point.x), y(point.y));
      prev = point;
    }
    ctx.lineTo(x(Math.min(t, s.end ?? xMax)), y(prev.y));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  if (Number.isFinite(t) && t < xMax) {
    ctx.strokeStyle = "#ffffff66";
    ctx.beginPath();
    ctx.moveTo(x(t), pad.top);
    ctx.lineTo(x(t), height - pad.bottom);
    ctx.stroke();
  }
}

// pattern returns n bytes of a repeating, recognizable pattern.
export function pattern(n) {
  const text = encoder.encode("NetLab sends this test file packet by packet. ");
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = text[i % text.length];
  return bytes;
}
