# T01: Repo scaffold — CLI skeleton, benchmark registry, results schema v1

**Status:** open
**Depends on:** nothing
**Blocks:** everything else (T02–T14)

## Context

emu-bench is a portable benchmark suite (see [SPEC.md](../SPEC.md), esp. §4 layout, §5 CLI, §7 schema, §12 hygiene). This ticket creates the skeleton every other ticket plugs into. Constraints that matter: Node ≥ 20, ESM, **zero runtime dependencies**, no build step; arm64-only hard gate; git history must never be rewritten from here on (SPEC §14).

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

- [ ] `./bin/emu-bench run --groups 1 --label smoke` executes a built-in trivial demo benchmark (e.g. a no-op timing loop registered under group 0/1) on leg A and writes a schema-valid results file with full machine/toolchain provenance.
- [ ] `node --experimental-default-type=module`-free: plain ESM via `"type": "module"`, runs on stock Node ≥ 20 with `npm install` unnecessary (no deps).
- [ ] Schema validation rejects a results file with a missing `machine.chip` (unit-test or fixture-based check).
- [ ] Battery refusal + `--allow-battery` override works and is recorded in the results file.

## Verification

```bash
./bin/emu-bench run --groups 1 --label smoke && cat results/*smoke*.json | head -40
```

File validates against `schema/v1.json`; provenance fields are populated on this machine (M3 Max → pCores 12, eCores 4).
