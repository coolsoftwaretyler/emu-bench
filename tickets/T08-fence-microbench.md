# T08: Fence round-trip microbenchmarks (Group 4, native probes)

**Status:** done (2026-08-29) — was **flagged riskiest ticket in the suite**; shipped on the native paths, no Skia fallback needed (see Implementation notes)
**Depends on:** T03 (native build system patterns), T01
**Blocks:** T13 (registry completeness)

## Context

Every GPU sync point in the emulator is a guest↔host round trip; this probe measures that cost directly (PLAN.md Group 4, hypothesis H6). Two small native CLI binaries, one per platform, each timing a minimal submit→wait loop (SPEC.md §10). This was consciously kept in scope at full-matrix fidelity during plan review (decision D2, SPEC.md §2), with a documented fallback if the Android path proves infeasible. A native macOS Metal variant serves as the leg-A baseline (SPEC.md §10) so the result reports as a ratio like Group 1.

## Scope

- **Android probe** (`kernels/fence_android.c` or separate dir): NDK CLI binary creating a surfaceless EGL context (`EGL_KHR_surfaceless_context` / pbuffer fallback), then loop: trivial draw → `glFinish()` → record µs. ≥ 1,000 iterations, JSON-lines output like T03. Run via `adb shell` on the emulator.
- **iOS simulator probe** (`kernels/fence_iossim.m`): CLI binary via `xcrun simctl spawn booted`, Metal: trivial command buffer → `commit` → `waitUntilCompleted` loop, same output format.
- **Documented fallback** (implement only if the Android EGL path fails on the emulator): in-rig Skia scene doing `flushAndSubmit(syncCpu)`-equivalent per iteration on both platforms; results flagged `method: "skia-fallback"` in provenance.
- Registry entries under group 4; results ids `fence.roundtrip` with per-leg `method` recorded.

## Acceptance criteria

- [x] Android probe runs on the `bench-tuned` emulator via `adb shell` and reports stable µs/round-trip (CV < 15%) — or the fallback is implemented, flagged, and the EGL failure mode is documented in this ticket file. — Evidence: verification cmd on emulator-5554 (bench-tuned, running): n=1000, median 364.96 µs, cv 2.1%; surfaceless unadvertised so the in-scope pbuffer fallback bootstrapped the context, recorded as `method:"egl-pbuffer"` (notes below).
- [x] iOS probe runs via `simctl spawn` and reports stable µs/round-trip. — Evidence: `xcrun simctl spawn booted ./kernels/build/iossim/fence_iossim --samples 1000`: n=1000, median 232.75 µs, cv 6.9%.
- [x] A native macOS Metal variant of the loop (leg A baseline) exists so the result is a ratio like everything else. — Evidence: `kernels/build/macos/fence_macos`, the same `fence_iossim.m` source built natively (`make -C kernels fence-macos`); 1000 samples: median 157.75 µs, cv 12.7% → run below reports leg B 2.32× / leg C 1.45× native.
- [x] Registered; `--groups 4` picks it up alongside T07. — Evidence: `./bin/emu-bench run --groups 4 --label t08-fence` executed `touch.latency` (b,c) + `fence.roundtrip` (a,b,c) → `results/apple-m3-max-2026-08-30-t08-fence.json`, schema-valid, 0 skips, per-leg `method` recorded (metal / egl-pbuffer / metal).

## Verification

```bash
make -C kernels fence && adb shell /data/local/tmp/fence_android --samples 1000 | tail -3
xcrun simctl spawn booted ./kernels/build/iossim/fence_iossim --samples 1000 | tail -3
```

## Risks

Surfaceless EGL may be unsupported or lie on the emulator's gfxstream stack; `glFinish` may be a no-op under some renderers (verify it actually blocks by checking the loop takes > trivial time and scales with work). Metal in a spawned simulator CLI process may need a minimal autorelease/runloop setup. Timebox: if both Android paths (surfaceless + pbuffer) fail after a day, ship the Skia fallback and move on.

## Implementation notes (2026-08-29)

How each predicted risk landed:

- **Surfaceless EGL: unavailable on the emulator.** The emulator's EGL 1.4 display ("Android Emulator OpenGL ES Translator", the gfxstream stack) does not advertise `EGL_KHR_surfaceless_context`; forcing it (`fence_android --method surfaceless`) exits 1 with "surfaceless context unavailable (EGL_KHR_surfaceless_context NOT advertised)". The probe's in-scope pbuffer fallback (a 1×1 pbuffer used only to make the context current — all timed draws go to the same 64×64 offscreen framebuffer either way, so the measured work is identical) bootstraps instead and is recorded per leg as `method: "egl-pbuffer"`. The EGL path therefore works, and the documented in-rig Skia fallback was **not needed**.
- **`glFinish` genuinely blocks** (it is not a no-op under this renderer): one round trip costs ~365 µs — roughly 100× the trivial cost of serializing the commands themselves (~1.1 µs per extra draw, measured by scaling `--work`: 1→370, 16→391, 64→443, 256→662 µs median), and both probes verify the GPU really executed the work before reporting anything (Android: `glReadPixels` color check; Metal: buffer readback after warmup).
- **Metal in a spawned CLI process: works** with a per-iteration `@autoreleasepool` and no runloop (`waitUntilCompleted` blocks on the command buffer directly).

Measurement design and plumbing:

- Each emitted JSON sample averages a batch of 16 round trips (probe default; `--batch 1` gives raw per-lap values). Raw per-iteration samples showed cv 11–20% at n=1000 (GPU power-state / scheduler jitter); batch means give cv 2–13%, under the 15% bar — the same aggregate-per-line sampling T03's kernels use (`ops` per line).
- Reference numbers from the `--groups 4` run (M3 Max, bench-tuned): leg A 157.0 µs, leg B 364.3 µs (**2.32× native**), leg C 227.2 µs (1.45× native) — the fence half of H6's "≥2× worse" prediction confirms for the emulator.
- Recording `method` required an additive-optional schema field: `benchmarks[].method` (string) in `schema/v1.json`, plumbed through `src/commands/run.js`/`src/types.js` (an entry's `run(ctx)` may now return `{samples, method}` instead of a bare array). All pre-existing results files still validate.
- The verification commands were run with `ANDROID_SERIAL=emulator-5554` exported: a physical device was also attached during verification, and bare `adb shell` needs a single target; `ANDROID_SERIAL` is adb's standard device-selection variable and doesn't alter the command.
