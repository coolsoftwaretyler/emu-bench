/**
 * Rig app root (SPEC.md §9, ticket T04). Deep links
 * (`emubench://scene/<id>?...`) route directly into a scene screen with no
 * navigation stack -- `react-navigation` (a pinned dep, D6) is reserved for
 * the `nav.transitions` scene (T06), not app-level routing.
 *
 * @format
 */

import './src/scenes';

import React, { useEffect, useState } from 'react';
import { Linking, StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { parseSceneLink } from './src/harness/deepLink';
import { getScene } from './src/harness/sceneRegistry';
import { SceneScreen } from './src/harness/SceneScreen';
import { SceneListScreen } from './src/screens/SceneListScreen';

type Route =
  | { kind: 'none' }
  | { kind: 'scene'; sceneId: string; params: Record<string, string>; launchKey: string }
  | { kind: 'unknown-scene'; sceneId: string };

let launchCounter = 0;

function routeFromUrl(url: string | null): Route {
  if (!url) return { kind: 'none' };
  const parsed = parseSceneLink(url);
  if (!parsed) return { kind: 'none' };
  const scene = getScene(parsed.sceneId);
  if (!scene) return { kind: 'unknown-scene', sceneId: parsed.sceneId };
  // `singleTask` (Android) / re-opening an already-running app (iOS) means
  // a repeat deep link into the same scene id delivers via onNewIntent /
  // Linking's 'url' event without unmounting the JS component tree. Every
  // dispatch gets a fresh `launchKey` so `AppContent` below can force a
  // full remount (via `key`) instead of reusing the previous run's
  // harness state (SceneScreen's runner, done/results state).
  launchCounter += 1;
  return {
    kind: 'scene',
    sceneId: parsed.sceneId,
    params: parsed.params,
    launchKey: `${parsed.sceneId}-${launchCounter}`,
  };
}

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [route, setRoute] = useState<Route>({ kind: 'none' });

  useEffect(() => {
    let cancelled = false;

    Linking.getInitialURL().then((url) => {
      if (!cancelled) setRoute(routeFromUrl(url));
    });

    const subscription = Linking.addEventListener('url', ({ url }) => {
      setRoute(routeFromUrl(url));
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <View style={styles.container}>
        <AppContent route={route} />
      </View>
    </SafeAreaProvider>
  );
}

function AppContent({ route }: { route: Route }) {
  if (route.kind === 'scene') {
    const scene = getScene(route.sceneId);
    if (scene) {
      return <SceneScreen key={route.launchKey} scene={scene} params={route.params} />;
    }
  }
  // No deep link, or an unresolvable one: fall back to the debug scene
  // list so a human tapping the app icon always sees something useful.
  // (Debug-only per ticket scope; a release build with no matching scene
  // still shows this rather than a blank screen, which is fine -- it is
  // never reached by automated extraction, which always deep-links.)
  return <SceneListScreen />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});

export default App;
