# T05: Rig scenes — Hermes suite (Group 2) + storage suite (Group 5)

**Status:** open
**Depends on:** T04
**Blocks:** T13 (full-matrix orchestration)

## Context

Two groups of pure-JS scenes that exploit the same-bytecode trick: Hermes is the identical engine on both platforms, so any measured gap is environment tax, not runtime differences (PLAN.md §4 Groups 2 & 5; hypotheses H3 and H7). Storage is predicted to be the largest gap in the whole suite via the fsync path (virtio-blk/qcow2 vs APFS).

## Scope

Hermes scenes (measure with `performance.now()`, report ops/s or ms/op samples, ≥30 samples each, warmups discarded by the harness):

- `hermes.json_parse`: parse a deterministic ~5 MB realistic API payload (generate from a seeded PRNG at scene start — no fixture files) ×N.
- `hermes.collections`: map/filter/reduce over 100k objects.
- `hermes.strings`: string building, RegExp, date parsing mix.
- `hermes.worklet`: Reanimated worklet executing a fixed computation on the UI thread; measures cross-thread scheduling + UI-thread throughput.

Storage scenes (via the sqlite lib chosen in T04):

- `sqlite.insert_fsync`: 10k single-row inserts, implicit transactions (the fsync-heavy pathological case).
- `sqlite.insert_txn`: same 10k rows in one transaction.
- `sqlite.reads`: 10k indexed point reads after seeding.
- `sqlite.wal_toggle`: repeat insert_fsync with WAL on vs off (two sub-results).
- `io.files`: write+read 1,000 × 100 KB files; one 500 MB streamed write (guard free space; reduce size with a param if needed). Report MB/s and ops/s.

All scenes register with the T04 harness and are runnable via `emubench://scene/<id>`; add registry entries so `emu-bench run --groups 2,5` executes them on legs B and C.

## Acceptance criteria

- [ ] Every scene runs to completion on both platforms in release mode and lands schema-valid samples via the extraction contract.
- [ ] Deterministic: two consecutive runs of `hermes.json_parse` on the same platform differ by < 10% median (or the instability is investigated and documented).
- [ ] `sqlite.insert_fsync` vs `sqlite.insert_txn` differ by ≥ 5× on at least one platform (sanity that the fsync path is actually being exercised; if not, the sqlite lib is batching behind our backs — fix the scene).
- [ ] `--groups 2,5 --legs b,c` end-to-end via the CLI produces a results file covering all scenes.

## Verification

```bash
./bin/emu-bench run --groups 2,5 --label js-scenes
```

Inspect medians; confirm no `skipped[]` entries for these groups.
