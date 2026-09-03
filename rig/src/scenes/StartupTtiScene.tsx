/**
 * `startup.tti` scene (SPEC.md §9): the app's normal first screen; marker
 * only, driven by launch scripts. Captures first-meaningful-render time as
 * early as possible after mount (i.e. after this screen has actually
 * painted) and computes the native-process-start -> JS-first-render delta
 * via the startup marker module.
 */

import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { computeStartupMarker } from '../harness/startupMarker';
import type { SceneProps } from '../harness/sceneHarness';

export function StartupTtiScene({ finish }: SceneProps) {
  useEffect(() => {
    // `InteractionManager` was removed from react-native core (this app's
    // pinned RN version throws on access in dev, and is simply `undefined`
    // in release -- see node_modules/react-native/index.js). Two chained
    // `requestAnimationFrame` calls wait for this screen's mount commit to
    // actually reach a presented frame (the first rAF fires once the
    // commit's frame is scheduled; the second confirms it was drawn) --
    // the closest signal this bare app has to "first-meaningful-render"
    // without a native paint callback.
    let cancelled = false;
    let innerHandle: number | null = null;

    const outerHandle = requestAnimationFrame(() => {
      innerHandle = requestAnimationFrame(() => {
        if (cancelled) return;
        const firstRenderTimeMs = Date.now();
        computeStartupMarker(firstRenderTimeMs).then((marker) => {
          // eslint-disable-next-line no-console
          console.log('startup.tti marker', JSON.stringify(marker));
          finish(marker);
        });
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(outerHandle);
      if (innerHandle !== null) cancelAnimationFrame(innerHandle);
    };
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.text}>emu-bench rig</Text>
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
    fontSize: 20,
    fontWeight: '600',
  },
});
