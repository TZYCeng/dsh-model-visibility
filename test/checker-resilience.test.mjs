import test from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilityVerifier } from '../lib/check-catalog.js'
import { callChecker } from '../lib/checker-call.js'
import { validateReplyShape, evidenceBackedRows, checkerSystemPrompt } from '../lib/checker-contract.js'

const emptyFetch = async () => new Response('{}')
const quiet = { warn() {} }
const unknown = id => ({ id, kind: null, input: null, output: null, contextWindow: null, maxTokens: null, reasoning: null, reasoningEfforts: null, defaultEffort: null, evidence: [] })
function setup(stream, extra = {}) {
  const writes = []
  const llm = {
    listProviders: () => [{ id: 'relay' }],
    listModels: async () => [{ id: 'a' }, { id: 'b' }],
    prepareCall: async config => ({ config, stream }),
    ...extra.llm,
  }
  const verifier = createCapabilityVerifier({ llm, learned: { upsertEntries: entries => writes.push(...entries), meta: () => ({}) }, fetch: emptyFetch, logger: quiet, timeoutMs: 30, ...extra, llm })
  return { verifier, writes, llm }
}
const start = verifier => verifier.start({ checker: { provider: 'relay', model: 'checker' }, writeBack: false })

test('175 known and 16 unknown models complete all 191 targets', async () => {
  const { verifier } = setup(async function* (request) {
    const ids = JSON.parse(request.messages[0].content[0].text.split('\n')[1])
    yield { type: 'text-delta', text: JSON.stringify(ids.map(id => Number(id.slice(1)) < 175 ? { id, kind: 'chat' } : { id })) }
  }, { timeoutMs: 1000, llm: { listModels: async () => Array.from({ length: 191 }, (_, i) => ({ id: `m${i}` })) } })
  const result = await start(verifier)
  assert.equal(result.phase, 'done')
  assert.equal(result.done, 175)
  assert.equal(result.processed, 191)
  assert.equal(result.unknown, 16)
  assert.equal(result.failed, 0)
})

test('a provider that hangs during prepareCall cannot hold the sweep forever', async () => {
  const { verifier, writes } = setup(async function* () {}, { llm: { prepareCall: () => new Promise(() => {}) } })
  const result = await start(verifier)
  assert.equal(result.running, false)
  assert.equal(result.processed, 2)
  assert.equal(result.failed, 2)
  assert.match(result.errors.join(), /timed out/)
  assert.deepEqual(writes, [])
})

test('cancel and dispose stop a stalled stream without waiting for next()', async () => {
  let entered
  const begun = new Promise(resolve => { entered = resolve })
  const { verifier, writes } = setup(async function* () { entered(); await new Promise(() => {}) }, { timeoutMs: 1000 })
  const run = start(verifier)
  await begun
  await verifier.dispose()
  assert.equal((await run).phase, 'cancelled')
  assert.deepEqual(writes, [])
})

test('healthy half survives a permanently malformed sibling', async () => {
  const { verifier, writes } = setup(async function* (request) {
    const ids = JSON.parse(request.messages[0].content[0].text.split('\n')[1])
    yield { type: 'text-delta', text: ids.includes('b') ? 'broken' : '[{"id":"a","kind":"chat"}]' }
  }, { timeoutMs: 1000 })
  const result = await start(verifier)
  assert.equal(result.processed, 2)
  assert.equal(result.done, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.unknown, 0)
  assert.equal(writes[0].id, 'a')
})

test('fixed contract rejects invalid fields, duplicates and contradictory reasoning', () => {
  assert.equal(validateReplyShape([unknown('a')], ['a'], { strict: true }).ok, true)
  for (const row of [{ ...unknown('a'), contextWindow: '1000' }, { ...unknown('a'), input: ['magic'] }, { ...unknown('a'), defaultEffort: 'high', reasoningEfforts: {} }, { ...unknown('a'), reasoning: false, reasoningEfforts: ['high'] }]) {
    assert.equal(validateReplyShape([row], ['a'], { strict: true }).ok, false)
  }
  assert.equal(validateReplyShape([unknown('a'), unknown('a')], ['a'], { strict: true }).ok, false)
  assert.equal(validateReplyShape([{ id: 'a' }], ['a'], { strict: true }).ok, false)
})

test('evidence gate discards fabricated sources and uncited fields', () => {
  const rows = evidenceBackedRows([{ ...unknown('a'), kind: 'chat', input: ['image'], contextWindow: 1000, evidence: [{ url: 'https://vendor.example/spec', fields: ['input'] }, { url: 'https://invented.example', fields: ['kind', 'contextWindow'] }] }], new Set(['https://vendor.example/spec']))
  assert.deepEqual(rows[0].input, ['image'])
  assert.equal(rows[0].kind, null)
  assert.equal(rows[0].contextWindow, null)
})

