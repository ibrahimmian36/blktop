/* Pure terminal-rendering toolkit for blktop: ANSI escapes, color ramps,
 * a braille canvas, and block-I/O-specific formatters (bytes, latency,
 * op types). No application state, no I/O — safe to import anywhere. */

export const ESC = "\x1b[";
export const HOME = `${ESC}H`;
export const CLEAR = `${ESC}2J${ESC}H`;
export const HIDE = `${ESC}?25l`;
export const SHOW = `${ESC}?25h`;
export const RESET = `${ESC}0m`;
export const EOL = `${ESC}K`;
export const bold = `${ESC}1m`;
export const dim = `${ESC}2m`;
export const ital = `${ESC}3m`;
export const fg = (n) => `${ESC}38;5;${n}m`;
export const bg = (n) => `${ESC}48;5;${n}m`;

/* low→high heat ramp and silent slot */
export const HEAT = [17, 18, 19, 20, 26, 32, 39, 45, 51, 50, 48, 46, 82, 118,
  154, 190, 226, 220, 214, 208, 202, 196, 197, 231];
export const SILENT_BG = 234;
export const EIGHTH = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/* op-type palette + names. Keep stable across panels. */
export const C_READ = 84;       /* green */
export const C_WRITE = 215;     /* orange */
export const C_FLUSH = 51;      /* cyan */
export const C_DISCARD = 141;   /* soft purple */
export const C_OTHER = 244;
export const C_SLOW = 196;      /* hot red */
export const C_AXIS = 238;
export const C_DIM = 240;

export const OPS = {
  0: { name: "read",    color: C_READ,    glyph: "▶" },
  1: { name: "write",   color: C_WRITE,   glyph: "◀" },
  2: { name: "flush",   color: C_FLUSH,   glyph: "↧" },
  3: { name: "discard", color: C_DISCARD, glyph: "✗" },
};
export const OP_OTHER = { name: "other", color: C_OTHER, glyph: "·" };
export function opOf(code) { return OPS[code] ?? OP_OTHER; }

/* ---- formatters ---------------------------------------------------- */
export function formatBytes(b) {
  if (b == null || !isFinite(b)) return "—";
  if (b < 1024) return b + "B";
  if (b < 1024 * 1024) {
    const k = b / 1024;
    return (k < 10 ? k.toFixed(1) : Math.round(k)) + "KB";
  }
  if (b < 1024 ** 3) {
    const m = b / (1024 * 1024);
    return (m < 10 ? m.toFixed(1) : Math.round(m)) + "MB";
  }
  const g = b / (1024 ** 3);
  return (g < 10 ? g.toFixed(2) : g.toFixed(1)) + "GB";
}

export function formatBps(bps) { return formatBytes(bps) + "/s"; }

/* Latency in nanoseconds → human units. Three significant figures. */
export function formatLatNs(ns) {
  if (ns == null || !isFinite(ns) || ns < 0) return "—";
  if (ns < 1000) return Math.round(ns) + "ns";
  if (ns < 1e6) {
    const us = ns / 1000;
    return (us < 10 ? us.toFixed(1) : Math.round(us)) + "µs";
  }
  if (ns < 1e9) {
    const ms = ns / 1e6;
    return (ms < 10 ? ms.toFixed(1) : Math.round(ms)) + "ms";
  }
  return (ns / 1e9).toFixed(2) + "s";
}

export function mmss(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}

export function compactNum(n) {
  if (!isFinite(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "G";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(0) + "k";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

/* visible length and ANSI-aware clip/pad */
export function vlen(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").length;
}
export function clip(s, n) {
  s = String(s ?? "");
  if (n <= 0) return "";
  if (s.length <= n) return s;
  if (n === 1) return "…";
  return s.slice(0, n - 1) + "…";
}
export function clipAnsi(s, n) {
  let out = "", vis = 0, i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    if (vis >= n) break;
    out += s[i]; vis++; i++;
  }
  return out + RESET;
}
export function fixw(s, w) {
  const v = vlen(s);
  if (v < w) s = s + " ".repeat(w - v);
  return clipAnsi(s, w);
}
export function padVis(s, n) {
  const pad = n - vlen(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

/* one heat cell: v<0 → idle (dark bg), else a bg-colored block */
export function heatCell(v) {
  if (v < 0) return bg(SILENT_BG) + " " + RESET;
  return bg(HEAT[Math.min(HEAT.length - 1, Math.floor(v * HEAT.length))]) + " " + RESET;
}

/* horizontal gauge: filled ▰ to count, ▱ for the remainder */
export function gauge(frac, width, color) {
  const n = Math.max(0, Math.min(width, Math.round(frac * width)));
  return fg(color) + "▰".repeat(n) + fg(237) + "▱".repeat(width - n) + RESET;
}

/* Braille canvas: each cell packs a 2×4 dot grid, so cw×ch cells give
 * 2cw×4ch pixels. One fg color per cell (last writer wins). (0,0) top-left. */
const BRAILLE_DOT = [[0x01, 0x08], [0x02, 0x10], [0x04, 0x20], [0x40, 0x80]];
export function brailleCanvas(cw, ch) {
  const PW = cw * 2, PH = ch * 4;
  const mask = new Int32Array(cw * ch);
  const color = new Array(cw * ch).fill(0);
  return {
    PW, PH,
    set(px, py, col) {
      if (px < 0 || px >= PW || py < 0 || py >= PH) return;
      const i = (py >> 2) * cw + (px >> 1);
      mask[i] |= BRAILLE_DOT[py & 3][px & 1];
      if (col) color[i] = col;
    },
    rows() {
      const out = [];
      for (let cy = 0; cy < ch; cy++) {
        let line = "";
        for (let cx = 0; cx < cw; cx++) {
          const i = cy * cw + cx, m = mask[i];
          line += m === 0 ? " " : fg(color[i] || 51) + String.fromCodePoint(0x2800 + m) + RESET;
        }
        out.push(line);
      }
      return out;
    },
  };
}

/* braille line/area chart: series = [{data:[0..1|null], color}].
 * Lines connect vertically between samples; fill draws to the baseline. */
export function brailleChart(cw, ch, series, fill) {
  const cv = brailleCanvas(cw, ch);
  const PW = cv.PW, PH = cv.PH;
  for (const s of series) {
    const d = s.data, n = d.length;
    if (!n) continue;
    let prev = null;
    for (let px = 0; px < PW; px++) {
      const t = n === 1 ? 0 : (px / (PW - 1)) * (n - 1);
      const i0 = Math.floor(t), i1 = Math.min(n - 1, i0 + 1), f = t - i0;
      const a = d[i0], b = d[i1];
      if (a == null || b == null) { prev = null; continue; }
      const v = Math.max(0, Math.min(1, a + (b - a) * f));
      const py = Math.round((1 - v) * (PH - 1));
      if (fill) { for (let y = py; y < PH; y++) cv.set(px, y, s.color); }
      else {
        cv.set(px, py, s.color);
        if (prev != null) {
          const lo = Math.min(prev, py), hi = Math.max(prev, py);
          for (let y = lo; y <= hi; y++) cv.set(px, y, s.color);
        }
        prev = py;
      }
    }
  }
  return cv.rows();
}
