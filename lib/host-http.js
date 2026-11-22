import { randomUUID } from 'node:crypto'
import { readResponseText } from './http-body.js'
import { boundedOperation } from './async-operation.js'

export const API = '/api/dsh-model-visibility'
export const json = (value, status = 200) => new Response(JSON.stringify(value), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const fail = (status, code, message = code) => json({ ok: false, error: { code, message } }, status)
const ok = value => json({ ok: true, value })
const rid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Trace route boundaries without observing the URL query, actual headers or raw body.
 * Responses carry a correlation id when tracing is enabled; authenticated DSH transport is retained. */
export function wrapConnection(connection, trace) {
  return { fetch: { register(route) {
    const module = route.path.slice(API.length + 1)
    if (module === 'diagnostics') return connection.fetch.register(route)
    return connection.fetch.register({ ...route, async fetch(request) {
      if (!trace.enabled) return route.fetch(request)
      const candidate = request.headers?.get('x-mv-request-id')
      const requestId = typeof candidate === 'string' && rid.test(candidate) ? candidate : randomUUID()
      const start = performance.now()
      const dispatch = async () => {
        trace(module, 'request.received', { requestId, method: request.method })
        try {
          const result = await route.fetch(request)
          result.headers.set('x-mv-request-id', requestId)
          trace(module, 'response.sent', { requestId, httpStatus: result.status, accepted: result.ok, durationMs: performance.now() - start })
          return result
        } catch (error) { trace(module, 'request.failed', { requestId, accepted: false }); throw error }
      }
      return trace.withRequest ? trace.withRequest(requestId, dispatch) : dispatch()
    } })
  } } }
}

const MAX_CONTROL_BYTES = 64 * 1024
export async function readControl(request, limit = MAX_CONTROL_BYTES) {
  // The Connection bridge buffers to its global cap; enforce our smaller route
  // cap while consuming that buffered Request, before allocating a second copy.
  const text = await boundedOperation(signal => readResponseText(request, limit, signal).catch(error => {
    if (error?.message === 'response body is too large') error.code = 'BODY_TOO_LARGE'
    throw error
  }), { timeoutMs: 4000, signal: request.signal, label: 'control body' })
  const value = JSON.parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object')
  return value
}

function bulkView(state, preview = false) {
  const rows = Array.isArray(state?.rows) ? state.rows : []
  const counts = state?.counts ?? {}
  return { ...state, total: Number.isFinite(state?.total) ? state.total : rows.length,
    ...(preview ? { eligible: state.eligible ?? counts.pending ?? rows.filter(r => r.status === 'pending').length } : {}),
    skipped: state?.skipped ?? counts.skipped ?? 0 }
}

export function registerSupportRoutes(scope, { connection, diagnostics, versions, bulk }) {
  const mount = (name, methods, fetcher) => scope.effect(() => connection.fetch.register({ path: `${API}/${name}`, methods,
    requestBody: 'buffered', fetch: fetcher }), `model-visibility: ${name}`)
  mount('version', ['GET'], async request => ok(await versions.read({ check: new URL(request.url).searchParams.get('check') === '1' })))
  mount('diagnostics', ['GET', 'POST'], async request => {
    if (request.method === 'GET') {
      const p = new URL(request.url).searchParams
      return ok(diagnostics.snapshot({ detail: p.get('detail') === '1', after: Number(p.get('after')) || 0 }))
    }
    let body
    try { body = await readControl(request) } catch (error) { return fail(error?.code === 'BODY_TOO_LARGE' ? 413 : 400, 'diagnostics/body') }
    if (body.action === 'toggle' && typeof body.enabled === 'boolean') {
      diagnostics.setEnabled(body.enabled)
      return ok(diagnostics.snapshot({ detail: body.detail === true }))
    }
    if (body.action === 'clear') return ok(diagnostics.clear())
    if (body.action === 'append') return diagnostics.append(body.epoch, body.events) ? ok({ accepted: true }) : fail(409, 'diagnostics/inactive')
    return fail(400, 'diagnostics/action')
  })
  mount('bulk-efforts', ['GET', 'POST'], async request => {
    if (request.method === 'GET') return ok(bulkView(bulk.inspect()))
    let body
    try { body = await readControl(request, 2048) } catch (error) { return fail(error?.code === 'BODY_TOO_LARGE' ? 413 : 400, 'bulk-efforts/body') }
    try {
      if (body.action === 'preview') return ok(bulkView(await bulk.preview(), true))
      if (body.action === 'disable') return ok(bulkView(await bulk.disable()))
      if (body.action === 'enable') {
        if (typeof body.ticket !== 'string' || !body.ticket || body.ticket.length > 180) return fail(400,'bulk-efforts/ticket-required')
        return ok(bulkView(await bulk.enable({ ticket: body.ticket })))
      }
      return fail(400, 'bulk-efforts/action')
    } catch (e) {
      const known = typeof e?.code === 'string' && /^bulk-efforts\/[a-z-]{1,64}$/.test(e.code)
      return fail(known ? 409 : 503, known ? e.code : 'bulk-efforts/unavailable')
    }
  })
}
