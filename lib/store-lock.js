import fs from 'node:fs'
import path from 'node:path'

/** Short, synchronous cooperating-writer lock. Protect the entire read/merge/rename,
 * not just rename. Do not spin on the Host thread or break a potentially live lock. */
export function withStoreLock(file, operation) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = file + '.lock'
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch (e) {
    if (e.code !== 'EEXIST') throw e
    throw Object.assign(new Error('Data store is busy; retry after the other writer finishes. After a crash, check that all writers are stopped before removing a stale .lock.'), { code: 'STORE_BUSY' })
  }
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); return operation() }
  finally { try { fs.closeSync(fd) } finally { fs.unlinkSync(lock) } }
}
