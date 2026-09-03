/**
 * `io.files` scene (ticket T05, PLAN.md §4 Group 5 / H7): "write+read 1,000
 * x 100 KB files; one 500 MB streamed write (guard free space; reduce size
 * with a param if needed). Report MB/s and ops/s." Uses the native
 * `ResultsFile` module's file-write/read/writeRandomFile/readFileSize
 * methods (extended for this ticket -- see nativeResultsFile.ts) rather
 * than a filesystem dependency, per D6 (SPEC.md §2).
 *
 * Two sub-measurements:
 *  - `smallFiles`: 1,000 write+read round trips of 100 KB each, per-op
 *    samples timed with performance.now(), MB/s and ops/s derived from
 *    the totals.
 *  - `largeFile`: one 500 MB streamed write + one streamed read-back,
 *    reported as MB/s (no per-op samples -- it's a single op by design).
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';
import { deleteFile, readFileSize, writeRandomFile } from '../harness/nativeResultsFile';
import { median, p95, p99, cv } from '../harness/stats';

const DEFAULT_SMALL_FILE_COUNT = 1000;
const SMALL_FILE_BYTES = 100 * 1024; // 100 KB
const DEFAULT_LARGE_FILE_BYTES = 500 * 1024 * 1024; // 500 MB
const BYTES_PER_MB = 1024 * 1024;

type OpStats = {
  n: number;
  samples_ms: number[];
  median: number;
  p95: number;
  p99: number;
  cv: number;
  opsPerSec: number;
  mbPerSec: number;
};

function summarizeOp(samples: number[], totalBytes: number): OpStats {
  const totalMs = samples.reduce((a, b) => a + b, 0);
  return {
    n: samples.length,
    samples_ms: samples,
    median: median(samples),
    p95: p95(samples),
    p99: p99(samples),
    cv: cv(samples),
    opsPerSec: totalMs > 0 ? (samples.length / totalMs) * 1000 : 0,
    mbPerSec: totalMs > 0 ? (totalBytes / BYTES_PER_MB) / (totalMs / 1000) : 0,
  };
}

async function runSmallFiles(fileCount: number): Promise<{ write: OpStats; read: OpStats }> {
  const writeSamples: number[] = [];
  const readSamples: number[] = [];

  for (let i = 0; i < fileCount; i++) {
    const filename = `embench_io_small_${i}.bin`;

    const writeStart = performance.now();
    await writeRandomFile(filename, SMALL_FILE_BYTES);
    writeSamples.push(performance.now() - writeStart);

    const readStart = performance.now();
    await readFileSize(filename);
    readSamples.push(performance.now() - readStart);

    await deleteFile(filename);
  }

  return {
    write: summarizeOp(writeSamples, fileCount * SMALL_FILE_BYTES),
    read: summarizeOp(readSamples, fileCount * SMALL_FILE_BYTES),
  };
}

async function runLargeFile(sizeBytes: number): Promise<{
  writeMs: number;
  readMs: number;
  writeMbPerSec: number;
  readMbPerSec: number;
  bytesWritten: number;
  bytesRead: number;
}> {
  const filename = 'embench_io_large.bin';

  const writeStart = performance.now();
  const bytesWritten = await writeRandomFile(filename, sizeBytes);
  const writeMs = performance.now() - writeStart;

  const readStart = performance.now();
  const bytesRead = await readFileSize(filename);
  const readMs = performance.now() - readStart;

  await deleteFile(filename);

  return {
    writeMs,
    readMs,
    writeMbPerSec: writeMs > 0 ? (bytesWritten / BYTES_PER_MB) / (writeMs / 1000) : 0,
    readMbPerSec: readMs > 0 ? (bytesRead / BYTES_PER_MB) / (readMs / 1000) : 0,
    bytesWritten,
    bytesRead,
  };
}

export function IoFilesScene({ params, finish }: SceneProps) {
  useEffect(() => {
    const fileCount = parseIntParam(params.fileCount, DEFAULT_SMALL_FILE_COUNT);
    const largeFileBytes = parseIntParam(params.largeFileBytes, DEFAULT_LARGE_FILE_BYTES);

    let cancelled = false;

    (async () => {
      const smallFiles = await runSmallFiles(fileCount);
      if (cancelled) return;
      const largeFile = await runLargeFile(largeFileBytes);
      if (cancelled) return;

      finish({
        fileCount,
        smallFileBytes: SMALL_FILE_BYTES,
        largeFileBytes,
        smallFiles,
        largeFile,
      });
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>io.files</Text>
      <Text style={styles.subtext}>1,000x100KB + one 500MB streamed write...</Text>
    </View>
  );
}

function parseIntParam(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  text: {
    color: 'white',
    fontSize: 24,
    fontWeight: '700',
  },
  subtext: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 8,
  },
});
