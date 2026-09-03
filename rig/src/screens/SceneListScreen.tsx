/**
 * Debug-only human scene list screen (ticket T04 scope). Shown when the
 * app is launched with no deep link (e.g. tapping the app icon in a dev
 * build) so a human can browse/trigger scenes without needing to remember
 * URLs. Not used by any automated extraction path -- those always launch
 * via deep link (SPEC.md §9).
 */

import React from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { allScenes } from '../harness/sceneRegistry';

export function SceneListScreen() {
  const scenes = allScenes();

  return (
    <View style={styles.container}>
      <Text style={styles.header}>emu-bench rig — scenes (debug)</Text>
      <FlatList
        data={scenes}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable
            style={styles.row}
            onPress={() => Linking.openURL(`emubench://scene/${item.id}?durationMs=1000`)}
          >
            <Text style={styles.rowText}>{item.id}</Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.rowText}>No scenes registered.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    paddingTop: 48,
    paddingHorizontal: 16,
  },
  header: {
    color: 'white',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  row: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#333',
  },
  rowText: {
    color: 'white',
    fontSize: 16,
  },
});
