/**
 * Read a Fetch response as UTF-8 with a real byte ceiling.
 *
 * `response.text()` buffers the complete body before a caller can inspect its
 * size. Streaming here stops at the limit instead, including for chunked
 * responses and non-ASCII payloads. The reader is always released/cancelled.
 *
 * @param response - a standard Fetch Response (test doubles may omit cancel).
 * @param limit - maximum number of bytes, not JavaScript characters.
 * @returns the decoded response body.
 */
export async function readResponseText(response, limit, signal) {
  signal?.throwIfAborted()
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel?.().catch(() => {})
    throw new Error('response body is too large')
  }
  if (response.body === null || response.body === undefined) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('response body is too large')
    return text
  }

  const reader = response.body.getReader()
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => {}) }
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      signal?.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('response body is too large')
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    signal?.removeEventListener('abort', cancel)
    if (size > limit) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
