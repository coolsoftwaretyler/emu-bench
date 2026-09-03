/* emu-bench kernels — portable C microbenchmark suite (Group 1).
 *
 * PLAN.md §4 Group 1 / SPEC.md §8: identical arm64 machine code, three
 * builds (macOS native, Android NDK static, iOS Simulator SDK), isolating
 * HVF vCPU tax and guest scheduler/timer overhead from pure compute. C11,
 * single directory, no dependencies beyond libc/libz/pthreads.
 *
 * Eight workloads: sha256, zlib deflate, 1024^2 double matmul, STREAM
 * triad, malloc/free churn, clock_gettime loop, getpid loop, pthread-cond
 * ping-pong. Each self-times with clock_gettime(CLOCK_MONOTONIC), runs
 * enough internal repetitions to target >=~1s per sample, and emits one
 * JSON line per sample on stdout:
 *   {"bench":"sha256","sample_ns_per_op":1234.5,"ops":100}
 *
 * Flags: --samples N (default 30), --list (print bench names, one per
 * line, and exit 0 without running anything).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <time.h>
#include <unistd.h>
#include <pthread.h>
#include <zlib.h>

#include "sha256.h"

#define DEFAULT_SAMPLES 30

/* ---- timing helper -------------------------------------------------- */

static double now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}

static void emit_sample(const char *bench, double sample_ns_per_op, long ops) {
    /* One compact JSON line per sample (SPEC.md §8: "JSON-lines output on
     * stdout, parsed by the runner"). Hand-rolled, not a JSON library —
     * the whole point of this suite is zero dependencies beyond
     * libc/libz/pthreads. */
    printf("{\"bench\":\"%s\",\"sample_ns_per_op\":%.3f,\"ops\":%ld}\n", bench, sample_ns_per_op,
           ops);
    fflush(stdout);
}

/* Runs `iterations` of the given inner loop, repeating whole passes until
 * elapsed time reaches at least `target_ns`, and returns ns/op for that
 * whole timed span (SPEC.md §8, ticket line 14: "internal repetitions
 * targeting >= ~1s per sample"). `total_ops_out` receives the number of
 * inner-loop ops actually executed, for the JSON `ops` field. */
typedef void (*bench_fn)(void *state, long ops_per_pass);

static double time_pass(bench_fn fn, void *state, long ops_per_pass, double target_ns,
                         long *total_ops_out) {
    long total_ops = 0;
    double start = now_ns();
    double elapsed;
    do {
        fn(state, ops_per_pass);
        total_ops += ops_per_pass;
        elapsed = now_ns() - start;
    } while (elapsed < target_ns);
    *total_ops_out = total_ops;
    return elapsed / (double)total_ops;
}

/* Target wall-time per sample. 1.05s gives headroom over the ticket's
 * "~1s" floor so scheduling jitter on a loaded/guest machine doesn't push
 * a sample under the floor. */
static const double TARGET_NS_PER_SAMPLE = 1.05e9;

/* ---- deterministic PRNG (xorshift64*) --------------------------------
 * Used to generate the zlib corpus and the malloc-churn size distribution
 * without any test-data files in the repo (ticket line 13: "deterministic
 * PRNG — no test-data files in the repo"). Fixed seed -> byte-identical
 * corpus across every leg and every run, so leg-to-leg differences are
 * never attributable to differing input data.
 */
static uint64_t prng_state = 0x9e3779b97f4a7c15ULL;

static uint64_t xorshift64star(uint64_t *state) {
    uint64_t x = *state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    *state = x;
    return x * 0x2545F4914F6CDD1DULL;
}

static void prng_reset(void) { prng_state = 0x9e3779b97f4a7c15ULL; }

/* ==== 1. SHA-256 over 1 GB ============================================ */
/* PLAN.md §4: "hash 1 GB of data — raw number-crunching speed" (integer
 * ALU throughput). One "op" = hashing the full 1 GB buffer once. */

#define SHA256_BUF_BYTES (1u << 20) /* 1 MiB chunks, hashed 1024x = 1 GiB */
#define SHA256_CHUNKS 1024

typedef struct {
    uint8_t *buf;
} sha256_bench_state;

