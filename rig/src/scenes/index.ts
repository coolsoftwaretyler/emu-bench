/**
 * Registers every scene T04 ships. Later tickets add their own
 * registration modules and import them here (or from a growing index) --
 * T04 scope is `demo.noop`, `demo.framerecorder` (frame recorder demo,
 * acceptance criterion 3), and `startup.tti`.
 */

import { registerScene } from '../harness/sceneRegistry';
import { DemoNoopScene } from './DemoNoopScene';
import { FrameRecorderDemoScene } from './FrameRecorderDemoScene';
import { StartupTtiScene } from './StartupTtiScene';

registerScene({ id: 'demo.noop', component: DemoNoopScene });
registerScene({ id: 'demo.framerecorder', component: FrameRecorderDemoScene });
registerScene({ id: 'startup.tti', component: StartupTtiScene });
