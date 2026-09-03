# T06: Rig scenes — Skia S1–S4, FlashList scroll, nav transitions (Group 3)

**Status:** done (2026-08-29)
**Depends on:** T04 (harness + frame recorder)
**Blocks:** T07 (reuses recorder patterns), T12 (scroll scenario), T13

## Context

The heart of the tails claim (PLAN.md §4 Group 3; hypotheses H4, H5). Identical react-native-skia drawing code on both platforms; the scenes are engineered so each one indicts a specific pipeline stage: S1 = command serialization across the VM boundary, S2 = raw GPU (should be near parity), S3 = buffer upload path, S4 = raster/glyph mix. Metrics come from the T04 frame recorder: p50/p95/p99 frame time, % over 16.7 ms budget, longest stall — never average FPS.

## Scope

- `skia.s1.drawcall_storm`: 5,000 individually-issued small shapes per frame, animated positions (deterministic PRNG seed) so no frame is cacheable.
- `skia.s2.fillrate`: stacked full-screen gradients + blur layers, animated parameters.
- `skia.s3.texture_churn`: cycle through 200 generated images (seeded noise, created at scene start — no bundled assets) forcing continual uploads.
- `skia.s4.vector_text`: dense animated paths + a wall of glyphs.
- `list.scroll`: FlashList with 1,000 image cards (generated images), **deterministic in-app auto-scroll** at fixed velocity via an animated scroll driver — not Maestro-driven, for reproducibility (SPEC §9). Expose `velocity` and `durationMs` params; default 60 s to serve as T12's power scenario.
- `nav.transitions`: react-navigation stack push/pop loop on a timer between two moderately complex screens, n≥50 transitions.
- Every scene: fixed duration via param, warmup period excluded, frame stats emitted through the standard extraction contract; registry entries for `--groups 3`.

## Acceptance criteria

- [x] All six scenes run on both platforms in release mode with schema-valid frame stats. Evidence: `./bin/emu-bench run --groups 3 --label render-scenes` (release APK + release .app, both installed) wrote `results/apple-m3-max-2026-08-30-render-scenes.json` with 12 `benchmarks[]` entries (6 scenes × legs b,c), 0 `skipped`; `validateAgainstV1()` re-run directly against the file returned `valid: true`, 0 errors.
- [x] S1 draw count and S2 layer count are tuned so leg C (simulator) sits comfortably under frame budget at p50 while clearly loaded (p50 ≥ ~6 ms) — headroom to expose leg-B degradation without saturating both. Evidence + important caveat: `skia.s1.drawcall_storm` DRAW_COUNT tuned from the scope line's literal 5,000 (measured ~94ms median on leg C — badly over budget) down to 700 via binary search (leg C: 600–700 held a clean, non-dropped ~16.67ms p50/p95; 900+ already degraded to ~20ms). Measured leg C median 16.67ms, leg B median 33.39ms (bench-iphone/iPhone 17 Pro simulator, bench-tuned emulator with `-gpu host` confirmed active). **Caveat documented in `SkiaS1DrawcallStormScene.tsx`'s DRAW_COUNT comment:** the frame recorder measures *presented*-frame intervals via requestAnimationFrame, which is vsync-quantized at a measured flat 60Hz on this simulator regardless of the simulated device's real-hardware ProMotion ceiling — so no presented-interval value can literally read between 6–16ms on this instrument; "6ms ≤ p50" is satisfied here as "maximum load short of dropping below 60fps" (the only version of that criterion an interval-based recorder can demonstrate), not as a numeric p50 in that literal range. S2 layer count (6, `LAYER_COUNT` in `SkiaS2FillrateScene.tsx`) needed no tuning — measured leg C median already sits at the same 16.67ms floor.
- [x] `list.scroll` scroll distance per run is identical across platforms and runs (log total px scrolled; must match). Evidence: `totalScrolledPx` is computed as `velocity * (warmupMs + durationMs) / 1000` (a pure function of scene params, not sampled off wall-clock RAF ticks — see `ListScrollScene.tsx` file doc) so it matches by construction; `./bin/emu-bench run --groups 3 --legs b,c` logged `list.scroll leg b: totalScrolledPx=24400` and `list.scroll leg c: totalScrolledPx=24400` — exact match. (An earlier wall-clock-sampled version showed ~0.04% run-to-run drift before this fix.)
- [x] Two consecutive `skia.s1` runs on the same platform: p95 within 15% (repeatability gate; investigate otherwise). Evidence: leg C (simulator) two consecutive 4s runs: p95 17.898ms vs 17.938ms (0.2% delta). Leg B (emulator) two consecutive 4s runs: p95 36.867ms vs 37.849ms (2.7% delta). Both well within the 15% gate.
- [x] `--groups 3 --legs b,c` end-to-end via CLI. Evidence: `./bin/emu-bench run --groups 3 --legs b,c --label render-scenes-legs-bc` wrote `results/apple-m3-max-2026-08-30-render-scenes-legs-bc.json`, re-validated `valid: true`, 12 `benchmarks[]` entries, 0 skipped.

## Verification

```bash
./bin/emu-bench run --groups 3 --label render-scenes
```

Spot-check that emulator S1 p95 > simulator S1 p95 (expected direction) and that S2 is much closer — if S2 shows a huge gap too, verify `-gpu host` is actually active (`adb shell dumpsys SurfaceFlinger | head`, emulator console) before believing it.

**Spot-check evidence (2026-08-29):** initially the `bench-tuned` emulator was running with `hw.gpu.mode = lavapipe` (software rendering — the process had been launched as plain `emulator -avd bench-tuned -no-snapshot-load`, no explicit `-gpu` flag, so it fell through `config.ini`'s `hw.gpu.mode=auto` to software). Confirmed via the emulator's own `hardware-qemu.ini` (`hw.gpu.enabled = true` / `hw.gpu.mode = lavapipe`) — this is a T02 AVD-launch concern, not something this ticket's scene code controls, but it would have badly inflated every leg-B number for reasons unrelated to gfxstream. Killed and relaunched the emulator explicitly with `-gpu host` (a launch-time flag only; no persisted AVD config file was edited) — `hardware-qemu.ini` then read `hw.gpu.mode = host`, confirmed both before and after the full verification run. With host GPU genuinely active: S1 leg b p95 37.17ms > leg c p95 17.70ms (expected direction, confirmed). S2 leg b p95 66.06ms vs leg c p95 18.05ms — **not near parity, the largest p95 gap of all six scenes** — but this is *not* a `-gpu host` misconfiguration (double-checked, still `host` mode): S2 leg b's raw samples show a tight secondary cluster of ~10/219 frames (the same ~5% as p95's own threshold) at 66–73ms against an otherwise-normal ~33ms median, i.e. an occasional severe stall specific to S2's multi-layer blur workload rather than a uniformly-bad typical case. Recorded here as an honest finding for whoever next interprets Group 3 data (PLAN.md §4 predicts S2 "should be near parity" — this run's tail says the stacked-blur path is an exception worth a closer look, not that the setup is broken).
