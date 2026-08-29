# Benchmark Plan: Android Emulator vs iOS Simulator on Apple Silicon

This document is the methodology; the buildable-software contract is [SPEC.md](SPEC.md) (including the decision log) and work items are in [tickets/](tickets/).

**How to read this document:** every benchmark group in §4 answers the same four questions — **what it measures** in plain English, **what runs** (the actual program or app scene), **where it runs** (which of the three environments in §3), and **what we'll see** in the results. Unfamiliar terms are defined in the [Glossary](#appendix--glossary) at the bottom.

## 1. The question

Two competing claims about the Android emulator on Apple Silicon Macs, both currently unproven:

- **Claim A:** CPU execution under Hypervisor.framework is near-native; the perceived slowness lives in the tails — frame pacing, sync latency, storage I/O, boot/lifecycle, and the dev loop.
- **Claim B:** Execution speed itself is genuinely bad, not just the tails.

In plain terms: Claim A says the emulator *computes* as fast as the Mac itself, and what developers feel is everything around the computing — stuttery frames, slow disk writes, slow boots, a sluggish edit-save-reload loop. Claim B says no — even the raw computing is slow. This suite is designed so that either claim can lose.

The output doubles as a requirements document: every measured gap indicts a specific subsystem (graphics serialization, virtio storage, networking transport, lifecycle management). When a number is bad, the design already tells us which part of the emulator to blame — and therefore what a better emulator would actually need to fix.

**Why the comparison is hard:** emulator-vs-simulator comparisons naively measure two different OSes, runtimes, and UI stacks at once. The design below cancels those confounds instead of ignoring them.

## 2. Design principles

1. **Never compare absolutes across platforms.** "The emulator did it in 90 ms, the simulator in 60 ms" compares Android to iOS as much as it compares environments. Instead, measure each environment's overhead against a native-host baseline and compare the *ratios*: "1.1× native" vs "4× native" means the same thing on every Mac; raw milliseconds don't.
2. **Hold the workload constant.** Same arm64 machine code (all three environments execute arm64 — nothing is instruction-translated), same Hermes bytecode (identical JS engine on both platforms), same Skia drawing commands (via react-native-skia). When the work is identical down to the bytecode and the draw calls, any difference in the numbers is the environment's fault — there is nothing else left to blame.
3. **Tails over averages.** Report p50/p95/p99 and dropped-frame %, not mean FPS. An app that *averages* 60 fps can still stutter constantly; interactivity is governed by the worst frames, so we report the times the slowest 5% and 1% of frames exceed.
4. **Every benchmark indicts one subsystem.** A result we can't attribute is a result we can't act on — so each workload is built to stress one layer (the graphics command pipe, the disk sync path, the timer path, …) while leaving the others idle.
5. **Measure the developer experience, not just the runtime.** Boot, install, fast refresh, and E2E duration are first-class metrics — "the emulator is slow," as developers say it, is usually about the dev loop as much as the app.

## 3. Environments ("legs")

| Leg | Environment | Role |
|-----|-------------|------|
| A | macOS native process | Baseline = 1.0 |
| B | Android Emulator — arm64 AVD, HVF, `-gpu host` (Google APIs image, not Play, so `adb root` works) | System under test |
| C | iOS Simulator — arm64 processes on the macOS kernel, Metal direct to host GPU | Reference "doesn't suck" |

What each leg actually is:

- **Leg A — a plain Mac program.** The workload runs directly on macOS like any command-line tool: no virtual machine, no translation, no extra layers. This is the speed of the hardware itself, and it defines 1.0 — every other number is "how many times slower than this."
- **Leg B — a complete Android device inside a virtual machine.** The emulator (built on QEMU) boots a full Android OS with its own Linux kernel. Because macOS's Hypervisor.framework (HVF) runs the guest's arm64 instructions directly on the CPU cores, *pure computation should be near-native*. Everything else crosses a virtualization boundary: the "disk" is a qcow2 image file accessed through virtio-blk, graphics commands are serialized by gfxstream and replayed on the host GPU, networking passes through a user-mode translation layer, and kernel-boundary work (timers, thread wakeups) may pay hypervisor-exit costs. Pricing each of those boundaries is what this suite does.
- **Leg C — iOS apps as ordinary Mac processes.** The iOS Simulator is *not* a virtual machine. Simulator apps are arm64 macOS processes linked against an iOS-flavored set of system libraries; they run on the Mac's own kernel, read and write the Mac's own filesystem, and draw via Metal essentially straight to the host GPU. There is almost no "environment" to pay for — which is exactly why it serves as the reference for what a device environment on a Mac *can* feel like.

