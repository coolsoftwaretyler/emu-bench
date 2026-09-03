/**
 * `form.basic` scene (ticket T11, PLAN.md §4 Group 6 E2E row: "launch rig ->
 * fill a small form scene -> scroll a list -> navigate -> assert a terminal
 * testID"). SPEC.md §9's scene table has no dedicated form scene, and T04's
 * debug list screen (rig/src/screens/SceneListScreen.tsx) is a scene
 * *launcher*, not a fillable form -- so per this ticket's own scope line
 * ("add a `form.basic` scene to the rig if T04's debug screen doesn't
 * suffice -- keep it trivial: two inputs + a submit that navigates"), this
 * is a new, deliberately minimal scene: two `TextInput`s (name, email) and a
 * submit button.
 *
 * "Submit that navigates": this scene owns no `NavigationContainer` of its
 * own -- `react-navigation` is reserved for `nav.transitions`
 * (NavTransitionsScene.tsx's own doc comment: "the only place in the rig
 * react-navigation is actually mounted"), and the E2E flow already drives
 * *between* scenes as separate deep-link launches (see flows/e2e.yaml,
 * following flows/touch-latency.yaml's precedent of one `openLink` per
 * scene rather than one continuous in-app navigator spanning the whole
 * flow). So "navigates" here means an in-scene screen transition: pressing
 * submit swaps the form's content for a second, distinct screen (still the
 * same mounted scene component, no unmount/remount) bearing its own stable
 * testID -- a real, visible navigation-shaped state change Maestro can
 * assert on, without a second, unused navigation stack competing with
 * nav.transitions' own.
 *
 * Finishes (renders `bench-done`, same harness contract as every other
 * scene) once the second screen has rendered -- there is nothing to time
 * here (this scene is a flow *step*, not a Group 3/4/5 measurement in its
 * own right; e2e.duration/e2e.flake_rate time the whole Maestro flow from
 * the host side, src/scenarios/e2e.js), so the "measurement" finish()
 * reports is trivial: which values were submitted, confirming the fields
 * actually round-tripped through the two controlled inputs.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { SceneProps } from '../harness/sceneHarness';

export function FormBasicScene({ finish }: SceneProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <View style={styles.container} testID="form-basic-success">
        <Text style={styles.text}>form.basic</Text>
        <Text style={styles.subtext}>submitted</Text>
        <Text style={styles.value}>name: {name}</Text>
        <Text style={styles.value}>email: {email}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.text}>form.basic</Text>
      <TextInput
        testID="form-name-input"
        style={styles.input}
        placeholder="Name"
        placeholderTextColor="#666"
        value={name}
        onChangeText={setName}
      />
      <TextInput
        testID="form-email-input"
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#666"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <Pressable
        testID="form-submit-button"
        style={styles.button}
        onPress={() => {
          setSubmitted(true);
          finish({ name, email });
        }}
      >
        <Text style={styles.buttonText}>Submit</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
    paddingHorizontal: 24,
  },
  text: {
    color: 'white',
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 20,
  },
  subtext: {
    color: '#7fd88f',
    fontSize: 18,
    marginBottom: 12,
  },
  value: {
    color: '#ccc',
    fontSize: 14,
    marginTop: 4,
  },
  input: {
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#555',
    borderRadius: 6,
    color: 'white',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#0a6e31',
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginTop: 8,
  },
  buttonText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 16,
  },
});
