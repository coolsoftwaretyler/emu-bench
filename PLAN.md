# Benchmark Plan: Android Emulator vs iOS Simulator on Apple Silicon

**Date:** 2026-08-28
**Status:** Locked after plan review, 2026-08-28. This document is the methodology; the buildable-software contract is [SPEC.md](SPEC.md) (including the decision log D1–D10) and work items are in [tickets/](tickets/). Phase 0 (T00) can run any time with off-the-shelf tools.

## 1. The question

Two competing claims about the Android emulator on Apple Silicon Macs, both currently unproven:

- **Claim A:** CPU execution under Hypervisor.framework is near-native; the perceived slowness lives in the tails — frame pacing, sync latency, storage I/O, boot/lifecycle, and the dev loop.
- **Claim B:** Execution speed itself is genuinely bad, not just the tails.

This suite is designed so that either claim can lose. The output doubles as a requirements document: every measured gap indicts a specific subsystem (graphics serialization, virtio storage, networking transport, lifecycle management), which tells us what a better emulator would actually need to fix.

**Why the comparison is hard:** emulator-vs-simulator comparisons naively measure two different OSes, runtimes, and UI stacks at once. The design below cancels those confounds instead of ignoring them.

## 2. Design principles

1. **Never compare absolutes across platforms.** Measure each environment's overhead against a native-host baseline and compare the *ratios*.
2. **Hold the workload constant.** Same arm64 machine code (all three environments are arm64), same Hermes bytecode (identical JS engine on both platforms), same Skia drawing commands (via react-native-skia).
3. **Tails over averages.** Report p50/p95/p99 and dropped-frame %, not mean FPS. Interactivity is governed by the worst frames.
4. **Every benchmark indicts one subsystem.** A result we can't attribute is a result we can't act on.
5. **Measure the developer experience, not just the runtime.** Boot, install, fast refresh, and E2E duration are first-class metrics.

## 3. Environments ("legs")

| Leg | Environment | Role |
|-----|-------------|------|
| A | macOS native process | Baseline = 1.0 |
| B | Android Emulator — arm64 AVD, HVF, `-gpu host` (Google APIs image, not Play, so `adb root` works) | System under test |
| C | iOS Simulator — arm64 processes on the macOS kernel, Metal direct to host GPU | Reference "doesn't suck" |
*(Decision D2: a fourth leg of real devices, and additional emulators like Genymotion, were considered and cut for v1 — the suite and writeup scope themselves to "Google's emulator vs Apple's simulator on a Mac," and the limitations section preempts both questions.)*

Key facts that make this fair: Apple Silicon, the Android guest, and the simulator all execute arm64. The simulator is not a VM — its processes run on the host kernel. Leg B pays for a guest Linux kernel, virtio devices, and GLES/Vulkan→gfxstream→Metal translation; leg C pays almost nothing. Quantifying that difference *is the experiment*.

**Hardware (decision D5):** no fixed machine matrix. The suite is hardware-agnostic, portable software that anyone runs on their own Apple Silicon Mac; ratios-to-native-baseline make results comparable across machines, and machine fingerprinting in the results provenance is a core feature. Our own run (M3 Max) is merely the reference dataset. The 10-minute thermal endurance scenario ships in the suite, and H9's thermal findings emerge from community runs on passively-cooled machines rather than from a machine we own.

## 4. Benchmark matrix

### Group 1 — CPU & kernel-boundary microbenchmarks
*Isolates: HVF vCPU tax, guest scheduler/timer overhead.*

Portable single-file C suite, compiled three ways from identical source:

- Leg A: `clang -O2` native
- Leg B: NDK clang (`aarch64-linux-android*-clang -static`), `adb push` to `/data/local/tmp`, run via `adb shell`
- Leg C: `xcrun -sdk iphonesimulator clang -target arm64-apple-ios-simulator`, run via `xcrun simctl spawn booted`

Workloads:

| Benchmark | Stresses |
|---|---|
| SHA-256 over 1 GB | Integer ALU throughput |
| zlib deflate, 100 MB mixed corpus | Branchy compute + memory |
| 1024² double matmul (naive) | FP + cache |
| STREAM triad | Memory bandwidth |
| malloc/free churn (10M small allocs) | Allocator + page faults |
| `clock_gettime` tight loop | Timer path (vDSO vs vmexit) |
| `getpid` tight loop | Raw syscall cost |
| pthread cond ping-pong, 2 threads | Context-switch latency |

