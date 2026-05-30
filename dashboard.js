/* Dashboard composition for blktop. Same layout idioms as xtop/airtop —
 * full-width strips plus a zip()'d split row — but the panels are tuned
 * for block I/O. The signature visual is the latency heatmap: log-scale
 * latency on the y-axis, time on the x, color = log-normalized count. */

import {
  fg, bg, bold, dim, ital, RESET, EOL,
  HEAT, SILENT_BG, EIGHTH,
  OPS, OP_OTHER, opOf,
  C_READ, C_WRITE, C_FLUSH, C_DISCARD, C_OTHER, C_SLOW, C_AXIS, C_DIM,
  heatCell, mmss, compactNum, vlen, clipAnsi, fixw, padVis,
  formatBytes, formatBps, formatLatNs,
} from "./render.js";
import {
  tot, liveIOPS, rdBps, wrBps, p50_ns, p95_ns, p99_ns,
  bucketHist, iopsHist, opHist,
  disks, topProcs, recentSlow, disksByActivity,
  aName, aDisk, startTime,
  TICK_MS, WINDOW_MS, NB, SLOW_THRESH_NS,
} from "./state.js";

const MIN_COLS = 80;
const MIN_ROWS = 28;

/* ---- layout helpers (mirror xtop/airtop) --------------------------- */
function topRule(C, title) {
  const head = ` ▌ ${title} `;
  return bold + fg(51) + head + RESET + fg(C_AXIS) +
    "─".repeat(Math.max(0, C - head.length)) + RESET + EOL;
}
function botRule(C) { return fg(C_AXIS) + "─".repeat(C) + RESET + EOL; }
function sectionBar(C, text) {
  return `${fg(45)}  ${text} ${fg(C_AXIS)}${"─".repeat(Math.max(0, C - vlen(text) - 3))}${RESET}${EOL}`;
}
function sectionTitle(lw, left, right) {
  return `${fg(45)}${left}${" ".repeat(Math.max(1, lw - left.length))}${fg(C_AXIS)}│ ` +
    `${fg(45)}${right}${RESET}${EOL}`;
}
function zip(L, R, lw, rw, rows) {
  const h = Math.max(L.length, R.length);
  const bl = " ".repeat(lw), br = " ".repeat(rw);
  for (let i = 0; i < h; i++)
    rows.push(`${L[i] ?? bl}${fg(C_AXIS)}│${RESET} ${R[i] ?? br}${EOL}`);
}

/* ---- panel: header status line ------------------------------------- */
function headerLine(C) {
  const live = bold + fg(46) + "●" + RESET + fg(252) + " LIVE " + RESET;
  const up = fg(C_DIM) + mmss(Date.now() - startTime) + RESET;
  const ios = fg(252) + compactNum(tot.ios) + RESET + fg(C_DIM) + " IOs" + RESET;
  const iops = fg(252) + compactNum(liveIOPS) + RESET + fg(C_DIM) + "/s" + RESET;
  const rd = fg(C_READ) + "▶" + RESET + " " + fg(252) + formatBps(rdBps) + RESET;
  const wr = fg(C_WRITE) + "◀" + RESET + " " + fg(252) + formatBps(wrBps) + RESET;
  const p50 = fg(C_DIM) + "p50 " + RESET + fg(252) + formatLatNs(p50_ns) + RESET;
  const p95 = fg(C_DIM) + "p95 " + RESET + fg(252) + formatLatNs(p95_ns) + RESET;
  const p99 = fg(C_DIM) + "p99 " + RESET + fg(252) + formatLatNs(p99_ns) + RESET;
  const slowC = tot.slow > 0 ? fg(C_SLOW) + "⚠ " + tot.slow + " slow" + RESET : fg(C_DIM) + "0 slow" + RESET;
  const SEP = fg(C_DIM) + " · " + RESET;
  const parts = [live + up, ios + " " + iops, rd, wr, p50 + SEP + p95 + SEP + p99, slowC];
  let line = parts.join(fg(C_DIM) + "   " + RESET);
  if (vlen(line) > C) line = clipAnsi(line, C);
  return clipAnsi(line, C) + EOL;
}

