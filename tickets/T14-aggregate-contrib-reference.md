# T14: Aggregate command, contribution pipeline, reference dataset

**Status:** open
**Depends on:** T13 (and everything beneath it)
**Blocks:** publication (the writeup consumes this ticket's outputs)

## Context

Final assembly (decision D5, SPEC.md §2; SPEC.md §5 aggregate, §13 acceptance; pre-registration rule in [tickets/README.md](README.md)). Community runs arrive by PR as results JSON; `aggregate` turns the results directory into the comparison tables — including the ones the writeup publishes, so no number is ever hand-copied. The reference dataset is this machine's full run.

## Scope

- `emu-bench aggregate [--out md|csv]`: validate every `results/*.json` against `schema/v1.json`; reject (list, don't crash) runs with incomplete provenance or schemaVersion mismatch; group by chip class; render:
  1. the main table — Groups 1–5 as B/A and C/A ratios (recomputed from raw samples), Groups 6–7 as absolutes;
  2. the tuned-vs-default delta table (headline subset);
  3. a per-machine appendix with CV flags and skips.
- `CONTRIBUTING.md`: how to run doctor + run, what gets committed (the results JSON only), hygiene requirements (AC power, nominal thermal start — enforced by the tool, stated for humans), and the PR checklist.
- PR template (`.github/PULL_REQUEST_TEMPLATE.md`): machine description, confirmation the run was unmodified, results file path.
- **Reference dataset**: execute the full rehearsal-quality run on this M3 Max (tuned full matrix + default headline subset + `--endurance`), commit the results file as the first entry.
- README overhaul for public readers: what this is, quick start (doctor → run → aggregate), how to read ratios, link to PLAN/SPEC, limitations paragraph (core-three scoping; preempt the Genymotion question per D1 and SPEC §3 non-goals).
- v1 acceptance sweep: verify all five SPEC §13 criteria; record evidence (commands + outputs) in this ticket file. Criterion 5 (fresh-session reproduction from README alone) executed as a genuinely fresh Claude session or second human.

## Acceptance criteria

- [ ] `aggregate` renders all three tables from ≥ 2 results files (reference run + at least one other run, e.g. a second labeled run on this machine).
- [ ] An intentionally corrupted results file is listed as rejected with a reason; aggregation still completes.
- [ ] Reference dataset committed; git history contains hypotheses (PLAN.md) before any results file (verify with `git log --follow` — this is the pre-registration evidence per [tickets/README.md](README.md); never rewrite history).
- [ ] All five SPEC §13 v1 acceptance criteria pass with recorded evidence.

## Verification

```bash
./bin/emu-bench aggregate --out md
git log --oneline --follow PLAN.md results/ | tail -20
```

The rendered main table is the artifact the writeup will embed.
