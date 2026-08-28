# emu-bench — Software Specification

**Date:** 2026-08-28
**Status:** Locked after plan review. Methodology lives in [PLAN.md](PLAN.md); this document specifies the software that implements it; work items live in [tickets/](tickets/).

## 1. What this is

A portable, hardware-agnostic benchmark suite that quantifies Android Emulator overhead vs iOS Simulator overhead on any Apple Silicon Mac. It runs three legs (macOS native baseline, Android emulator, iOS Simulator), reports ratios to the native baseline so results travel across machines, and emits versioned JSON with full provenance so community runs can be aggregated by PR.

The suite is the product. Our own collection run is merely the reference dataset.

## 2. Decision log (from plan review, 2026-08-28)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Comparison set | Core three legs only (native / emulator / simulator). No other targets | 
| D2 | Scope | Full seven-group matrix, including fence microbench and screen-recorded input-to-photon |
| D3 | Hardware | Hardware-agnostic portable suite; no fixed machine matrix; findings emerge from community runs |
| D4 | Setup process | Doctor + guided setup; auto-install what's possible; skipped options get recorded in provenance |
| D5 | Results flow | Use a versioned schema so we can accept community results on different hardware | 
| D6 | Example app | Bare RN, latest stable, New Architecture, Hermes; deps: react-native-skia, sqlite lib, Reanimated, FlashList, react-navigation | 

## 3. Non-goals (v1)

- Intel Macs. The methodology depends on arm64-everywhere; the CLI refuses to run on x86_64 with an explanation.
- Windows/Linux hosts, real devices, Genymotion, BlueStacks, cloud emulators.
- CI-automated collection. Runs are attended by design 
- Hosted results collection or dashboards (PR flow only).

## 4. Repository layout

```
emu-bench/
  PLAN.md            # methodology, hypotheses, controls
  SPEC.md            # this document
  CONTRIBUTING.md    # how to submit a run (T14)
  tickets/           # self-contained work items, T00–T14
  bin/emu-bench      # CLI entrypoint (node)
  src/               # CLI implementation (Node ≥20, ESM, zero runtime deps)
  schema/v1.json     # results JSON Schema
  kernels/           # portable C suite + Makefile (macos / android / iossim targets)
  rig/               # bare RN app (scenes, recorder, markers)
  flows/             # Maestro flows
  results/           # reference dataset + community submissions (JSON)
```

## 5. CLI surface

Single entrypoint: `./bin/emu-bench <command>`. Implementation: Node ≥ 20, ESM JavaScript with JSDoc types, **zero runtime dependencies**, shelling out to `adb`, `emulator`, `xcrun simctl`, `maestro`, `powermetrics`, `ffmpeg`. No build step — a community runner clones and runs.

### `emu-bench doctor`

Detects and reports readiness to run the suite; fixes what it can; prints exact instructions for what it can't. Never modifies anything without printing what it is about to do.

| Check | Auto-fix | Manual instruction |
|---|---|---|
| Host is Apple Silicon (`sysctl hw.optional.arm64`) | — | Hard refusal on Intel |
| Xcode + CLT present; newest iOS runtime + iPhone device type | — | Install/upgrade Xcode |
| `ANDROID_HOME`, `sdkmanager`, `emulator`, `adb` | — | Print SDK install steps |
| Latest stable `google_apis` arm64 system image | `sdkmanager` install | — |
| NDK (for kernel builds, leg B) | `sdkmanager` install | — |
| AVDs `bench-tuned` and `bench-default` (see §6) | create via `avdmanager` | — |
| Maestro | — | `brew install maestro` line |
| ffmpeg (input-to-photon secondary only) | — | `brew install ffmpeg` line |
| sudo for powermetrics (Group 7 only) | — | Explains the prompt at run time |

Exit code 0 = at least legs A+B+C runnable for Groups 1–6. Every unmet optional dependency maps to a named skip that later appears in results provenance.

### `emu-bench run [--groups 1-7] [--legs a,b,c] [--config tuned|default|both] [--label NAME] [--endurance]`

Default behavior: full matrix on the tuned config, then the headline subset (cold boot, S-list scroll, sqlite fsync-heavy, install) re-run on the default config. Orchestration hygiene per PLAN §5: interleaved legs, 2 warmup discards, n≥10 macro / n≥30 micro, cooldown after GPU-heavy scenes, CV computed per benchmark and flagged when > 10%. Writes `results/<chip-slug>-<date>-<label>.json`.

### `emu-bench aggregate [--out md|csv]`

