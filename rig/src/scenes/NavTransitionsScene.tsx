/**
 * `nav.transitions` (ticket T06, PLAN.md §4 Group 3): "react-navigation
 * stack push/pop loop on a timer between two moderately complex screens,
 * n>=50 transitions." Owns its own `NavigationContainer` + native-stack
 * navigator internally (App.tsx's own comment: react-navigation is
 * "reserved for the nav.transitions scene (T06), not app-level routing") --
 * this scene is the only place in the rig react-navigation is actually
 * mounted.
 *
 * A timer inside the currently-focused screen alternates `navigation.
 * navigate('B'|'A')` (push) and `navigation.goBack()` (pop) at a fixed
 * interval; a shared FrameRecorder runs for the scene's whole `durationMs`
 * (same instrumentation contract as every other T06 scene) so a stutter
 * during the transition animation itself shows up in the frame stats, not
 * just "how long did N transitions take."
 */

import React, { useEffect, useRef } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { NavigationContainer, useNavigation, type NavigationProp } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { FrameRecorder } from '../harness/frameRecorder';
import { parseDurationMs, parseWarmupMs, parseNumberParam } from '../harness/sceneHarness';
import type { SceneProps } from '../harness/sceneHarness';

const DEFAULT_DURATION_MS = 15_000;
const DEFAULT_WARMUP_MS = 1000;
/** n>=50 per the ticket's literal acceptance/scope line. Fixed (not a
 * param) because the interval below is derived from it and durationMs so
 * the loop always completes within the measured window regardless of
 * durationMs overrides. */
const MIN_TRANSITIONS = 50;
/** Rows rendered per screen -- "moderately complex" per scope: enough
 * layout/text work to be a real screen, not a blank view, without being a
 * scene of its own. */
const ROWS_PER_SCREEN = 30;

type RootStackParamList = { ScreenA: undefined; ScreenB: undefined };

const Stack = createNativeStackNavigator<RootStackParamList>();

function ScreenContent({ label, accent }: { label: string; accent: string }) {
  const rows = Array.from({ length: ROWS_PER_SCREEN }, (_, i) => i);
  return (
    <View style={[styles.screen, { backgroundColor: accent }]}>
      <Text style={styles.title}>{label}</Text>
      <FlatList
        data={rows}
        keyExtractor={(i) => String(i)}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rowText}>
              {label} - row {item}
            </Text>
          </View>
        )}
      />
    </View>
  );
}

/**
 * Drives the push/pop timer loop. Mounted once, inside `ScreenA` only (not
 * duplicated onto `ScreenB`) so exactly one timer runs regardless of which
 * screen currently has focus -- `navigation.navigate`/`goBack` both work
 * from any screen in the stack via the shared `navigation` object.
 */
function useTransitionLoop(
  navigation: NavigationProp<RootStackParamList>,
  intervalMs: number,
  targetTransitions: number,
  onDone: (transitionCount: number) => void,
) {
  const countRef = useRef(0);
  const onScreenBRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => {
      if (countRef.current >= targetTransitions) {
        clearInterval(timer);
        onDone(countRef.current);
        return;
      }
      if (onScreenBRef.current) {
        navigation.goBack();
      } else {
        navigation.navigate('ScreenB');
      }
      onScreenBRef.current = !onScreenBRef.current;
      countRef.current += 1;
    }, intervalMs);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, targetTransitions]);
}

function ScreenA({ intervalMs, targetTransitions, onDone }: {
  intervalMs: number;
  targetTransitions: number;
  onDone: (transitionCount: number) => void;
}) {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  useTransitionLoop(navigation, intervalMs, targetTransitions, onDone);
  return <ScreenContent label="Screen A" accent="#1a2a4a" />;
}

function ScreenB() {
  return <ScreenContent label="Screen B" accent="#2a1a4a" />;
}

export function NavTransitionsScene({ params, finish }: SceneProps) {
  const durationMs = parseDurationMs(params, DEFAULT_DURATION_MS);
  const warmupMs = parseWarmupMs(params, DEFAULT_WARMUP_MS);
  const minTransitions = parseNumberParam(params, 'minTransitions', MIN_TRANSITIONS);
  // Spread `minTransitions` push/pop cycles evenly across the measured
  // window (post-warmup) so the loop neither finishes long before
  // durationMs elapses nor tries to exceed it.
  const intervalMs = Math.max(50, Math.floor(durationMs / minTransitions));

  // `transitionCount` (from the push/pop loop) and the frame recorder run
  // on independent clocks -- the loop has no warmup concept, so it
  // finishes its `minTransitions` cycles around wall-clock `durationMs`
  // after mount, while the recorder (which excludes `warmupMs` from its
  // own clock) finishes around `warmupMs + durationMs`. `finish` fires
  // once, keyed on the recorder (the scene's timing source of truth,
  // same contract as every other T06 scene) -- by the time it resolves,
  // the loop has always already reached `minTransitions` (its finish
  // condition is reached strictly earlier), so `transitionCountRef`
  // reflects the completed loop, not a partial one.
  const transitionCountRef = useRef(0);

  useEffect(() => {
    const recorder = new FrameRecorder(durationMs, warmupMs);
    recorder.start().then((stats) => {
      finish({ ...stats, transitionCount: transitionCountRef.current, minTransitions, intervalMs });
    });
    return () => recorder.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationMs, warmupMs]);

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ animation: 'slide_from_right' }}>
        <Stack.Screen name="ScreenA" options={{ headerShown: false }}>
          {() => (
            <ScreenA
              intervalMs={intervalMs}
              targetTransitions={minTransitions}
              onDone={(count) => {
                transitionCountRef.current = count;
              }}
            />
          )}
        </Stack.Screen>
        <Stack.Screen name="ScreenB" component={ScreenB} options={{ headerShown: false }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    paddingTop: 48,
    paddingHorizontal: 16,
  },
  title: {
    color: 'white',
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
  },
  row: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.15)',
  },
  rowText: {
    color: '#eee',
    fontSize: 14,
  },
});