Emit JSON lines (`{bench, ns_per_op, ...}`); the runner aggregates.

**Predictions:** compute kernels within ~10% across all legs. Timer/syscall/context-switch may be 2–10× worse in the guest — and that matters, because a JS runtime is timer- and wakeup-heavy.

**Day-0 shortcut:** Geekbench 6 CPU (arm64 APK inside the emulator vs native macOS build — same published workloads) approximates this group in an hour, minus the syscall micros. No simulator leg, but B/A is the headline number anyway.

### Group 2 — JavaScript on Hermes (identical engine, identical bytecode)
*Isolates: environment tax on the RN JS thread. No "ART vs JSC" excuses possible.*

Scenes inside the rig app, timed with `performance.now()`, run in release mode:

- Parse a realistic 5 MB API payload ×N
- map/filter/reduce over 100k objects
- String building / RegExp / date parsing
- Reanimated worklet load on the UI thread (cross-thread scheduling probe)

**Prediction:** within 5–15% of each other. If the gap is large, Group 1's syscall/timer numbers should explain it; if they don't, that's a finding.

### Group 3 — Rendering pipeline
*Isolates: command serialization (gfxstream) vs raw GPU throughput vs upload path.*

`react-native-skia` scenes — identical drawing code both platforms:

| Scene | Design | Indicts if slow |
|---|---|---|
| S1 draw-call storm | 5,000 individually-issued small shapes/frame | Command serialization across the VM boundary |
| S2 fill-rate | Stacked full-screen gradients/blurs | Raw GPU (should be near parity — same physical GPU) |
| S3 texture churn | Cycle 200 images, upload-heavy | Buffer upload/copy path (zero-copy vs staged copies) |
| S4 vector/text | Heavy paths + glyphs | Skia raster/upload mix |

Plus real-world RN: FlashList scroll of 1,000 image cards at scripted velocity; navigation transition loop.

**Instrumentation:** identical in-app frame-time recorder (ring buffer via frame callbacks, dumped as JSON) on both platforms as the primary source; `adb shell dumpsys gfxinfo <pkg> framestats` on Android as a secondary pipeline-stage breakdown.

**Metrics:** p50/p95/p99 frame time, % frames over budget (16.7 ms), longest stall.

**Known confound (accepted):** RN Skia renders via OpenGL on Android and Metal on iOS. That asymmetry is exactly what ships in real RN apps, so it's representative — but it means S1–S4 measure "the pipeline RN devs actually get," not gfxstream alone. Document, don't hide.

### Group 4 — Sync & input latency
*Isolates: guest↔host round trips; window presentation path.*

- **Fence round-trip:** minimal render-flush-finish loop (exact API chosen at rig-build time; a native GLES `glFinish` loop in the guest vs a Metal wait on the sim is acceptable), µs per round trip.
- **Input-to-photon, primary (in-app):** touch-event native timestamp → next presented frame after the state change commits. Identical JS instrumentation both platforms; immune to injection-tool differences.
- **Input-to-photon, secondary (end-to-end):** script a tap via Maestro, record the *Mac screen* with ffmpeg/avfoundation at 60 fps, count frames from tap to visible pixel change. Coarse (±1 frame) but captures the full path including the emulator/simulator window compositor. Injection paths differ between platforms — treat as secondary, n≥30.

### Group 5 — Storage I/O
*Isolates: virtio-blk + qcow2 + guest fs + fsync semantics vs APFS-native.*

Identical JS via op-sqlite:

- 10k single-row inserts, implicit transactions (fsync-heavy — the pathological case)
- 10k rows in one transaction (the batched case)
- Indexed point reads; WAL on/off
- File ops: 1,000 × 100 KB writes+reads; one 500 MB streamed write

**Prediction:** the fsync-heavy case is the single largest gap in the entire suite. Any sqlite/Realm/MMKV-heavy app feels this directly.

### Group 6 — Dev loop & E2E (absolute numbers, B vs C directly)
*No native baseline exists for these; report seconds side by side. This is the group that matters most for "does it suck."*

