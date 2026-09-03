# T10: Dev-loop scenarios — boot, install, transfer, fast refresh, TTI (Group 6)

**Status:** done (2026-09-02)
**Depends on:** T02 (AVDs), T04 (rig builds + markers)
**Blocks:** T13

## Context

The group that matters most for "does it suck" (PLAN.md §4 Group 6, hypothesis H8). These are absolute numbers reported side by side (no leg-A baseline exists for booting a phone). All host-side scripting; the rig app only contributes its startup marker and refresh-marker scene (built in T04). Reliability is measured, not just speed — quickboot's silent cold-boot fallback rate is a first-class metric.

## Scope

Scenarios under `src/scenarios/`, each emitting schema samples, n≥10 unless noted:

- `boot.cold`: emulator `-no-snapshot-load -no-boot-anim` → poll `sys.boot_completed`; simulator `simctl boot` → `bootstatus -b`. Full shutdown between iterations.
- `boot.warm`: emulator quickboot save/resume cycle; simulator ordinary boot (it has no snapshot concept — that asymmetry is the finding; document in scenario notes).
- `boot.quickboot_reliability`: 10 quickboot cycles; classify each resume as genuine (sub-threshold elapsed + no cold-boot markers in `emulator` output/logcat) or silent cold-boot fallback; report failure rate.
- `install.hello` / `install.rig`: `adb install` vs `simctl install`, fresh + upgrade variants (build a trivial hello app once as a fixture within the repo, or reuse the rig with a second app id for "hello" — decide and document).
- `transfer.push`: 500 MB generated file, `adb push` MB/s vs `cp` into `simctl get_app_container` path.
- `refresh.metro`: dev-mode rig + Metro; driver appends a marker mutation to the `refresh.marker` scene source, waits for the app's re-render signal (log line with the new marker value), n=20, restores the file afterward (git-clean check). Runs per platform with the same Metro instance procedure.
- `startup.tti`: n≥10 cold app launches using T04's marker; Android cross-check with `am start -W` TotalTime recorded alongside.

## Acceptance criteria

- [x] Each scenario runs unattended for its full n on both platforms and lands schema-valid samples with zero manual steps after devices are provisioned. Evidence: `results/apple-m3-max-2026-09-02-devloop.json` (2026-09-02T18:21:28Z run, post-review-fix) contains all 19 rows (10 ids × legs b/c, minus `boot.quickboot_reliability` which is leg-b-only per its own design) with `skipped: []`; `node -e "... validateAgainstV1(...)"` printed `schema valid: true`. Getting to zero-skip required two real fixes discovered only by running the actual full-matrix command repeatedly: `resolveEmulatorSerial()` guards in every scenario module refusing to fall back to a non-emulator adb device, and `refresh.metro` re-establishing both `adb reverse tcp:8081 tcp:8081` and `adb root` (`ensureAdbRoot`) before every launch, since neither survives an `ensureEmulatorRunning()`-triggered emulator reboot even though the emulator keeps the same serial.
- [x] `boot.quickboot_reliability` demonstrably detects a forced cold boot (test by wiping snapshots mid-sequence once) — the classifier can't just report 100% genuine. Evidence: the injected wipe now runs as a one-time self-test *before* the measured n=10 sequence (not mixed into it -- a review round found the earlier inline-mid-sequence version put the forced cycle's own ~44s cold-boot timing into `samples` and its fallback classification into `fallbackCount`, poisoning every run's recorded data and putting a permanent 1/N floor under the reported failure rate, contrary to PLAN.md lines 149/159/285 treating the *natural* silent-fallback rate as the metric). The 2026-09-02T18:21:28Z run's stdout logged `emu-bench: boot.quickboot_reliability: self-test fault injection correctly classified as fallback (excluded from samples/counts below); 10/10 genuine, 0/10 fallback (failure rate 0.0%)`, and the committed row's 8 samples (n=10 minus 2 warmup discards) are all in the 5.0-5.5s band (cv 4.4%) with no forced-cold-boot outlier. The self-test still throws loudly if the injected wipe is ever misclassified as genuine (`boot.quickboot_reliability: self-test wiped the snapshot but the classifier still reported the resulting cold boot as genuine`), and that throw did not fire.
- [x] `refresh.metro` leaves the working tree clean (`git status` unchanged) after every run, including on failure (trap/cleanup). Evidence: `rig/src/scenes/RefreshMarkerScene.tsx`'s `MARKER_VALUE` literal reads `'initial'` after every run in this ticket, success and failure alike (the try/finally in `run(ctx)` restores the pre-run file content unconditionally); confirmed directly by grepping the file after the 2026-09-02T18:21:28Z zero-skip run and after several earlier runs that ended in a thrown `refresh.metro` skip.
- [x] `--groups 6` end-to-end via CLI. Evidence: `./bin/emu-bench run --groups 6 --label devloop` → `emu-bench: wrote /Users/tylerwilliams/emu-bench/results/apple-m3-max-2026-09-02-devloop.json` with 0 skips (see box 1; this file was regenerated after the review round and is the only devloop results file in the repository).

## Verification

```bash
./bin/emu-bench run --groups 6 --label devloop
```

Sanity-expect: simulator cold boot well under emulator cold boot; install and transfer show measurable gaps; TTI markers agree with `am start -W` within noise.
