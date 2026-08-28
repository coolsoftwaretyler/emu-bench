# T11: Maestro E2E flow + flake-rate runner (Group 6)

**Status:** open
**Depends on:** T04 (rig), T06 (scroll/nav scenes as flow targets)
**Blocks:** T13

## Context

E2E duration and **flake rate** are the CI-relevant numbers (PLAN.md Group 6): CI throughput = duration × (1 + flake rate), so a fast-but-flaky environment loses to a slower reliable one. One flow, identical YAML on both platforms except launch stanzas.

## Scope

- `flows/e2e.yaml`: launch rig → fill a small form scene (add a `form.basic` scene to the rig if T04's debug screen doesn't suffice — keep it trivial: two inputs + a submit that navigates) → scroll a list (reuse `list.scroll` scene in manual-scroll mode: add a `mode=manual` param disabling auto-scroll so Maestro swipes) → navigate via `nav.transitions` screens → assert a terminal testID.
- Duration runner: n≥10 timed executions per platform, cold app start each time, device already booted (boot time is T10's metric, not this one).
- Flake runner: 50 executions per platform; classify each as pass / fail-flake (passes on immediate retry) / fail-real; emit duration samples + flake rate. Persist per-iteration logs for failed runs under `results/logs/` (gitignored).
- Registry entries `e2e.duration` and `e2e.flake_rate`, group 6.

## Acceptance criteria

- [ ] The flow passes ≥ 48/50 on the simulator on this machine (if it doesn't, the flow itself is flaky — fix the flow, not the number; document any legitimate environment flake found on the way).
- [ ] Same YAML file drives both platforms (platform conditionals only in launch/app-id stanzas).
- [ ] Flake classification distinguishes retry-passes from real failures; both appear in results.
- [ ] `--groups 6` includes both benchmarks; 50-run mode is behind a flag (`--flake-runs 50`) since it's slow.

## Verification

```bash
maestro test flows/e2e.yaml   # against each booted platform
./bin/emu-bench run --groups 6 --label e2e --flake-runs 10
```

## Risks

Maestro's Android and iOS drivers differ in tap/wait semantics; keep assertions on stable testIDs with generous-but-equal timeouts so the flow measures the environment, not driver timing quirks.