| Measurement | Method |
|---|---|
| Cold boot → interactive | `emulator -no-snapshot-load` + poll `sys.boot_completed`; `xcrun simctl boot` + `simctl bootstatus -b`. n≥10 each. |
| Warm start | Emulator quickboot resume vs simulator routine boot. Also record quickboot **failure rate** (silent cold-boot fallbacks) — reliability is a perf metric. |
| Install | `adb install` vs `simctl install`, both a hello-world app and the full rig app; fresh + upgrade. |
| File transfer | `adb push` a 500 MB file (MB/s) vs `cp` into the sim container. Directly measures the transport tax (slirp-style user-mode networking). |
| Metro fast refresh | Script appends a marker string to a source file; app logs when the marker renders; measure the delta. n=20. Dev-mode build, both platforms. |
| E2E flow | One identical Maestro flow (launch → form fill → scroll → navigate → assert): duration, plus **flake rate over 50 runs**. CI throughput = duration × (1 + flake rate). |
| App startup TTI | Launch → shared JS "first meaningful render" marker; cross-check with `adb shell am start -W` TotalTime on Android. n≥10 cold launches. |

### Group 7 — Host cost ("why is my fan on")
- `sudo powermetrics --samplers cpu_power,gpu_power` during a fixed 60 s scripted scroll: average watts and total joules per scenario, per leg.
- Host RAM per booted device: qemu process RSS vs the CoreSimulator process tree delta; and the marginal cost of a **second** instance of each.
- Thermal endurance: 10-minute sustained scroll on the fanless Air; plot p95 frame time and package power over time. Degradation curve = the "feels slow on my machine" hypothesis.

**Prediction:** 2–4× energy for the emulator on the same visual result; measurable p95 degradation on the Air within 10 minutes.

## 5. Controls & pinning

