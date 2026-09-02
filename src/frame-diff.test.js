// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseRegion, analyzeFrames, decodeCroppedFrameSignals } from './frame-diff.mjs';

const execFileAsync = promisify(execFile);

/**
 * @returns {Promise<boolean>}
 */
async function ffmpegAvailable() {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a synthetic decoded-frame buffer: `nFrames` frames of `w`x`h`
 * rgb24, all one solid color except the frames in `flipAtFrames` onward
 * (each flip toggles between two colors), mirroring TouchLatencyScene's own
 * full-region flat-color flip so the same analyzer code path this module
 * uses against a real ffmpeg decode is exercised here without needing
 * ffmpeg, a screen recording, or a device at all.
 * @param {{ w: number, h: number, nFrames: number, flipAtFrames: number[] }} args
 * @returns {Buffer}
 */
function buildSyntheticFrames({ w, h, nFrames, flipAtFrames }) {
  const bytesPerFrame = w * h * 3;
  const buf = Buffer.alloc(bytesPerFrame * nFrames);
  const sortedFlips = [...flipAtFrames].sort((a, b) => a - b);
  let colorIsLight = false;
  let nextFlipIdx = 0;
  for (let f = 0; f < nFrames; f++) {
    while (nextFlipIdx < sortedFlips.length && sortedFlips[nextFlipIdx] === f) {
      colorIsLight = !colorIsLight;
      nextFlipIdx++;
    }
    const value = colorIsLight ? 0xf5 : 0x05; // matches COLOR_LIGHT/COLOR_DARK's near-white/near-black
    buf.fill(value, f * bytesPerFrame, (f + 1) * bytesPerFrame);
  }
  return buf;
}

test('parseRegion parses "x,y,w,h"', () => {
  assert.deepEqual(parseRegion('10,20,300,400'), { x: 10, y: 20, w: 300, h: 400 });
});

test('parseRegion rejects malformed input', () => {
  assert.throws(() => parseRegion('not-a-region'));
  assert.throws(() => parseRegion('1,2,3'));
  assert.throws(() => parseRegion('1,2,0,4')); // zero width
  assert.throws(() => parseRegion('1,2,3,0')); // zero height
  assert.throws(() => parseRegion('1,2,-3,4')); // negative width
});

test('parseRegion accepts negative x/y (macOS multi-monitor global coordinate space)', () => {
  // Confirmed live during this ticket's own verification: a genuine,
  // correctly-detected device window on a second display (an external
  // ultrawide arranged to the left of the primary in System Settings >
  // Displays) reported bounds with negative x AND y. Only w/h (a size,
  // never a position) must be positive -- see parseRegion's own doc
  // comment for the full explanation.
  assert.deepEqual(parseRegion('-2288,-410,399,919'), { x: -2288, y: -410, w: 399, h: 919 });
});

test('analyzeFrames finds the exact flip frame for a single tap (no quantization ambiguity)', () => {
  const fps = 60;
  const buf = buildSyntheticFrames({ w: 20, h: 20, nFrames: 180, flipAtFrames: [60] });
  const { results, missed } = analyzeFrames({
    buf,
    width: 20,
    height: 20,
    fps,
    taps: [{ tapIndex: 0, tapAtMs: (60 / fps) * 1000 }], // tap logged exactly at the flip's own frame time
  });
  assert.equal(missed.length, 0);
  assert.equal(results.length, 1);
  assert.equal(results[0].frameIndex, 60);
  assert.equal(results[0].latencyFrames, 0);
  assert.ok(Math.abs(results[0].latencyMs - 0) < 1e-9);
});

test('analyzeFrames reports positive latency in frames and derives ms from frames (quantization honesty)', () => {
  const fps = 60;
  // Tap logged at frame 55's timestamp; the scene doesn't actually flip
  // until frame 60 -- a realistic 5-frame (~83ms) photon delay.
  const buf = buildSyntheticFrames({ w: 20, h: 20, nFrames: 180, flipAtFrames: [60] });
  const tapAtMs = (55 / fps) * 1000;
  const { results } = analyzeFrames({ buf, width: 20, height: 20, fps, taps: [{ tapIndex: 0, tapAtMs }] });
  assert.equal(results.length, 1);
  assert.equal(results[0].frameIndex, 60);
  assert.equal(results[0].latencyFrames, 5);
  // ms is *derived* from the frame count, not an independently measured value.
  assert.equal(results[0].latencyMs, (5 / fps) * 1000);
});

test('analyzeFrames resolves multiple taps against multiple flips (>=30-style batch)', () => {
  const fps = 60;
  // 32 flips spaced 60 frames (1s) apart, matching the touch.latency scene's
  // own Maestro tap cadence (~1s intervals per T07's flow) and this
  // ticket's own n>=30 floor.
  const flips = Array.from({ length: 32 }, (_, i) => 60 * (i + 1));
  const nFrames = 60 * 34;
  const buf = buildSyntheticFrames({ w: 16, h: 16, nFrames, flipAtFrames: flips });
  const taps = flips.map((flipFrame, i) => ({
    tapIndex: i,
    tapAtMs: ((flipFrame - 3) / fps) * 1000, // each tap logged 3 frames before its own flip
  }));
  const { results, missed } = analyzeFrames({ buf, width: 16, height: 16, fps, taps });
  assert.equal(missed.length, 0);
  assert.equal(results.length, 32);
  for (const r of results) {
    assert.equal(r.latencyFrames, 3);
  }
});

test('analyzeFrames reports a miss when no post-tap transition exists in the recording', () => {
  const fps = 60;
  const buf = buildSyntheticFrames({ w: 10, h: 10, nFrames: 120, flipAtFrames: [] }); // never flips
  const { results, missed } = analyzeFrames({
    buf,
    width: 10,
    height: 10,
    fps,
    taps: [{ tapIndex: 0, tapAtMs: 500 }],
  });
  assert.equal(results.length, 0);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].tapIndex, 0);
});

