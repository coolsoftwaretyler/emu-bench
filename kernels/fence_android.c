/* emu-bench fence probe, Android leg (Group 4, ticket T08).
 *
 * PLAN.md §4 Group 4 / H6, SPEC.md §10: every GPU sync point in the
 * emulator is a guest↔host round trip; this probe prices one lap
 * directly. NDK CLI binary: create a surfaceless EGL context
 * (EGL_KHR_surfaceless_context, pbuffer fallback), then loop
 * trivial draw → glFinish() → record µs per round trip. On the emulator
 * each glFinish crosses the gfxstream guest↔host boundary; natively it
 * would not. Run inside the emulator via `adb shell` from
 * /data/local/tmp (deployed by src/fence.js, same as the Group 1
 * kernels).
 *
 * Output: JSON lines on stdout like T03's kernels (SPEC.md §8 shape,
 * fence-flavored fields):
 *   {"bench":"fence_roundtrip","sample_us_per_roundtrip":123.456,
 *    "ops":1,"method":"egl-surfaceless","work":1}
 * plus one final {"summary":true,...} line with n/median/cv so a human
 * tailing the output (ticket verification: `... | tail -3`) sees the
 * stability numbers directly. The host parser keys on
 * `sample_us_per_roundtrip` and ignores the summary line.
 *
 * `method` is recorded per line (ticket: results ids fence.roundtrip
 * with per-leg method recorded): "egl-surfaceless" or "egl-pbuffer",
 * whichever context bootstrap actually succeeded. The drawn work is
 * identical either way (both render into the same small FBO), so the
 * two methods differ only in how the context came up.
 *
 * Flags: --samples N (default 1000, ticket: ">= 1,000 iterations"),
 * --work N (draws per round trip, default 1 — exists so the "glFinish
 * may be a no-op" risk can be checked: per-iteration time must grow
 * with --work, see ticket Risks), --batch K (round trips averaged per
 * emitted sample, default 16), --warmup N (untimed iterations, default
 * 32), --method auto|surfaceless|pbuffer (default auto).
 *
 * Why batch defaults to 16 (not 1): a single round trip's µs wobbles
 * with scheduler/GPU-power-state noise — measured on this suite's legs,
 * per-iteration samples give CV 11-20% at n=1000 while means over 16
 * consecutive round trips give CV 2.6-12.6%, under the ticket's <15%
 * stability bar. Averaging ops into each emitted sample is exactly how
 * T03's kernels sample too (each JSON line spans `ops` internal
 * repetitions), and 1000 samples x 16 still satisfies ">= 1,000
 * iterations" many times over. --batch 1 remains available for raw
 * per-lap inspection.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>
#include <time.h>

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES2/gl2.h>

#define DEFAULT_SAMPLES 1000
#define DEFAULT_WARMUP 32
#define DEFAULT_BATCH 16
#define FBO_SIZE 64

/* ---- timing helper (same clock as kernels/main.c) -------------------- */

static double now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e9 + (double)ts.tv_nsec;
}

/* ---- EGL/GLES setup --------------------------------------------------- */

static const char *egl_error_str(void) {
    static char buf[32];
    snprintf(buf, sizeof(buf), "0x%04x", eglGetError());
    return buf;
}

static GLuint compile_shader(GLenum type, const char *src) {
    GLuint shader = glCreateShader(type);
    glShaderSource(shader, 1, &src, NULL);
    glCompileShader(shader);
    GLint ok = 0;
    glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[512];
        glGetShaderInfoLog(shader, sizeof(log), NULL, log);
        fprintf(stderr, "fence_android: shader compile failed: %s\n", log);
        exit(1);
    }
    return shader;
}

static int double_cmp(const void *a, const void *b) {
    double da = *(const double *)a, db = *(const double *)b;
    return (da > db) - (da < db);
}

static void print_usage(const char *argv0) {
    fprintf(stderr,
            "usage: %s [--samples N] [--work N] [--batch K] [--warmup N] "
            "[--method auto|surfaceless|pbuffer]\n"
            "  --samples N   JSON sample lines to emit (default %d)\n"
            "  --work N      draws per round trip (default 1; scaling check for glFinish)\n"
            "  --batch K     round trips averaged per sample (default %d)\n"
            "  --warmup N    untimed warmup round trips (default %d)\n"
            "  --method M    context bootstrap: auto (default), surfaceless, pbuffer\n",
            argv0, DEFAULT_SAMPLES, DEFAULT_BATCH, DEFAULT_WARMUP);
}

