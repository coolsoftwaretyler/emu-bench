# T03: Portable C kernel suite (Group 1) + three-target build + runner integration

**Status:** done (2026-08-29)
**Depends on:** T01 (registry); T02 useful but not required (leg B needs NDK + an AVD)
**Blocks:** T13 (orchestrator needs real benchmarks), T08 (shares the native build system)

## Context

Group 1 of PLAN.md §4: identical arm64 machine code run in all three legs isolates pure virtualization/scheduling tax (hypotheses H1, H2). Same source, three builds: macOS native, Android (NDK, static), iOS simulator SDK. Design constraints in SPEC.md §8: C11, single directory, no deps beyond libc/libz/pthreads, JSON-lines output, built locally on the runner's machine (no prebuilt binaries).

## Scope

- `kernels/` with a small harness (`main.c` + per-bench files): sha256 (bundle a compact public-domain impl), zlib deflate over a generated 100 MB mixed corpus (deterministic PRNG — no test-data files in the repo), 1024² double matmul, STREAM triad, malloc churn (10M small alloc/free), `clock_gettime` tight loop, `getpid` loop, pthread-cond ping-pong context-switch pairs.
- Each bench self-times with `clock_gettime(CLOCK_MONOTONIC)`, runs internal repetitions targeting ≥ ~1s per sample, emits one JSON line per sample: `{"bench":"sha256","sample_ns_per_op":...,"ops":...}`. `--samples N` flag (default 30), `--list` flag.
- `kernels/Makefile`: `make macos`, `make android` (NDK clang `aarch64-linux-android*-clang`, `-static`; NDK path from `ANDROID_HOME/ndk/<ver>` or `$NDK_HOME`), `make iossim` (`xcrun -sdk iphonesimulator clang -target arm64-apple-ios-simulator`). `-O2` everywhere, identical flags otherwise.
- Registry integration (`src/`): group-1 benchmarks that build (if needed), deploy, and execute per leg — A: run directly; B: `adb push` to `/data/local/tmp`, `chmod +x`, `adb shell`; C: `xcrun simctl spawn booted`. Parse JSON lines into schema samples.

## Acceptance criteria

- [x] All three targets build warning-clean on this machine. Evidence: `make -C kernels clean && make -C kernels all` — macos (clang), android (NDK 27.1.12297006 clang, API 35, `-static`), iossim (`xcrun -sdk iphonesimulator clang -target arm64-apple-ios-simulator`) all built with zero warnings under `-Wall -Wextra -Wpedantic`; confirmed arm64 (`file`/`lipo` on macos+iossim, ELF aarch64 static on android).
- [x] `./bin/emu-bench run --groups 1 --legs a` produces schema-valid results for every kernel on leg A. Evidence: wrote `results/apple-m3-max-2026-08-29-t03-lega-check.json`, schema-validated by the CLI itself before writing (exit 0); 9 entries (8 kernels + T01's `demo.noop_loop`), all leg=a, n=30, 0 skipped.
- [x] With `bench-tuned` booted and a simulator booted: `--legs a,b,c` yields all kernels × all legs; a spot-check shows leg B sha256 within ~15% of leg A. Evidence: `./bin/emu-bench run --groups 1 --label kernels-check` → `results/apple-m3-max-2026-08-29-kernels-check.json`, 25 entries (8 kernels × 3 legs + demo), 0 skipped, all CV < 8%. sha256 leg B/leg A = 3403679230.5/3153875000 = **1.079× (7.9%)**, within ~15%.
- [x] `getpid` and `clock_gettime` results differ plausibly across legs. Evidence (same run + direct spot-checks): `getpid_loop` medians — leg A 1.08 ns, leg B 98.5 ns (**~91× slower**, real vmexit cost), leg C 1.07 ns (Simulator = plain Mac process, ties leg A). `clock_gettime_loop` — leg A 15.8 ns, leg B 13.3 ns, leg C 15.6 ns (all close: vDSO-equivalent path works on every platform). Not identical everywhere, not nonsensical — see `kernels/main.c`'s `getpid_loop` comment block for the platform-specific mechanism investigated and documented (bionic caches getpid → forced via `syscall(SYS_getpid)`; Darwin's own getpid is measured, not cached, ~1ns, and `syscall(2)` is deprecated/unsupported there so it is not used).

## Verification

```bash
make -C kernels macos && ./kernels/build/macos/embench-kernels --samples 3
./bin/emu-bench run --groups 1 --label kernels-check
```

## Risks

`getpid` may be cached by libc on some platforms (use `syscall(SYS_getpid)` on Linux; document the macOS/iOS equivalent chosen). Static linking against bionic: keep to plain libc + pthreads; zlib may need to be vendored for the static Android build if `libz` static linking is awkward.
