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
    // Initiate cleanup, but never allow an upstream cancel hook to obscure the
    // actual size error with a timeout (or trigger a needless retry).
    cancelQuietly(response.body)
    throw new Error('response body is too large')
  }
  if (response.body === null || response.body === undefined) {
    const text = await response.text()
    signal?.throwIfAborted()
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('response body is too large')
    return text
  }

  const reader = response.body.getReader()
  const cancel = () => cancelQuietly(reader, signal?.reason)
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
    if (size > limit) cancelQuietly(reader)
    reader.releaseLock()
  }
}

function cancelQuietly(stream, reason) {
  try { void Promise.resolve(stream?.cancel?.(reason)).catch(() => {}) } catch { /* Release best-effort. */ }
}
