# emu-bench

A portable benchmark suite that quantifies how the Android Emulator on Apple Silicon actually compares to the iOS Simulator — on *any* Apple Silicon Mac. It cancels platform confounds by holding workloads constant (same arm64 machine code, same Hermes bytecode, same Skia drawing commands) and reporting ratios to a native-host baseline, so every measured gap indicts a specific subsystem: HVF/vCPU tax, gfxstream command serialization, virtio storage, transport, lifecycle.

The suite is the product: results are versioned JSON with full machine/toolchain provenance, community runs are submitted by PR, and `emu-bench aggregate` renders the comparison tables. The findings double as the requirements document for a potential "Android emulator that doesn't suck" project.

**Status:** specified and ticketed; build not started. Private until the single-reveal publication (decision D8).

- [PLAN.md](PLAN.md) — methodology: design principles, the seven benchmark groups, controls, hypotheses H1–H9
- [SPEC.md](SPEC.md) — software contract: decision log D1–D10, CLI surface, doctor behavior, results schema v1, scene inventory, acceptance criteria
- [tickets/](tickets/README.md) — self-contained work items T00–T14 with dependency order

## Quick start (current state)

Nothing is built yet. Phase 0 needs no code — Geekbench 6 (emulator APK vs native macOS), boot stopwatches, `adb push` throughput, quickboot failure counts — see [T00](tickets/T00-phase0-smoke-run.md) and the PLAN.md appendix.

Once built: `emu-bench doctor` → `emu-bench run` → `emu-bench aggregate`.