test('checker really searches, reads and receives tool history before returning JSON', async () => {
  let round = 0
  const webCalls = []
  const activity = []
  const llm = { prepareCall: async config => ({ config, stream: async function* (request) {
    if (round++ === 0) {
      assert.equal(request.tools.length, 2)
      yield { type: 'tool-call-delta', index: 0, id: 's1', name: 'search_model_docs', argumentsDelta: '{"query":"a official modalities"}' }
    } else if (round === 2) {
      assert.equal(request.messages.at(-1).role, 'tool')
      assert.match(request.messages.at(-1).content[0].text, /vendor.example/)
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'f1', name: 'read_model_doc', arguments: '{"url":"https://vendor.example/a"}' } }
    } else {
      assert.match(request.messages.at(-1).content[0].text, /accepts images/)
      yield { type: 'text-delta', text: JSON.stringify([{ ...unknown('a'), input: ['text', 'image'], evidence: [{ url: 'https://vendor.example/a', fields: ['input'] }] }]) }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }) }
  const web = {
    search: async request => { webCalls.push(request); return { sources: [{ url: 'https://vendor.example/a', snippet: 'spec' }] } },
    fetch: async request => { webCalls.push(request); return { statusCode: 200, body: { kind: 'text', content: 'a accepts images' } } },
  }
  const reply = await callChecker({ llm, web, checker: { provider: 'relay', model: 'checker' }, system: checkerSystemPrompt(true), input: 'a', webSearch: true, timeoutMs: 1000, onActivity: value => activity.push(value) })
  assert.equal(webCalls.length, 2)
  assert.ok(reply.allowedUrls.has('https://vendor.example/a'))
  assert.ok(reply.readUrls.has('https://vendor.example/a'))
  assert.ok(activity.includes('search'))
  assert.ok(activity.includes('fetch'))
})

test('offline model cannot claim to have performed a search', async () => {
  const llm = { prepareCall: async config => ({ config, stream: async function* () { yield { type: 'text-delta', text: JSON.stringify([unknown('a')]) } } }) }
  await assert.rejects(callChecker({ llm, checker: { provider: 'r', model: 'm' }, system: '', input: '', webSearch: true, timeoutMs: 1000 }), /did not call/)
})

test('web tools refuse arbitrary reads and never execute other tool names', async () => {
  let round = 0
  let fetches = 0
  const llm = { prepareCall: async config => ({ config, stream: async function* (request) {
    if (round++ === 0) yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'x', name: 'read_model_doc', arguments: '{"url":"https://127.0.0.1/secret"}' } }
    else {
      assert.match(request.messages.at(-1).content[0].text, /public HTTPS source/)
      yield { type: 'text-delta', text: '[]' }
    }
  } }) }
  await assert.rejects(callChecker({ llm, web: { fetch: async () => { fetches++ } }, checker: { provider: 'r', model: 'm' }, system: '', input: '', webSearch: true, timeoutMs: 1000 }), /did not call/)
  assert.equal(fetches, 0)
})

test('non-reasoning checkers never receive an unsupported explicit effort', async () => {
  const llm = { prepareCall: async (config, signal, configure) => {
    assert.equal(config.reasoningEffort, undefined)
    const controls = configure(config, {})
    assert.equal(controls.reasoningEffort, undefined)
    return { config: controls, stream: async function* () { yield { type: 'text-delta', text: '[]' } } }
  } }
  await callChecker({ llm, checker: { provider: 'r', model: 'm' }, system: '', input: '', effort: 'low' })
})

test('oversized streamed replies close their generator', async () => {
  let cleaned = false
  const llm = { prepareCall: async config => ({ config, stream: async function* () {
    try { yield { type: 'text-delta', text: 'x'.repeat(130000) } }
    finally { cleaned = true }
  } }) }
  await assert.rejects(callChecker({ llm, checker: { provider: 'r', model: 'm' }, system: '', input: '' }), /size/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(cleaned, true)
})

test('a failed flush drains sibling workers before a new sweep may start', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let round = 0
  const { verifier } = setup(async function* (request) {
    const ids = JSON.parse(request.messages[0].content[0].text.split('\n')[1])
    if (ids[0] === 'b') { entered(); await gate }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'text-delta', text: JSON.stringify(ids.map(id => ({ id, kind: 'chat' }))) }
  }, { timeoutMs: 1000, batchSize: 1, learned: { upsertEntries() { throw new Error('disk fail') }, meta() {} }, llm: { listModels: async () => round++ ? [] : [{ id: 'a' }, { id: 'b' }] } })
  const first = start(verifier)
  await started
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(verifier.isRunning(), true, 'a failed worker cannot release sibling ownership')
  const joined = start(verifier)
  release()
  assert.equal((await first).phase, 'error')
  assert.equal((await joined).phase, 'error')
  const next = await start(verifier)
  assert.deepEqual(next.tokenUsage, [0, 0, 0, 0])
})

test('public catalog results remain usable when checker transport fails', async () => {
  const { verifier, writes } = setup(async function* () { throw new Error('checker unreachable') }, {
    fetch: async url => new Response(String(url).includes('models.dev/models.json') ? JSON.stringify({ a: { modalities: { input: ['text', 'image'] } } }) : '{}'),
  })
  const result = await start(verifier)
  assert.equal(result.processed, 2)
  assert.equal(result.done, 1)
  assert.deepEqual(writes[0].input, ['text', 'image'])
})