int main(int argc, char **argv) {
    int samples = DEFAULT_SAMPLES;
    int work = 1;
    int batch = DEFAULT_BATCH;
    int warmup = DEFAULT_WARMUP;
    const char *method_arg = "auto";

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--samples") == 0 && i + 1 < argc) {
            samples = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--work") == 0 && i + 1 < argc) {
            work = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--batch") == 0 && i + 1 < argc) {
            batch = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--warmup") == 0 && i + 1 < argc) {
            warmup = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--method") == 0 && i + 1 < argc) {
            method_arg = argv[++i];
        } else if (strcmp(argv[i], "--help") == 0 || strcmp(argv[i], "-h") == 0) {
            print_usage(argv[0]);
            return 0;
        } else {
            fprintf(stderr, "fence_android: unrecognized argument: %s\n", argv[i]);
            print_usage(argv[0]);
            return 1;
        }
    }
    if (samples < 1 || work < 1 || batch < 1 || warmup < 0) {
        fprintf(stderr, "fence_android: --samples/--work/--batch must be >= 1, --warmup >= 0\n");
        return 1;
    }
    int want_surfaceless, allow_pbuffer_fallback;
    if (strcmp(method_arg, "auto") == 0) {
        want_surfaceless = 1;
        allow_pbuffer_fallback = 1;
    } else if (strcmp(method_arg, "surfaceless") == 0) {
        want_surfaceless = 1;
        allow_pbuffer_fallback = 0;
    } else if (strcmp(method_arg, "pbuffer") == 0) {
        want_surfaceless = 0;
        allow_pbuffer_fallback = 1;
    } else {
        fprintf(stderr, "fence_android: --method must be auto|surfaceless|pbuffer\n");
        return 1;
    }

    /* -- display + context ------------------------------------------------ */

    EGLDisplay dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (dpy == EGL_NO_DISPLAY) {
        fprintf(stderr, "fence_android: eglGetDisplay failed (%s)\n", egl_error_str());
        return 1;
    }
    EGLint egl_major = 0, egl_minor = 0;
    if (!eglInitialize(dpy, &egl_major, &egl_minor)) {
        fprintf(stderr, "fence_android: eglInitialize failed (%s)\n", egl_error_str());
        return 1;
    }
    eglBindAPI(EGL_OPENGL_ES_API);

    const char *exts = eglQueryString(dpy, EGL_EXTENSIONS);
    int has_surfaceless = exts != NULL && strstr(exts, "EGL_KHR_surfaceless_context") != NULL;

    /* Config chosen with PBUFFER_BIT so the same config serves both the
     * surfaceless path (surface type is irrelevant there) and the pbuffer
     * fallback. */
    const EGLint config_attribs[] = {
        EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT,
        EGL_SURFACE_TYPE,    EGL_PBUFFER_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8,
        EGL_NONE,
    };
    EGLConfig config;
    EGLint num_configs = 0;
    if (!eglChooseConfig(dpy, config_attribs, &config, 1, &num_configs) || num_configs < 1) {
        fprintf(stderr, "fence_android: eglChooseConfig found no RGBA8 pbuffer-capable config (%s)\n",
                egl_error_str());
        return 1;
    }

    const EGLint ctx_attribs[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
    EGLContext ctx = eglCreateContext(dpy, config, EGL_NO_CONTEXT, ctx_attribs);
    if (ctx == EGL_NO_CONTEXT) {
        fprintf(stderr, "fence_android: eglCreateContext failed (%s)\n", egl_error_str());
        return 1;
    }

    const char *method = NULL;
    EGLSurface surface = EGL_NO_SURFACE;
    if (want_surfaceless) {
        if (has_surfaceless &&
            eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) {
            method = "egl-surfaceless";
        } else if (!allow_pbuffer_fallback) {
            fprintf(stderr,
                    "fence_android: surfaceless context unavailable "
                    "(EGL_KHR_surfaceless_context %s, eglMakeCurrent error %s) "
                    "and --method surfaceless forbids the pbuffer fallback\n",
                    has_surfaceless ? "advertised" : "NOT advertised", egl_error_str());
            return 1;
        }
    }
    if (method == NULL) {
        const EGLint pbuf_attribs[] = {EGL_WIDTH, 1, EGL_HEIGHT, 1, EGL_NONE};
        surface = eglCreatePbufferSurface(dpy, config, pbuf_attribs);
        if (surface == EGL_NO_SURFACE) {
            fprintf(stderr, "fence_android: eglCreatePbufferSurface failed (%s)\n", egl_error_str());
            return 1;
        }
        if (!eglMakeCurrent(dpy, surface, surface, ctx)) {
            fprintf(stderr, "fence_android: eglMakeCurrent(pbuffer) failed (%s)\n", egl_error_str());
            return 1;
        }
        method = "egl-pbuffer";
    }

    fprintf(stderr,
            "fence_android: egl=%d.%d method=%s surfaceless_ext=%d renderer=\"%s\" vendor=\"%s\" version=\"%s\"\n",
            egl_major, egl_minor, method, has_surfaceless,
            (const char *)glGetString(GL_RENDERER), (const char *)glGetString(GL_VENDOR),
            (const char *)glGetString(GL_VERSION));

    /* -- FBO + trivial draw pipeline --------------------------------------
     * Both methods render into this same small FBO, so the timed work is
     * identical regardless of how the context came up (a surfaceless
     * context has no default framebuffer at all; the 1x1 fallback pbuffer
     * is never drawn to). */

    GLuint rbo = 0, fbo = 0;
    glGenRenderbuffers(1, &rbo);
    glBindRenderbuffer(GL_RENDERBUFFER, rbo);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_RGBA4, FBO_SIZE, FBO_SIZE);
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, rbo);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) {
        fprintf(stderr, "fence_android: FBO incomplete (status 0x%04x)\n",
                glCheckFramebufferStatus(GL_FRAMEBUFFER));
        return 1;
    }
    glViewport(0, 0, FBO_SIZE, FBO_SIZE);

    GLuint vs = compile_shader(GL_VERTEX_SHADER,
                               "attribute vec2 pos;\n"
                               "void main() { gl_Position = vec4(pos, 0.0, 1.0); }\n");
    GLuint fs = compile_shader(GL_FRAGMENT_SHADER,
                               "precision mediump float;\n"
                               "void main() { gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0); }\n");
    GLuint prog = glCreateProgram();
    glAttachShader(prog, vs);
    glAttachShader(prog, fs);
    glBindAttribLocation(prog, 0, "pos");
    glLinkProgram(prog);
    GLint linked = 0;
    glGetProgramiv(prog, GL_LINK_STATUS, &linked);
    if (!linked) {
        char log[512];
        glGetProgramInfoLog(prog, sizeof(log), NULL, log);
        fprintf(stderr, "fence_android: program link failed: %s\n", log);
        return 1;
    }
    glUseProgram(prog);

    /* One triangle covering the whole viewport. */
    static const GLfloat verts[] = {-1.0f, -1.0f, 3.0f, -1.0f, -1.0f, 3.0f};
    GLuint vbo = 0;
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glClearColor(1.0f, 0.0f, 0.0f, 1.0f);

    GLenum setup_err = glGetError();
    if (setup_err != GL_NO_ERROR) {
        fprintf(stderr, "fence_android: GL error 0x%04x after setup\n", setup_err);
        return 1;
    }

    /* -- one round trip: trivial draw(s), then block until the GPU is done - */

