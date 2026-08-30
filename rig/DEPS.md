# Rig app dependencies

Recorded at scaffold time (ticket T04). Exact resolved versions from
`node_modules` (not the `package.json` semver ranges) -- SPEC.md §9 pins
the rig to *exactly* this dependency set; every entry below is one of the
deps D6 (SPEC.md §2) names, plus their required peers.

| Package | Version | Why it's here |
|---|---|---|
| `react-native` | 0.87.1 | latest stable at scaffold time (D6) |
| `react` | 19.2.3 | RN 0.87.1's required React version |
| `@shopify/react-native-skia` | 2.11.1 | D6 -- Skia scenes (Group 3, T06) |
| `@shopify/flash-list` | 2.3.2 | D6 -- `list.scroll` scene (T06) |
| `react-native-reanimated` | 4.6.0 | D6 -- worklet scene (T05), cross-thread scheduling probe |
| `react-native-worklets` | 0.12.1 | required peer of Reanimated 4.x (Reanimated split worklets out into its own package as of v4) |
| `@op-engineering/op-sqlite` | 18.1.4 | D6's "maintained sqlite lib" -- **sqlite choice made here, see below** |
| `@react-navigation/native` | 7.3.18 | D6 -- `nav.transitions` scene only (T06), not app-level routing (that's deep links, see SPEC.md §9) |
| `@react-navigation/native-stack` | 7.18.10 | required by `@react-navigation/native` for a stack navigator |
| `react-native-screens` | 4.27.0 | required peer of `@react-navigation/native-stack` |
| `react-native-gesture-handler` | 3.2.1 | required peer of `@react-navigation/native` |
| `react-native-safe-area-context` | 5.9.1 | required peer of `@react-navigation/native` (also ships in the RN template default) |

## Sqlite lib choice: `@op-engineering/op-sqlite`

D6 says "maintained sqlite lib" and names `op-sqlite-class` as the
category, deferring the exact library to T04. `@op-engineering/op-sqlite`
was chosen because:

- It is the actual `op-sqlite` package PLAN.md's glossary refers to
  ("op-sqlite -- a maintained SQLite binding for RN").
- It supports the New Architecture (TurboModule-based) and is actively
  maintained (18.x as of scaffold time).
- It exposes native path constants (`IOS_DOCUMENT_PATH`,
  `ANDROID_FILES_PATH`, etc.) used elsewhere in the native tooling
  ecosystem, though the rig's own results writer uses its own minimal
  native module (see below) rather than op-sqlite's API, since op-sqlite
  itself has no plain-file write API (it is a SQLite binding, not a
  filesystem library) -- `sqlite.*` scenes (T05, Group 5) will use its
  actual SQL API.

## New Architecture / Hermes

Both are the RN 0.87.1 default (no opt-out flags needed):

- Android: `android/gradle.properties` -- `newArchEnabled=true`,
  `hermesEnabled=true`.
- iOS: `use_react_native!` in `ios/Podfile` defaults to New Architecture +
  Hermes; confirmed via `RCTNewArchEnabled` in the built `Info.plist`
  after `pod install`'s `react_native_post_install` step.

## One small addition beyond the pinned JS deps: a native `ResultsFile` module

SPEC.md §9's result-extraction contract needs a *plain JSON file* written
to the app's documents directory (`<documents>/embench-results.json`),
readable by `adb pull` / `simctl get_app_container ... data`. None of the
pinned dependencies write plain files -- op-sqlite is a SQLite binding
with no filesystem API, and D6 closes the dependency list (no
`react-native-fs` or similar). Rather than add a new JS dependency, T04
adds a small legacy bridge native module (~50 lines each,
`android/app/src/main/java/com/emubench/rig/ResultsFileModule.kt` and
`ios/RigApp/ResultsFileModule.m`) that exposes `writeFile`,
`getDocumentsPath`, and `getProcessStartTimeMs` (the `startup.tti`
native-anchor timestamp). It registers as a legacy bridge module, which
works under the New Architecture's bridge interop layer without needing
Codegen -- no `package.json` entry, since it ships as part of the rig's
own native source rather than a package dependency.
