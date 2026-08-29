# T08: Fence round-trip microbenchmarks (Group 4, native probes)

**Status:** open — **flagged riskiest ticket in the suite**
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

- [ ] Android probe runs on the `bench-tuned` emulator via `adb shell` and reports stable µs/round-trip (CV < 15%) — or the fallback is implemented, flagged, and the EGL failure mode is documented in this ticket file.
- [ ] iOS probe runs via `simctl spawn` and reports stable µs/round-trip.
- [ ] A native macOS Metal variant of the loop (leg A baseline) exists so the result is a ratio like everything else.
- [ ] Registered; `--groups 4` picks it up alongside T07.

## Verification

```bash
make -C kernels fence && adb shell /data/local/tmp/fence_android --samples 1000 | tail -3
xcrun simctl spawn booted ./kernels/build/iossim/fence_iossim --samples 1000 | tail -3
```

## Risks

Surfaceless EGL may be unsupported or lie on the emulator's gfxstream stack; `glFinish` may be a no-op under some renderers (verify it actually blocks by checking the loop takes > trivial time and scales with work). Metal in a spawned simulator CLI process may need a minimal autorelease/runloop setup. Timebox: if both Android paths (surfaceless + pbuffer) fail after a day, ship the Skia fallback and move on.
