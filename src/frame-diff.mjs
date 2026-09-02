// @ts-check
/**
 * Frame-diff analyzer for `photon.latency` (ticket T09, PLAN.md §4 Group 4
 * "Input-to-photon, secondary", SPEC.md §10). Zero-dependency Node script:
 * decodes a screen recording to raw `rgb24` frames via `ffmpeg`, cropped to
 * the device-window region, piped into this process on stdout — no on-disk
 * frame-image intermediates, no npm image-decoding package.
 *
 * For every driver-logged tap timestamp (ms, relative to the recording's
 * own start), finds the first decoded frame at or after that timestamp
 * whose region content differs from the frame immediately preceding it by
 * more than `--threshold` (mean-per-sampled-byte delta) -- the first frame
 * showing the `touch.latency` scene's high-contrast flip (COLOR_DARK
 * #050505 <-> COLOR_LIGHT #f5f5f5, TouchLatencyScene.tsx) after that tap
 * was injected. Emits one `{tapIndex, tapAtMs, frameIndex, frameAtMs,
 * latencyFrames, latencyMs}` line per tap that resolves, plus a summary
 * line, on stdout as JSON-lines (matching the JSON-lines convention every
 * other native-probe module in this suite uses, e.g. kernels/main.c,
 * src/fence.js's probe parsing).
 *
 * Quantization honesty (ticket acceptance criterion 3): a video frame is
 * the finest unit this method can resolve, so `latencyFrames` is the
 * primitive measurement and `latencyMs` (`= latencyFrames / captureFps *
 * 1000`) is explicitly the derived value -- never the reverse. The scene's
 * own flip has no partial-frame state (it's a synchronous background-color
 * swap), so "changes beyond a threshold" is a same-frame binary event, not
 * a gradual ramp a smaller threshold would sharpen.
 *
 * Usage (see src/photon.js for the caller):
 *   node src/frame-diff.mjs --video <path> --fps 60 \
 *     --region x,y,w,h --taps taps.json [--threshold 8] [--sample-stride 97]
 *
 * `--taps` points at a JSON file: `[{ "tapIndex": 0, "tapAtMs": 1234.5 }, ...]`
 * (tapAtMs measured by the driver as `Date.now() - recordingStartedAtMs`,
 * i.e. already in the recording's own timeline -- this module never touches
 * wall-clock time itself, only frame-relative offsets, so it has no
 * assumption about ffmpeg's own startup latency baked in).
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/**
 * Sampling stride (in bytes) through each cropped rgb24 frame buffer used to
 * compute a lightweight per-frame signal, rather than summing every byte of
 * every frame (region crops can still be large; this suite's target is a
 * scene that fills the entire device-window region with one flat color per
 * TouchLatencyScene.tsx, so a coarse stride is exactly as sensitive to a
 * genuine full-region flip as a full-frame sum would be, at a fraction of
 * the CPU cost). 97 is prime and > 3 (the rgb24 stride) so the sample walks
 * across all three color channels over the course of a frame rather than
 * hitting the same channel every time.
 */
const DEFAULT_SAMPLE_STRIDE = 97;

/** Default detection threshold, in the same units as the per-frame signal
 * (a stride-sampled sum of byte values) -- see `resolveThreshold`. */
const DEFAULT_THRESHOLD_FRACTION = 0.2;

/**
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    out[key] = next;
    i++;
  }
  return out;
}

/**
 * `x`/`y` may legitimately be negative: they are positions in macOS's
 * GLOBAL screen-coordinate space, which extends left of and above the
 * primary display on a multi-monitor setup (e.g. an ultrawide external
 * display arranged to the primary's left in System Settings > Displays).
 * Confirmed live during this ticket's own verification: a genuine,
 * correctly-CoreGraphics-detected device window on a second display
 * reported bounds of `-2288,-410,399,919` -- rejecting negative x/y here
 * would make every multi-monitor machine unable to use this leg at all,
 * not just an edge case. Only `w`/`h` (a region's size, never its
 * position) must be positive.
 * @param {string} raw "x,y,w,h"
 * @returns {{ x: number, y: number, w: number, h: number }}
 */
