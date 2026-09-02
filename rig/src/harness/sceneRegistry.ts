/**
 * Scene registry (SPEC.md §9): maps a scene id (as used in
 * `emubench://scene/<id>?...`) to the component that implements it. Later
 * tickets (T05, T06, T07) register their scenes here; T04 registers only
 * `demo.noop` and `startup.tti`.
 */

import type { ComponentType } from 'react';
import type { SceneProps } from './sceneHarness';

export type SceneDefinition = {
  id: string;
  component: ComponentType<SceneProps>;
};

const scenes = new Map<string, SceneDefinition>();

/**
 * Registers a scene, overwriting any existing registration under the same
 * id (ticket T10 discovery, `refresh.metro`): React Native's Fast Refresh
 * re-executes a changed module's entire dependent graph, which includes
 * every top-level `registerScene(...)` call in `scenes/index.ts` -- so
 * *any* edit to *any* scene file reachable from that index re-runs every
 * one of these calls again in the same process. A throw-on-duplicate
 * registry (the original behavior here) made Fast Refresh crash on its
 * very first update for any scene, with "sceneRegistry: duplicate scene
 * id ..." -- confirmed via a real dev-mode edit-and-observe run against
 * `refresh.marker`. Overwriting is the correct, idempotent behavior for a
 * registry that must survive repeated re-execution of its own
 * registration calls; a genuine accidental duplicate id at authoring time
 * is a code-review concern, not a runtime invariant to enforce here.
 */
export function registerScene(definition: SceneDefinition): void {
  scenes.set(definition.id, definition);
}

export function getScene(id: string): SceneDefinition | undefined {
  return scenes.get(id);
}

export function allScenes(): SceneDefinition[] {
  return [...scenes.values()];
}
