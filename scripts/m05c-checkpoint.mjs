import assert from 'node:assert/strict';
import { runWorkerSmoke } from './smoke-worker.mjs';

// Uses a private temporary database and stops/restarts the whole local runtime.
// The normal `npm run dev:worker` database is never read or changed.
// --preview runs built assets/Worker with Wrangler's explicit local-only binding
// override. Plain `npm run preview:worker` keeps collection access disabled.
const arguments_ = process.argv.slice(2);
assert.ok(arguments_.length === 0 || (arguments_.length === 1 && arguments_[0] === '--preview'),
  'Usage: node scripts/m05c-checkpoint.mjs [--preview]');
await runWorkerSmoke({ development: !arguments_.includes('--preview'), restart: true });
