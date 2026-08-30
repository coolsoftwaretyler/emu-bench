/**
 * JS wrapper around the `ResultsFile` native module (see
 * android/app/src/main/java/com/emubench/rig/ResultsFileModule.kt and
 * ios/RigApp/ResultsFileModule.m). Legacy bridge module -- works fine under
 * the New Architecture's bridge interop layer without Codegen.
 */

import { NativeModules } from 'react-native';

type ResultsFileNativeModule = {
  getDocumentsPath(): Promise<string>;
  writeFile(filename: string, contents: string): Promise<string>;
  getProcessStartTimeMs(): Promise<number>;
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