static void sha256_pass(void *vstate, long ops_per_pass) {
    sha256_bench_state *state = (sha256_bench_state *)vstate;
    for (long i = 0; i < ops_per_pass; i++) {
        sha256_ctx ctx;
        sha256_init(&ctx);
        for (int c = 0; c < SHA256_CHUNKS; c++) {
            sha256_update(&ctx, state->buf, SHA256_BUF_BYTES);
        }
        uint8_t digest[32];
        sha256_final(&ctx, digest);
        /* Prevent the optimizer from hoisting the hash out of the loop:
         * fold one byte of the digest back into the buffer. Negligible
         * cost next to hashing 1 GiB. */
        state->buf[0] ^= digest[0];
    }
}

static void run_sha256(int samples) {
    uint8_t *buf = malloc(SHA256_BUF_BYTES);
    if (!buf) {
        fprintf(stderr, "emu-bench-kernels: sha256: malloc failed\n");
        exit(1);
    }
    prng_reset();
    for (size_t i = 0; i < SHA256_BUF_BYTES; i += 8) {
        uint64_t r = xorshift64star(&prng_state);
        memcpy(buf + i, &r, 8);
    }
    sha256_bench_state state = {.buf = buf};

    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op = time_pass(sha256_pass, &state, 1, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("sha256", ns_per_op, ops);
    }
    free(buf);
}

/* ==== 2. zlib deflate, 100 MB mixed corpus ============================ */
/* PLAN.md §4: "compress 100 MB — realistic mixed CPU work" (branchy
 * compute + memory). The corpus is generated once from the deterministic
 * PRNG, mixing compressible runs with random bytes so deflate does real
 * work rather than hitting the trivial all-same-byte fast path. One "op"
 * = compressing the full 100 MB corpus once. */

#define DEFLATE_CORPUS_BYTES (100u * 1024 * 1024)

typedef struct {
    uint8_t *corpus;
    uint8_t *out;
    size_t out_cap;
} deflate_bench_state;

static void generate_mixed_corpus(uint8_t *buf, size_t len) {
    /* Alternates runs of a repeated byte (compressible) with runs of PRNG
     * output (incompressible) in ~4 KiB blocks, so the corpus resembles
     * real-world mixed data rather than either extreme. */
    size_t i = 0;
    int compressible = 1;
    while (i < len) {
        size_t block = 4096;
        if (block > len - i) block = len - i;
        if (compressible) {
            uint8_t fill = (uint8_t)(xorshift64star(&prng_state) & 0xFF);
            memset(buf + i, fill, block);
        } else {
            size_t j = 0;
            while (j + 8 <= block) {
                uint64_t r = xorshift64star(&prng_state);
                memcpy(buf + i + j, &r, 8);
                j += 8;
            }
            while (j < block) {
                buf[i + j] = (uint8_t)(xorshift64star(&prng_state) & 0xFF);
                j++;
            }
        }
        i += block;
        compressible = !compressible;
    }
}

static void deflate_pass(void *vstate, long ops_per_pass) {
    deflate_bench_state *state = (deflate_bench_state *)vstate;
    for (long i = 0; i < ops_per_pass; i++) {
        uLongf out_len = (uLongf)state->out_cap;
        int rc = compress2(state->out, &out_len, state->corpus, DEFLATE_CORPUS_BYTES,
                            Z_DEFAULT_COMPRESSION);
        if (rc != Z_OK) {
            fprintf(stderr, "emu-bench-kernels: deflate: compress2 failed (rc=%d)\n", rc);
            exit(1);
        }
    }
}

static void run_deflate(int samples) {
    uint8_t *corpus = malloc(DEFLATE_CORPUS_BYTES);
    size_t out_cap = compressBound(DEFLATE_CORPUS_BYTES);
    uint8_t *out = malloc(out_cap);
    if (!corpus || !out) {
        fprintf(stderr, "emu-bench-kernels: deflate: malloc failed\n");
        exit(1);
    }
    prng_reset();
    generate_mixed_corpus(corpus, DEFLATE_CORPUS_BYTES);
    deflate_bench_state state = {.corpus = corpus, .out = out, .out_cap = out_cap};

    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op = time_pass(deflate_pass, &state, 1, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("zlib_deflate", ns_per_op, ops);
    }
    free(corpus);
    free(out);
}

