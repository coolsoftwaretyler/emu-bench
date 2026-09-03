// @ts-check
/**
 * Shared JSDoc typedefs for the results schema (SPEC.md §7) and the
 * benchmark registry. This file has no runtime exports — it exists purely
 * so other modules can `@import` these types via
 * `import('./types.js').Machine` etc.
 */

/**
 * @typedef {Object} Machine
 * @property {string} model
 * @property {string} chip
 * @property {number} pCores
 * @property {number} eCores
 * @property {number} ramGB
 * @property {string} macosVersion
 * @property {string} powerSource
 * @property {string} thermalPressureStart
 */

/**
 * @typedef {Object} Toolchain
 * @property {string} xcode
 * @property {string} iosRuntime
 * @property {string} deviceType
 * @property {string} emulatorVersion
 * @property {string} systemImage
 * @property {number} apiLevel
 * @property {string} ndk
 * @property {string} rnVersion
 * @property {string} maestro
 * @property {string} node
 */

/**
 * @typedef {Object} BenchmarkResult
 * @property {number} group
 * @property {string} id
 * @property {string} leg
 * @property {string} config
 * @property {string} unit
 * @property {string} [method] how this number was measured, when a probe
 *   only knows at runtime (T08 fence.roundtrip: "egl-surfaceless" /
 *   "egl-pbuffer" / "metal", or "skia-fallback" per SPEC.md §10; T09
 *   photon.latency: "scene-flash")
 * @property {number} [captureFps] recording frame rate for probes whose
 *   measurement quantizes to whole video frames (T09 photon.latency: 60 —
 *   "quantization honesty" per the ticket's acceptance criteria: this
 *   field plus the analyzer's frame-count values make the +/-1-frame
 *   quantization explicit rather than hiding it behind an ms-only number)
 * @property {number} n
 * @property {number} warmupsDiscarded
 * @property {number[]} samples
 * @property {number} median
 * @property {number} p95
 * @property {number} p99
 * @property {number} cv
 * @property {boolean} [cvFlagged] true when `cv > 0.10` (PLAN.md §5 "flag
 *   CV > 10% as unstable"; SPEC.md §12 "CV flags"). Additive-optional, so
 *   files written before this field existed remain valid (matches
 *   method/captureFps's own precedent).
 */

/**
 * @typedef {Object} Skip
 * @property {string} id
 * @property {string} leg
 * @property {string} reason
 */

/**
 * A single leg's execution context, handed to a registered benchmark's
 * `run(ctx)`. Later tickets (T02+) populate device handles for legs B/C;
 * T01 only exercises leg A (local exec).
 * @typedef {Object} RunContext
 * @property {'a'|'b'|'c'} leg
 * @property {'tuned'|'default'|null} config
 * @property {(cmd: string, args: string[]) => Promise<{stdout: string, stderr: string}>} exec
 *   Runs a command appropriate to this leg (leg A: local shell; leg B: adb
 *   shell; leg C: simctl spawn — wired up as those legs are implemented).
 * @property {number} [flakeRuns] `--flake-runs N` CLI override (T11,
 *   src/scenarios/e2e.js's `e2e.flake_rate`: "50-run mode is behind a flag
 *   since it's slow" — a run without the flag uses that entry's own
 *   default rather than this field being required).
 */

/**
 * A benchmark registry entry (SPEC.md §4 "Design for per-leg execution
 * contexts").
 * @typedef {Object} BenchmarkEntry
 * @property {string} id
 * @property {number} group
 * @property {string[]} legs supported leg letters, e.g. ["a"]
 * @property {'micro'|'macro'} kind micro: n>=30, macro: n>=10 (PLAN.md §5)
 * @property {string} unit
 * @property {boolean} [gpuHeavy] T13 orchestrator hygiene (PLAN.md §5
 *   "2-min cooldown after GPU-heavy scenes"; SPEC.md §12 "cooldown timers
 *   are orchestrator behavior, not instructions in a README"): flags a
 *   scene that exercises gfxstream/the GPU compositor (Group 3 rendering
 *   scenes, plus the fence probe and photon/touch-latency scenes that
 *   also drive a GPU frame) so the run orchestrator inserts a cooldown
 *   timer immediately after it runs. Omitted (falsy) means no cooldown.
 * @property {number} [durationEstimateS] rough single-invocation wall-time
 *   estimate in seconds, used only for the orchestrator's up-front runtime
 *   estimate print (ticket T13 scope: "so a runner knows what they're
 *   committing to") — never affects execution or results. Omitted entries
 *   fall back to a coarse per-kind default in the estimator.
 * @property {(ctx: RunContext) => Promise<number[] | {samples: number[], method?: string, captureFps?: number}>} run
 *   returns raw samples — either a bare array, or `{samples, method,
 *   captureFps}` when the probe's measurement method is runtime-determined
 *   and/or the samples were derived from a fixed capture frame rate and
 *   belong in the results row (see BenchmarkResult.method/.captureFps)
 */

export {};
