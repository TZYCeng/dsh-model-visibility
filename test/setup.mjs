/**
 * Test bootstrap: point DSH_HOME at a scratch directory before any module is
 * loaded by the runner.
 *
 * `lib/model-info.js` falls back to `$DSH_HOME/dsh-model-visibility/learned.json`
 * when a caller does not inject a learned store, and the override/shadow stores
 * read the same directory. Without this, a developer's real snapshot leaks into
 * assertions and the suite passes or fails depending on what they last verified
 * on their own machine.
 *
 * Loaded via `node --import ./test/setup.mjs` (see package.json).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-home-'))