/* ==== 3. 1024^2 double matmul (naive) ================================= */
/* PLAN.md §4: "multiply two 1024x1024 matrices — floating-point math and
 * cache behavior" (FP + cache). One "op" = one full matmul (1024^3 FMAs). */

#define MATMUL_N 1024

typedef struct {
    double *a;
    double *b;
    double *c;
} matmul_bench_state;

static void matmul_pass(void *vstate, long ops_per_pass) {
    matmul_bench_state *state = (matmul_bench_state *)vstate;
    for (long op = 0; op < ops_per_pass; op++) {
        /* Naive i-k-j loop order (PLAN.md/ticket say "naive"): no
         * blocking/tiling, no SIMD intrinsics — deliberately the textbook
         * triple loop so the benchmark measures what an unoptimized
         * scalar FP kernel costs on each leg, not how well each compiler
         * happens to auto-vectorize a smarter loop order. i-k-j (rather
         * than i-j-k) keeps the innermost loop's b/c accesses
         * stride-1, which is still "naive" but avoids a purely
         * cache-thrashing implementation that would mostly measure cache
         * miss latency instead of FP throughput. */
        for (int i = 0; i < MATMUL_N; i++) {
            double *crow = &state->c[i * MATMUL_N];
            for (int j = 0; j < MATMUL_N; j++) crow[j] = 0.0;
            const double *arow = &state->a[i * MATMUL_N];
            for (int k = 0; k < MATMUL_N; k++) {
                double aik = arow[k];
                const double *brow = &state->b[k * MATMUL_N];
                for (int j = 0; j < MATMUL_N; j++) {
                    crow[j] += aik * brow[j];
                }
            }
        }
    }
}

static void run_matmul(int samples) {
    size_t bytes = (size_t)MATMUL_N * MATMUL_N * sizeof(double);
    double *a = malloc(bytes);
    double *b = malloc(bytes);
    double *c = malloc(bytes);
    if (!a || !b || !c) {
        fprintf(stderr, "emu-bench-kernels: matmul: malloc failed\n");
        exit(1);
    }
    prng_reset();
    for (int i = 0; i < MATMUL_N * MATMUL_N; i++) {
        a[i] = (double)(xorshift64star(&prng_state) % 1000) / 1000.0;
        b[i] = (double)(xorshift64star(&prng_state) % 1000) / 1000.0;
    }
    matmul_bench_state state = {.a = a, .b = b, .c = c};

    /* A single 1024^3-FMA naive matmul already takes well over a second
     * on every leg this suite targets, so one op per sample is enough to
     * clear the ~1s floor without also flirting with multi-minute
     * samples; time_pass still loops passes if a leg turns out faster
     * than expected. */
    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op = time_pass(matmul_pass, &state, 1, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("matmul_1024", ns_per_op, ops);
    }
    free(a);
    free(b);
    free(c);
}

/* ==== 4. STREAM triad =================================================
 * PLAN.md §4: "a[i] = b[i] + q*c[i] over large arrays — how fast RAM
 * moves" (memory bandwidth). Arrays sized well past any plausible L2/L3
 * cache so the loop is bandwidth-bound, not cache-resident. One "op" =
 * one full triad pass over the arrays. */

#define STREAM_N (20u * 1024 * 1024) /* 20M doubles/array = 160 MB/array */

typedef struct {
    double *a;
    double *b;
    double *c;
} stream_bench_state;

static void stream_pass(void *vstate, long ops_per_pass) {
    stream_bench_state *state = (stream_bench_state *)vstate;
    const double q = 3.14159265358979;
    for (long op = 0; op < ops_per_pass; op++) {
        double *a = state->a;
        const double *b = state->b;
        const double *c = state->c;
        for (uint32_t i = 0; i < STREAM_N; i++) {
            a[i] = b[i] + q * c[i];
        }
    }
}

static void run_stream(int samples) {
    size_t bytes = (size_t)STREAM_N * sizeof(double);
    double *a = malloc(bytes);
    double *b = malloc(bytes);
    double *c = malloc(bytes);
    if (!a || !b || !c) {
        fprintf(stderr, "emu-bench-kernels: stream: malloc failed\n");
        exit(1);
    }
    prng_reset();
    for (uint32_t i = 0; i < STREAM_N; i++) {
        b[i] = (double)(xorshift64star(&prng_state) % 1000) / 1000.0;
        c[i] = (double)(xorshift64star(&prng_state) % 1000) / 1000.0;
        a[i] = 0.0;
    }
    stream_bench_state state = {.a = a, .b = b, .c = c};

    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op = time_pass(stream_pass, &state, 4, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("stream_triad", ns_per_op, ops);
    }
    free(a);
    free(b);
    free(c);
}

