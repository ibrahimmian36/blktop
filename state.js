/* Application state + ingest for blktop.
 *
 * Two sources feed one model:
 *   • the BPF ring buffer → one event per completed block I/O, carrying
 *     latency, op type, byte count, device name, and the issuer pid/comm
 *   • `advance()` rolls per-tick counters into ring buffers and recomputes
 *     the windowed percentiles from the bucket histogram (no per-event
 *     sort — percentiles come straight from the log-scale histogram). */

export const TICK_MS = 200;          /* render cadence + sample spacing */
export const WINDOW_MS = 10000;      /* rolling window: percentiles, top procs */
export const NB = 32;                /* log2 latency buckets: 2^i ns each */
export const SLOW_THRESH_NS = 20_000_000;  /* ≥ 20 ms goes to the slow log */
const HIST_LEN = 240;                /* ticks of history retained (~48 s) */
const SLOW_KEEP = 200;
const PROCWIN_KEEP = 6000;
const DISK_STALE_MS = 60_000;        /* drop devices idle this long */

/* ---- counters + rolling history ------------------------------------ */
export const startTime = Date.now();
export const tot = { ios: 0, slow: 0, err: 0 };
export let liveIOPS = 0, rdBps = 0, wrBps = 0;
export let p50_ns = 0, p95_ns = 0, p99_ns = 0;

const tickBuckets = new Int32Array(NB);
export const bucketHist = [];        /* Int32Array(NB) per tick */
let tickIO = 0;
export const iopsHist = [];
const tickOps = { 0: 0, 1: 0, 2: 0, 3: 0, other: 0 };
export const opHist = { 0: [], 1: [], 2: [], 3: [], other: [] };
let tickBytesR = 0, tickBytesW = 0;
const bytesRHist = [], bytesWHist = [];

export const disks = new Map();      /* name -> {iops,bytesR,bytesW,hist*,lastSeen} */
function getDisk(name) {
  let d = disks.get(name);
  if (!d) {
    d = { iops: 0, bytesR: 0, bytesW: 0, histIO: [], histR: [], histW: [], lastSeen: Date.now() };
    disks.set(name, d);
  }
  return d;
}

const procWin = [];                  /* {ts, pid, comm, bytes, op} for top-procs */
const slowLog = [];                  /* recent ≥SLOW_THRESH I/Os */

/* ---- anonymize (screenshot-safe relabeling) ------------------------- */
const anon = !!globalThis.yeet?.args?.anonymize;
const aliasMaps = { name: new Map(), disk: new Map() };
function aliasGen(kind, key, prefix) {
  const m = aliasMaps[kind];
  let a = m.get(key);
  if (!a) { a = prefix + String(m.size + 1).padStart(2, "0"); m.set(key, a); }
  return a;
}
export function aName(s) { return anon && s ? aliasGen("name", s, "proc-") : s; }
export function aDisk(s) { return anon && s ? aliasGen("disk", s, "disk-") : s; }

/* ---- helpers ------------------------------------------------------- */
/* log2 bucket; 0 ≤ result < NB. Latencies ≥ 2^(NB-1) ns clamp into top. */
export function bucketOf(latNs) {
  if (latNs < 1) return 0;
  const i = Math.floor(Math.log2(latNs));
  if (i < 0) return 0;
  if (i >= NB) return NB - 1;
  return i;
}
function opKey(op) {
  if (op === 0 || op === 1 || op === 2 || op === 3) return op;
  return "other";
}
function push(arr, v, max) { arr.push(v); if (arr.length > max) arr.shift(); }
function num(v) { return typeof v === "bigint" ? Number(v) : v; }

/* ---- ingest -------------------------------------------------------- */
export function onEvent(e) {
  const now = Date.now();
  const latN = num(e.lat_ns);
  if (!isFinite(latN) || latN < 0) return;
  const op = num(e.op) | 0;
  const bytes = num(e.bytes) >>> 0;
  const disk = String(e.disk || "?");
  const pid = num(e.pid) | 0;
  const comm = String(e.comm || "?");
  const error = num(e.error) | 0;

  tot.ios++; tickIO++;
  if (error !== 0) tot.err++;

  tickBuckets[bucketOf(latN)]++;

  const k = opKey(op);
  tickOps[k]++;
  if (op === 0) tickBytesR += bytes;
  else if (op === 1) tickBytesW += bytes;

  const d = getDisk(disk);
  d.iops++; d.lastSeen = now;
  if (op === 0) d.bytesR += bytes;
  else if (op === 1) d.bytesW += bytes;

  if (pid > 0 && bytes > 0) {
    push(procWin, { ts: now, pid, comm, bytes, op }, PROCWIN_KEEP);
  }
  if (latN >= SLOW_THRESH_NS) {
    tot.slow++;
    push(slowLog, { ts: now, latNs: latN, disk, op, bytes, pid, comm, error }, SLOW_KEEP);
  }
}

