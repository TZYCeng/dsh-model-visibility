import assert from 'node:assert/strict'
import test from 'node:test'

import { readResponseText } from '../lib/http-body.js'

test('the body limit uses bytes and preserves non-ASCII JSON', async () => {
  const body = JSON.stringify({ name: '模型' })
  const response = new Response(body)
  assert.equal(await readResponseText(response, Buffer.byteLength(body)), body)
  assert.deepEqual(JSON.parse(await readResponseText(new Response(body), 100)), { name: '模型' })
})

test('an oversized response is cancelled without buffering it as text', async () => {
  let cancelled = false
  let textReads = 0
  const response = {
    headers: { get: () => null },
    body: {
      getReader: () => ({
        async read() {
          return { done: false, value: Buffer.alloc(64) }
        },
        async cancel() {
          cancelled = true
        },
        releaseLock() {},
      }),
    },
    async text() {
      textReads += 1
      return ''
    },
  }
  await assert.rejects(readResponseText(response, 16), /too large/)
  assert.equal(cancelled, true)
  assert.equal(textReads, 0)
})

test('a large Content-Length is refused before the body is read', async () => {
  const response = new Response('not-json', { status: 200 })
  Object.defineProperty(response, 'text', {
    value: () => {
      throw new Error('must not buffer a refused body')
    },
  })
  response.headers.set('content-length', '100')
  await assert.rejects(readResponseText(response, 4), /too large/)
})

test('abort cancels a stalled body reader and rejects the read', async () => {
  let cancelled = false
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ cancel() { cancelled = true } }))
  const reading = readResponseText(response, 100, controller.signal)
  controller.abort(new Error('cancelled read'))
  await assert.rejects(reading, /cancelled read/)
  assert.equal(cancelled, true)
})
