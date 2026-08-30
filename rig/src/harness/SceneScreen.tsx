/**
 * Scene screen (SPEC.md §9): hosts one running scene. Renders the scene's
 * component, then once the scene calls `finish(measurement)`, writes the
 * results file and renders the stable `bench-done` testID Maestro (and the
 * host's poll loop) waits on.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { createSceneRunner } from './sceneHarness';
import type { SceneDefinition } from './sceneRegistry';

type Props = {
  scene: SceneDefinition;
  params: Record<string, string>;
};

export function SceneScreen({ scene, params }: Props) {
  const [done, setDone] = useState(false);
  const [resultsPath, setResultsPath] = useState<string | null>(null);
  const runnerRef = useRef(createSceneRunner(scene.id, params));

  const finish = useCallback((measurement: unknown) => {
    runnerRef.current.complete(measurement).then((result) => {
      setResultsPath(result.resultsPath);
      setDone(true);
    });
  }, []);

  const SceneComponent = scene.component;

  return (
    <View style={styles.container}>
      <SceneComponent sceneId={scene.id} params={params} finish={finish} />
      {done ? (
        <View testID="bench-done" style={styles.doneBanner}>
          <Text style={styles.doneText}>bench-done: {scene.id}</Text>
          {resultsPath ? <Text style={styles.pathText}>{resultsPath}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  doneBanner: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#0a6e31',
    padding: 8,
  },
  doneText: {
    color: 'white',
    fontWeight: '600',
  },
  pathText: {
    color: 'white',
    fontSize: 10,
    opacity: 0.8,
  },
});