Reads `results/*.json`, validates against `schema/v1.json`, filters runs with incomplete provenance, groups by chip class, and renders the comparison table (ratios for Groups 1–5, absolutes for Groups 6–7). This is also what the writeup's tables are generated from — no hand-copied numbers.

## 6. Device configurations

**Tuned AVD (`bench-tuned`)**:

- `hw.cpu.ncore` = `sysctl hw.perflevel0.logicalcpu` (P-core count, computed per machine)
- `hw.ramSize` = 8192
- launched with `-gpu host`; snapshot behavior explicit per test (`-no-snapshot-load` for cold boots)
- image: latest stable `google_apis` arm64 (Google APIs, not Play — `adb root` required)

**Default AVD (`bench-default`)**: created via `avdmanager` with the pixel-class device profile and an unmodified `config.ini`. Whatever the defaults turn out to be **is the measurement**; the actual values are recorded. (Known caveat, documented in the writeup: Android Studio's GUI applies slightly different defaults than `avdmanager`; we measure the latter and say so.)

**iOS Simulator**: newest iPhone device type of the installed newest runtime. No perf-relevant config exists; one configuration only.

## 7. Results schema (v1)

`schema/v1.json` is the contract; `schemaVersion` is stamped in every file. Shape:

```jsonc
{
  "schemaVersion": 1,
  "run": { "timestamp": "...", "label": "...", "suiteGitSha": "..." },
  "machine": {
    "model": "MacBook Pro", "chip": "Apple M3 Max",
    "pCores": 12, "eCores": 4, "ramGB": 48,
    "macosVersion": "...", "powerSource": "AC", "thermalPressureStart": "nominal"
  },
  "toolchain": {
    "xcode": "...", "iosRuntime": "...", "deviceType": "...",
    "emulatorVersion": "...", "systemImage": "...", "apiLevel": 0,
    "ndk": "...", "rnVersion": "...", "maestro": "...", "node": "..."
  },
  "config": { "avdTuned": { /* actual config.ini values */ }, "avdDefault": { /* ditto */ } },
  "benchmarks": [
    {
      "group": 3, "id": "skia.s1.drawcall_storm", "leg": "b", "config": "tuned",
      "unit": "ms_frame", "n": 0, "warmupsDiscarded": 2,
      "samples": [], "median": 0, "p95": 0, "p99": 0, "cv": 0
    }
  ],
  "skipped": [ { "id": "...", "leg": "...", "reason": "..." } ],
  "notes": ""
}
```

## 8. Kernel suite (Group 1)

Single-directory portable C (C11, no dependencies beyond libc/libz/pthreads), one binary, JSON-lines output. Workloads per PLAN §4 Group 1: sha256 (bundled impl), zlib deflate, 1024² matmul, STREAM triad, malloc churn, `clock_gettime` loop, `getpid` loop, pthread cond ping-pong.

Build targets (Makefile): `make macos` (clang), `make android` (NDK clang, `-static`), `make iossim` (`xcrun -sdk iphonesimulator clang -target arm64-apple-ios-simulator`). Kernels are **built locally on the runner's machine** — no prebuilt binaries in a public benchmark repo. Execution: leg A directly; leg B via `adb push /data/local/tmp && adb shell`; leg C via `xcrun simctl spawn booted`.

## 9. Rig app

Bare RN (latest stable at build time), New Architecture, Hermes, release configuration for all measurements (dev build used only by the fast-refresh scenario). Dependencies exactly: `@shopify/react-native-skia`, `@shopify/flash-list`, `react-native-reanimated`, a maintained sqlite lib (op-sqlite class — chosen at T04, recorded in provenance), `react-navigation` (transition scene only).

**Scene routing:** deep links — `emubench://scene/<id>?durationMs=...&param=...` — driven by `adb shell am start` / `xcrun simctl openurl` / Maestro. No in-app menu needed for automation (a debug list screen exists for humans).

**Result extraction:** each scene writes `<documents>/embench-results.json` when done, then renders a stable `bench-done` testID (Maestro-visible) and logs a `EMUBENCH_DONE` line. The host retrieves the file via `adb pull` / `simctl get_app_container … data` + `cp`. File-based, no network dependency — transport is never part of a measurement.

**Shared modules:** frame recorder (frame-callback ring buffer → p50/p95/p99, dropped %, longest stall), scene harness (params, warmup handling, JSON writer), startup marker (native launch timestamp → JS first-meaningful-render delta).

**Scenes:**

| Scene id | Group | Notes |
|---|---|---|
| `hermes.json_parse`, `hermes.collections`, `hermes.strings`, `hermes.worklet` | 2 | `performance.now()`, ops/s |
| `skia.s1.drawcall_storm`, `skia.s2.fillrate`, `skia.s3.texture_churn`, `skia.s4.vector_text` | 3 | identical drawing code both platforms |
| `list.scroll` | 3 | FlashList, 1,000 image cards, **deterministic in-app auto-scroll** at fixed velocity (not Maestro-driven — reproducibility) |
| `nav.transitions` | 3 | react-navigation push/pop loop on a timer |
| `touch.latency` | 4 | records touch-event timestamp → next presented frame; Maestro taps it N times |
| `sqlite.insert_fsync`, `sqlite.insert_txn`, `sqlite.reads`, `io.files` | 5 | identical JS both platforms |
| `startup.tti` | 6 | marker only; driven by launch scripts |
| `refresh.marker` | 6 | renders a marker string that the fast-refresh driver mutates |

## 10. Native probes (Group 4)

The riskiest components; isolated so failure doesn't block the suite (skips are recorded, PLAN's fallback applies).