export function parseRegion(raw) {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`frame-diff: invalid --region "${raw}", expected "x,y,w,h" (four numbers)`);
  }
  const [x, y, w, h] = parts;
  if (w <= 0 || h <= 0) {
    throw new Error(`frame-diff: --region width/height must be > 0, got "${raw}"`);
  }
  return { x, y, w, h };
}

/**
 * Spawns ffmpeg to decode `videoPath` to raw rgb24 frames, cropped to
 * `region`, and resolves with one lightweight per-frame signal value per
 * decoded frame (see `frameSignal`) -- NOT the raw frame bytes themselves.
 *
 * Earlier version of this function buffered the ENTIRE decoded recording
 * in memory (`Buffer.concat` over every chunk) before handing it to
 * `analyzeFrames`, capped at a fixed 512MB. Discovered during this
 * ticket's own live verification that this cap is badly undersized for a
 * real capture: a leg-b run with a 411x759 region (936,207 bytes/frame at
 * rgb24) hit "decoded frame buffer exceeded 536870912 bytes" well before
 * the recording's actual ~1-2 minute duration (32 taps x ~1s inter-tap
 * delay plus per-tap Maestro overhead) finished decoding -- the 512MB cap
 * covered only ~9.5s of that region/fps combination. Raising the constant
 * would only move the same problem to a bigger region or a longer run
 * (`--photon-taps` isn't bounded), so this function now computes each
 * frame's signal incrementally as ffmpeg's stdout chunks arrive, holding
 * at most one partial frame's worth of bytes (a few hundred KB to a few
 * MB depending on region size) at any time -- memory use no longer scales
 * with recording LENGTH at all, only with region size, and even that stays
 * bounded to a single frame's byte count regardless of how many frames
 * this decode produces.
 * @param {{ videoPath: string, region: {x:number,y:number,w:number,h:number}, fps: number, stride?: number }} args
 * @returns {Promise<number[]>} one signal value per decoded frame, in order
 */
export function decodeCroppedFrameSignals({ videoPath, region, fps, stride = DEFAULT_SAMPLE_STRIDE }) {
  return new Promise((resolve, reject) => {
    const bytesPerFrame = region.w * region.h * 3;
    if (bytesPerFrame <= 0) {
      reject(new Error(`frame-diff: invalid region dimensions ${region.w}x${region.h}`));
      return;
    }
    const args = [
      '-y',
      '-i', videoPath,
      '-vf', `crop=${region.w}:${region.h}:${region.x}:${region.y},fps=${fps}`,
      '-pix_fmt', 'rgb24',
      '-f', 'rawvideo',
      'pipe:1',
    ];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {number[]} */
    const signals = [];
    // Bytes carried over from the previous chunk that didn't complete a
    // full frame yet -- ffmpeg's stdout chunking has no relationship to
    // frame boundaries, so a frame's bytes routinely straddle two (or
    // more) 'data' events.
    let pending = Buffer.alloc(0);
    let stderr = '';
    child.stdout.on('data', (/** @type {Buffer} */ chunk) => {
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0;
      while (pending.length - offset >= bytesPerFrame) {
        signals.push(frameSignal(pending, offset, bytesPerFrame, stride));
        offset += bytesPerFrame;
      }
      // Keep only the incomplete tail -- everything before `offset` has
      // already been folded into a signal value and is no longer needed.
      pending = offset > 0 ? pending.subarray(offset) : pending;
    });
    child.stderr.on('data', (/** @type {Buffer} */ chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`frame-diff: ffmpeg decode exited ${code}\n${stderr}`));
        return;
      }
      resolve(signals);
    });
  });
}

/**
 * Computes one lightweight per-frame signal value: a stride-sampled sum of
 * raw byte values within one frame's slice of a buffer. Cheap (no
 * allocation, one pass at `stride` granularity) and, for a scene whose
 * "change" is a full-region flat-color flip, exactly as discriminating as
 * a full-frame sum.
 * @param {Buffer} buf
 * @param {number} frameOffset byte offset of this frame's first byte within `buf`
 * @param {number} bytesPerFrame
 * @param {number} stride
 * @returns {number}
 */
