# T01: Repo scaffold — CLI skeleton, benchmark registry, results schema v1

**Status:** done (2026-08-29)
**Depends on:** nothing
**Blocks:** everything else (T02–T14)

## Context

emu-bench is a portable benchmark suite (see [SPEC.md](../SPEC.md), esp. §4 layout, §5 CLI, §7 schema, §12 hygiene). This ticket creates the skeleton every other ticket plugs into. Constraints that matter: Node ≥ 20, ESM, **zero runtime dependencies**, no build step; arm64-only hard gate; git history must never be rewritten from here on (pre-registration rule — see [tickets/README.md](README.md)).

## Scope

- `bin/emu-bench` entrypoint + `src/` with subcommand dispatch: `doctor`, `run`, `aggregate` (stubs OK for doctor/aggregate; `run --groups` should execute whatever is in the registry).
- **Benchmark registry**: a benchmark = `{ id, group, legs, kind, run(ctx) → samples }`. Later tickets register entries; the orchestrator iterates the registry. Design for per-leg execution contexts (leg A = local exec, leg B = adb, leg C = simctl).
- **Provenance module**: captures everything in SPEC §7 `machine` + `toolchain` (sysctl for chip/P-cores/E-cores/RAM, sw_vers, xcodebuild -version, emulator -version, sdkmanager --list_installed parsing, node --version, git SHA). Power-source check (refuse on battery without `--allow-battery`; record the override).
- **Stats module**: median, p95, p99, CV from raw samples; warmup-discard helper.
- `schema/v1.json` (JSON Schema) exactly matching SPEC §7, plus a validator used by `aggregate` and by `run` before writing.
- Results writer: `results/<chip-slug>-<date>-<label>.json`.
- `LICENSE` (MIT), `.gitignore` (node_modules, rig build outputs, .DS_Store), minimal `CONTRIBUTING.md` stub pointing at T14.
- Arm64 gate: `sysctl -n hw.optional.arm64` must be 1 or every command exits with the explanation from SPEC §3.

## Out of scope

Doctor logic (T02), any real benchmarks (T03+), aggregation rendering (T14).

## Acceptance criteria

- [x] `./bin/emu-bench run --groups 1 --label smoke` executes a built-in trivial demo benchmark (e.g. a no-op timing loop registered under group 0/1) on leg A and writes a schema-valid results file with full machine/toolchain provenance. — Ran `./bin/emu-bench run --groups 1 --label smoke`; wrote `results/apple-m3-max-2026-08-29-smoke.json` with `demo.noop_loop` (group 1, leg a, n=30) and full `machine`/`toolchain` blocks populated (chip "Apple M3 Max", pCores 12, eCores 4); validated against `schema/v1.json` via `validateAgainstV1()` → VALID.
- [x] `node --experimental-default-type=module`-free: plain ESM via `"type": "module"`, runs on stock Node ≥ 20 with `npm install` unnecessary (no deps). — `package.json` has `"type": "module"`, no `dependencies` key, `"engines": {"node": ">=20"}`; ran directly on stock `node v24.2.0` with no `node_modules/` present and no experimental flags.
- [x] Schema validation rejects a results file with a missing `machine.chip` (unit-test or fixture-based check). — `node --test src/schema.test.js`: 6/6 pass, including `"schema rejects a results file with missing machine.chip (acceptance criterion 3)"`.
- [x] Battery refusal + `--allow-battery` override works and is recorded in the results file. — With a stubbed `pmset -g batt` reporting `'Battery Power'` on PATH: plain `run` refused with exit 1 and no file written; `run --allow-battery` exited 0, wrote a results file with `machine.powerSource: "Battery"` and `notes: "Ran on battery power via --allow-battery override."`, and validated against `schema/v1.json` → VALID.

## Verification

```bash
./bin/emu-bench run --groups 1 --label smoke && cat results/*smoke*.json | head -40
```

File validates against `schema/v1.json`; provenance fields are populated on this machine (M3 Max → pCores 12, eCores 4).