/* ---- panel: latency heatmap (signature) ---------------------------- */
/* Display range: buckets 8..NB-1 (≈256ns to ~2.1s). Sub-256ns latencies
 * are merged into the bottom display row so no count is lost. */
const B_MIN_DISP = 8;
const DECADE_LABELS = [
  { b: 10, label: "1µs" },
  { b: 13, label: "8µs" },
  { b: 17, label: "131µs" },
  { b: 20, label: "1ms" },
  { b: 23, label: "8ms" },
  { b: 27, label: "131ms" },
  { b: 30, label: "1s" },
];
function labelForRowRange(bStart, bEnd) {
  for (const d of DECADE_LABELS) if (d.b >= bStart && d.b < bEnd) return d.label;
  return "";
}

function panelLatencyHeatmap(C, H) {
  if (H < 4) return [];
  const labelW = 8;            /* "  100ms " */
  const sepW = 2;              /* "│ "       */
  const stripW = C - labelW - sepW;
  if (stripW < 10) return [];

  const visTicks = Math.min(stripW, bucketHist.length);
  const histStart = bucketHist.length - visTicks;
  const range = NB - B_MIN_DISP;          /* 24 buckets for display */

  /* For each display row k (0 = top = highest latency), compute bucket
   * range and aggregate counts across the visible tick window. */
  const rows = new Array(H);
  let maxCount = 0;
  for (let k = 0; k < H; k++) {
    const inv = H - 1 - k;
    let bStart = B_MIN_DISP + Math.floor(inv * range / H);
    const bEnd = B_MIN_DISP + Math.floor((inv + 1) * range / H);
    if (k === H - 1) bStart = 0;          /* bottom row absorbs <256ns */
    const counts = new Int32Array(visTicks);
    for (let t = 0; t < visTicks; t++) {
      const arr = bucketHist[histStart + t];
      let s = 0;
      for (let b = bStart; b < bEnd; b++) s += arr[b];
      counts[t] = s;
      if (s > maxCount) maxCount = s;
    }
    rows[k] = { counts, bStart, bEnd };
  }

  /* Log-normalize: tames the long tail typical of I/O count distributions. */
  const logMax = Math.log(1 + maxCount);
  const norm = (v) => maxCount > 0 ? Math.log(1 + v) / logMax : -1;

  const out = [];
  for (let k = 0; k < H; k++) {
    const { counts, bStart, bEnd } = rows[k];
    const label = labelForRowRange(bStart, bEnd);
    const axis = fg(C_AXIS) + (label || "").padStart(labelW - 1) + " │" + RESET;
    let strip = "";
    const lead = stripW - visTicks;
    for (let i = 0; i < lead; i++) strip += heatCell(-1);
    for (let i = 0; i < visTicks; i++) {
      const v = counts[i];
      strip += v > 0 ? heatCell(norm(v)) : heatCell(-1);
    }
    out.push(axis + " " + strip + EOL);
  }
  return out;
}

/* ---- panel: per-device throughput sparklines ----------------------- */
/* Layout: device(10) + sp + sparkline + sp + ▶rate(12) + sp + ◀rate(12).
 * Visible chars: 10 + 1 + trail + 1 + 12 + 1 + 12 = trail + 37. */
function panelPerDevice(W, H) {
  const list = disksByActivity(H);
  if (list.length === 0) {
    return [fg(C_DIM) + ital + "  no active devices yet…" + RESET];
  }
  const out = [];
  const trailCols = Math.max(4, W - 37);
  for (const [name, d] of list) {
    if (out.length >= H) break;
    const nm = fixw(fg(252) + aDisk(name) + RESET, 10);
    const rdNow = d.histR.slice(-5).reduce((a, b) => a + b, 0);
    const wrNow = d.histW.slice(-5).reduce((a, b) => a + b, 0);
    const rdTxt = fg(C_READ) + "▶" + RESET + fg(252) + fixw(formatBps(rdNow), 11) + RESET;
    const wrTxt = fg(C_WRITE) + "◀" + RESET + fg(252) + fixw(formatBps(wrNow), 11) + RESET;
    const trail = sparkline(d.histIO, trailCols);
    out.push(nm + " " + trail + " " + rdTxt + " " + wrTxt);
  }
  /* pad to fixed H so the zip aligns */
  while (out.length < H) out.push(" ".repeat(W));
  return out;
}

