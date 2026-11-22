import { API } from './constants.mjs'

// Browser instrumentation is inert until this Host explicitly opens a debug session.
// Send metadata to the same authenticated Host only. Never send a draft, request body,
// raw result, headers, error message, credential, or endpoint URL.
let active = null
let buffer = []
let timer = null
let sending = false
let lost = 0
const batchMax = 40
const keys = new Set('provider model runId requestId fields source status reason mode count total eligible skipped failed written pending processed accepted durationMs bytes groups models cached fresh enabled ok'.split(' '))
const symbol = /^[\p{L}\p{N}_.:/+@~-]{1,120}$/u
const secret = /(?:https?:|bearer|(?:sk-|gh[pousr]_|github_pat_|AKIA[A-Z0-9])|[A-Za-z0-9_\-]{40,})/i
const label = (v) => typeof v === 'string' && symbol.test(v) && !secret.test(v) && !v.startsWith('/') && !v.includes('://') ? v : undefined
const clean = (input) => {
  const out = {}
  for (const key of keys) {
    const val = input?.[key]
    if (typeof val === 'boolean' || Number.isFinite(val)) out[key] = val
    else if (key === 'fields' && Array.isArray(val)) out.fields = val.slice(0, 24).map(label).filter(Boolean)
    else if (label(val)) out[key] = label(val)
  }
  return out
}
function arm() {
  if (!active || sending || timer !== null || !buffer.length) return
  timer = setTimeout(flush, 250)
  timer?.unref?.()
}
async function flush() {
  timer = null
  if (!active || sending || !buffer.length) return
  const epoch = active
  const events = buffer.splice(0, batchMax)
  if (lost) { events.push({ module: 'client', step: 'buffer.dropped', data: { count: lost } }); lost = 0 }
  sending = true
  try {
    const res = await fetch(API + '/diagnostics', { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'append', epoch, events }), signal: AbortSignal.timeout(4000) })
    if (active === epoch && (res.status === 409 || res.status === 404)) setClientTraceSession(null)
  } catch { /* No retry loop and no interference with application work. */ }
  finally { sending = false; arm() }
}
export function setClientTraceSession(epoch) {
  const next = typeof epoch === 'string' && /^[a-f0-9-]{36}$/i.test(epoch) ? epoch : null
  if (next === active) return
  active = next; buffer = []; lost = 0
  if (timer !== null) clearTimeout(timer)
  timer = null
}
export function tracedFetch(path, options, fetchImpl = fetch) {
  if (!active || typeof globalThis.crypto?.randomUUID !== 'function') return fetchImpl(path, options)
  const session = active
  const requestId = globalThis.crypto.randomUUID()
  const module = String(path).split('?')[0].split('/').pop() || 'client'
  const start = Date.now()
  clientTrace(module, 'request.sent', { requestId, mode: options?.method === 'POST' ? 'write' : 'read' })
  return Promise.resolve().then(() => fetchImpl(path, { ...options, headers: { ...options?.headers, 'x-mv-request-id': requestId } }))
    .then(response => { if (active === session) clientTrace(module, 'reply.received', { requestId, accepted: response.ok, durationMs: Date.now() - start }); return response },
      error => { if (active === session) clientTrace(module, 'reply.unavailable', { requestId, accepted: false }); throw error })
}
export function clientTrace(module, step, data = {}) {
  if (!active) return
  if (!label(module) || !label(step)) return
  if (buffer.length >= 200) { lost++; return }
  buffer.push({ module, step, data: clean(data) }); arm()
}
