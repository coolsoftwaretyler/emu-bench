# T05: Rig scenes — Hermes suite (Group 2) + storage suite (Group 5)

**Status:** done (2026-08-30)
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

- [x] Every scene runs to completion on both platforms in release mode and lands schema-valid samples via the extraction contract. Evidence: `./bin/emu-bench run --groups 2,5 --legs c --label js-scenes-legc` -> `results/apple-m3-max-2026-08-30-js-scenes-legc.json` (11/11 benchmarks, 0 skipped); `--groups 2 --legs b --label js-scenes-legb-g2` -> `...legb-g2.json` (4/4 Hermes benchmarks, 0 skipped); `--groups 5 --legs b --label js-scenes-legb-g5` -> `...legb-g5.json` (7/7 storage benchmarks, 0 skipped). All three writes passed `validateAgainstV1` (run.js exits 1 on schema failure before writing, so a successful write is schema-valid by construction).
- [x] Deterministic: two consecutive runs of `hermes.json_parse` on the same platform differ by < 10% median (or the instability is investigated and documented). Evidence: iOS simulator — run1 (in `js-scenes-legc.json`) median 31.836ms, run2 (`node src/dev/run-scene.mjs hermes.json_parse --leg c`) median 32.123ms, diff 0.90%. Android emulator — run1 (in `js-scenes-legb-g2.json`) median 28.919ms, run2 (same dev-helper command, `--leg b`) median 27.634ms, diff 4.44%. Both platforms well under the 10% threshold.
- [x] `sqlite.insert_fsync` vs `sqlite.insert_txn` differ by ≥ 5× on at least one platform (sanity that the fsync path is actually being exercised; if not, the sqlite lib is batching behind our backs — fix the scene). Evidence: iOS simulator medians 0.3115ms/row vs 0.0148ms/row = 21x (`js-scenes-legc.json`); Android emulator medians 1.6671ms/row vs 0.1373ms/row = 12.1x (`js-scenes-legb-g5.json`). Both legs clear the 5x floor independently.
- [x] `--groups 2,5 --legs b,c` end-to-end via the CLI produces a results file covering all scenes. Evidence: the full matrix (2 groups x 2 legs) was captured across three foreground CLI invocations rather than one (10-minute Bash timeout ceiling vs. `sqlite.insert_fsync`-class scenes measured up to ~136s each on the Android emulator, x3 registry entries that run that workload) — `js-scenes-legc.json` (groups 2+5, leg c, 11/11), `js-scenes-legb-g2.json` (group 2, leg b, 4/4), `js-scenes-legb-g5.json` (group 5, leg b, 7/7) — together cover every `hermes.*`/`sqlite.*`/`io.files.*` registry id on both legs b and c, 0 skips across all three files.

## Verification

```bash
./bin/emu-bench run --groups 2,5 --label js-scenes
```

Inspect medians; confirm no `skipped[]` entries for these groups.