function sparkline(hist, w) {
  if (w <= 0 || hist.length === 0) return " ".repeat(Math.max(0, w));
  const vis = Math.min(w, hist.length);
  const start = hist.length - vis;
  let max = 0;
  for (let i = start; i < hist.length; i++) if (hist[i] > max) max = hist[i];
  let out = "";
  for (let i = 0; i < w - vis; i++) out += " ";
  if (max === 0) {
    for (let i = 0; i < vis; i++) out += fg(C_DIM) + EIGHTH[0] + RESET;
  } else {
    for (let i = 0; i < vis; i++) {
      const v = hist[start + i] / max;
      const idx = Math.max(1, Math.min(8, Math.round(v * 8)));
      out += fg(45) + EIGHTH[idx] + RESET;
    }
  }
  return out;
}

/* ---- panel: top I/O processes -------------------------------------- */
/* Layout: comm + sp + pid(9) + sp + bytes(8) + 2sp + ios.
 * Visible: commW + 21 + iosLen; iosLen ≤ 8 ("1.5k IOs").
 * Below ~39 cols the IOs column drops out so a 10-wide comm still fits. */
function panelTopProcs(W, H) {
  const list = topProcs(H);
  if (list.length === 0) return [fg(C_DIM) + ital + "  no process attributed I/O yet…" + RESET];
  const showIos = W >= 39;
  const commW = Math.min(13, Math.max(10, W - 29));
  const out = [];
  for (let i = 0; i < Math.min(H, list.length); i++) {
    const p = list[i];
    const comm = fixw(fg(252) + aName(p.comm) + RESET, commW);
    const pid = fg(C_DIM) + ("pid " + p.pid).padEnd(9) + RESET;
    const bytes = fg(C_READ) + fixw(formatBytes(p.bytes), 8) + RESET;
    const ios = showIos ? "  " + fg(C_DIM) + compactNum(p.ios) + " IOs" + RESET : "";
    const line = comm + " " + pid + " " + bytes + ios;
    out.push(clipAnsi(line, W));
  }
  while (out.length < H) out.push(" ".repeat(W));
  return out;
}

/* ---- panel: op-type rate heatmap ----------------------------------- */
const OP_ROWS = [
  { key: 0, label: "read",    color: C_READ },
  { key: 1, label: "write",   color: C_WRITE },
  { key: 2, label: "flush",   color: C_FLUSH },
  { key: 3, label: "discard", color: C_DISCARD },
];
function panelOpHeatmap(C) {
  const labelW = 9;
  const stripW = C - labelW - 2;
  if (stripW < 8) return [];
  const rows = [];
  for (const r of OP_ROWS) {
    const hist = opHist[r.key];
    const vis = Math.min(stripW, hist.length);
    const start = hist.length - vis;
    let max = 0;
    for (let i = start; i < hist.length; i++) if (hist[i] > max) max = hist[i];
    let strip = "";
    for (let i = 0; i < stripW - vis; i++) strip += heatCell(-1);
    if (max === 0) {
      for (let i = 0; i < vis; i++) strip += heatCell(-1);
    } else {
      for (let i = 0; i < vis; i++) {
        const v = hist[start + i];
        strip += v > 0 ? heatCell(v / max) : heatCell(-1);
      }
    }
    const labelTxt = fg(r.color) + r.label + RESET;
    const axis = padVis(labelTxt, labelW - 1) + fg(C_AXIS) + " │" + RESET;
    rows.push(axis + " " + strip + EOL);
  }
  return rows;
}

