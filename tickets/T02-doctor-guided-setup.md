# T02: Doctor + guided setup + AVD provisioning

**Status:** open
**Depends on:** T01
**Blocks:** T03 (leg B builds), T10–T13 (device scenarios)

## Context

Decision D4 (SPEC.md §2): a stranger's Mac goes from "RN dev machine" to "collecting benchmarks" in ~30 minutes via `emu-bench doctor` — auto-installing what's possible, printing exact instructions for the rest, and mapping every unmet optional dependency to a named skip that later appears in results provenance. Full check/fix table in SPEC.md §5; AVD definitions in SPEC.md §6.

## Scope

- Implement every row of the SPEC §5 doctor table: arm64 gate; Xcode + newest iOS runtime + newest iPhone device type discovery (`simctl list -j`); ANDROID_HOME/sdkmanager/emulator/adb detection; latest stable `google_apis` arm64 image (query `sdkmanager --list`, pick highest stable API); NDK; Maestro; ffmpeg; sudo note for Group 7.
- Auto-fixes print the exact command before running it, and only run installers that are non-interactive (`sdkmanager` with license pre-check — if licenses unaccepted, print the `sdkmanager --licenses` instruction instead of hanging).
- Create `bench-tuned` (ncore = `sysctl -n hw.perflevel0.logicalcpu`, ramSize 8192) and `bench-default` (unmodified `avdmanager` defaults, pixel-class profile) per SPEC §6. Record both AVDs' effective `config.ini` values for provenance (module consumed by T01's provenance code).
- Readiness summary output: per-leg, per-group status grid; exit 0 iff legs A+B+C can run Groups 1–6.
- `doctor --json` machine-readable output the orchestrator consumes to decide skips.

## Out of scope

Installing Xcode or Homebrew packages (instructions only). Booting devices (orchestrator's job).

## Acceptance criteria

- [ ] On this machine (Android SDK present but newest local image is API 34): doctor detects the stale image, installs the latest stable `google_apis` arm64 image after printing the command, and creates both AVDs.
- [ ] On a simulated-bare environment (temporarily unset ANDROID_HOME): doctor degrades to instructions, exits non-zero, and names which legs/groups are unavailable.
- [ ] `bench-tuned` config.ini shows ncore = P-core count and ramSize 8192; `bench-default` config.ini is untouched defaults; both captured in `doctor --json`.
- [ ] Running doctor twice is idempotent (no duplicate AVDs, no re-downloads).

## Verification

```bash
./bin/emu-bench doctor && ./bin/emu-bench doctor --json | head -50
```

Then `emulator -list-avds` shows `bench-tuned` and `bench-default`; boot `bench-tuned` once to confirm it starts.
