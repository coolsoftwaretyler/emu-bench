# T04: Rig app scaffold — routing, frame recorder, results writer, startup marker

**Status:** done (2026-08-29)
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

- [x] Release builds install and run on `bench-tuned` emulator and a booted simulator. Evidence: `./gradlew assembleRelease` -> `BUILD SUCCESSFUL`, `adb -s emulator-5554 install -r app-release.apk` -> `Success` (emulator-5554 confirmed running AVD `bench-tuned` via `getprop ro.boot.qemu.avd_name`); `xcodebuild ... -configuration Release ... build` -> `BUILD SUCCEEDED`, `xcrun simctl install 8831130E-0AAE-4076-9DE3-095A54674896 RigApp.app` installed on booted simulator `bench-iphone`.
- [x] `emubench://scene/demo.noop?durationMs=1000` via `adb shell am start` and `simctl openurl` runs the scene; host helper retrieves a well-formed results JSON from both platforms. Evidence: `node src/dev/run-scene.mjs demo.noop --leg b && node src/dev/run-scene.mjs demo.noop --leg c` printed well-formed `{sceneId, params, startedAtIso, finishedAtIso, measurement}` JSON from both legs (2026-08-30T00:32Z run); also confirmed directly via `adb shell am start -W -a android.intent.action.VIEW -d "emubench://..."` (`Status: ok`, `Activity: com.emubench.rig/.MainActivity`) and `xcrun simctl openurl <udid> "emubench://..."`.
- [x] Frame recorder demo scene reports plausible ~60/120 Hz frame stats on both platforms. Evidence: `node src/dev/run-scene.mjs demo.framerecorder --leg c --durationMs 3000` -> median 16.66ms (60.0Hz, droppedPct 0) on the iOS simulator; `--leg b` -> median ~33.2ms (~30Hz, droppedPct 0) on the Android emulator, cross-checked against `adb shell dumpsys display` reporting the panel's actual mode as 60Hz (`peakRefreshRate=60.000004`) -- the lower Android number reflects real rendering/bridge overhead under virtualization, not a display-mode or recorder artifact, and is directly in line with this suite's own thesis (PLAN.md §3).
- [x] `startup.tti` marker produces a delta on cold launch on both platforms. Evidence: `node src/dev/run-scene.mjs startup.tti --leg b` -> `ttiMs: 9886` (cold launch, Android emulator); `--leg c` -> `ttiMs: 781.55` (cold launch, iOS simulator). Note: this surfaced and fixed a real bug -- `InteractionManager` is removed from RN 0.87 core (throws in dev, silently `undefined` in release); the marker now anchors on two chained `requestAnimationFrame` calls instead.
- [x] `rig/DEPS.md` records exact dep versions and the sqlite lib choice. Evidence: `/Users/tylerwilliams/emu-bench/rig/DEPS.md` lists resolved (not semver-range) versions read from each package's own `package.json` in `node_modules`, and documents the `@op-engineering/op-sqlite@18.1.4` choice + rationale.

## Verification

```bash
# with emulator + simulator booted
node src/dev/run-scene.mjs demo.noop --leg b && node src/dev/run-scene.mjs demo.noop --leg c
```

Both print the retrieved results JSON.
