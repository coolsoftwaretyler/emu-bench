# emu-bench

A portable benchmark suite that quantifies how the Android Emulator on
Apple Silicon actually compares to the iOS Simulator — on *any* Apple
Silicon Mac. It cancels platform confounds by holding workloads constant
(the exact same compiled code, running in both places) and reporting
ratios to a native-host baseline, so every measured gap points at a
specific cause instead of a vague "the emulator feels slow": the virtual
machine's virtual disk, its graphics pipeline shipping each draw call
across a VM boundary, the cost of a guest OS handling a timer or a
context switch, and so on. (Full technical vocabulary — HVF, gfxstream,
virtio — is in [PLAN.md](PLAN.md)'s glossary; nothing above requires
knowing those terms going in.)

The suite is the product: results are versioned JSON with full
machine/toolchain provenance, community runs are submitted by PR, and
`emu-bench aggregate` renders the comparison tables straight from those
files — no number in the writeup is ever hand-copied. The findings double
as the requirements document for a potential "Android emulator that
doesn't suck" project.

- [PLAN.md](PLAN.md) — methodology: design principles, the seven
  benchmark groups, controls, hypotheses H1–H9
- [SPEC.md](SPEC.md) — software contract: decision log, CLI surface,
  doctor behavior, results schema v1, scene inventory, acceptance
  criteria
- [tickets/](tickets/README.md) — self-contained work items with
  dependency order
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to submit your own run

## Quick start

`doctor` needs to find your Android SDK, which means `ANDROID_HOME` has
to be set before you run anything — if you don't already have this in
your shell profile:

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

Then three commands, in order:

```bash
git clone <this repo>
cd emu-bench
./bin/emu-bench doctor      # checks your Mac is ready, installs what it can
./bin/emu-bench run         # runs the full benchmark matrix, writes one results file
./bin/emu-bench aggregate --out md   # renders the comparison tables
```

`doctor` answers "can this Mac run the suite?" — it checks for Xcode, the
Android SDK, the right emulator images, Maestro, ffmpeg, and the two
benchmark AVDs, installing what it safely can and printing exact commands
for what it can't (never modifies anything without saying so first). If
you skipped the `ANDROID_HOME` step above, this is where you'll find out
— `doctor` fails the Android SDK checks and tells you exactly what's
missing.

`run` is the experiment. It's attended (a human present) but hands-off
after one `sudo` prompt (needed for the power-measurement group): it
builds the workloads, boots the Android Emulator and iOS Simulator, drives
every benchmark, and writes a single JSON file to `results/` with every
sample plus full provenance (machine, tool versions, config, thermal
state). Expect it to take a while — it's covering a lot of ground.

`aggregate` reads every file in `results/` — the one you just produced,
plus anyone else's — validates each against the results schema, and
renders the comparison tables. This is also exactly what generates the
tables in any published writeup, so the numbers you see are always
reproducible from the committed JSON.

Want to contribute your own machine's numbers? See
[CONTRIBUTING.md](CONTRIBUTING.md) — it's a PR with one JSON file.

## How to read the ratios

Every benchmark runs on up to three "legs":

| Leg | What it is | Role |
|---|---|---|
| **A** | A plain Mac program — no VM, no translation | Baseline = 1.0 |
| **B** | Android Emulator (arm64 AVD, hardware-accelerated) | System under test |
| **C** | iOS Simulator (arm64 process on the Mac's own kernel) | Reference — what a device environment on a Mac *can* feel like |

Where all three exist, results are reported as **ratios to leg A**:
`B/A` and `C/A`. A `B/A` of `4.0×` means the emulator took four times as
long as the identical workload running natively on the same Mac. Numbers
near `1.0×` mean "no meaningful overhead here"; large numbers point at a
specific subsystem paying a real cost. Where leg A has no meaning (most
of the app-level benchmarks — the example app only builds for the two
device targets), the comparison is emulator vs. simulator directly
(`C/B`) instead. A few groups (device boot, install, power) are inherently
absolute, not ratio-shaped — the aggregator reports them as-is.

Ratios travel across machines even though absolute times don't, which is
the whole point of measuring this way: your M1 Air's numbers and someone
else's M4 Max's numbers are comparable as ratios even though neither
machine's raw milliseconds are.

## Limitations

**Three legs, deliberately.** This suite compares exactly native macOS,
the Android Emulator, and the iOS Simulator — no other Android
virtualization option is in scope, and that's a considered choice, not an
oversight: cancelling confounds requires holding almost everything else
constant (same host, same arm64 machine code, same app, same measurement
methodology), and every additional target multiplies what has to be
controlled for. If you're wondering about Genymotion, BlueStacks, or a
cloud-hosted emulator: they're explicitly out of scope, along with real
devices and non-macOS hosts. The Android Emulator was chosen because it's
what a plain `npx react-native run-android` gives a developer by default
— that default experience, not the best achievable one, is what's being
measured.

**Apple Silicon only.** The methodology depends on arm64-everywhere (the
guest, the host, and the workload binaries all being the same
instruction set) — the CLI refuses to run on Intel Macs with an
explanation rather than attempting a degraded comparison.

**Attended runs, no CI.** Every run needs a human present (for the power
prompt, and because the emulator/simulator windows are genuinely visible
during a run). There's no hosted results collection or automated
nightly run — results arrive by PR, reviewed like any other contribution.

See [SPEC.md](SPEC.md) §3 for the full non-goals list, and
[PLAN.md](PLAN.md) §3 for how the three legs are actually defined.