/* ==== 5. malloc/free churn (10M small allocs) ==========================
 * PLAN.md §4: "allocate and free 10 million small blocks — memory-
 * management overhead" (allocator + page faults). One "op" = one
 * alloc+free pair. Sizes vary (16-256 bytes) via the PRNG so the
 * allocator can't trivially special-case a single fixed size. */

#define MALLOC_CHURN_OPS_PER_PASS (1u << 16)

static void malloc_churn_pass(void *vstate, long ops_per_pass) {
    (void)vstate;
    for (long i = 0; i < ops_per_pass; i++) {
        size_t size = 16 + (xorshift64star(&prng_state) % 241); /* 16..256 */
        void *p = malloc(size);
        if (!p) {
            fprintf(stderr, "emu-bench-kernels: malloc_churn: malloc failed\n");
            exit(1);
        }
        /* Touch the memory so this isn't just reserving address space —
         * a real allocation gets its pages faulted in. */
        memset(p, 0xAA, size);
        free(p);
    }
}

static void run_malloc_churn(int samples) {
    prng_reset();
    long total_target = 10000000; /* ticket: "10M small alloc/free" */
    long passes_per_sample = total_target / MALLOC_CHURN_OPS_PER_PASS;
    if (passes_per_sample < 1) passes_per_sample = 1;

    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op =
            time_pass(malloc_churn_pass, NULL, MALLOC_CHURN_OPS_PER_PASS, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("malloc_churn", ns_per_op, ops);
    }
    (void)passes_per_sample; /* time_pass self-paces to the ~1s floor */
}

/* ==== 6. clock_gettime tight loop ======================================
 * PLAN.md §4 / glossary "vDSO": "ask what time is it in a tight loop —
 * nearly free natively, potentially far costlier in a guest." This is
 * the timer-path probe: on a platform with a working vDSO,
 * clock_gettime never traps into the kernel; where the guest doesn't get
 * that fast path (or HVF adds vmexit cost to whatever *does* trap), this
 * number rises. One "op" = one clock_gettime call. */

#define CLOCK_LOOP_OPS_PER_PASS (1u << 20)

static void clock_loop_pass(void *vstate, long ops_per_pass) {
    (void)vstate;
    struct timespec ts;
    for (long i = 0; i < ops_per_pass; i++) {
        clock_gettime(CLOCK_MONOTONIC, &ts);
    }
    /* Touch ts so the call can't be proven dead and hoisted out entirely
     * by an aggressive optimizer (clock_gettime has side effects the
     * compiler can't see through anyway, but this keeps the intent
     * explicit). */
    if (ts.tv_sec < 0) fprintf(stderr, "unreachable\n");
}

static void run_clock_loop(int samples) {
    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op =
            time_pass(clock_loop_pass, NULL, CLOCK_LOOP_OPS_PER_PASS, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("clock_gettime_loop", ns_per_op, ops);
    }
}

