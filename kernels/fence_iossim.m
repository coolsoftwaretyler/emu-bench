/* emu-bench fence probe, Metal legs (Group 4, ticket T08).
 *
 * PLAN.md §4 Group 4 / H6, SPEC.md §10: the same submit-and-wait lap as
 * kernels/fence_android.c, in Metal terms — trivial command buffer →
 * commit → waitUntilCompleted, µs per round trip.
 *
 * One source, two binaries (the Group 1 identical-source philosophy,
 * SPEC.md §8):
 *   - leg C: built with the iphonesimulator SDK, run inside the booted
 *     simulator via `xcrun simctl spawn booted` (SPEC.md §10 "Fence
 *     round-trip, iOS sim");
 *   - leg A: the very same file built as a native macOS CLI (SPEC.md §10
 *     "Fence round-trip, macOS (leg A): the same Metal submit→wait loop
 *     as a native host CLI"), so fence results report as ratios to
 *     native like Group 1.
 * The Metal code is platform-neutral; only the SDK/target differs.
 *
 * Trivial GPU work per round trip: a blit-encoder fillBuffer over a
 * small shared buffer — enough to make the GPU genuinely execute
 * something (verified by reading the buffer back after warmup), small
 * enough that the measured time is the sync round trip, not the work.
 * Each loop iteration runs inside its own @autoreleasepool (the ticket
 * Risks' "minimal autorelease/runloop setup": waitUntilCompleted blocks
 * on the command buffer directly and needs no runloop, but without a
 * per-iteration pool the loop would accumulate thousands of autoreleased
 * command buffers).
 *
 * Output: JSON lines on stdout, same shape as fence_android.c (which
 * itself mirrors T03's kernels), with method "metal":
 *   {"bench":"fence_roundtrip","sample_us_per_roundtrip":12.345,
 *    "ops":1,"method":"metal","work":1}
 * plus a final {"summary":true,...} line.
 *
 * Flags: --samples N (default 1000), --work N (fill commands per round
 * trip, default 1 — the scaling check), --batch K (round trips averaged
 * per sample, default 16 — see fence_android.c's header for why batch
 * means are the default sampling design on every leg), --warmup N
 * (default 32).
 */

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define DEFAULT_SAMPLES 1000
#define DEFAULT_WARMUP 32
#define DEFAULT_BATCH 16
#define FILL_BYTES 4096
#define FILL_VALUE 0xA5

static double now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}

static int double_cmp(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static void print_usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s [--samples N] [--work N] [--batch K] [--warmup N]\n"
            "  --samples N   JSON sample lines to emit (default %d)\n"
            "  --work N      fill commands per round trip (default 1; scaling check)\n"
            "  --batch K     round trips averaged per sample (default %d)\n"
            "  --warmup N    untimed warmup round trips (default %d)\n",
            argv0, DEFAULT_SAMPLES, DEFAULT_BATCH, DEFAULT_WARMUP);
}

