import manifest from '../package.json' with { type: 'json' }
import { boundedOperation } from './async-operation.js'
import { readResponseText } from './http-body.js'

const ENDPOINT = 'https://registry.npmjs.org/@tzyc%2fdsh-model-visibility/latest'
const goodFor = 6 * 60 * 60_000
const retryAfter = 60_000
const pattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
function parse(value) {
  if (typeof value !== 'string' || value.length > 128) return null
  const m = pattern.exec(value)
  if (!m || m[4]?.split('.').some(id => /^0\d+$/.test(id))) return null
  return { core: m.slice(1, 4).map(x => BigInt(x)), pre: m[4]?.split('.') }
}
const cmp = (a, b) => a === b ? 0 : a < b ? -1 : 1
export function compareVersions(left, right) {
  const a = parse(left), b = parse(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return cmp(a.core[i], b.core[i])
  if (!a.pre || !b.pre) return cmp(!a.pre, !b.pre)
  for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
    const l = a.pre[i], r = b.pre[i]
    if (l === r) continue
    const ln = /^\d+$/.test(l), rn = /^\d+$/.test(r)
    return ln && rn ? cmp(BigInt(l), BigInt(r)) : ln !== rn ? (ln ? -1 : 1) : cmp(l, r)
  }
  return cmp(a.pre.length, b.pre.length)
}
/** No network on activation. Read-only fixed npm endpoint; never install or update a package. */
export function createVersionInfo({ fetch: fetchImpl = globalThis.fetch, now = Date.now, trace = () => {}, timeoutMs = 4500 } = {}) {
  const controller = new AbortController()
  let latest = null, checkedAt = null, failure = null, attemptedAt = -Infinity, pending = null
  const snapshot = () => ({ current: manifest.version, latest, checkedAt, source: 'npm', error: failure,
    comparison: latest === null ? null : compareVersions(manifest.version, latest) })
  const read = ({ check = false } = {}) => {
    if (!check || controller.signal.aborted) return Promise.resolve(snapshot())
    if (pending) return pending
    if (now() - attemptedAt < (failure ? retryAfter : goodFor)) return Promise.resolve(snapshot())
    attemptedAt = now()
    trace('version', 'check.start', { source: 'npm' })
    pending = boundedOperation(async signal => {
      const response = await fetchImpl(ENDPOINT, { redirect: 'error', credentials: 'omit', headers: { accept: 'application/json' }, signal })
      if (!response.ok) { void response.body?.cancel?.().catch(() => {}); throw new Error('registry-unavailable') }
      const body = JSON.parse(await readResponseText(response, 96 * 1024, signal))
      if (body?.name !== manifest.name || !parse(body.version)) throw new Error('registry-invalid')
      return body.version
    }, { signal: controller.signal, timeoutMs, label: 'release metadata' }).then(version => {
      latest = version; checkedAt = now(); failure = null; trace('version', 'check.received', { source: 'npm', accepted: true })
    }, () => { failure = 'unavailable'; trace('version', 'check.failed', { source: 'npm', accepted: false }) })
      .then(snapshot).finally(() => { pending = null })
    return pending
  }
  return { read, dispose: () => controller.abort() }
}