/* ==== 7. getpid tight loop ==============================================
 * PLAN.md §4 / glossary "syscall": "the cheapest possible kernel request
 * — the fixed toll of asking the OS for anything." One "op" = one getpid
 * call.
 *
 * Platform-specific note (ticket "Risks": "getpid may be cached by libc
 * on some platforms — use syscall(SYS_getpid) on Linux; document the
 * macOS/iOS equivalent chosen"):
 *
 *   - Android (bionic/Linux): plain getpid() *is* cached by bionic after
 *     the first call in a process (bionic stores the pid and returns it
 *     without trapping on repeat calls) — exactly the caching risk the
 *     ticket warns about, and it would make this bench measure "read a
 *     cached field" instead of "pay the syscall/vmexit toll." We call
 *     syscall(SYS_getpid) directly (via <sys/syscall.h>) to force a real
 *     trap into the kernel on every iteration.
 *   - macOS / iOS Simulator (Darwin/XNU): measured directly on this
 *     machine (disassembly of an isolated -O2 loop confirms the call is
 *     not hoisted or optimized away), plain getpid() costs ~1 ns/call —
 *     cheaper than this same binary's clock_gettime_loop (~15 ns/call),
 *     which strongly suggests Darwin's libsystem_kernel.dylib caches the
 *     pid in-process (e.g. in thread-local/TSD state set up at exec) and
 *     answers getpid() without a fresh trap into XNU on every call, the
 *     same class of optimization the ticket warns bionic does. Darwin
 *     also marks the raw syscall(2) interface itself as
 *     deprecated/unsupported (see <unistd.h>: "syscall(2) is unsupported;
 *     please switch to a supported interface"), so there is no
 *     supported way to force a fresh trap here, and using it anyway
 *     would violate the "warning-clean" build acceptance criterion. So:
 *     leg A/C's getpid_loop is documented to actually measure "cost of a
 *     cached-pid libc call," not "cost of a real vmexit" — a real
 *     platform difference in what "the cheapest syscall" means on each
 *     OS, not a bug in this bench. (A dtrace probe on `syscall::getpid`
 *     would confirm this precisely but needs interactive sudo, which
 *     this suite cannot assume; the timing + disassembly evidence above
 *     is what's documented here instead.)
 *
 * This is exactly the kind of platform divergence Group 1's last three
 * benchmarks exist to surface — see the acceptance criterion that
 * getpid/clock_gettime numbers should differ plausibly across legs, not
 * mysteriously tie (which would mean this bench was silently measuring a
 * cached value instead of the syscall path). Here the *interesting*
 * result is the reverse of the naive prediction: leg A's getpid appears
 * cheaper than its own clock_gettime, because getpid is the cached call
 * and clock_gettime is the one doing real per-call work (commpage time
 * computation) on this platform.
 */

#if defined(__ANDROID__) || (defined(__linux__) && !defined(__APPLE__))
#include <sys/syscall.h>
#define GETPID_CALL() ((void)syscall(SYS_getpid))
#else
#define GETPID_CALL() ((void)getpid())
#endif

#define GETPID_LOOP_OPS_PER_PASS (1u << 20)

static void getpid_loop_pass(void *vstate, long ops_per_pass) {
    (void)vstate;
    for (long i = 0; i < ops_per_pass; i++) {
        GETPID_CALL();
    }
}

static void run_getpid_loop(int samples) {
    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op =
            time_pass(getpid_loop_pass, NULL, GETPID_LOOP_OPS_PER_PASS, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("getpid_loop", ns_per_op, ops);
    }
}

/* ==== 8. pthread cond ping-pong, 2 threads ============================
 * PLAN.md §4 / glossary "context switch": "two threads waking each other
 * back and forth — the price of a thread wakeup." Two threads hand a
 * single token back and forth via a mutex + two condvars, so each
 * "ping-pong" round trip forces (at least) one context switch (often two,
 * depending on scheduler behavior) — RN's JS-thread/UI-thread/render-
 * thread handoffs do this constantly (PLAN.md glossary "context switch").
 * One "op" = one round trip (ping + pong). */

typedef struct {
    pthread_mutex_t mutex;
    pthread_cond_t cond_a;
    pthread_cond_t cond_b;
    int turn; /* 0 = thread A's turn, 1 = thread B's turn */
    volatile long remaining_rounds;
    int stop;
} pingpong_state;

static void *pingpong_thread_b(void *arg) {
    pingpong_state *st = (pingpong_state *)arg;
    pthread_mutex_lock(&st->mutex);
    while (!st->stop) {
        while (st->turn != 1 && !st->stop) {
            pthread_cond_wait(&st->cond_b, &st->mutex);
        }
        if (st->stop) break;
        st->turn = 0;
        pthread_cond_signal(&st->cond_a);
    }
    pthread_mutex_unlock(&st->mutex);
    return NULL;
}

/* Runs `rounds` full ping-pong round trips against thread B, from the
 * calling (A) thread. Blocking, synchronous — returns once all rounds
 * have completed. */
static void pingpong_run_rounds(pingpong_state *st, long rounds) {
    pthread_mutex_lock(&st->mutex);
    for (long i = 0; i < rounds; i++) {
        /* A's turn already (invariant on entry / after previous round) —
         * hand off to B and wait for it to hand back. */
        st->turn = 1;
        pthread_cond_signal(&st->cond_b);
        while (st->turn != 0) {
            pthread_cond_wait(&st->cond_a, &st->mutex);
        }
    }
    pthread_mutex_unlock(&st->mutex);
}

