# T07: Input latency, primary — in-app touch→frame scene + tap driver (Group 4)

**Status:** open
**Depends on:** T04 (harness), T06 (frame recorder conventions)
**Blocks:** T09 (shares the tap flow), T13

## Context

PLAN.md Group 4's primary input-to-photon metric: measured **inside the app** — touch-event native timestamp → next presented frame after the resulting state change commits — with identical JS on both platforms, so the injection tool's own latency cancels out of the comparison (it only needs to deliver taps, not deliver them fast). Hypothesis H6.

## Scope

- `touch.latency` scene: full-screen touchable; on press, read the event's native timestamp (`event.nativeEvent.timestamp` — verify its clock domain per platform and normalize; document the normalization in the scene source), trigger a visible state change, record delta to the next frame-present callback. Collect ≥ 30 taps; emit samples + median/p95 via the standard contract. Visual feedback must be an obvious high-contrast change (T09 reuses it for pixel-diff detection).
- Tap driver: Maestro flow (`flows/touch-latency.yaml`) tapping the scene N times at ~1 s intervals, shared YAML with per-platform launch stanzas. Fallback driver via `adb shell input tap` for Android if Maestro's tap cadence proves unreliable — but Maestro must remain the documented default so both platforms use the same injector.
- Registry entry: `--groups 4` runs the scene by launching it, executing the flow, then extracting results.

## Acceptance criteria

- [ ] ≥ 30 valid tap samples per run on both platforms; taps that miss (no state change) are excluded and counted in the results `notes`.
- [ ] Clock-domain handling verified: deltas are plausible (2–100 ms range, not negative, not seconds) on both platforms.
- [ ] Repeatability: two consecutive runs on the simulator differ by < 20% at p50.
- [ ] End-to-end via CLI with both devices booted.

## Verification

```bash
./bin/emu-bench run --groups 4 --label touch-primary
```

Compare medians across legs; direction should show emulator ≥ simulator. If emulator < simulator, suspect timestamp clock domains before celebrating.

## Risks

`nativeEvent.timestamp` clock domain differs across platforms/RN versions (uptime vs epoch). Budget time to verify against `performance.now()` bridging on each platform; record the method in the scene source and results `notes`.
