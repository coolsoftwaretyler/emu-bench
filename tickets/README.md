# Tickets

Work items for building emu-bench. Each ticket is self-contained: a fresh session should read [SPEC.md](../SPEC.md) (contract) and skim [PLAN.md](../PLAN.md) (methodology), then work the ticket without needing any prior conversation. PLAN.md's Glossary appendix defines the domain terms used throughout these tickets. Use Sonnet models for initial work.

**Working a ticket:** update its `Status:` line (open → in progress → done, with date), satisfy every acceptance checkbox with evidence, run the verification commands, and commit. **Never rewrite git history** — commit timestamps are this project's pre-registration evidence: the hypotheses in PLAN.md must verifiably predate every results file in `results/`.

## Order and dependencies

| Ticket | Title | Depends on |
|---|---|---|
| [T00](T00-phase0-smoke-run.md) | Phase 0 smoke run (manual, no code) | — (any time) |
| [T01](T01-scaffold-cli-schema.md) | Scaffold: CLI, registry, schema v1 | — |
| [T02](T02-doctor-guided-setup.md) | Doctor + guided setup + AVDs | T01 |
| [T03](T03-kernel-suite.md) | C kernel suite (Group 1) | T01 |
| [T04](T04-rig-scaffold.md) | Rig app scaffold | T01 |
| [T05](T05-scenes-hermes-storage.md) | Scenes: Hermes + storage (Groups 2, 5) | T04 |
| [T06](T06-scenes-rendering.md) | Scenes: Skia, scroll, transitions (Group 3) | T04 |
| [T07](T07-input-latency-primary.md) | Input latency, in-app (Group 4) | T04, T06 |
| [T08](T08-fence-microbench.md) | Fence microbenchmarks (Group 4) ⚠ riskiest | T03 |
| [T09](T09-input-to-photon-secondary.md) | Input-to-photon, screen-recorded (Group 4) | T07, T02 |
| [T10](T10-devloop-scenarios.md) | Dev-loop scenarios (Group 6) | T02, T04 |
| [T11](T11-maestro-e2e-flake.md) | Maestro E2E + flake rate (Group 6) | T04, T06 |
| [T12](T12-host-cost.md) | Power, RAM, endurance (Group 7) | T06, T02 |
| [T13](T13-orchestrator-matrix.md) | Run orchestrator + matrix policy | T02–T12 |
| [T14](T14-aggregate-contrib-reference.md) | Aggregate, contribution flow, reference dataset | T13 |

Parallelizable tracks after T01: {T02 → T10}, {T03 → T08}, {T04 → T05/T06 → T07/T09/T11/T12}. T13 integrates; T14 finishes.
