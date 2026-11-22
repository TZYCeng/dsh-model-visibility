/** Small bounded helpers for catalog/probe work. No I/O or detached workers. */
export function concurrency(value, fallback, max = 16) {
  return Number.isFinite(value) ? Math.min(max, Math.max(1, Math.trunc(value))) : fallback
}

/** Pull only when a worker is free; keep the adapter's original row order. */
export async function mapWorkers(items, limit, signal, visit) {
  const result = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      signal?.throwIfAborted()
      const i = next++
      result[i] = await visit(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, worker))
  signal?.throwIfAborted()
  return result
}

/** Some installed services (listModels, credentials.resolve) have no signal
 * parameter; even a signalled adapter/fetch implementation can ignore abort.
 * Hold a real slot until its underlying operation settles, not merely until the
 * caller stops waiting. If all slots are abandoned, degrade instead of issuing
 * N more calls. Other waiters wake on settlement/abort, without polling. */
export function operationSlots(limit) {
  const active = new Map(), waiters = new Set()
  const wake = () => { for (const resume of waiters) resume() }
  return async (signal, operation, ownerCurrent) => {
    signal.throwIfAborted()
    while (active.size >= limit) {
      // A retired adapter must not permanently poison its replacement. This
      // exception is registration-bound: merely refreshing the page or cache
      // never starts a second wave on the same stalled adapter.
      for (const [previous, current] of active) {
        if (previous.aborted && current && !current()) active.delete(previous)
      }
      if (active.size < limit) break
      if ([...active.keys()].every(parent => parent.aborted) || waiters.size >= limit * 2) {
        throw new Error('capacity unavailable: previous operations have not settled')
      }
      await new Promise(resolve => {
        const resume = () => { waiters.delete(resume); signal.removeEventListener('abort', resume); resolve() }
        waiters.add(resume)
        signal.addEventListener('abort', resume, { once: true })
      })
      signal.throwIfAborted()
    }
    active.set(signal, ownerCurrent)
    signal.addEventListener('abort', wake, { once: true })
    try { return await operation() }
    finally { signal.removeEventListener('abort', wake); active.delete(signal); wake() }
  }
}

/** Only explicit model/provider IDs may reach a per-model debug sample. Reject
 * URLs, paths, credential-looking strings and unexpectedly long identifiers;
 * never substitute a display name, exception message or serialized object. */
const traceId = value => typeof value === 'string' && value.length <= 120 &&
  /^[\p{L}\p{N}][\p{L}\p{N}._:/@+~-]*$/u.test(value) && !value.includes('://') && !value.includes('..') &&
  !/(?:bearer|secret|password|credential|(?:api|access)[_-]?key|token[=:]|sk-|gh[pousr]_|github_pat_|AKIA[A-Z0-9]|[a-z0-9]{48})/i.test(value) ? value : undefined
export function traceRoute(provider, model) {
  const p = traceId(provider), m = traceId(model)
  return { ...(p ? { provider: p } : {}), ...(m ? { model: m } : {}) }
}

/** Diagnostic callbacks are optional observers. Only fixed codes and counters
 * are supplied by the call sites; never pass an endpoint, model, error or key. */
export function traceEvent(trace, module, step, data) {
  if (typeof trace === 'function') {
    try { trace(module, step, data) } catch { /* Observability cannot break requests. */ }
  }
}
