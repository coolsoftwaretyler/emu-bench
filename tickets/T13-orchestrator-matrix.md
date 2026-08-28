# T13: Run orchestrator — matrix policy, hygiene enforcement, skip handling

**Status:** open
**Depends on:** T02–T12 (orchestrates all of them; can begin once T02–T06 exist and grow as tickets land)
**Blocks:** T14

## Context

`emu-bench run` turns the registry into a disciplined collection session (SPEC.md §5, §12; PLAN.md §5 controls). Two policies come from plan review and must be code, not documentation: decision D3 (tuned config primary for everything; the **headline subset** — cold boot, `list.scroll` p95, `sqlite.insert_fsync`, `install.rig` — re-run on the default AVD) and the hygiene rules (interleaved legs, warmup discards, cooldowns, CV flagging, battery/thermal gates).

## Scope

- Full `run` implementation: consume `doctor --json`, boot/shutdown devices per leg as needed (tuned vs default AVD per config), execute registry benchmarks in **interleaved leg order** (A,B,C,A,B,C…) within each group, enforce per-benchmark n (≥10 macro / ≥30 micro, from registry metadata), discard 2 warmups, insert cooldown timers after GPU-heavy scenes (registry flag), compute stats, stamp CV flags.
- Default matrix = all available groups × legs, tuned; then the headline subset × leg B, default config. `--config tuned|default|both` overrides.
- Skip machinery: unavailable dependency, declined sudo, failed benchmark after one retry — all land in `skipped[]` with named reasons; the run continues.
- Session report: end-of-run console summary (per-group medians, flagged CVs, skips) and the results-file write with schema validation (refuse to write invalid).
- Resumability: `--resume <file>` continues an interrupted session (device crashed mid-run) without redoing completed benchmarks. Keep it simple — completed benchmark ids are skipped on resume.
- Runtime estimate printed up front (sum of registered durations) so a runner knows what they're committing to.

## Acceptance criteria

- [ ] A full `./bin/emu-bench run --label rehearsal` on this machine completes unattended (post sudo prompt), covering every registered benchmark on tuned + the headline subset on default, producing one schema-valid file with zero unexplained skips.
- [ ] Interleaving verified in the run log (leg order alternates within groups).
- [ ] Killing the run mid-way and `--resume`ing produces a complete, valid file without re-running finished benchmarks.
- [ ] Battery gate, thermal annotation, and CV flags all present in the output file.
- [ ] Total rehearsal wall time recorded in the ticket on completion (feeds T14's runner documentation).

## Verification

```bash
./bin/emu-bench run --label rehearsal
./bin/emu-bench aggregate  # once T14 lands; until then, validate via schema check
```

## Notes

This ticket is the integration point — expect it to surface interface friction from earlier tickets; fixing those here is in scope.
