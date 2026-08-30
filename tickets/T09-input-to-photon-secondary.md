# T09: Input-to-photon, secondary — screen-recorded end-to-end latency (Group 4)

**Status:** parked — needs human: grant Screen Recording permission to Claude.app and launch Simulator.app GUI, then re-run photon leg (2026-08-30)
**Depends on:** T07 (scene + tap flow), T02 (ffmpeg doctor check)
**Blocks:** T13

## Context

The end-to-end variant of input latency: records the **Mac screen** (not the device framebuffer) while taps are injected, so the measurement includes the emulator/simulator window compositor path that T07's in-app metric can't see (PLAN.md Group 4, SPEC.md §10). Explicitly secondary in all reporting because injection paths differ per platform; n≥30 to survive the ±1 frame quantization at 60 fps capture.

## Scope

- Capture: `ffmpeg -f avfoundation` screen recording at 60 fps, started/stopped by the scenario script; device window region located automatically if cheap (window bounds via `osascript`/CoreGraphics window list) or via a one-time calibration step that saves the region to the run config.
- Tap marking: reuse T07's `touch.latency` scene; the tap must be visually detectable in the recording — either the scene's high-contrast response alone (count frames from injected-tap timestamp logged by the driver to first pixel change), or better, a cursor-position flash marker if timestamp alignment proves unreliable. Choose one method, document it, record it in provenance as `method`.
- Frame-diff analyzer: script (node, zero deps — decode via ffmpeg to raw frames piped in) that finds the first frame where the device-window region changes beyond a threshold after each tap; emits per-tap latency in frames and ms.
- Registry entry `photon.latency`, group 4, legs b/c only (no leg-A analog); auto-skip with a named reason when ffmpeg is absent.

## Acceptance criteria

- [ ] One command produces ≥ 30 per-tap latencies on each platform with the recording, analysis, and cleanup fully automated.
- [ ] Sanity: photon latency ≥ the same run's T07 in-app latency on each platform (it includes strictly more pipeline; if it's ever lower, the alignment method is broken).
- [ ] Quantization honesty: results carry `captureFps: 60` and the analyzer reports frame-count values, with ms derived; p50/p95 computed on ms.
- [ ] Skips cleanly (named reason in `skipped[]`) when ffmpeg is missing.

## Verification

```bash
./bin/emu-bench run --groups 4 --label photon --legs b,c
```

Compare `photon.latency` medians to `touch.latency` medians from the same run; verify the ≥ relationship holds on both legs.

## Risks

Screen-recording permission (macOS TCC) must be granted to the terminal — doctor should detect a black recording and print the System Settings instruction. Window-region detection is the fiddly part; a manual `--region x,y,w,h` escape hatch is acceptable for v1.
