# T10: Dev-loop scenarios — boot, install, transfer, fast refresh, TTI (Group 6)

**Status:** open
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

- [ ] Each scenario runs unattended for its full n on both platforms and lands schema-valid samples with zero manual steps after devices are provisioned.
- [ ] `boot.quickboot_reliability` demonstrably detects a forced cold boot (test by wiping snapshots mid-sequence once) — the classifier can't just report 100% genuine.
- [ ] `refresh.metro` leaves the working tree clean (`git status` unchanged) after every run, including on failure (trap/cleanup).
- [ ] `--groups 6` end-to-end via CLI.

## Verification

```bash
./bin/emu-bench run --groups 6 --label devloop
```

Sanity-expect: simulator cold boot well under emulator cold boot; install and transfer show measurable gaps; TTI markers agree with `am start -W` within noise.