/* ---- per-tick roll + derived stats --------------------------------- */
const oneSecTicks = Math.max(1, Math.round(1000 / TICK_MS));

export function advance() {
  const now = Date.now();

  /* roll the per-tick buckets into history */
  const snap = new Int32Array(NB);
  for (let i = 0; i < NB; i++) snap[i] = tickBuckets[i];
  push(bucketHist, snap, HIST_LEN);
  tickBuckets.fill(0);

  push(iopsHist, tickIO, HIST_LEN); tickIO = 0;
  for (const k of [0, 1, 2, 3, "other"]) {
    push(opHist[k], tickOps[k], HIST_LEN); tickOps[k] = 0;
  }
  push(bytesRHist, tickBytesR, HIST_LEN); tickBytesR = 0;
  push(bytesWHist, tickBytesW, HIST_LEN); tickBytesW = 0;

  /* per-device roll + stale-device reaping */
  for (const [name, d] of disks) {
    push(d.histIO, d.iops, HIST_LEN);
    push(d.histR, d.bytesR, HIST_LEN);
    push(d.histW, d.bytesW, HIST_LEN);
    d.iops = 0; d.bytesR = 0; d.bytesW = 0;
    if (now - d.lastSeen > DISK_STALE_MS) disks.delete(name);
  }

  /* prune the per-process window log */
  while (procWin.length && now - procWin[0].ts > WINDOW_MS) procWin.shift();

  /* IOPS and throughput over the last second (5 ticks at TICK_MS=200) */
  liveIOPS = sumTail(iopsHist, oneSecTicks);
  rdBps = sumTail(bytesRHist, oneSecTicks);
  wrBps = sumTail(bytesWHist, oneSecTicks);

  /* percentiles from the windowed bucket histogram — no per-event sort */
  const winTicks = Math.round(WINDOW_MS / TICK_MS);
  const winCounts = new Int32Array(NB);
  const start = Math.max(0, bucketHist.length - winTicks);
  for (let t = start; t < bucketHist.length; t++) {
    const a = bucketHist[t];
    for (let i = 0; i < NB; i++) winCounts[i] += a[i];
  }
  const total = winCounts.reduce((a, b) => a + b, 0);
  if (total > 0) {
    p50_ns = percentile(winCounts, total, 0.50);
    p95_ns = percentile(winCounts, total, 0.95);
    p99_ns = percentile(winCounts, total, 0.99);
  } else {
    p50_ns = 0; p95_ns = 0; p99_ns = 0;
  }
}

function sumTail(arr, n) {
  const start = Math.max(0, arr.length - n);
  let s = 0;
  for (let i = start; i < arr.length; i++) s += arr[i];
  return s;
}
function percentile(counts, total, frac) {
  const target = Math.max(1, Math.round(total * frac));
  let acc = 0;
  for (let i = 0; i < NB; i++) {
    acc += counts[i];
    if (acc >= target) return Math.pow(2, i + 0.5); /* geometric midpoint */
  }
  return Math.pow(2, NB - 1);
}

/* ---- accessors ----------------------------------------------------- */
export function topProcs(n) {
  const now = Date.now();
  const agg = new Map();
  for (const e of procWin) {
    if (now - e.ts > WINDOW_MS) continue;
    let a = agg.get(e.pid);
    if (!a) { a = { pid: e.pid, comm: e.comm, bytes: 0, ios: 0 }; agg.set(e.pid, a); }
    a.bytes += e.bytes; a.ios++; a.comm = e.comm;
  }
  return [...agg.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n);
}
export function recentSlow(n) { return slowLog.slice(-n).reverse(); }
export function disksByActivity(n) {
  return [...disks.entries()]
    .filter(([, d]) => sumTail(d.histIO, oneSecTicks * 5) > 0)
    .sort((a, b) => sumTail(b[1].histIO, oneSecTicks * 5) - sumTail(a[1].histIO, oneSecTicks * 5))
    .slice(0, n);
}
