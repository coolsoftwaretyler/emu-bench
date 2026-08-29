# T04: Rig app scaffold — routing, frame recorder, results writer, startup marker

**Status:** open
**Depends on:** T01
**Blocks:** T05, T06, T07, T10, T11 (all scenes and app-driven scenarios)

## Context

The rig is one bare React Native app that runs identical workload code on Android and iOS (SPEC.md §9). Decision D6 (SPEC.md §2) pins the stack: latest stable RN, New Architecture, Hermes, and exactly these deps: `@shopify/react-native-skia`, `@shopify/flash-list`, `react-native-reanimated`, one maintained sqlite lib (choose op-sqlite-class at implementation time; record the choice + version in a `rig/DEPS.md`), `react-navigation` (transition scene only). Everything measured runs in **release** configuration; only the fast-refresh scenario (T10) uses dev mode.

## Scope

- `rig/` RN app (`npx @react-native-community/cli init` or current equivalent), app id `com.emubench.rig` / bundle id `com.emubench.rig`, deep-link scheme `emubench://` wired on both platforms (`scene/<id>?durationMs=...` routes without any nav stack).
- **Scene harness**: registers scenes by id; parses params; standard lifecycle (mount → optional warmup → measure → write results → render `bench-done` testID + log `EMUBENCH_DONE`). Include one `demo.noop` scene.
- **Frame recorder** module: frame-callback ring buffer → `{samples_ms, median, p95, p99, droppedPct, longestStallMs}` (SPEC §9). Must use the same JS mechanism on both platforms.
- **Results writer**: JSON to the app documents dir as `embench-results.json` (SPEC §9 extraction contract).
- **Startup marker**: capture native process-start→JS-first-meaningful-render delta for `startup.tti`; log line + inclusion in the results file.
- Host-side extraction helpers in `src/`: launch scene (adb / simctl openurl), await completion (poll for `bench-done` file or `EMUBENCH_DONE`), pull results (`adb pull` / `simctl get_app_container ... data`), plus release build+install helpers for both platforms.
- Debug-only human scene list screen.

## Out of scope

All real scenes (T05–T07), Maestro flows (T11), fast-refresh driver (T10).

## Acceptance criteria

- [ ] Release builds install and run on `bench-tuned` emulator and a booted simulator.
- [ ] `emubench://scene/demo.noop?durationMs=1000` via `adb shell am start` and `simctl openurl` runs the scene; host helper retrieves a well-formed results JSON from both platforms.
- [ ] Frame recorder demo scene reports plausible ~60/120 Hz frame stats on both platforms.
- [ ] `startup.tti` marker produces a delta on cold launch on both platforms.
- [ ] `rig/DEPS.md` records exact dep versions and the sqlite lib choice.

## Verification

```bash
# with emulator + simulator booted
node src/dev/run-scene.mjs demo.noop --leg b && node src/dev/run-scene.mjs demo.noop --leg c
```

Both print the retrieved results JSON.