int main(int argc, char **argv) {
    int samples = DEFAULT_SAMPLES;
    int work = 1;
    int batch = DEFAULT_BATCH;
    int warmup = DEFAULT_WARMUP;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--samples") == 0 && i + 1 < argc) {
            samples = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--work") == 0 && i + 1 < argc) {
            work = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--batch") == 0 && i + 1 < argc) {
            batch = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--warmup") == 0 && i + 1 < argc) {
            warmup = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "fence_metal: unrecognized argument: %s\n", argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }
    if (samples < 1 || work < 1 || batch < 1 || warmup < 0) {
        fprintf(stderr, "fence_metal: --samples/--work/--batch must be >= 1, --warmup >= 0\n");
        return 1;
    }

    @autoreleasepool {
        id<MTLDevice> device = MTLCreateSystemDefaultDevice();
        if (device == nil) {
            fprintf(stderr, "fence_metal: MTLCreateSystemDefaultDevice returned nil "
                            "(no Metal device available in this process)\n");
            return 1;
        }
        id<MTLCommandQueue> queue = [device newCommandQueue];
        if (queue == nil) {
            fprintf(stderr, "fence_metal: newCommandQueue failed\n");
            return 1;
        }
        /* Shared storage so the CPU can verify after the warmup loop that
         * the GPU really executed the fill (a wait that "completes" without
         * doing anything must not report success — same spirit as
         * fence_android.c's glReadPixels check). */
        id<MTLBuffer> buf = [device newBufferWithLength:FILL_BYTES
                                                options:MTLResourceStorageModeShared];
        if (buf == nil) {
            fprintf(stderr, "fence_metal: newBufferWithLength failed\n");
            return 1;
        }
        memset(buf.contents, 0, FILL_BYTES);

        fprintf(stderr, "fence_metal: method=metal device=\"%s\"\n",
                [[device name] UTF8String]);

        /* One round trip: encode `work` trivial fills into one command
         * buffer, commit, block until the GPU confirms completion. */
        int (^round_trip)(void) = ^int(void) {
            id<MTLCommandBuffer> cb = [queue commandBuffer];
            id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
            for (int w = 0; w < work; w++) {
                [blit fillBuffer:buf range:NSMakeRange(0, FILL_BYTES) value:FILL_VALUE];
            }
            [blit endEncoding];
            [cb commit];
            [cb waitUntilCompleted];
            return cb.status == MTLCommandBufferStatusCompleted ? 0 : 1;
        };

        for (int i = 0; i < warmup; i++) {
            @autoreleasepool {
                if (round_trip() != 0) {
                    fprintf(stderr, "fence_metal: command buffer failed during warmup\n");
                    return 1;
                }
            }
        }
        if (((const unsigned char *)buf.contents)[0] != FILL_VALUE ||
            ((const unsigned char *)buf.contents)[FILL_BYTES - 1] != FILL_VALUE) {
            fprintf(stderr, "fence_metal: readback check failed — the fill never executed; "
                            "the commit->waitUntilCompleted loop is not doing real GPU work\n");
            return 1;
        }

        double *vals = malloc((size_t)samples * sizeof(double));
        if (vals == NULL) {
            fprintf(stderr, "fence_metal: malloc failed\n");
            return 1;
        }

        int failures = 0;
        for (int s = 0; s < samples; s++) {
            @autoreleasepool {
                double start = now_ns();
                for (int k = 0; k < batch; k++) {
                    failures += round_trip();
                }
                double us_per_roundtrip = (now_ns() - start) / 1e3 / (double)batch;
                vals[s] = us_per_roundtrip;
                printf("{\"bench\":\"fence_roundtrip\",\"sample_us_per_roundtrip\":%.3f,"
                       "\"ops\":%d,\"method\":\"metal\",\"work\":%d}\n",
                       us_per_roundtrip, batch, work);
            }
        }
        fflush(stdout);
        if (failures > 0) {
            fprintf(stderr, "fence_metal: %d command buffer(s) did not complete successfully\n",
                    failures);
            free(vals);
            return 1;
        }

        double sum = 0.0;
        for (int s = 0; s < samples; s++) sum += vals[s];
        double mean = sum / samples;
        double var = 0.0;
        if (samples > 1) {
            for (int s = 0; s < samples; s++) var += (vals[s] - mean) * (vals[s] - mean);
            var /= (samples - 1);
        }
        double cv = mean > 0.0 ? sqrt(var) / mean : 0.0;
        qsort(vals, (size_t)samples, sizeof(double), double_cmp);
        double median = samples % 2 == 0
                            ? (vals[samples / 2 - 1] + vals[samples / 2]) / 2.0
                            : vals[samples / 2];
        printf("{\"bench\":\"fence_roundtrip\",\"summary\":true,\"n\":%d,\"method\":\"metal\","
               "\"work\":%d,\"batch\":%d,\"median_us\":%.3f,\"mean_us\":%.3f,\"cv\":%.4f,"
               "\"min_us\":%.3f,\"max_us\":%.3f}\n",
               samples, work, batch, median, mean, cv, vals[0], vals[samples - 1]);
        fflush(stdout);
        free(vals);
    }
    return 0;
}
