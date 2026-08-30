/**
 * Registers every scene the rig ships. Later tickets add their own
 * registration modules and import them here (or from a growing index) --
 * T04 scope was `demo.noop`, `demo.framerecorder` (frame recorder demo,
 * acceptance criterion 3), and `startup.tti`. T05 adds the Hermes suite
 * (Group 2) and storage suite (Group 5) -- see PLAN.md §4.
 */

import { registerScene } from '../harness/sceneRegistry';
import { DemoNoopScene } from './DemoNoopScene';
import { FrameRecorderDemoScene } from './FrameRecorderDemoScene';
import { StartupTtiScene } from './StartupTtiScene';
import { HermesJsonParseScene } from './HermesJsonParseScene';
import { HermesCollectionsScene } from './HermesCollectionsScene';
import { HermesStringsScene } from './HermesStringsScene';
import { HermesWorkletScene } from './HermesWorkletScene';
import { SqliteInsertFsyncScene } from './SqliteInsertFsyncScene';
import { SqliteInsertTxnScene } from './SqliteInsertTxnScene';
import { SqliteReadsScene } from './SqliteReadsScene';
import { SqliteWalToggleScene } from './SqliteWalToggleScene';
import { IoFilesScene } from './IoFilesScene';

registerScene({ id: 'demo.noop', component: DemoNoopScene });
registerScene({ id: 'demo.framerecorder', component: FrameRecorderDemoScene });
registerScene({ id: 'startup.tti', component: StartupTtiScene });

// Group 2 -- Hermes suite (ticket T05)
registerScene({ id: 'hermes.json_parse', component: HermesJsonParseScene });
registerScene({ id: 'hermes.collections', component: HermesCollectionsScene });
registerScene({ id: 'hermes.strings', component: HermesStringsScene });
registerScene({ id: 'hermes.worklet', component: HermesWorkletScene });

// Group 5 -- storage suite (ticket T05)
registerScene({ id: 'sqlite.insert_fsync', component: SqliteInsertFsyncScene });
registerScene({ id: 'sqlite.insert_txn', component: SqliteInsertTxnScene });
registerScene({ id: 'sqlite.reads', component: SqliteReadsScene });
registerScene({ id: 'sqlite.wal_toggle', component: SqliteWalToggleScene });
registerScene({ id: 'io.files', component: IoFilesScene });
