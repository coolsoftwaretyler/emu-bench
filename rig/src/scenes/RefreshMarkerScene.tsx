/**
 * `refresh.marker` scene (SPEC.md §9 scene table, PLAN.md §4 Group 6, H8;
 * ticket T10 scope). Renders a marker string; the *value* of that string
 * lives in this file as a plain module-level string literal
 * (`MARKER_VALUE` below) so the host-side fast-refresh driver
 * (src/scenarios/refresh.js) can locate and rewrite it with a plain text
 * replace, exactly like a developer editing source and hitting save.
 *
 * Unlike every other scene, this one never calls `finish()` -- the whole
 * point of the fast-refresh loop is that Metro's Fast Refresh reloads this
 * module *in place* (dev-mode build, PLAN.md §5 "Dev-mode builds used
 * only for the fast-refresh test") without the app restarting or this
 * component unmounting: each edit-save re-executes this file's module
 * body (React Fast Refresh's documented behavior -- it re-runs the
 * changed module and re-renders components using it, preserving app
 * state elsewhere), which re-evaluates `MARKER_VALUE` to its new source
 * value and re-renders with it.
 *
 * That re-render is the app's own "re-render signal" (ticket: "waits for
 * the app's re-render signal"). It is surfaced two ways:
 *
 *   1. `console.log('EMUBENCH_REFRESH_MARKER', MARKER_VALUE)` -- reaches
 *      Android's logcat under the `ReactNativeJS` tag (confirmed against
 *      a real dev-mode build + live Metro instance during this ticket's
 *      implementation).
 *   2. A tiny sentinel file, `<documents>/refresh-marker.local.txt`,
 *      containing the current `MARKER_VALUE`, written via the same
 *      native `ResultsFile.writeFile` module every other scene's results
 *      writer uses (rig/src/harness/nativeResultsFile.ts) -- because
 *      iOS's `console.log` in this RN version (0.87, New Architecture /
 *      Bridgeless) does not surface through Apple's unified logging
 *      system in a way `simctl spawn ... log stream` can observe
 *      (confirmed empirically: an `os_log`-level capture scoped to the
 *      RigApp process during this ticket's implementation, across a
 *      full scene mount + marker render, contained no trace of the JS
 *      console.log call at all). The file is the reliable cross-platform
 *      signal `refresh.js` actually polls; the log line is kept as a
 *      secondary, human-debuggable trace on the platform where it does
 *      surface.
 *
 * No `durationMs`/params handling, no `bench-done` testID: this scene
 * runs indefinitely under the driver's control, not for a fixed measured
 * duration the scene itself owns. It does reuse the same
 * `embench-results.json`-sibling documents directory every other scene
 * writes into, via the same native module -- just a different filename,
 * so the host's existing per-platform "read a file back out of the app's
 * documents dir" mechanics (src/rig-host.js's `awaitAndPullResultsAndroid`
 * / `awaitAndPullResultsIos`, both already proven reliable by every other
 * scene) apply unchanged.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { writeFile } from '../harness/nativeResultsFile';
import type { SceneProps } from '../harness/sceneHarness';

/** Matches src/scenarios/refresh.js's REFRESH_MARKER_FILENAME constant. */
const MARKER_FILENAME = 'refresh-marker.local.txt';

// The literal the driver rewrites in place, one line, nothing else on it
// -- src/scenarios/refresh.js matches this exact line via regex and
// replaces only the quoted value, so keep this declaration on its own
// line untouched by formatting that would wrap or split it.
export const MARKER_VALUE = 'initial';

export function RefreshMarkerScene(_props: SceneProps) {
  // Fires on mount AND on every Fast-Refresh-triggered re-render (the
  // re-executed module body re-registers this component with React,
  // which re-renders it) -- exactly the signal the driver polls for.
  // Logged directly in the render body (not gated behind an effect with
  // an empty dependency array, which would fire once on the *initial*
  // mount and never again once Fast Refresh preserves that mount)
  // guarantees a fresh console.log line on every re-render, refresh
  // included; the sentinel-file write below happens in an effect with no
  // dependency array for the same reason -- Fast Refresh re-running this
  // module body re-creates and re-invokes that effect too.
  // eslint-disable-next-line no-console
  console.log('EMUBENCH_REFRESH_MARKER', MARKER_VALUE);

  useEffect(() => {
    writeFile(MARKER_FILENAME, MARKER_VALUE).catch(() => {
      // Best-effort -- a transient native-module hiccup shouldn't crash
      // the scene; the driver's own poll-with-timeout will surface a
      // missing/stale file as a clear timeout error instead.
    });
  });

  return (
    <View style={styles.container}>
      <Text style={styles.text}>refresh.marker</Text>
      <Text style={styles.marker}>{MARKER_VALUE}</Text>
    </View>
  );
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
  marker: {
    color: '#7fd88f',
    fontSize: 32,
    fontWeight: '800',
    marginTop: 12,
  },
});
