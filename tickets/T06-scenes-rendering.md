# T06: Rig scenes — Skia S1–S4, FlashList scroll, nav transitions (Group 3)

**Status:** open
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

- [ ] All six scenes run on both platforms in release mode with schema-valid frame stats.
- [ ] S1 draw count and S2 layer count are tuned so leg C (simulator) sits comfortably under frame budget at p50 while clearly loaded (p50 ≥ ~6 ms) — headroom to expose leg-B degradation without saturating both.
- [ ] `list.scroll` scroll distance per run is identical across platforms and runs (log total px scrolled; must match).
- [ ] Two consecutive `skia.s1` runs on the same platform: p95 within 15% (repeatability gate; investigate otherwise).
- [ ] `--groups 3 --legs b,c` end-to-end via CLI.

## Verification

```bash
./bin/emu-bench run --groups 3 --label render-scenes
```

Spot-check that emulator S1 p95 > simulator S1 p95 (expected direction) and that S2 is much closer — if S2 shows a huge gap too, verify `-gpu host` is actually active (`adb shell dumpsys SurfaceFlinger | head`, emulator console) before believing it.
