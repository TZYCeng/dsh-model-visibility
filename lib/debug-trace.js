import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { storageRoot } from './profile-store.js'

const MAX = 512
const nums = new Set('bytes count groups models total eligible matched written skipped skippedKnown catalogTargets checkerTargets pending processed acceptedCount failed unknown providers failures infoErrors collected allowed imported fieldsCount routes rows durationMs code httpStatus attempts batch index scanCount valid publicReliable sourceFailures searchCalls fetchCalls contextWindow maxTokens concurrency done'.split(' '))
const flags = new Set('ok allowed accepted cached fresh reload enabled running readBack guarded changed available applied cancelled writing computing exact alias readback writeBack'.split(' '))
const ids = new Set('provider model runId requestId'.split(' '))
const codes = new Set('source status reason mode phase api field outcome origin action method format'.split(' '))
const arrays = new Set(['fields','input','output','efforts','sources'])
const safeId = s => typeof s === 'string' && s.length <= 160 && /^[\p{L}\p{N}_.:@/+~-]+$/u.test(s) && !s.includes('://') && !s.startsWith('/') && !/(?:bearer|sk-|gh[pousr]_|github_pat_|AKIA[A-Z0-9]|[a-z0-9]{48})/i.test(s)
const code = s => safeId(s) && /^[a-z0-9][a-z0-9._:/-]{0,63}$/i.test(s)
const shortCode = s => code(s) && !s.includes('/')
const uuid = s => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
/** A positive schema, not a blacklist of passwords. Arbitrary objects/messages and payloads are dropped. */
export function traceData(raw) {
  const result = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result
  for (const key of Object.keys(raw).slice(0, 64)) {
    const v = raw[key]
    if (nums.has(key) && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) result[key] = Math.trunc(v)
    else if (flags.has(key) && typeof v === 'boolean') result[key] = v
    else if (ids.has(key) && safeId(v)) result[key] = v
    else if (codes.has(key) && code(v)) result[key] = v
    else if (arrays.has(key) && Array.isArray(v)) result[key] = v.slice(0, 24).filter(shortCode)
  }
  return result
}
export function createDebugTrace({ dir = path.join(storageRoot().current, 'logs'), now = Date.now, limit = MAX } = {}) {
  const cap = Math.max(8, Math.min(MAX, limit || MAX))
  const file = path.join(dir, `debug-${randomUUID()}.jsonl`)
  let events = [], seq = 0, dropped = 0, timer = null, dirty = false, disposed = false, epoch = null, diskError = false, ownFile = false
  // Retain crash evidence across restarts, without ever following links or touching
  // unrelated files. Only trace files created by this module can match the name.
  let lastSweep = -Infinity
  const prune = () => {
    if (now() - lastSweep < 86_400_000) return
    lastSweep = now()
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^debug-[a-f0-9-]{36}\.jsonl$/i.test(entry.name)) continue
        const candidate = path.join(dir, entry.name)
        if (candidate !== file && now() - fs.statSync(candidate).mtimeMs > 7 * 86_400_000) fs.unlinkSync(candidate)
      }
    } catch { /* Optional cleanup must not affect collection. */ }
  }
  const flush = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!dirty) return
    const temp = file + '.tmp'
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.writeFileSync(temp, events.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 })
      fs.renameSync(temp, file); ownFile = true; dirty = diskError = false; prune()
    } catch { diskError = true; try { fs.unlinkSync(temp) } catch { /* optional diagnostic sink */ } }
  }
  const schedule = () => { dirty = true; if (timer === null) { timer = setTimeout(flush, 700); timer.unref?.() } }
  const add = (origin, module, step, data) => {
    if (!epoch || disposed || !shortCode(module) || !shortCode(step)) return false
    try {
      events.push({ seq: ++seq, at: now(), origin, module, step, data: traceData(data) })
      if (events.length > cap) { events.shift(); dropped++ }
      schedule(); return true
    } catch { return false } // Instrumentation must never make a request fail.
  }
  const context = new AsyncLocalStorage()
  const trace = (module, step, data) => {
    if (!epoch || disposed) return false
    const parent = context.getStore()
    if (parent && parent.epoch !== epoch) return false
    return add('host', module, step, parent ? { requestId: parent.requestId, ...data } : data)
  }
  trace.withRequest = (requestId, run) => context.run({ requestId, epoch }, run)
  Object.defineProperty(trace, 'enabled', { get: () => !!epoch && !disposed })
  const snapshot = ({ detail = false, after = 0 } = {}) => ({ enabled: !!epoch, epoch, count: events.length, dropped, diskError,
    ...(ownFile || epoch ? { file } : {}), ...(detail ? { events: events.filter(e => e.seq > after).map(e => structuredClone(e)) } : {}) })
  const setEnabled = value => {
    if (disposed || value === !!epoch) return snapshot()
    if (value) { epoch = randomUUID(); trace('debug', 'recording.on', { enabled: true }) }
    else { trace('debug', 'recording.off', { enabled: false }); epoch = null; flush() }
    return snapshot()
  }
  return { trace, snapshot, setEnabled,
    append(key, rows) { if (!uuid(key) || key !== epoch || !Array.isArray(rows) || rows.length > 48) return false
      for (const row of rows) if (row && typeof row === 'object') add('client', row.module, row.step, row.data)
      return true },
    clear() { events = []; dropped = 0; if (epoch) epoch = randomUUID(); if (ownFile || dirty) { dirty = true; flush() } return snapshot({ detail: true }) },
    dispose() { if (disposed) return; setEnabled(false); flush(); disposed = true; context.disable() },
  }
}
