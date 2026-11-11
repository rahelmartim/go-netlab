/* NetLab front end: the tabs and the start-up code. */

import {
  $,
  COLORS,
  Ladder,
  PRESETS,
  Player,
  applyPreset,
  conditions,
  controls,
  dataStats,
  decoder,
  describe,
  el,
  encoder,
  fromBase64,
  ms,
  nextSeed,
  niceStep,
  packetStates,
  pct,
  playerFor,
  players,
  rebuild,
  reducedMotion,
  renderStats,
  renderText,
  setStatus,
  setupCanvas,
  setupConditions,
  shortLabel,
  showConditionValues,
  simulate,
  summary,
  svg,
  toBase64,
} from "./core.js";
import {
  runBench,
  runBuilder,
  runFlavors,
  runOptimizations,
  runOwn,
  setupBench,
  setupBuilder,
  setupFlavors,
  setupOptimizations,
  setupOwn,
} from "./advanced.js";
import { applySharedLink, rememberRun, setupShareButton } from "./share.js";

/* Tabs */

const tabs = [...document.querySelectorAll('[role="tab"]')];
const tabStarted = new Set();
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

function currentTab() {
  return tabs.find((tab) => tab.getAttribute("aria-selected") === "true").id.replace("tab-", "");
}

// guard runs an experiment, shows errors in the status bar, and keeps the
// run in the URL, so that the address bar always has a shareable link.
function guard(fn) {
  return () => {
    setStatus("Simulating…");
    // Let the browser paint the status before a long simulation.
    setTimeout(() => {
      try {
        fn();
        rememberRun(currentTab());
      } catch (error) {
        console.error(error);
        setStatus(`Error: ${error.message}`);
      }
    }, 0);
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
    if (p.retransmit && p.kind === "DATA") events.push([p.sentAt, `Retransmits seq ${p.seq}`, true]);
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
  flavors: guard(runFlavors),
  optim: guard(runOptimizations),
  bench: guard(runBench),
  own: guard(runOwn),
  builder: guard(runBuilder),
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
  setupFlavors();
  setupOptimizations();
  setupBench();
  setupOwn();
  setupBuilder();
  setupShareButton(currentTab, setStatus);
  drawOriginal();
  const shared = applySharedLink(tabs.map((tab) => tab.id.replace("tab-", "")));

  const go = new Go();
  const wasm = await WebAssembly.instantiateStreaming(fetch("netlab.wasm"), go.importObject);
  window.addEventListener(
    "netlab-ready",
    () => {
      setStatus("Ready. Pick a tab and press Send.");
      for (const button of document.querySelectorAll(".btn-go")) button.disabled = false;
      selectTab(shared ? $(`#tab-${shared}`) : tabs.find((tab) => tab.getAttribute("aria-selected") === "true"));
      if (shared) setStatus("Opened a shared link: same network, same seed.");
    },
    { once: true },
  );
  for (const button of document.querySelectorAll(".btn-go")) button.disabled = true;
  go.run(wasm.instance);
}

start().catch(showStartError);