function frameSignal(buf, frameOffset, bytesPerFrame, stride) {
  let sum = 0;
  for (let i = 0; i < bytesPerFrame; i += stride) {
    sum += buf[frameOffset + i];
  }
  return sum;
}

/**
 * Resolves the absolute detection threshold. `thresholdFraction` (default
 * 0.2 = 20%) is applied against the maximum possible per-frame signal for
 * this region/stride (every sampled byte at 255), rather than a fixed
 * absolute number -- so the same `--threshold` default works across
 * differently-sized regions and doesn't need per-run tuning. TouchLatency-
 * Scene's flip is COLOR_DARK #050505 <-> COLOR_LIGHT #f5f5f5 -- a near-
 * maximal swing on every channel -- so even a generous 20% margin leaves
 * enormous headroom against video-codec noise on static frames while
 * remaining far below the genuine transition's actual delta.
 * @param {number} bytesPerFrame
 * @param {number} stride
 * @param {number} thresholdFraction
 * @returns {number}
 */
function resolveThreshold(bytesPerFrame, stride, thresholdFraction) {
  const samplesPerFrame = Math.ceil(bytesPerFrame / stride);
  return samplesPerFrame * 255 * thresholdFraction;
}

/**
 * Core analysis: given decoded frames and a list of tap events (each with a
 * `tapAtMs` already relative to the recording's own start), finds -- for
 * each tap -- the first frame at/after that tap's timestamp whose signal
 * differs from the previous frame's signal by more than `threshold`.
 *
 * Accepts EITHER a raw `buf` (this function computes each frame's signal
 * from it, one pass, same as before) OR a precomputed `signals` array
 * (skips that pass entirely) -- the latter is what the CLI `main()` below
 * now passes, from `decodeCroppedFrameSignals`'s incremental/streaming
 * decode (see that function's doc for why: buffering a whole real
 * recording in memory turned out to be genuinely too small at any fixed
 * cap). `buf` remains supported so every synthetic-buffer unit test in
 * frame-diff.test.js -- which deliberately avoids needing a real ffmpeg
 * decode to exercise this function's tap-matching logic -- keeps working
 * unchanged.
 * @param {{
 *   buf?: Buffer,
 *   signals?: number[],
 *   width: number,
 *   height: number,
 *   fps: number,
 *   taps: {tapIndex: number, tapAtMs: number}[],
 *   stride?: number,
 *   thresholdFraction?: number,
 * }} args
 * @returns {{ results: Array<{tapIndex: number, tapAtMs: number, frameIndex: number, frameAtMs: number, latencyFrames: number, latencyMs: number}>, missed: Array<{tapIndex: number, tapAtMs: number, reason: string}>, nFrames: number, threshold: number }}
 */
