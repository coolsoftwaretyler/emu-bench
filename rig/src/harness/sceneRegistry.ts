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

export function registerScene(definition: SceneDefinition): void {
  if (scenes.has(definition.id)) {
    throw new Error(`sceneRegistry: duplicate scene id "${definition.id}"`);
  }
  scenes.set(definition.id, definition);
}

export function getScene(id: string): SceneDefinition | undefined {
  return scenes.get(id);
}

export function allScenes(): SceneDefinition[] {
  return [...scenes.values()];
}
