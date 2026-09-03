# Contributing

emu-bench collects its dataset by community PR: you run the suite on your
own Apple Silicon Mac, then submit the one JSON file it writes. No hosted
collection service, no dashboard, no CI — a pull request with a results
file *is* the submission (SPEC.md §3 non-goals).

## What you need

Any Apple Silicon Mac (Intel is refused with an explanation — SPEC.md §3).
That's the hardware bar; `doctor` (below) checks and installs the rest.

## How to run

`doctor` needs `ANDROID_HOME` set to find your Android SDK — if it's not
already in your shell profile:

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
```

Then:

```bash
git clone <this repo>
cd emu-bench
./bin/emu-bench doctor   # checks Xcode, Android SDK, AVDs, Maestro,
                          # ffmpeg; installs what it can, prints exact
                          # commands for what it can't (SPEC.md §5 doctor)
./bin/emu-bench run      # the experiment: builds, boots the emulator +
                          # simulator, drives every benchmark, writes one
                          # file to results/ (SPEC.md §5 run)
./bin/emu-bench aggregate --out md   # renders the comparison tables from
                                      # every results/*.json, yours included
```

`run` is attended — a human present — but hands-off after the initial
`sudo` prompt for `powermetrics` (Group 7, host power). Expect it to take
a while: it builds three native binaries, builds the example RN app twice,
boots two devices, and works through the full benchmark matrix.

A subset (`--groups`, `--legs`, `--config`) is fine for a quick check, but
a **submitted** run should be the full default matrix — tuned config
across all legs/groups, then the default-config headline subset (SPEC.md
§5 `run`) — so it's comparable to every other machine's submission.

## What gets committed

**Only the results JSON file** `run` writes to `results/` — nothing else.
Don't commit build artifacts, AVD images, device logs, or anything from
`results/.scratch/` or `results/logs/` (already gitignored). One PR, one
file, one Mac.

## Hygiene the tool enforces (you don't have to remember it)

These aren't asks — `run` checks them itself and refuses or records
accordingly (SPEC.md §12, "provenance & hygiene enforcement: code, not
discipline"):

- **AC power.** `run` refuses to start on battery (a battery-throttled
  CPU biases every measurement). Plug in before running. An override flag
  exists for edge cases; using it is recorded in your results file, so
  don't reach for it just to get a run to start.
- **Nominal thermal start.** Thermal pressure is sampled at the start of
  the run and between every group, and lands in the file regardless of
  what it reads — you don't need a cold machine, but a run that starts
  already throttled will show it, and that's fine: it's provenance, not
  a gate.

What *is* on you, because the tool can't check it: don't run something
else CPU/GPU-heavy at the same time, and try not to run on a laptop
balanced on a pillow. Machine fingerprinting (chip, core counts, RAM,
macOS version) travels with every result, so an unusual environment is at
least visible even if it isn't prevented.

## PR checklist

Use the PR template (auto-populated when you open a PR) — it asks for:

1. **Machine description** — model/chip (the file's own `machine` block
   already has this; the template field is a quick human-readable summary
   for the PR itself).
2. **Confirmation the run was unmodified** — you ran `emu-bench run`
   against this repo as cloned, no source edits, no hand-tweaked results.
3. **Results file path** — the single file this PR adds under `results/`.

That's it. If `aggregate` renders your file into the tables without
complaint, you're done — see [SPEC.md](SPEC.md) for what "complaint"
means (schema validation, provenance completeness).

## Questions

Read [PLAN.md](PLAN.md) for the methodology (why these benchmarks, what
each hypothesis means) and [SPEC.md](SPEC.md) for the software contract
(exact CLI behavior, results schema, acceptance criteria). Both are
short enough to read end to end.
