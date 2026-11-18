import assert from 'node:assert/strict'
import test from 'node:test'
import { callChecker } from '../lib/checker-call.js'
import { createCheckerSearchBridge } from '../lib/checker-search-bridge.js'

const string = { type: 'string' }
const advancedSearch = {
  name: 'advanced_search',
  parameters: { properties: { query: string, maxResults: { type: 'number' }, engine: string, timeRange: string } },
  output: { schema: { properties: { provider: string, content: string, sources: { type: 'array', items: { properties: { url: string } } } } } },
}
const sourceUrl = 'https://vendor.example/spec'
const toolCall = (name, args) => ({ type: 'tool-call', name, id: name, arguments: JSON.stringify(args) })
const success = (call, value) => ({ results: [{ callId: call.id, result: { isError: false, value, content: [{ type: 'text', text: 'https://rendered.example/ignore' }] } }] })
function setup(execute, { value = { provider: 'bing' }, executable = () => advancedSearch } = {}) {
  return createCheckerSearchBridge({
    getTools: () => ({ executable, execute }),
    getSettings: () => ({ describe: options => {
      assert.deepEqual(options, { redactSecrets: true })
      return value ? [{ ns: 'web-search-free', value }] : []
    } }),
  })
}
function fakeChecker(...rounds) {
  let next = 0
  return { prepareCall: async config => ({ config, stream: async function* (request) {
    assert.deepEqual(request.tools.map(tool => tool.name), ['search_model_docs', 'read_model_doc'])
    const reply = rounds[next++]?.(request)
    if (Array.isArray(reply)) {
      for (const [index, block] of reply.entries()) yield { type: 'block-end', index, block }
    } else yield { type: 'text-delta', text: '[]' }
  } }) }
}
function run(llm, extra) {
  return callChecker({ llm, checker: { provider: 'r', model: 'm' }, system: '', input: 'model', webSearch: true, timeoutMs: 1000, ...extra })
}
const searchRound = () => [toolCall('search_model_docs', { query: 'model official specs' })]

test('only the fixed standalone advanced_search is dispatched; structured HTTPS evidence and the Host fetch remain bounded', async () => {
  const sources = [
    null, { url: 'http://plain.example/x' }, { url: 'https://127.0.0.1/secret' },
    { url: sourceUrl, title: 'x'.repeat(700), snippet: 'y'.repeat(4000) },
    ...Array.from({ length: 7 }, (_, i) => ({ url: `https://example.com/${i}` })),
  ]
  const searchBridge = setup(async input => {
    assert.deepEqual(Object.keys(input).sort(), ['calls', 'signal'])
    assert.ok(input.signal instanceof AbortSignal)
    assert.equal(input.calls.length, 1)
    const [call] = input.calls
    assert.equal(call.name, 'advanced_search')
    assert.notEqual(call.id, 'search_model_docs')
    assert.deepEqual(JSON.parse(call.arguments), { query: 'model official specs', maxResults: 5 })
    return success(call, { sources, content: 'z'.repeat(5000) })
  })
  const fetched = []
  const routes = []
  const llm = fakeChecker(searchRound, request => {
    const result = JSON.parse(request.messages.at(-1).content[0].text)
    assert.equal(result.untrusted, true)
    assert.equal(result.content.length, 4000)
    assert.equal(result.sources.length, 5)
    assert.equal(result.sources[0].title.length, 300)
    assert.equal(result.sources[0].snippet.length, 2500)
    return [
      toolCall('read_model_doc', { url: 'https://rendered.example/ignore' }),
      toolCall('advanced_search', { query: 'arbitrary tool' }),
      toolCall('search_model_docs', { query: 'model', engine: 'openai' }),
      toolCall('read_model_doc', { url: sourceUrl }),
    ]
  }, request => {
    assert.match(request.messages.at(-4).content[0].text, /public HTTPS source/)
    assert.match(request.messages.at(-3).content[0].text, /unsupported checker tool/)
    assert.match(request.messages.at(-2).content[0].text, /expected query/)
    assert.equal(JSON.parse(request.messages.at(-1).content[0].text).text.length, 16_000)
  })
  const reply = await run(llm, { searchBridge, web: {
    search() { assert.fail('Host search must not run when Free Search is available') },
    async fetch(request) { fetched.push(request); return { statusCode: 200, body: { content: 'r'.repeat(20_000) } } },
  }, onWebCall: (...args) => routes.push(args) })
  assert.deepEqual(fetched, [{ url: sourceUrl }])
  assert.deepEqual(routes, [['search', 'dsh-free-search'], ['fetch', 'host-web']])
  assert.deepEqual([...reply.readUrls], [sourceUrl])
  assert.deepEqual([...reply.allowedUrls], [sourceUrl, ...sources.slice(4, 8).map(source => source.url)])
})

