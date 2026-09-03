# T00: Phase 0 smoke run (manual, no code)

**Status:** parked — eyeball power measurement needs interactive sudo powermetrics; a human must run it and append results (2026-08-29)
**Depends on:** nothing — can run any time, on any Apple Silicon Mac with Android SDK + Xcode
**Blocks:** nothing (informs plan revisions)

## Context

Before investing in the suite (see [SPEC.md](../SPEC.md)), run the off-the-shelf smoke tests from PLAN.md's appendix to sanity-check that the measured gaps are roughly where the hypotheses (PLAN.md §6) predict. If Phase 0 contradicts the predictions badly, revise PLAN/SPEC before building.

## Scope

Run and record, n≥5 each where timing is involved:

1. **Cold boot stopwatch**: emulator `-no-snapshot-load` → `sys.boot_completed` vs `simctl boot` + `bootstatus -b` (commands in PLAN.md appendix).
2. **Quickboot failure count**: 10 quickboot launch/quit cycles; count silent cold-boot fallbacks (a "resume" taking cold-boot-scale time).
3. **Transfer throughput**: 500 MB `adb push` MB/s.
4. **Eyeball power**: `sudo powermetrics --samplers cpu_power,gpu_power -i 1000 -n 60` during a manual scroll session in any app, emulator vs simulator.

Note: local AVDs may be stale (API 34 as of 2026-08-28); install the latest stable `google_apis` arm64 image first and create an AVD matching SPEC.md §6 (tuned).

## Acceptance criteria

- [ ] `results/phase0-notes.md` exists with all four measurements, machine + version info, and a short "predictions vs observed" paragraph per relevant hypothesis (H8, H9-adjacent).
- [ ] Any result that contradicts a PLAN.md §6 prediction is flagged with a proposed plan/spec revision.

## Verification

The notes file exists, numbers have units and n, and the summary paragraph states whether the full build proceeds unchanged.