- **Fence round-trip, Android:** NDK CLI binary, surfaceless EGL context, `glFinish` loop → µs/round-trip. If surfaceless EGL proves unavailable on the emulator, fallback = in-rig Skia `flushAndSubmit(sync)` scene, flagged in provenance as the fallback method.
- **Fence round-trip, iOS sim:** CLI binary via `simctl spawn`, Metal command buffer + `waitUntilCompleted` loop.
- **Input-to-photon secondary:** script taps via Maestro, ffmpeg/avfoundation records the Mac screen at 60 fps, a frame-diff script counts frames from tap-marker to pixel change in the device window region. n≥30. Marked secondary in all reporting (injection paths differ per platform).

## 11. Host-side scenarios (Groups 6–7)

All scripted under `src/scenarios/`, all emitting into the same results schema:

- **Boot:** cold (`-no-snapshot-load` → poll `sys.boot_completed`; `simctl boot` → `bootstatus -b`), warm (quickboot resume), and **quickboot failure rate** (n=10 cycles; a resume that cold-boots counts as a failure — detected via boot-completed elapsed time threshold and emulator logs).
- **Install:** hello-world APK/app + full rig APK/app, fresh and upgrade, via `adb install` / `simctl install`.
- **Transfer:** 500 MB `adb push` MB/s vs `cp` into the simulator container.
- **Fast refresh:** driver mutates the `refresh.marker` source string, watches for the app's re-render signal, n=20, dev-mode builds on both platforms.
- **E2E:** one Maestro flow (launch → form → scroll → navigate → assert), identical YAML both platforms except launch stanzas; duration n≥10 plus flake rate over 50 runs.
- **TTI:** n≥10 cold launches, shared JS marker, cross-checked with `am start -W` on Android.
- **Power:** `sudo powermetrics --samplers cpu_power,gpu_power` sampled during a fixed 60 s `list.scroll` run → watts + joules per leg. Sudo is requested up front (`sudo -v`) with an explanation, or the group is skipped.
- **RAM footprint:** steady-state host memory per booted device (qemu RSS vs CoreSimulator process-tree delta), plus the marginal second instance.
- **Endurance (`--endurance`):** 10-minute sustained `list.scroll`, logging p95 frame time + package power per minute → degradation curve. Off by default; community runners on passively-cooled machines are the intended audience (H9).

## 12. Provenance & hygiene enforcement (code, not discipline)

- Runner refuses to start on battery power (override flag exists, recorded in results).
- Thermal pressure sampled at start and between groups; runs annotated.
- Leg interleaving (A,B,C,A,B,C…), warmup discards, and cooldown timers are orchestrator behavior, not instructions in a README.
- Every external tool version is captured at run start; missing/failed benchmarks land in `skipped[]` with reasons, never silently absent.

## 13. Acceptance for v1 ("ready to collect the reference dataset")

1. `doctor` goes from a bare RN-dev Mac to all-legs-ready with at most Xcode/brew steps done by hand.
2. `run` completes the full matrix unattended except for the initial sudo prompt, on this M3 Max, producing a schema-valid results file with zero unexplained skips.
3. `aggregate` renders the comparison table from ≥2 results files, including the tuned-vs-default delta table.
4. Every hypothesis H1–H9 in PLAN.md maps to at least one benchmark id emitting data (H9 via `--endurance`).
5. A second person (or fresh Claude session) reproduces a run from README instructions alone.