test('analyzeFrames does not false-positive on video-codec-scale static-frame noise', () => {
  // Simulates lossy-codec noise: every byte in every frame jitters by a
  // small amount (well within TouchLatencyScene's near-maximal #050505 <->
  // #f5f5f5 swing), but the region never genuinely flips.
  const fps = 60;
  const w = 20, h = 20;
  const bytesPerFrame = w * h * 3;
  const nFrames = 120;
  const buf = Buffer.alloc(bytesPerFrame * nFrames);
  for (let f = 0; f < nFrames; f++) {
    // Deterministic small oscillation (+/-2), not a genuine flip.
    const value = 0x05 + (f % 2 === 0 ? 0 : 2);
    buf.fill(value, f * bytesPerFrame, (f + 1) * bytesPerFrame);
  }
  const { results, missed } = analyzeFrames({
    buf,
    width: w,
    height: h,
    fps,
    taps: [{ tapIndex: 0, tapAtMs: 500 }],
  });
  assert.equal(results.length, 0);
  assert.equal(missed.length, 1, 'small per-frame jitter must not be mistaken for the scene\'s flip');
});

test('analyzeFrames accepts a precomputed `signals` array (the streaming-decode path) with identical results to `buf`', () => {
  // Ticket T09's own live verification found the original whole-buffer
  // decode's fixed 512MB cap too small for a real recording (a leg-b
  // capture with a 411x759 region blew through it well before the
  // recording's actual multi-minute length finished decoding) --
  // decodeCroppedFrameSignals streams instead, computing each frame's
  // signal incrementally and only ever handing analyzeFrames the already-
  // reduced signals array, never the raw frame bytes. This test proves
  // that path produces bit-identical results to the original `buf` path
  // for the same underlying frames, using the exact same synthetic-flip
  // fixture the `buf`-path tests above already use.
  const fps = 60;
  const buf = buildSyntheticFrames({ w: 20, h: 20, nFrames: 180, flipAtFrames: [60] });
  const bytesPerFrame = 20 * 20 * 3;
  // Reproduce what decodeCroppedFrameSignals computes internally, without
  // needing ffmpeg or a real file -- same DEFAULT_SAMPLE_STRIDE-driven sum
  // frameSignal() (frame-diff.mjs, not exported) would compute per frame.
  const stride = 97;
  /** @type {number[]} */
  const signals = [];
  for (let f = 0; f < 180; f++) {
    let sum = 0;
    for (let i = 0; i < bytesPerFrame; i += stride) sum += buf[f * bytesPerFrame + i];
    signals.push(sum);
  }

  const viaBuf = analyzeFrames({ buf, width: 20, height: 20, fps, taps: [{ tapIndex: 0, tapAtMs: (55 / fps) * 1000 }] });
  const viaSignals = analyzeFrames({ signals, width: 20, height: 20, fps, taps: [{ tapIndex: 0, tapAtMs: (55 / fps) * 1000 }] });
  assert.deepEqual(viaSignals.results, viaBuf.results);
  assert.deepEqual(viaSignals.missed, viaBuf.missed);
  assert.equal(viaSignals.nFrames, viaBuf.nFrames);
});

test('analyzeFrames throws a clear error when neither `buf` nor `signals` is given', () => {
  assert.throws(
    () => analyzeFrames({ width: 20, height: 20, fps: 60, taps: [] }),
    /requires either `buf` or `signals`/,
  );
});

test(
  'decodeCroppedFrameSignals streams a real ffmpeg-decoded recording without buffering the whole thing (real ffmpeg required)',
  { skip: !(await ffmpegAvailable()) && 'ffmpeg not found on PATH -- skipping real-decode integration test' },
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'frame-diff-test-'));
    const videoPath = path.join(dir, 'test.mov');
    try {
      // Three 1s segments (dark, light, dark) at 60fps, 320x240 --
      // matches TouchLatencyScene's own COLOR_DARK/COLOR_LIGHT hex values
      // so this is a realistic stand-in for a genuine screen recording of
      // that scene, not just an arbitrary color pair.
      await execFileAsync('ffmpeg', [
        '-y',
        '-f', 'lavfi', '-i', 'color=c=0x050505:s=320x240:r=60:d=1',
        '-f', 'lavfi', '-i', 'color=c=0xf5f5f5:s=320x240:r=60:d=1',
        '-f', 'lavfi', '-i', 'color=c=0x050505:s=320x240:r=60:d=1',
        '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[outv]',
        '-map', '[outv]',
        videoPath,
      ]);

      const signals = await decodeCroppedFrameSignals({
        videoPath,
        region: { x: 50, y: 50, w: 100, h: 100 },
        fps: 60,
      });
      assert.equal(signals.length, 180, 'expected 180 frames from a 3s/60fps recording');

      const { results, missed } = analyzeFrames({
        signals,
        width: 100,
        height: 100,
        fps: 60,
        taps: [
          { tapIndex: 0, tapAtMs: (58 / 60) * 1000 }, // 2 frames before the dark->light flip at frame 60
          { tapIndex: 1, tapAtMs: (118 / 60) * 1000 }, // 2 frames before the light->dark flip at frame 120
        ],
      });
      assert.equal(missed.length, 0);
      assert.equal(results.length, 2);
      assert.equal(results[0].frameIndex, 60);
      assert.equal(results[0].latencyFrames, 2);
      assert.equal(results[1].frameIndex, 120);
      assert.equal(results[1].latencyFrames, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
