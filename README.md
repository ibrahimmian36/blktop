# blktop

> *iostat, but with the time axis you always wanted.*

`blktop` is a live observatory for the Linux block layer. Every read, every
write, every flush, every discard on every disk on your box flows through
two BPF tracepoints, gets latency-stamped, bucketed on a log scale, and
drawn as a heatmap that rolls across your terminal. It's the iconic eBPF
latency visualization — the one Brendan Gregg has been drawing for a
decade — turned into a top-style tool you can leave open while you work.

It's built on [**yeet**](https://yeet.cx), a runtime that
makes a kernel-side BPF program, a per-tick render loop, and a JS state
model feel like one program.

<!-- To record the demo GIF, run `vhs assets/blktop.tape` on a Linux box
     with yeet installed, then add:
     ![blktop](assets/blktop.gif)
     here. -->

---

## Sixty-second primer

Every disk read or write that crosses the page cache is a **request**.
The kernel hands it to the block layer, which queues it, schedules it,
maybe merges it with neighbors, and eventually ships it to the device.
Time passes. The device finishes. The kernel signals completion. The
elapsed wall-clock between those two moments is the request's **latency**.

That latency is where almost every interesting story lives:

- A 100 µs read is your NVMe being its usual cool self.
- A 5 ms read is a spinning disk doing a seek.
- A 50 ms write is the SSD's controller pausing to do garbage collection,
  or the request waiting behind hundreds of others in the queue.
- A 2 s read is something is very wrong.

Averages destroy this story. The mean of a thousand 100 µs reads and one
2 s read is meaningless; the user staring at a frozen progress bar is
living in the one outlier, not the average. The right tool is a
**distribution over time** — and the right way to draw it is a heatmap
with **log-scale latency on the y axis** and **time on the x axis**.

That's the centerpiece of blktop.

---

## What you're looking at

```
 ▌ BLKTOP · live block I/O observatory ─────────────────────────────────────
● LIVE 04:32   1.2M IOs · 4.1k/s   ▶ 280 MB/s   ◀ 65 MB/s   p50 138µs · p95 2.1ms · p99 28ms   ⚠ 14 slow

  LATENCY × TIME · log-scale y, 10s+ history ──────────────────────────────
     1s │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
  131ms │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▄░░░░░░░░░░░▄░░░░░░░░░░
    8ms │ ░░░░░░░░░░░░▒▒▒▒▒▒░░░░░▒▒▓▓▓▓▒▒▒░▒▒▒░░░░▓░░░▓░░░▒░░▓░░░░░░░░
    1ms │ ▒▒▒▒▒▓▓▓▓▓▓████▓▓▒▒▒▓▓▓▓▓████████▓▓▓▓▓▓▒▒▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓░░
  131µs │ ▓▓▓████████████████▓▓▓▓███████████▓▓▓███████████████████████
    8µs │ ▒▒▒░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
        │
  PER-DEVICE THROUGHPUT             │  TOP I/O PROCESSES · 10s window
nvme0n1  ▂▃▅▇▆▄▂▁  ▶32MB/s ◀8MB/s  │  postgres        pid  812   128MB    245 IOs
sda      ▁▂▂▃▃▂▁▁  ▶4MB/s  ◀1MB/s  │  kworker/u8:2    pid 1284    74MB    198 IOs
                                   │  fluent-bit      pid 4421    32MB     61 IOs

  OPS × TIME · per-op completion rate ───────────────────────────────────
read    │ ▓▓▓██████████████████████████████████████████████████████████
write   │ ▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓▓▒▒▒▒▒▒▒▒
flush   │ ░░░░░░░░░░░░▒░░░░░░░░░░▒░░░░░░░░▒░░░░░░░░░░░░░
discard │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░

  SLOW I/Os · ≥ 20ms, newest first ──────────────────────────────────────
 04:31  ◀ write   nvme0n1    64KB    52ms  pid 812  postgres
 04:30  ▶ read    sda        4KB     38ms  pid 4421 fluent-bit
 04:30  ▶ read    sda        8KB     27ms  pid 4421 fluent-bit
```

### Panel by panel

**Header.** Uptime, total completed I/Os, current IOPS, byte-throughput
broken down into reads (▶) and writes (◀), and the rolling p50/p95/p99
latency over the last ten seconds. The slow counter highlights in red as
soon as anything crosses the 20 ms threshold.