/* ---- panel: slow-I/O feed ------------------------------------------ */
function panelSlowFeed(C, H) {
  const list = recentSlow(H);
  if (list.length === 0) {
    return [fg(C_DIM) + ital + "  no slow I/Os (threshold " + formatLatNs(SLOW_THRESH_NS) + ")…" + RESET];
  }
  const out = [];
  for (let i = 0; i < Math.min(H, list.length); i++) {
    const e = list[i];
    const ts = fg(C_DIM) + mmss(Math.max(0, e.ts - startTime)) + RESET;
    const op = opOf(e.op);
    const opTxt = fg(op.color) + op.glyph + " " + op.name.padEnd(7) + RESET;
    const disk = fg(252) + fixw(aDisk(e.disk) || "?", 10) + RESET;
    const bytes = fg(C_DIM) + fixw(formatBytes(e.bytes), 7) + RESET;
    const lat = fg(C_SLOW) + bold + fixw(formatLatNs(e.latNs), 8) + RESET;
    const proc = e.pid > 0 ? fg(C_DIM) + " pid " + e.pid + " " + RESET + fg(248) + aName(e.comm) + RESET : "";
    const err = e.error !== 0 ? "  " + fg(C_SLOW) + "err=" + e.error + RESET : "";
    const line = " " + ts + "  " + opTxt + " " + disk + " " + bytes + " " + lat + proc + err;
    out.push(clipAnsi(line, C));
  }
  while (out.length < H) out.push(" ".repeat(C));
  return out;
}

/* ---- top-level composition ----------------------------------------- */
export function renderDashboard(C, R) {
  if (C < MIN_COLS || R < MIN_ROWS) {
    return clearScreen() + smallTerm(C, R);
  }
  const rows = [];

  /* chrome */
  rows.push(topRule(C, "BLKTOP · live block I/O observatory"));
  rows.push(headerLine(C));
  rows.push("");

  /* adaptive content sizing */
  const showOp = R >= 36;
  const showMid = R >= 30;
  /* lines used by titles/blanks: top+header+blank+heatTitle+blank+(midTitle+blank?)
   * +(opTitle+blank?)+slowTitle+bottomRule */
  let chrome = 2 /* top + header */ + 1 /* blank */
             + 1 /* heat title */ + 1 /* blank */
             + (showMid ? 1 + 1 : 0)
             + (showOp ? 1 + 1 : 0)
             + 1 /* slow title */
             + 1 /* bottom rule */;
  const content = R - chrome - (showOp ? OP_ROWS.length : 0);
  const heatH = Math.max(7, Math.round(content * (showMid ? 0.55 : 0.65)));
  const midH = showMid ? Math.max(4, Math.round(content * 0.25)) : 0;
  const slowH = Math.max(3, content - heatH - midH);

  /* signature: latency heatmap */
  rows.push(sectionBar(C, "LATENCY × TIME · log-scale y, " + Math.round(WINDOW_MS / 1000) + "s+ history"));
  const heat = panelLatencyHeatmap(C, heatH);
  for (let i = 0; i < heatH; i++) rows.push(heat[i] ?? " ".repeat(C));

  /* mid row: per-device | top processes */
  if (showMid) {
    rows.push("");
    const lw = Math.floor((C - 2) * 0.58);   /* left a bit wider for sparkline */
    const rw = C - lw - 2;
    rows.push(sectionTitle(lw, "PER-DEVICE THROUGHPUT", "TOP I/O PROCESSES · " + Math.round(WINDOW_MS / 1000) + "s window"));
    const L = panelPerDevice(lw, midH);
    const R2 = panelTopProcs(rw, midH);
    zip(L, R2, lw, rw, rows);
  }

  /* op-type heatmap */
  if (showOp) {
    rows.push("");
    rows.push(sectionBar(C, "OPS × TIME · per-op completion rate"));
    const op = panelOpHeatmap(C);
    for (const line of op) rows.push(line);
  }

  /* slow-I/O feed */
  rows.push("");
  rows.push(sectionBar(C, "SLOW I/Os · ≥ " + formatLatNs(SLOW_THRESH_NS) + ", newest first"));
  const slow = panelSlowFeed(C, slowH);
  for (let i = 0; i < slowH; i++) rows.push(slow[i] ?? " ".repeat(C));

  rows.push(botRule(C));

  /* clip to R rows and join */
  const out = rows.slice(0, R).map((l) => l.endsWith(EOL) || l.includes("\x1b[K") ? l : l + EOL);
  return clearScreen() + out.join("\n");
}

export function clearScreen() {
  return "\x1b[H\x1b[2J";
}

function smallTerm(C, R) {
  /* Keep the message itself within the available width. */
  const lines = [
    `blktop: terminal too small`,
    `need ≥ ${MIN_COLS}×${MIN_ROWS}`,
    `have ${C}×${R}`,
  ];
  return lines.map((l) => l.slice(0, Math.max(1, C))).join("\n") + "\n";
}