test('missing, disabled or incompatible integration uses the configured Host search, without adding selection parameters', async () => {
  for (const options of [{ value: null }, { value: { disabledTools: ['advanced_search'] } }, { executable: () => undefined }, { executable: () => ({ name: 'advanced_search' }) }]) {
    const searchBridge = setup(() => assert.fail('Free Search should not dispatch'), options)
    const web = { async search(request, signal) {
      assert.deepEqual(request, { query: 'model official specs', maxResults: 5 })
      assert.ok(signal instanceof AbortSignal)
      assert.equal(this, web)
      return { sources: [{ url: sourceUrl }] }
    } }
    const routes = []
    const result = await run(fakeChecker(searchRound, () => {}), { searchBridge, web, onWebCall: (...args) => routes.push(args) })
    assert.deepEqual([...result.allowedUrls], [sourceUrl])
    assert.deepEqual(routes, [['search', 'host-web']])
  }
})

test('Free Search execution and output errors never trigger a second backend', async () => {
  const web = { search() { assert.fail('Host fallback is only for absence, not a failure') } }
  const scenarios = [
    [async () => { throw new Error('executor failure') }, /executor failure/],
    [async ({ calls: [call] }) => ({ results: [{ callId: call.id, result: { isError: true, error: { message: 'quota exhausted' } } }] }), /quota exhausted/],
    [async ({ calls: [call] }) => success(call, { content: 'https://fake.example' }), /no structured search result/],
  ]
  for (const [execute, message] of scenarios) {
    await assert.rejects(run(fakeChecker(searchRound, () => {}), { searchBridge: setup(execute), web }), message)
  }
})

test('checker times out stalled Free Search work without dispatching the fallback', async () => {
  let settle
  let dispatcherSignal
  const searchBridge = setup(async ({ calls: [call], signal }) => {
    dispatcherSignal = signal
    await new Promise(resolve => { settle = resolve })
    return success(call, { sources: [] })
  })
  const web = { search() { assert.fail('timeout must not dispatch Host fallback') } }
  try {
    await assert.rejects(run(fakeChecker(searchRound, () => {}), { searchBridge, web, timeoutMs: 40 }), /web search timed out/)
    assert.equal(dispatcherSignal.aborted, true)
  } finally {
    settle?.()
  }
})

test('cancelled Free Search work cannot overlap a new dispatch until the executor settles', async () => {
  let settle
  let dispatches = 0
  const searchBridge = setup(async ({ calls: [call] }) => {
    if (++dispatches === 1) await new Promise(resolve => { settle = resolve })
    return success(call, { sources: [] })
  })
  const controller = new AbortController()
  const request = { query: 'q', maxResults: 5 }
  const abandoned = searchBridge.resolve()(request, controller.signal)
  controller.abort()
  await assert.rejects(searchBridge.resolve()(request, new AbortController().signal), /still settling/)
  assert.equal(dispatches, 1)
  settle()
  await assert.rejects(abandoned, { name: 'AbortError' })
  await searchBridge.resolve()(request, new AbortController().signal)
  assert.equal(dispatches, 2)
})
