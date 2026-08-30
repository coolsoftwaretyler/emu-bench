/**
 * JS wrapper around the `ResultsFile` native module (see
 * android/app/src/main/java/com/emubench/rig/ResultsFileModule.kt and
 * ios/RigApp/ResultsFileModule.m). Legacy bridge module -- works fine under
 * the New Architecture's bridge interop layer without Codegen.
 *
 * `readFile`/`deleteFile`/`writeRandomFile`/`readFileSize` were added for
 * ticket T05's `io.files` scene (PLAN.md §4 Group 5): the module already
 * had a plain-file write path (`writeFile`) but no read path, and no way
 * to write/read a large file without materializing it as one JS string
 * (see writeRandomFile's doc comment in the native module for why that
 * matters at 500 MB).
 */

import { NativeModules } from 'react-native';

type ResultsFileNativeModule = {
  getDocumentsPath(): Promise<string>;
  writeFile(filename: string, contents: string): Promise<string>;
  getProcessStartTimeMs(): Promise<number>;
  readFile(filename: string): Promise<string>;
  deleteFile(filename: string): Promise<void>;
  writeRandomFile(filename: string, sizeBytes: number): Promise<number>;
  readFileSize(filename: string): Promise<number>;
};

function getModule(): ResultsFileNativeModule {
  const mod = NativeModules.ResultsFile as ResultsFileNativeModule | undefined;
  if (!mod) {
    throw new Error(
      'ResultsFile native module not found. Rebuild the app -- ' +
        'android/app/src/main/java/com/emubench/rig/ResultsFilePackage.kt must be ' +
        'registered in MainApplication.kt, and ios/RigApp/ResultsFileModule.m must ' +
        'be a Compile Sources member of the RigApp target.',
    );
  }
  return mod;
}

/** Absolute path to the app's documents directory on this platform. */
export function getDocumentsPath(): Promise<string> {
  return getModule().getDocumentsPath();
}

/** Writes `contents` to `<documentsPath>/<filename>`. Returns the full path written. */
export function writeFile(filename: string, contents: string): Promise<string> {
  return getModule().writeFile(filename, contents);
}

/** Native process-start timestamp, epoch ms. */
export function getProcessStartTimeMs(): Promise<number> {
  return getModule().getProcessStartTimeMs();
}

/** Reads `<documentsPath>/<filename>` as UTF-8 text. */
export function readFile(filename: string): Promise<string> {
  return getModule().readFile(filename);
}

/** Deletes `<documentsPath>/<filename>` if it exists. */
export function deleteFile(filename: string): Promise<void> {
  return getModule().deleteFile(filename);
}

/**
 * Writes `sizeBytes` of pseudo-random content to `<documentsPath>/
 * <filename>`, generated and streamed to disk natively -- never
 * materialized as a single JS string. Returns bytes actually written.
 */
export function writeRandomFile(filename: string, sizeBytes: number): Promise<number> {
  return getModule().writeRandomFile(filename, sizeBytes);
}

/**
 * Reads back `<documentsPath>/<filename>` in native-side chunks, without
 * materializing it in JS. Returns the total byte count read.
 */
export function readFileSize(filename: string): Promise<number> {
  return getModule().readFileSize(filename);
}
