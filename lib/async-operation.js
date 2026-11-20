/** Bound even providers that ignore AbortSignal; late results have no authority to write state. */
export function boundedOperation(operation, { signal, timeoutMs = 180_000, label = 'operation' } = {}) {
  const controller = new AbortController()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (failed, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      if (failed) {
        controller.abort(value)
        reject(value)
      } else resolve(value)
    }
    const cancel = () => finish(true, Object.assign(new Error(`${label} cancelled`), { code: 'CANCELLED' }))
    const timer = setTimeout(() => finish(true, Object.assign(new Error(`${label} timed out after ${timeoutMs} ms`), { code: 'TIMEOUT' })), timeoutMs)
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) return cancel()
    Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return operation(controller.signal)
    }).then(value => finish(false, value), error => finish(true, error))
  })
}
