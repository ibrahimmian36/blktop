#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_core_read.h>
#include <bpf/bpf_tracing.h>

/* blktop — live block-I/O latency observatory.
 *
 * Two BTF-typed scheduler-style tracepoints around the block layer's
 * request lifecycle, plus a hash map keyed by the request pointer so
 * every completion can subtract its own issue timestamp. The pid/comm
 * captured at issue is the *issuer* of the I/O: that's the application
 * for direct/sync I/O, and the flusher kworker for buffered writeback.
 *
 *   block_rq_issue    →  remember (issue_ns, pid, comm) keyed by rq
 *   block_rq_complete →  pop, compute latency, emit one ringbuf record */

#define DISK_LEN 32              /* matches sizeof(gendisk.disk_name) */
#define COMM_LEN 16              /* matches TASK_COMM_LEN */

/* JS reads this object decoded as `io_evt` (yeet wraps it under the
 * struct name). Field names here are what state.js expects. */
struct io_evt {
    __u64 ts_ns;                 /* completion timestamp (bpf_ktime) */
    __u64 lat_ns;                /* completion - issue, in nanoseconds */
    __u64 sector;                /* starting sector of the request */
    __u32 bytes;                 /* nr_bytes the completion reports */
    __u32 pid;                   /* tgid of the *issuer* (best-effort) */
    __u32 op;                    /* REQ_OP_* (read/write/flush/discard/…) */
    __s32 error;                 /* blk_status_t, 0 == success */
    char  disk[DISK_LEN];        /* gendisk->disk_name, e.g. "nvme0n1" */
    char  comm[COMM_LEN];        /* issuer comm */
};
__attribute__((used)) static const struct io_evt __io_evt_anchor;

/* what we stash at issue time so the completion can compute latency
 * and reconstruct who issued the I/O */
struct issue_info {
    __u64 ts_ns;
    __u32 pid;
    char  comm[COMM_LEN];
};

struct {
    __uint(type, BPF_MAP_TYPE_HASH);
    __uint(max_entries, 65536);  /* enough for high queue-depth NVMe */
    __type(key, __u64);          /* request pointer */
    __type(value, struct issue_info);
} starts SEC(".maps");

struct {
    __uint(type, BPF_MAP_TYPE_RINGBUF);
    __uint(max_entries, 1 << 18);
} events SEC(".maps");

SEC("tp_btf/block_rq_issue")
int BPF_PROG(on_issue, struct request *rq)
{
    struct issue_info info = {};
    info.ts_ns = bpf_ktime_get_ns();
    info.pid   = bpf_get_current_pid_tgid() >> 32;
    bpf_get_current_comm(&info.comm, sizeof(info.comm));
    __u64 key = (__u64)rq;
    bpf_map_update_elem(&starts, &key, &info, BPF_ANY);
    return 0;
}

SEC("tp_btf/block_rq_complete")
int BPF_PROG(on_complete, struct request *rq, int error, unsigned int nr_bytes)
{
    __u64 key = (__u64)rq;
    struct issue_info *info = bpf_map_lookup_elem(&starts, &key);
    if (!info)
        return 0;                /* completion without a paired issue */

    __u64 now = bpf_ktime_get_ns();
    __u64 lat = now - info->ts_ns;

    struct io_evt *e = bpf_ringbuf_reserve(&events, sizeof(*e), 0);
    if (!e) {
        bpf_map_delete_elem(&starts, &key);
        return 0;
    }

    e->ts_ns  = now;
    e->lat_ns = lat;
    e->bytes  = nr_bytes;
    e->error  = error;
    e->pid    = info->pid;
    __builtin_memcpy(e->comm, info->comm, COMM_LEN);

    e->sector = BPF_CORE_READ(rq, __sector);
    /* low 8 bits of cmd_flags hold the operation enum (REQ_OP_MASK) */
    e->op     = BPF_CORE_READ(rq, cmd_flags) & 0xff;
    e->disk[0] = '\0';
    /* gendisk->disk_name, e.g. "sda", "nvme0n1", "vda" */
    BPF_CORE_READ_STR_INTO(&e->disk, rq, q, disk, disk_name);

    bpf_map_delete_elem(&starts, &key);
    bpf_ringbuf_submit(e, 0);
    return 0;
}

char LICENSE[] SEC("license") = "GPL";
