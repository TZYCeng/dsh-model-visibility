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

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-test-home-'))
process.env.DSH_HOME = scratch
// Tests use a private, legacy-shaped home unless explicitly exercising a profile migration.
delete process.env.DSH_PROFILE_DIR
delete process.env.DSH_PROFILE
process.once('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }) } catch { /* Windows may briefly retain a file handle. */ } })