| Dimension | Setting |
|---|---|
| Power/thermals | AC power, fixed brightness, other apps quit, `caffeinate` held, 2-min cooldown after GPU-heavy scenes |
| AVD | arm64-v8a Google APIs image, latest stable API level; `hw.cpu.ncore` = P-core count; `hw.ramSize=8192`; `-gpu host`; snapshot behavior explicit per test |
| Simulator | Current-generation iPhone device type, current iOS runtime |
| Config policy (D3) | Tuned AVD is primary for the full matrix; the headline subset (cold boot, `list.scroll` p95, `sqlite.insert_fsync`, rig install) is re-run on an unmodified-defaults AVD and the tuned-vs-default delta is published as its own finding |
| App builds | One RN codebase, two targets; release config (Hermes bytecode precompiled, dev menu off, New Architecture on). Dev-mode builds used **only** for the fast-refresh test |
| Animations | System animations ON for interaction tests (that's the shipped experience), consistent across legs |
| Runs & stats | n≥10 macro / n≥30 micro; discard 2 warmups; **interleave legs (A,B,C,A,B,C…)** rather than blocking, to spread thermal drift; report median + p95; flag CV > 10% as unstable |
| Provenance | Every results JSON embeds: Mac model, macOS/Xcode/emulator/system-image/RN/library versions, AVD config, git SHA of the rig |

## 6. Hypotheses — and what each result means

| # | Hypothesis | If confirmed, indicts | Fixable by |
|---|---|---|---|
| H1 | CPU kernels within 10% of native in the guest | Nothing — HVF is fine | n/a (if it *fails*, "physics is solved" was wrong) |
| H2 | Guest syscall/timer/ctx-switch 2–10× worse | vmexit cost, guest clock config | Tier-2 VMM tuning; partially config |
| H3 | Hermes within 15% | JS thread is fine; RN slowness isn't the engine | n/a |
| H4 | Draw-call storm 2–5× worse; fill-rate near parity | gfxstream command serialization, not the GPU | Graphics-stack investment only — shell polish can't touch it |
| H5 | Texture churn significantly worse | Copy-heavy upload path (no zero-copy) | Unified-memory buffer path (tier 2 / graphics work) |
| H6 | Fence + input-to-photon ≥2× worse | Guest↔host round trips + window presentation | Presentation path (tier 1, partial); VMM (tier 2) |
| H7 | fsync-heavy sqlite ≥5× worse | virtio-blk/qcow2/fsync | Cache-mode config (tier 1, partial); proper storage design (tier 2) |
| H8 | Dev-loop metrics 2–10× worse across the board | Lifecycle, transport, product neglect | **Tier 1 — this is its core value proposition** |
| H9 | 2–4× energy; Air degrades within 10 min | Aggregate overhead → thermal throttling | Explains anecdotal "it's slow"; tier 2 reduces |

Reconciliation logic: if H1/H3 hold while H4/H6/H7/H8 confirm, then *both* prior claims were right — throughput is fine and the experience is genuinely bad, because the experience lives in the tails. If H1 fails, execution speed itself is the problem and the tier-2 VMM work moves up the priority list.

## 7. Phases & deliverables

- **Phase 0 — smoke tests (half a day, no code, [T00](tickets/T00-phase0-smoke-run.md)):** Geekbench 6 B-vs-A; boot stopwatch; `adb push` MB/s; quickboot failure count over 10 launches. Sanity-check that gaps are roughly where predicted; revise the plan if not. Commands in the appendix.
- **Phase 1 — spec + tickets (done 2026-08-28):** decisions locked in plan review; contract in [SPEC.md](SPEC.md); work items T00–T14 in [tickets/](tickets/).
- **Phase 2 — build (~5–7 build-days across sessions):** execute T01–T13 per the dependency order in [tickets/README.md](tickets/README.md). Full matrix per decision D4, including the fence microbench and screen-recorded input-to-photon.
- **Phase 3 — reference collection (T13 rehearsal + T14):** full run on the M3 Max reference machine; results committed as the first dataset entry.
- **Phase 4 — write-up + single reveal (decision D8):** repo goes public together with the writeup; all published tables generated by `emu-bench aggregate` from committed results. Hypotheses (§6) remain committed before any results, and git history is never rewritten, so timestamps serve as late-disclosed pre-registration.

Repository layout is specified in SPEC.md §4.

## 8. Threats to validity (known and accepted)

- **Skia GL-vs-Metal backend asymmetry** (Group 3): representative of shipped RN reality, but not a pure gfxstream measurement. The native fence test (Group 4) partially disambiguates.
- **The simulator is not an iPhone.** This suite compares *developer experiences on a Mac*, not device performance. Real-device legs were cut for v1 (D2), so no claims are made about emulator overhead relative to physical Android hardware.
- **No third-party emulators.** Genymotion/BlueStacks-class comparisons were deliberately cut for v1 (D2); the writeup says so up front rather than letting "did you try Genymotion?" land in the comments. It remains the natural follow-up piece — it directly tests whether a better product shell on the same core moves the needles.
- **RN-centric.** Results generalize partially to Flutter (same VM/GPU/IO substrate) and native dev (everything except the Hermes group).
- **Injection-path asymmetry** in end-to-end latency (Maestro drivers differ) — mitigated by making the in-app measurement primary.
- **Emulator window scale** affects presentation cost: pin the window to 1:1 device pixels and note it.
- **Image variant:** Google APIs images (needed for `adb root`) differ slightly from Play images in background services. Document; spot-check one Play-image run.

## Appendix — Phase 0 commands

Cold boot (Android), n=10:

```bash
time ( $ANDROID_HOME/emulator/emulator -avd bench -no-snapshot-load -no-boot-anim & \
  adb wait-for-device shell 'while [ "$(getprop sys.boot_completed)" != "1" ]; do sleep 0.2; done' )
```

Cold boot (iOS):

```bash
xcrun simctl shutdown all; time ( xcrun simctl boot "iPhone 16" && xcrun simctl bootstatus "iPhone 16" -b )
```

Transfer throughput:

```bash
dd if=/dev/urandom of=/tmp/blob bs=1m count=500 && time adb push /tmp/blob /data/local/tmp/
```

Host power during a manual 60 s scroll session:

```bash
sudo powermetrics --samplers cpu_power,gpu_power -i 1000 -n 60
```

Geekbench: install the arm64 APK in the emulator, run CPU benchmark; run the macOS build natively; compare single/multi-core scores directly (same published workloads).
