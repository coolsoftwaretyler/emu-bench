# T12: Host cost — power, RAM footprint, thermal endurance (Group 7)

**Status:** open
**Depends on:** T06 (`list.scroll` as the standard load), T02
**Blocks:** T13

## Context

"The emulator burns 3× the watts to show the same list" is the stat that ends arguments (PLAN.md Group 7, hypothesis H9). Power via `powermetrics` (needs sudo — requested up front with an explanation, else the group is skipped with a named reason). The endurance scenario ships for community runners on passively-cooled machines; we don't own the thermal finding, the dataset does (decision D3, SPEC.md §2).

## Scope

- `power.scroll`: run `list.scroll` (60 s, fixed params) per leg while sampling `sudo powermetrics --samplers cpu_power,gpu_power -i 1000`; parse to average CPU W, GPU W, total joules; also record the device process CPU% (qemu process vs the app + CoreSimulator tree) via `ps` sampling. Leg A analog: none (skip; this group is B-vs-C absolute).
- `ram.footprint`: steady-state host memory for one booted idle device — emulator process RSS vs CoreSimulator process-tree delta (measure the tree before/after boot; document the process-matching method) — plus the **marginal** cost of booting a second instance of each.
- `endurance` (behind `--endurance`): 10 minutes sustained `list.scroll` per leg; per-minute p95 frame time (frame recorder) + package power; emits a time series (`samples` = per-minute tuples) for degradation-curve plotting. Start-of-run thermal pressure recorded; refuse to start if not `nominal` (unless `--allow-hot`, recorded).
- sudo handling: `sudo -v` at scenario start with a printed explanation; graceful named skip if declined.

## Acceptance criteria

- [ ] `power.scroll` produces watts + joules per leg with the scroll workload verified identical (same scene params, same total px scrolled per T06's log).
- [ ] `ram.footprint` numbers are stable across two consecutive measurements (< 15% variance) and the process-tree accounting method is documented in the scenario source.
- [ ] `endurance` emits a well-formed per-minute time series on both legs and annotates thermal pressure transitions.
- [ ] Declining sudo skips group 7 cleanly with a named reason; nothing else breaks.

## Verification

```bash
./bin/emu-bench run --groups 7 --label hostcost
./bin/emu-bench run --groups 7 --endurance --label endurance-check
```

On this (actively cooled M3 Max) machine, endurance should show a flat-ish curve — the interesting curves come from community Airs; what's verified here is the machinery.
