import assert from 'node:assert/strict'
import test from 'node:test'
import { boundedOperation } from '../lib/async-operation.js'

test('bounded operation settles ordinary success and both sync and async failures', async () => {
  assert.equal(await boundedOperation(() => 42), 42)
  const failure = new Error('downstream failed')
  await assert.rejects(boundedOperation(() => { throw failure }), error => error === failure)
  for (const value of [undefined, null, false, 0, '']) {
    const settled = await boundedOperation(() => Promise.reject(value)).then(
      () => ({ ok: true }), reason => ({ ok: false, reason }),
    )
    assert.deepEqual(settled, { ok: false, reason: value })
  }
})

test('deadline aborts the downstream operation and owns its late completion', async () => {
  const work = Promise.withResolvers()
  let downstream
  const pending = boundedOperation(signal => { downstream = signal; return work.promise }, { timeoutMs: 15 })
  await assert.rejects(pending, { code: 'TIMEOUT' })
  assert.equal(downstream.aborted, true)
  work.reject(new Error('ignored late downstream rejection'))
  await new Promise(resolve => setImmediate(resolve))
})

test('a cancelled parent prevents new work from starting', async () => {
  const started = { value: false }
  const parent = new AbortController()
  const pending = boundedOperation(() => { started.value = true }, { signal: parent.signal })
  parent.abort()
  await assert.rejects(pending, { code: 'CANCELLED' })
  assert.equal(started.value, false)
})