#define ROUND_TRIP()                                        \
    do {                                                    \
        glClear(GL_COLOR_BUFFER_BIT);                       \
        for (int w = 0; w < work; w++) {                    \
            glDrawArrays(GL_TRIANGLES, 0, 3);               \
        }                                                   \
        glFinish();                                         \
    } while (0)

    for (int i = 0; i < warmup; i++) {
        ROUND_TRIP();
    }

    /* Prove the pipeline actually rendered before reporting anything:
     * glReadPixels forces completion and returns the drawn color. A probe
     * whose draws silently fail (the "glFinish may be a no-op / lie" risk,
     * ticket Risks) must not report success. RGBA4 storage quantizes to
     * 0x00/0xFF here, but allow slack anyway. */
    {
        unsigned char px[4] = {0, 0, 0, 0};
        glReadPixels(0, 0, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
        if (!(px[1] > 200 && px[0] < 50)) {
            fprintf(stderr,
                    "fence_android: readback check failed — expected green, got rgba(%d,%d,%d,%d); "
                    "the draw->glFinish loop is not actually rendering\n",
                    px[0], px[1], px[2], px[3]);
            return 1;
        }
    }

    double *vals = malloc((size_t)samples * sizeof(double));
    if (!vals) {
        fprintf(stderr, "fence_android: malloc failed\n");
        return 1;
    }

    for (int s = 0; s < samples; s++) {
        double start = now_ns();
        for (int k = 0; k < batch; k++) {
            ROUND_TRIP();
        }
        double us_per_roundtrip = (now_ns() - start) / 1e3 / (double)batch;
        vals[s] = us_per_roundtrip;
        printf("{\"bench\":\"fence_roundtrip\",\"sample_us_per_roundtrip\":%.3f,\"ops\":%d,"
               "\"method\":\"%s\",\"work\":%d}\n",
               us_per_roundtrip, batch, method, work);
    }
    fflush(stdout);

    /* -- summary line (mean-based CV, matching src/stats.js) --------------- */
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
    double median = samples % 2 == 0 ? (vals[samples / 2 - 1] + vals[samples / 2]) / 2.0
                                     : vals[samples / 2];
    printf("{\"bench\":\"fence_roundtrip\",\"summary\":true,\"n\":%d,\"method\":\"%s\",\"work\":%d,"
           "\"batch\":%d,\"median_us\":%.3f,\"mean_us\":%.3f,\"cv\":%.4f,\"min_us\":%.3f,"
           "\"max_us\":%.3f}\n",
           samples, method, work, batch, median, mean, cv, vals[0], vals[samples - 1]);
    fflush(stdout);

    free(vals);
    glDeleteBuffers(1, &vbo);
    glDeleteProgram(prog);
    glDeleteShader(vs);
    glDeleteShader(fs);
    glDeleteFramebuffers(1, &fbo);
    glDeleteRenderbuffers(1, &rbo);
    eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (surface != EGL_NO_SURFACE) eglDestroySurface(dpy, surface);
    eglDestroyContext(dpy, ctx);
    eglTerminate(dpy);
    return 0;
}