Leg B pays for a guest Linux kernel, virtio devices, and GLES/Vulkan→gfxstream→Metal translation; leg C pays almost nothing. Quantifying that difference *is the experiment*.

**Which legs run what:** leg A exists only where the workload can run as a plain Mac program — the Group 1 C suite. The rig app (Groups 2–5) builds for exactly two targets, so those groups compare emulator vs simulator head-to-head on identical code. Groups 6–7 measure the devices themselves (boot, install, power), where a "native Mac leg" has no meaning — also B vs C.

**Hardware:**  The suite is hardware-agnostic, portable software that anyone runs on their own Apple Silicon Mac; ratios-to-native-baseline make results comparable across machines, and machine fingerprinting in the results is a core feature. Our own run (M3 Max) is merely the reference dataset. The 10-minute thermal endurance scenario ships in the suite, and H9's thermal findings emerge from community runs on passively-cooled machines rather than from a machine we own.

## 4. Benchmark matrix

### Group 1 — CPU & kernel-boundary microbenchmarks
*Isolates: HVF vCPU tax, guest scheduler/timer overhead.*

**What it measures:** the direct test of Claim B. The first five workloads are pure computation and memory — if HVF virtualization works as advertised, all three legs should effectively tie. The last three hammer the user↔kernel boundary — reading the clock, making the cheapest possible syscall, waking a sleeping thread — which is where virtualization overhead is expected to hide, and which a JavaScript runtime does constantly.

**What runs & where:** a portable single-file C suite, compiled three ways from identical source. Same source, three compilers, three environments — the only variable is where the binary runs:

- Leg A: `clang -O2` native — run directly in a macOS terminal
- Leg B: NDK clang (`aarch64-linux-android*-clang -static`) — `adb push` to `/data/local/tmp`, run inside Android via `adb shell`
- Leg C: `xcrun -sdk iphonesimulator clang -target arm64-apple-ios-simulator` — run inside the booted simulator via `xcrun simctl spawn booted`

Workloads:

| Benchmark | Stresses | In plain terms |
|---|---|---|
| SHA-256 over 1 GB | Integer ALU throughput | hash 1 GB of data — raw number-crunching speed |
| zlib deflate, 100 MB mixed corpus | Branchy compute + memory | compress 100 MB — realistic mixed CPU work |
| 1024² double matmul (naive) | FP + cache | multiply two 1024×1024 matrices — floating-point math and cache behavior |
| STREAM triad | Memory bandwidth | `a[i] = b[i] + q·c[i]` over large arrays — how fast RAM moves |
| malloc/free churn (10M small allocs) | Allocator + page faults | allocate and free 10 million small blocks — memory-management overhead |
| `clock_gettime` tight loop | Timer path (vDSO vs vmexit) | ask "what time is it?" in a tight loop — nearly free natively, potentially far costlier in a guest |
| `getpid` tight loop | Raw syscall cost | the cheapest possible kernel request — the fixed toll of asking the OS for anything |
| pthread cond ping-pong, 2 threads | Context-switch latency | two threads waking each other back and forth — the price of a thread wakeup |

**What we'll see:** each binary emits one JSON line per workload (`{bench, ns_per_op, ...}`); the runner aggregates them into per-leg medians and ratios to leg A — results shaped like "`clock_gettime`: simulator 1.05× native, emulator 4.7× native" (numbers illustrative).

**Predictions:** compute kernels within ~10% across all legs. Timer/syscall/context-switch may be 2–10× worse in the guest — and that matters, because a JS runtime is timer- and wakeup-heavy.

