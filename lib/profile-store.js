import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { withStoreLock } from './store-lock.js'

// Do not turn a permissions or I/O failure on a legacy file into an empty profile.
const exists = file => fs.statSync(file, { throwIfNoEntry: false }) !== undefined

/** Keep runtime data under DSH_HOME, never in the user's profile configuration tree. */
export function storageRoot(home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), profile = process.env.DSH_PROFILE_DIR) {
  const legacy = path.join(home, 'dsh-model-visibility')
  // Explicit scratch homes (tests and standalone tools) must never inherit live state.
  if (!profile || (process.env.DSH_HOME && path.resolve(home) !== path.resolve(process.env.DSH_HOME))) return { legacy, current: legacy }
  const key = path.resolve(profile)
  const name = createHash('sha256').update(process.platform === 'win32' ? key.toLowerCase() : key).digest('hex').slice(0, 20)
  return { legacy, current: path.join(legacy, 'profiles', name) }
}
/** Migrate a user-owned legacy snapshot once, preserving the original. Publication is
 * exclusive and atomic even if two Hosts initialize the same profile concurrently. */
export function profileDataFile(name, { home, profile, importLegacy = true } = {}) {
  if (!/^[a-z][a-z0-9-]*\.json$/.test(name)) throw new TypeError('Invalid data filename')
  const { legacy, current } = storageRoot(home, profile)
  const file = path.join(current, name)
  if (current === legacy || !importLegacy || exists(file)) return file
  const original = path.join(legacy, name)
  if (!exists(original)) return file
  return withStoreLock(file, () => {
    if (exists(file)) return file
    const tmp = `${file}.${randomUUID()}.import`
    try {
      fs.copyFileSync(original, tmp, fs.constants.COPYFILE_EXCL)
      // Same-directory rename also works on volumes with no hard-link support.
      fs.renameSync(tmp, file)
    } finally { try { fs.unlinkSync(tmp) } catch (e) { if (e.code !== 'ENOENT') throw e } }
    return file
  })
}