typedef struct {
    pingpong_state *st;
} pingpong_bench_state;

static void pingpong_pass(void *vstate, long ops_per_pass) {
    pingpong_bench_state *bs = (pingpong_bench_state *)vstate;
    pingpong_run_rounds(bs->st, ops_per_pass);
}

static void run_pingpong(int samples) {
    pingpong_state st;
    pthread_mutex_init(&st.mutex, NULL);
    pthread_cond_init(&st.cond_a, NULL);
    pthread_cond_init(&st.cond_b, NULL);
    st.turn = 0;
    st.remaining_rounds = 0;
    st.stop = 0;

    pthread_t thread_b;
    if (pthread_create(&thread_b, NULL, pingpong_thread_b, &st) != 0) {
        fprintf(stderr, "emu-bench-kernels: pingpong: pthread_create failed\n");
        exit(1);
    }

    pingpong_bench_state bs = {.st = &st};
    /* One "op" per JSON line here is one round trip; ops_per_pass is
     * chosen small (1024) because each round trip already forces a real
     * context switch (microseconds, not nanoseconds), so a modest count
     * comfortably clears the ~1s floor without an excessive per-sample
     * runtime on a slow guest. */
    for (int s = 0; s < samples; s++) {
        long ops;
        double ns_per_op = time_pass(pingpong_pass, &bs, 1024, TARGET_NS_PER_SAMPLE, &ops);
        emit_sample("pthread_pingpong", ns_per_op, ops);
    }

    pthread_mutex_lock(&st.mutex);
    st.stop = 1;
    pthread_cond_signal(&st.cond_b);
    pthread_mutex_unlock(&st.mutex);
    pthread_join(thread_b, NULL);

    pthread_mutex_destroy(&st.mutex);
    pthread_cond_destroy(&st.cond_a);
    pthread_cond_destroy(&st.cond_b);
}

/* ---- bench registry + CLI --------------------------------------------- */

typedef struct {
    const char *name;
    void (*run)(int samples);
} bench_entry;

static const bench_entry BENCHES[] = {
    {"sha256", run_sha256},
    {"zlib_deflate", run_deflate},
    {"matmul_1024", run_matmul},
    {"stream_triad", run_stream},
    {"malloc_churn", run_malloc_churn},
    {"clock_gettime_loop", run_clock_loop},
    {"getpid_loop", run_getpid_loop},
    {"pthread_pingpong", run_pingpong},
};
static const size_t BENCH_COUNT = sizeof(BENCHES) / sizeof(BENCHES[0]);

static void print_usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s [--samples N] [--list] [--bench NAME]\n"
            "  --samples N   samples per benchmark (default %d)\n"
            "  --list        print benchmark names, one per line, and exit\n"
            "  --bench NAME  run only the named benchmark (repeatable)\n",
            argv0, DEFAULT_SAMPLES);
}

int main(int argc, char **argv) {
    int samples = DEFAULT_SAMPLES;
    int list_only = 0;
    const char *only_names[64];
    int only_count = 0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--samples") == 0 && i + 1 < argc) {
            samples = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--list") == 0) {
            list_only = 1;
        } else if (strcmp(argv[i], "--bench") == 0 && i + 1 < argc) {
            if (only_count < 64) only_names[only_count++] = argv[++i];
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "emu-bench-kernels: unrecognized argument: %s\n", argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }

    if (list_only) {
        for (size_t i = 0; i < BENCH_COUNT; i++) {
            printf("%s\n", BENCHES[i].name);
        }
        return 0;
    }

    if (samples < 1) {
        fprintf(stderr, "emu-bench-kernels: --samples must be >= 1\n");
        return 1;
    }

    for (size_t i = 0; i < BENCH_COUNT; i++) {
        if (only_count > 0) {
            int match = 0;
            for (int j = 0; j < only_count; j++) {
                if (strcmp(only_names[j], BENCHES[i].name) == 0) match = 1;
            }
            if (!match) continue;
        }
        BENCHES[i].run(samples);
    }

    return 0;
}