**Latency × time heatmap (the centerpiece).** Each column is a render
tick (≈200 ms wall-clock). Each row is a latency band; the y-axis is
**log scale**, so the band labeled "1ms" actually holds I/Os in the
~1–2 ms range, the next one up holds ~2–4 ms, and so on. The cell color
is the log-normalized count of completions in that (latency, time) cell
— hotter colors mean more I/Os landed there. A healthy system shows a
tight band of color around its native latency; a degraded one shows
that band fraying upward or splitting into two bands.

**Per-device throughput.** One row per recently-active disk, with a
combined-IO sparkline plus the live read/write byte rates. New devices
appear as soon as they see traffic; devices idle for sixty seconds drop
off.

**Top I/O processes.** A leaderboard of processes by bytes-of-I/O over
the last ten seconds, computed from the issuer attribution that blktop
records at request issue time. For buffered writes this surfaces the
flusher kworker (which is the issuer of record from the block layer's
point of view — see caveats below). For direct I/O, reads, and database
log writes, it surfaces the application doing the work.

**Op × time heatmap.** Four rows — read, write, flush, discard — each
one a heat strip of that op's completion rate over time. Lets you see at
a glance whether a workload is read-heavy, write-heavy, or punctuated by
flushes and discards.

**Slow-I/O feed.** Every completion above 20 ms gets logged here with
its op, device, byte size, latency (in red), and the issuing pid/comm.
The most recent are at the top.

---

## How it works

Two BTF-typed tracepoints around the block layer's request lifecycle,
plus a hash map keyed by the request pointer so completions can compute
their own latency:

| BPF program            | hook                              | what it does                                  |
|------------------------|-----------------------------------|-----------------------------------------------|
| `on_issue`             | `tp_btf/block_rq_issue`           | stash `(ktime, pid, comm)` keyed by `rq` ptr  |
| `on_complete`          | `tp_btf/block_rq_complete`        | pop, compute latency, emit one ringbuf record |

The userspace side is one ringbuf subscriber and a `setInterval` tick.
No per-event sorting, no /proc polling, no JSON. Percentiles are
computed straight from the log-scale bucket histogram — at every tick
we sum the per-tick bucket arrays over the rolling window and walk the
cumulative distribution to find p50, p95, and p99. The "value" each
percentile reports is the geometric midpoint of its bucket, which is
the natural reporting point on a log-scale axis.

---

## Requirements

- **Linux ≥ 5.5** for BTF-typed tracepoints. CO-RE handles kernel-struct
  drift across versions.
- **CAP_BPF + CAP_PERFMON** (or root) to load the program.
- **clang** + **bpftool** to build.
- A terminal with 256-color support and Unicode (heat-map cells use the
  256-color background range; axes and braille use Unicode block chars).
- Minimum sensible terminal size: **80 × 28**. Below that the panels
  collapse and you get a "needs larger terminal" message.

---

## Build & run

```sh
make
yeet main.js               # all devices, all I/O
yeet main.js -- --anonymize  # screenshot-safe: aliases comm + disk names
```

To stop, hit `Ctrl-C`. The cursor is restored on exit.

---

## Caveats — read these before you panic at the numbers

- **Pid attribution is the *issuer*, not always the originator.** For
  buffered writes, the application writes to the page cache and the
  flusher kworker issues the block-layer request later. blktop will
  attribute that write to `kworker/u*:*`, which is accurate — the
  kworker is genuinely who handed the request to the block layer — but
  it is not the application that called `write()`. Reads, direct I/O,
  and database log writes go straight to the block layer from the
  application, so those attribute to the app as you'd expect.
- **Latency buckets clamp at the top.** The histogram covers 1 ns up to
  ~2.1 s; anything slower collapses into the top bucket. If your I/O
  regularly takes longer than 2 s, you have other problems.
- **`disk_name` is read from `request->q->disk->disk_name`.** Modern
  kernels. Very old kernels (pre-5.4-ish) had `rq->rq_disk` instead;
  blktop doesn't try to support those.
- **The hash map of in-flight requests caps at 65 536 entries.** Modern
  NVMe drives with 16 queues × 1024 depth can theoretically touch that
  ceiling under torture loads; in practice you'll be fine.
- **Counters are wall-clock-windowed.** Percentiles, byte-rates, and top
  procs are over the last ten seconds. If a slow I/O scrolls off the
  bottom of the slow feed, the slow *counter* in the header still
  remembers it forever (until the next process restart).

---

## License

Apache 2.0.