### Group 2 — JavaScript on Hermes (identical engine, identical bytecode)
*Isolates: environment tax on the RN JS thread.*

**What it measures:** the thread every React Native app's business logic lives on. Both platforms run the same Hermes engine executing the same precompiled bytecode, so any gap is the environment's doing — the engine can't be blamed.

**What runs & where:** JS scenes inside the rig app (the suite's instrumented RN test app — see SPEC §9), release mode, on legs B and C, timed with `performance.now()`:

- Parse a realistic 5 MB API payload ×N — "ingest a big API response"
- map/filter/reduce over 100k objects — bulk data transformation
- String building / RegExp / date parsing — everyday JS grunt work
- Reanimated worklet load on the UI thread — JS deliberately run on the *UI* thread, probing cross-thread scheduling cost

**What we'll see:** ops/sec per scene, emulator vs simulator.

**Prediction:** within 5–15% of each other. If the gap is large, Group 1's syscall/timer numbers should explain it; if they don't, that's a finding.

### Group 3 — Rendering pipeline
*Isolates: command serialization (gfxstream) vs raw GPU throughput vs upload path.*

**What it measures:** where emulator graphics overhead actually lives. On the emulator, an app's GPU commands can't touch the GPU directly: gfxstream serializes each call into a stream, ships it across the VM boundary, and the host replays it against the Mac's GPU. The scenes pull that pipeline apart — many tiny commands (stresses the pipe), few huge commands (stresses the GPU itself, which is the same physical chip for all legs), and upload-heavy work (stresses the memory-copy path).

**What runs & where:** `react-native-skia` scenes in the rig app — identical drawing code on legs B and C:

| Scene | What's on screen, and why | Indicts if slow |
|---|---|---|
| S1 draw-call storm | 5,000 small shapes, each issued as its own draw call, redrawn every frame — maximizes commands crossing the VM boundary | Command serialization across the VM boundary |
| S2 fill-rate | stacked full-screen gradients/blurs — few commands, maximal pixel work | Raw GPU (should be near parity — same physical GPU) |
| S3 texture churn | a grid cycling through 200 images — constant fresh texture uploads | Buffer upload/copy path (zero-copy vs staged copies) |
| S4 vector/text | heavy vector paths + walls of glyphs | Skia raster/upload mix |

Plus real-world RN: a FlashList scroll of 1,000 image cards auto-scrolling at scripted velocity (the canonical "does scrolling stutter" test), and a react-navigation transition loop (screens pushing and popping repeatedly).

**Instrumentation:** an identical in-app frame-time recorder on both platforms — frame callbacks feed a ring buffer that logs how long every frame took, dumped as JSON when the scene ends — as the primary source; `adb shell dumpsys gfxinfo <pkg> framestats` on Android as a secondary pipeline-stage breakdown.

**What we'll see:** p50/p95/p99 frame time, % of frames over the 16.7 ms budget (at 60 Hz a frame has 16.7 ms to be ready; a frame over budget is a visible hitch), and the longest single stall.

**Known confound (accepted):** RN Skia renders via OpenGL on Android and Metal on iOS. That asymmetry is exactly what ships in real RN apps, so it's representative — but it means S1–S4 measure "the pipeline RN devs actually get," not gfxstream alone. Document, don't hide.

### Group 4 — Sync & input latency
*Isolates: guest↔host round trips; window presentation path.*

**What it measures:** two latencies you feel but an FPS counter hides — the time for one round trip to the GPU and back (a floor under every frame that synchronizes), and the time from finger-down to changed pixels.

- **Fence round-trip:** a minimal native loop submits trivial GPU work and blocks until it's confirmed done, over and over (exact API chosen at rig-build time; a native GLES `glFinish` loop in the guest vs a Metal wait on the sim is acceptable). Reported as µs per round trip. On the emulator each lap crosses the guest↔host boundary; on the simulator it doesn't.
- **Input-to-photon, primary (in-app):** the rig records each touch event's native timestamp and the time of the next presented frame after the resulting state change commits — the gap is what a user waits. Identical JS instrumentation both platforms; immune to injection-tool differences.
- **Input-to-photon, secondary (end-to-end):** Maestro scripts a tap, ffmpeg/avfoundation records the *Mac screen* at 60 fps, and a frame-diff script counts frames from tap to visible pixel change. Coarse (±1 frame ≈ ±17 ms) but captures the full path *including the emulator/simulator window compositor* — the true glass-to-glass number. Injection paths differ between platforms — treat as secondary, n≥30.

**What we'll see:** µs per fence round trip; ms from touch to pixels, measured in-app and corroborated on-screen.

### Group 5 — Storage I/O
*Isolates: virtio-blk + qcow2 + guest fs + fsync semantics vs APFS-native.*

**What it measures:** what a database write costs in each environment. An emulator write travels app → guest filesystem → virtio-blk (the VM's paravirtual disk) → qcow2 image file on the host → APFS → SSD. A simulator write is just app → APFS → SSD. The killer operation is `fsync` — "put this on disk *now*, don't just buffer it" — which SQLite issues on every commit, and which must punch through every one of those layers.

**What runs & where:** identical JS in the rig app via op-sqlite, on legs B and C:

- 10k single-row inserts, implicit transactions (an fsync per row — the pathological case)
- 10k rows in one transaction (one fsync for the whole batch)
- Indexed point reads; WAL on/off (SQLite's write-ahead-log journal mode)
- File ops: 1,000 × 100 KB writes+reads; one 500 MB streamed write

**What we'll see:** rows/sec for the insert cases, ops/sec for reads, MB/s for the file work — per leg.

**Prediction:** the fsync-heavy case is the single largest gap in the entire suite. Any sqlite/Realm/MMKV-heavy app feels this directly.

### Group 6 — Dev loop & E2E (absolute numbers, B vs C directly)
*No native baseline exists for these — there is no "boot" of a Mac process — so this group reports raw seconds side by side. This is the group that matters most for "does it suck": it is the developer's day with a stopwatch on it.*

| Measurement | Method |
|---|---|
| Cold boot → interactive | `emulator -no-snapshot-load` + poll `sys.boot_completed`; `xcrun simctl boot` + `simctl bootstatus -b`. n≥10 each. |
| Warm start | Emulator quickboot resume vs simulator routine boot. Also record quickboot **failure rate** (silent cold-boot fallbacks) — reliability is a perf metric. |
| Install | `adb install` vs `simctl install`, both a hello-world app and the full rig app; fresh + upgrade. |
| File transfer | `adb push` a 500 MB file (MB/s) vs `cp` into the sim container. Directly measures the transport tax (slirp-style user-mode networking). |
| Metro fast refresh | Script appends a marker string to a source file; app logs when the marker renders; measure the delta. n=20. Dev-mode build, both platforms. |
| E2E flow | One identical Maestro flow (launch → form fill → scroll → navigate → assert): duration, plus **flake rate over 50 runs**. CI throughput = duration × (1 + flake rate). |
| App startup TTI | Launch → shared JS "first meaningful render" marker; cross-check with `adb shell am start -W` TotalTime on Android. n≥10 cold launches. |

Row by row, in plain terms:

- **Cold boot** — power-on to usable. `-no-snapshot-load` forces the emulator to truly boot rather than resume a snapshot; "interactive" means Android's `sys.boot_completed` property flips to 1 / `simctl bootstatus -b` returns.
- **Warm start** — the emulator's *quickboot* snapshots the entire VM and resumes it later instead of booting. We also count how often that resume **silently fails** into a cold boot — reliability is a perf metric.
- **Install** — getting an app onto the device: a tiny hello-world and the full rig app, first install and upgrade.
- **File transfer** — push one 500 MB file into the device and time it. On the emulator this rides the user-mode networking transport that adb uses to reach the guest (historically a bottleneck); the simulator equivalent is a plain file copy into its container.
- **Metro fast refresh** — the save-a-file-see-the-change loop of daily RN development: a script edits source, the dev-mode app logs when the change actually renders, and the delta is "⌘S → pixels."
- **E2E flow** — one identical Maestro UI test (launch → fill a form → scroll → navigate → assert) on both platforms: duration, plus the **flake rate** — how often the same test spuriously fails across 50 runs. Flakes are a time tax, hence effective CI throughput = duration × (1 + flake rate).
- **App startup TTI** — icon tap to "first meaningful render" (a shared JS marker), cross-checked on Android against `am start -W` TotalTime.

### Group 7 — Host cost ("why is my fan on")

**What it measures:** what each running device costs the Mac itself — watts, RAM, and behavior under sustained load. This is the "my laptop is hot and my battery is gone" experience, quantified.

- **Power:** `sudo powermetrics --samplers cpu_power,gpu_power` (macOS's built-in power meter — the suite's one sudo prompt) sampled during a fixed 60 s scripted scroll: average watts and total joules per scenario, per leg — energy spent to put the same pixels on screen.
- **RAM:** host RAM per booted device — the emulator's qemu process RSS vs the CoreSimulator process-tree delta — plus the marginal cost of a **second** instance of each, since real developers run more than one.
- **Thermal endurance:** a 10-minute sustained scroll on a passively-cooled machine (e.g., a fanless MacBook Air), plotting p95 frame time and package power minute by minute. A degradation curve is the "it feels slow on *my* machine" hypothesis made visible. Ships behind `--endurance`; community runs on fanless machines are the intended source of this data (see §3, Hardware).

**What we'll see:** watts and joules per scenario per leg; GB of host RAM per device instance; a p95-over-time curve for the endurance run.

**Prediction:** 2–4× energy for the emulator on the same visual result; measurable p95 degradation on a passively-cooled machine within 10 minutes.

## 5. Controls & pinning

The rules that keep runs honest and comparable across machines — enforced by the orchestrator itself (SPEC §12), not by asking humans to be careful.

| Dimension | Setting |
|---|---|
| Power/thermals | AC power, fixed brightness, other apps quit, `caffeinate` held (sleep blocked), 2-min cooldown after GPU-heavy scenes |
| AVD | arm64-v8a Google APIs image, latest stable API level; `hw.cpu.ncore` = P-core count; `hw.ramSize=8192`; `-gpu host`; snapshot behavior explicit per test |
| Simulator | Current-generation iPhone device type, current iOS runtime |
| Config policy | Tuned AVD is primary for the full matrix; the headline subset (cold boot, `list.scroll` p95, `sqlite.insert_fsync`, rig install) is re-run on an unmodified-defaults AVD and the tuned-vs-default delta is published as its own finding |
| App builds | One RN codebase, two targets; release config (Hermes bytecode precompiled, dev menu off, New Architecture on). Dev-mode builds used **only** for the fast-refresh test |
| Animations | System animations ON for interaction tests (that's the shipped experience), consistent across legs |
| Runs & stats | n≥10 macro / n≥30 micro; discard 2 warmups; **interleave legs (A,B,C,A,B,C…)** rather than blocking, to spread thermal drift evenly; report median + p95; flag CV > 10% as unstable (too noisy to trust) |
| Provenance | Every results JSON embeds: Mac model, macOS/Xcode/emulator/system-image/RN/library versions, AVD config, git SHA of the rig |

## 6. Hypotheses — and what each result means

Each row is a falsifiable bet. **Indicts** names the subsystem that's guilty if the hypothesis confirms. **Fixable by** classifies the engineering that could close the gap, using two tiers referenced throughout: **tier 1** = building a better product *around* the stock emulator without touching its internals (lifecycle management, window/presentation, dev-loop tooling); **tier 2** = engineering *inside* the virtualization stack itself (VMM tuning or patches, graphics stack, storage design).

| # | Hypothesis | If confirmed, indicts |
|---|---|---|---|
| H1 | CPU kernels within 10% of native in the guest | Nothing — HVF is fine |
| H2 | Guest syscall/timer/ctx-switch 2–10× worse | vmexit cost, guest clock config | 
| H3 | Hermes within 15% | JS thread is fine; RN slowness isn't the engine |
| H4 | Draw-call storm 2–5× worse; fill-rate near parity | gfxstream command serialization, not the GPU |
| H5 | Texture churn significantly worse | Copy-heavy upload path (no zero-copy) |
| H6 | Fence + input-to-photon ≥2× worse | Guest↔host round trips + window presentation |
| H7 | fsync-heavy sqlite ≥5× worse | virtio-blk/qcow2/fsync |
| H8 | Dev-loop metrics 2–10× worse across the board | Lifecycle, transport, product neglect |
| H9 | 2–4× energy; Air degrades within 10 min | Aggregate overhead → thermal throttling |

Reconciliation logic: if H1/H3 hold while H4/H6/H7/H8 confirm, then *both* prior claims were right — throughput is fine and the experience is genuinely bad, because the experience lives in the tails. If H1 fails, execution speed itself is the problem and the tier-2 VMM work moves up the priority list.

Repository layout is specified in SPEC.md.

## Appendix — Phase 0 commands

Sanity checks you can run today with stock tools — no suite required — to confirm the headline gaps are roughly where the hypotheses predict.

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

## Appendix — Glossary

Shared by PLAN.md and SPEC.md. Grouped by theme.

### Virtualization & environments

- **Hypervisor.framework (HVF)** — macOS's built-in virtualization API. The emulator uses it to run Android's arm64 instructions directly on the CPU cores — no instruction translation, so pure compute should be near-native.
- **VMM (virtual machine monitor)** — the host-side program that runs a guest OS. The Android emulator is built on QEMU.
- **guest / host** — the OS inside the VM (Android's Linux) / the physical machine's OS (macOS).
- **vmexit** — a forced handoff from guest to hypervisor (e.g., to program a timer or touch virtual hardware). Each costs microseconds that native code never pays; the suspected source of kernel-boundary overhead.
- **syscall** — a program's request to the OS kernel (open a file, get the time). `getpid` is the cheapest one, which makes it a pure "toll booth" measurement.
- **vDSO** — a Linux mechanism that answers hot syscalls like `clock_gettime` in user space without entering the kernel. Whether the guest gets this cheap path is exactly what the timer microbench detects.
- **context switch** — the kernel pausing one thread to run another. RN apps do this constantly (JS thread ↔ UI thread ↔ render thread).
- **CoreSimulator** — the macOS service that hosts iOS Simulator devices. Simulator apps are plain Mac processes under it — not a VM.

### Graphics

- **gfxstream** — the emulator's graphics translation layer: the guest's OpenGL ES/Vulkan calls are serialized into a stream, shipped across the VM boundary, and replayed on the host GPU (ultimately via Metal). Priced by scene S1.
- **OpenGL ES / Vulkan / Metal** — GPU command APIs. The first two are what Android apps speak; Metal is what the Mac GPU speaks. The emulator translates between them; the simulator speaks Metal natively.
- **Skia / react-native-skia** — Skia is the 2D renderer used by Chrome and Android; react-native-skia exposes it to RN so one codebase issues *identical* drawing commands on both platforms.
- **draw call** — a single "draw this" command sent toward the GPU. Many small calls stress command handling; a few big calls stress the GPU itself.
- **fill rate** — how many pixels the GPU can paint per second (scene S2).
- **texture upload / zero-copy** — moving image bytes to the GPU. A zero-copy path shares memory; a staged path copies buffers extra times. Scene S3 detects which one we're getting.
- **fence / fence round-trip** — a GPU synchronization point: "tell me when this work is done." Round-trip time is the floor under any frame that waits on the GPU.
- **frame budget (16.7 ms)** — at 60 Hz, each frame must be ready in 1/60 s = 16.7 ms. Frames over budget are visible hitches.
- **frame callback** — a per-frame hook in the app; the rig's frame recorder uses it to timestamp every rendered frame.
- **input-to-photon** — the full latency from touching the glass to changed pixels on the screen.

### Storage

- **virtio / virtio-blk** — the standard paravirtual device family a VM guest uses; virtio-blk is the virtual disk. Every emulator disk operation crosses it.
- **qcow2** — the disk-image file format on the host. The Android device's entire "disk" is really one big file on your Mac.
- **APFS** — the Mac's native filesystem. The simulator writes to it directly; the emulator only reaches it at the bottom of the virtual stack.
- **fsync** — "commit this to durable storage *now*, don't just buffer it." SQLite issues it on every transaction; it is the most virtualization-hostile I/O operation because it must punch through every layer.
- **WAL (write-ahead logging)** — a SQLite journal mode that changes write/fsync patterns; measured both on and off.
- **op-sqlite** — a maintained SQLite binding for RN (final library choice made at T04 and recorded in provenance).

### Android & iOS tooling

- **AVD (Android Virtual Device)** — a named emulator configuration: device profile, CPU cores, RAM, system image. The suite defines `bench-tuned` and `bench-default` (SPEC §6).
- **system image — Google APIs vs Play** — the Android OS build an AVD boots. Google-APIs images permit `adb root`; Play-Store images don't. Benchmarking needs root, hence Google APIs.
- **adb (Android Debug Bridge)** — the CLI for talking to an Android device: `adb shell` runs commands inside it, `adb push` copies files in, `adb install` installs apps.
- **NDK (Native Development Kit)** — Android's C/C++ toolchain; builds the leg-B kernel binaries.
- **quickboot** — emulator VM snapshotting: save whole-machine state, resume later instead of booting. Can silently fall back to a cold boot; the suite counts those failures.
- **user-mode networking ("slirp-style")** — the emulator's network stack runs as ordinary host user-space code translating packets — flexible, but historically a throughput bottleneck. `adb push` rides on it.
- **`xcrun simctl`** — the iOS Simulator's CLI: `boot`, `install`, `openurl`, and `spawn` (run a command-line binary inside the booted simulator).
- **`sys.boot_completed`** — the Android system property that flips to 1 when boot finishes; polled to timestamp "interactive."
- **`am start -W`** — Android's activity launcher in wait mode; its TotalTime cross-checks the rig's TTI marker.
- **Maestro** — cross-platform mobile UI automation driven by YAML flows (tap, scroll, assert). The same flow runs on Android and iOS.
- **powermetrics** — macOS's built-in power profiler (requires sudo); reports CPU/GPU watts.
- **RSS (resident set size)** — the RAM a process actually occupies.
- **`caffeinate`** — macOS utility that prevents the machine from sleeping during long runs.

### React Native

- **Hermes** — the JS engine RN ships on both platforms. JS is precompiled to bytecode, so both legs execute byte-identical programs — the foundation of Group 2's fairness.
- **New Architecture** — RN's modern internals (Fabric renderer, TurboModules); the current default, enabled in the rig.
- **Metro / Fast Refresh** — RN's dev server and its save-to-screen live-update loop; Group 6 times it.
- **Reanimated / worklet** — an animation library that runs small JS functions ("worklets") on the UI thread; used here as a cross-thread scheduling probe.
- **FlashList** — a high-performance RN list component; the 1,000-image-card scroll is the canonical smoothness test.
- **TTI (time to interactive)** — app-icon tap to first meaningful render.
- **rig app** — this suite's instrumented RN test app containing every in-app scene (SPEC §9).

### Measurement & statistics

- **p50 / p95 / p99** — percentiles: p95 is the value 95% of samples beat — equivalently, the time the worst 5% exceed. Percentiles expose the stutter that averages hide.
- **CV (coefficient of variation)** — standard deviation ÷ mean. Above 10%, a benchmark's repeats wobble too much and the result is flagged rather than trusted.
- **n≥10 macro / n≥30 micro** — sample counts: long scenarios (boots, installs) repeat at least 10×; fast microbenchmarks at least 30×.
- **warmup discards** — the first iterations pay one-time costs (cold caches, lazy initialization) and are thrown away.
- **interleaving** — running legs A,B,C,A,B,C… instead of all of one leg then the next, so thermal drift degrades every leg equally.
- **ratio to native** — a leg's result divided by leg A's result on the same machine; the unit that makes results comparable across different Macs.
- **provenance** — the recorded context of a run (machine, tool versions, config, skips with reasons) that makes its numbers interpretable later.
