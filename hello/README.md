# hello — install-scenario fixture app

## Decision (ticket T10)

T10 (`install.hello`) needed a choice: "build a trivial hello app once as
a fixture within the repo, or reuse the rig with a second app id for
'hello' — decide and document."

**Decision: a separate, genuinely trivial native fixture app** (this
directory), not a second app id on the rig.

## Why

PLAN.md §4 Group 6 / SPEC.md §11 install measurement times both "a
hello-world app and the full rig app" specifically so the two contrast:
a hello app should be about as small as an installable app can be, and
the rig app is the real (RN + Hermes + Skia + sqlite) production-shaped
build. If `install.hello` were just the rig's own APK/IPA under a second
app id, both `install.hello` and `install.rig` would push effectively the
same number of bytes across `adb install` / `simctl install` — the
transport-cost delta the scenario exists to detect would collapse to
zero by construction, defeating the point of having two install rows at
all.

So `hello/` is a from-scratch minimal app, deliberately **not** built via
React Native: a single Activity (Android, plain Java, no Kotlin runtime)
/ a single UIViewController (iOS, Swift, UIKit, no storyboard) rendering
static text, wired into their own bare Gradle/Xcode projects with zero
dependencies beyond the platform SDKs. This is about as small as either
platform allows and is not wired into the rig's RN/Metro/Hermes build
pipeline at all.

## Measured contrast

| | Android | iOS |
|---|---|---|
| `hello` | ~7 KB APK | ~132 KB .app bundle |
| `rig` (release) | ~138 MB APK | (full RN + Skia + sqlite .app) |

(iOS's larger relative footprint for a "nothing app" is expected — a
Swift/UIKit binary links the Swift runtime and standard system
frameworks even for a no-op view controller; Android's plain-Java
Activity has no comparable runtime to link. Both are still two to three
orders of magnitude smaller than the rig, which is what the scenario
needs.)

## Structure

- `android/` — standalone Gradle project (own wrapper, own
  `settings.gradle`; not included from `rig/android`, whose
  `settings.gradle` depends on the React Native Gradle plugin).
  `applicationId com.emubench.hello`. `versionCode`/`versionName` are
  overridable via `-PhelloVersionCode=N` (`app/build.gradle`) so
  `src/scenarios/install.js` can build a "v2" APK for the
  upgrade-install variant without a second Gradle module.
- `ios/` — standalone Xcode project (`HelloApp.xcodeproj`, scheme
  `HelloApp`). `PRODUCT_BUNDLE_IDENTIFIER com.emubench.hello`.
  `CURRENT_PROJECT_VERSION`/`MARKETING_VERSION` read the
  `HELLO_BUILD_NUMBER` build setting (default `1`) so
  `src/scenarios/install.js` can pass
  `HELLO_BUILD_NUMBER=2` via `xcodebuild -destination ... HELLO_BUILD_NUMBER=2`
  for the upgrade variant the same way.

Both are built on demand by `src/scenarios/install.js` (same
build-if-needed precedent as `src/kernels.js`/`src/fence.js`), not
checked in as prebuilt binaries — matching SPEC.md §8's "no prebuilt
binaries in a public benchmark repo" rule, which applies here too even
though this app isn't part of the kernel suite.