export function analyzeFrames({ buf, signals: precomputedSignals, width, height, fps, taps, stride = DEFAULT_SAMPLE_STRIDE, thresholdFraction = DEFAULT_THRESHOLD_FRACTION }) {
  const bytesPerFrame = width * height * 3;
  if (bytesPerFrame <= 0) {
    throw new Error(`frame-diff: invalid region dimensions ${width}x${height}`);
  }
  const threshold = resolveThreshold(bytesPerFrame, stride, thresholdFraction);

  /** @type {number[]} */
  let signals;
  if (precomputedSignals !== undefined) {
    signals = precomputedSignals;
  } else if (buf !== undefined) {
    // Precompute every frame's signal once (O(nFrames) passes, not
    // O(nFrames * nTaps)) -- taps.length can be >=30 per the ticket's own
    // floor, and recomputing per tap would needlessly re-scan overlapping
    // frame ranges.
    const nFramesFromBuf = Math.floor(buf.length / bytesPerFrame);
    signals = new Array(nFramesFromBuf);
    for (let f = 0; f < nFramesFromBuf; f++) {
      signals[f] = frameSignal(buf, f * bytesPerFrame, bytesPerFrame, stride);
    }
  } else {
    throw new Error('frame-diff: analyzeFrames requires either `buf` or `signals`');
  }
  const nFrames = signals.length;

  /** @type {Array<{tapIndex: number, tapAtMs: number, frameIndex: number, frameAtMs: number, latencyFrames: number, latencyMs: number}>} */
  const results = [];
  /** @type {Array<{tapIndex: number, tapAtMs: number, reason: string}>} */
  const missed = [];

  for (const tap of taps) {
    const tapFrameIndex = Math.floor((tap.tapAtMs / 1000) * fps);
    let found = -1;
    // Start the search one frame *before* the tap's own frame: injection
    // and the frame boundary can straddle the same video frame (the tap
    // lands mid-frame-interval), and PLAN.md's own quantization note
    // ("+/-1 frame") accounts for exactly this rounding -- searching from
    // tapFrameIndex - 1 rather than tapFrameIndex avoids systematically
    // biasing every latency reading up by discarding a transition that
    // actually straddled the tap's own frame.
    const searchStart = Math.max(1, tapFrameIndex - 1);
    for (let f = searchStart; f < nFrames; f++) {
      const delta = Math.abs(signals[f] - signals[f - 1]);
      if (delta > threshold) {
        found = f;
        break;
      }
    }
    if (found === -1) {
      missed.push({
        tapIndex: tap.tapIndex,
        tapAtMs: tap.tapAtMs,
        reason: `no region pixel change detected within the recording after tap frame ${tapFrameIndex}`,
      });
      continue;
    }
    const frameAtMs = (found / fps) * 1000;
    const latencyFrames = found - tapFrameIndex;
    results.push({
      tapIndex: tap.tapIndex,
      tapAtMs: tap.tapAtMs,
      frameIndex: found,
      frameAtMs,
      latencyFrames,
      latencyMs: (latencyFrames / fps) * 1000,
    });
  }

  return { results, missed, nFrames, threshold };
}

/**
 * CLI entrypoint: decodes the video, runs the analysis, prints JSON-lines
 * (one per resolved tap, one per missed tap, one summary line) to stdout --
 * the same tolerant-line-parsing contract as kernels/main.c and
 * src/fence.js's probe output.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const videoPath = args.video;
  const fps = Number(args.fps ?? '60');
  const region = parseRegion(args.region);
  const tapsPath = args.taps;
  const thresholdFraction = args.threshold !== undefined ? Number(args.threshold) : DEFAULT_THRESHOLD_FRACTION;
  const stride = args['sample-stride'] !== undefined ? Number(args['sample-stride']) : DEFAULT_SAMPLE_STRIDE;

  if (!videoPath || !tapsPath || !Number.isFinite(fps) || fps <= 0) {
    console.error(
      'usage: node src/frame-diff.mjs --video <path> --fps 60 --region x,y,w,h --taps <path.json> [--threshold 0.2] [--sample-stride 97]',
    );
    process.exit(2);
  }

  const taps = JSON.parse(await readFile(tapsPath, 'utf8'));
  // Streaming decode (see decodeCroppedFrameSignals's doc) -- memory use
  // here stays bounded to a single frame's byte count regardless of how
  // long the recording is, unlike the whole-buffer approach this CLI used
  // before (which needed an arbitrary cap that a real multi-minute,
  // multi-tap capture blew through in live testing).
  const signals = await decodeCroppedFrameSignals({ videoPath, region, fps, stride });
  const { results, missed, nFrames, threshold } = analyzeFrames({
    signals,
    width: region.w,
    height: region.h,
    fps,
    taps,
    stride,
    thresholdFraction,
  });

  for (const r of results) {
    console.log(JSON.stringify({ event: 'tap_result', ...r }));
  }
  for (const m of missed) {
    console.log(JSON.stringify({ event: 'tap_missed', ...m }));
  }
  console.log(
    JSON.stringify({
      event: 'summary',
      summary: true,
      nFrames,
      threshold,
      captureFps: fps,
      nResolved: results.length,
      nMissed: missed.length,
    }),
  );
}

// Only run as a CLI when invoked directly (not when imported by
// src/photon.js for its exported helpers), matching the module/CLI dual-use
// convention this repo doesn't otherwise need but Node's own idiom covers
// cleanly via import.meta.url.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`frame-diff: ${err?.stack ?? err}`);
    process.exit(1);
  });
}
