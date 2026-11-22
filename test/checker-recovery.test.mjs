import test from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilityVerifier } from '../lib/check-catalog.js'
import { callChecker, CHECKER_MAX_TOKENS } from '../lib/checker-call.js'
import { recoverCompleteCheckerRows } from '../lib/checker-contract.js'

const checker = { provider: 'relay', model: 'checker' }
const citation = 'https://vendor.example/spec'
const text = value => ({ type: 'text-delta', text: typeof value === 'string' ? value : JSON.stringify(value) })
const finish = reason => ({ type: 'finish', reason })
const tool = (index, query = 'find specs') => ({ type: 'block-end', index, block: { type: 'tool-call', id: `tool-${index}`, name: 'search_model_docs', arguments: JSON.stringify({ query }) } })
const unknown = id => ({ id, kind: null, input: null, output: null, contextWindow: null, maxTokens: null, reasoning: null, reasoningEfforts: null, defaultEffort: null, evidence: [] })
const cited = (id, field, value) => ({ ...unknown(id), [field]: value, evidence: [{ url: citation, fields: [field] }] })
const searches = () => {
  let count = 0
  return { get count() { return count }, async search() { count++; return { sources: [{ url: citation, snippet: 'verified content' }] } } }
}
const checkerArgs = { checker, system: '', input: 'target', timeoutMs: 500 }
const prepared = stream => ({ prepareCall: async config => ({ config, stream }) })
function verifierFor(stream, { ids = ['a', 'b'], web = searches(), efforts, timeoutMs = 500, catalog = {} } = {}) {
  const persisted = []
  const calls = []
  const verifier = createCapabilityVerifier({
    llm: {
      listProviders: () => [{ id: 'relay' }],
      listModels: async () => ids.map(id => ({ id })),
      prepareCall: async (config, _signal, configure) => {
        const picked = configure(config, efforts ? { reasoning: { efforts: efforts.map(id => ({ id })) } } : {})
        calls.push(picked)
        return { config: picked, stream }
      },
    },
    web, timeoutMs, fetch: async url => Response.json(url.endsWith('/models.json') ? catalog : {}), logger: { warn() {} },
    learned: { meta: () => ({}), upsertEntries(rows) { persisted.push(...rows) } },
  })
  return { verifier, calls, persisted, web }
}

test('structured upstream timeout keeps its code and metadata without retry before search', async () => {
  let requests = 0
  const llm = prepared(async function* () {
    requests++
    yield finish({ kind: 'error', failure: { code: 'TIMEOUT', message: 'Request timed out', status: 504, providerRetryAfterMs: 64, requestId: 'test-id' } })
  })
  const web = searches()
  await assert.rejects(callChecker({ ...checkerArgs, llm, web, webSearch: true }), { code: 'TIMEOUT', message: 'Request timed out', status: 504, providerRetryAfterMs: 64, requestId: 'test-id' })
  assert.equal(requests, 1)
  assert.equal(web.count, 0)
})

for (const mode of ['upstream timeout', '13-call burst']) {
  test(`prior web evidence reaches tool-free synthesis after ${mode}`, async () => {
    let calls = 0
    const llm = prepared(async function* (request) {
      if (++calls === 1) yield tool(0)
      else if (calls === 2) {
        if (mode === 'upstream timeout') yield finish({ kind: 'error', failure: { code: 'TIMEOUT', message: 'Request timed out' } })
        else for (let index = 0; index < 13; index += 1) yield tool(index)
      } else {
        assert.deepEqual(request.tools, [])
        assert.match(request.messages[0].content[0].text, /verified content/)
        yield text([cited('target', 'input', ['text'])])
      }
    })
    const web = searches()
    const reply = await callChecker({ ...checkerArgs, llm, web, webSearch: true })
    assert.equal(calls, 3)
    assert.equal(web.count, 1)
    assert.ok(reply.allowedUrls.has(citation))
    assert.deepEqual(JSON.parse(reply.text), [cited('target', 'input', ['text'])])
  })
}

test('model transport failure does not fan out offline sub-batches', async () => {
  const fixture = verifierFor(async function* () {
    yield finish({ kind: 'error', failure: { code: 'AUTH', message: 'unauthorized' } })
  })
  const state = await fixture.verifier.start({ checker, webSearch: false })
  assert.equal(fixture.calls.length, 1)
  assert.equal(state.failed, 2)
  assert.match(state.errors.join(), /unauthorized/)
})

test('truncation keeps advertised off and retries compact JSON without cutting the thinking headroom', async () => {
  let requests = 0
  const fixture = verifierFor(async function* () {
    if (++requests === 1) {
      yield { type: 'reasoning-delta', text: 'thought' }
      yield finish({ kind: 'max-tokens' })
    } else yield text([{ id: 'a', contextWindow: 1000 }])
  }, { ids: ['a'], efforts: ['low', 'off', 'minimal', 'high'] })
  const state = await fixture.verifier.start({ checker, webSearch: false })
  assert.equal(state.done, 1)
  assert.deepEqual(fixture.calls.map(c => [c.reasoningEffort, c.maxTokens]), [['off', CHECKER_MAX_TOKENS], ['off', CHECKER_MAX_TOKENS]])
})

test('a cited sibling from the initial answer survives permanent format repair failure', async () => {
  let calls = 0
  const fixture = verifierFor(async function* (request) {
    if (++calls === 1) yield tool(0)
    else if (calls === 2) yield text('LOOKUP_DRAFT_MUST_NOT_REPLAY')
    else if (calls === 3) {
      assert.deepEqual(request.tools, [])
      assert.doesNotMatch(request.messages[0].content[0].text, /LOOKUP_DRAFT_MUST_NOT_REPLAY/)
      yield text([cited('a', 'contextWindow', 1000), { id: 'b', contextWindow: 'invalid' }])
    }
    else {
      assert.deepEqual(request.tools, [])
      const prompt = request.messages[0].content[0].text
      assert.match(prompt, /Repair only rows from the current reference map/)
      assert.deepEqual(JSON.parse(prompt.split('\n')[1]), ['b'])
      assert.equal(prompt.split('"b"').length - 1, 1)
      yield finish({ kind: 'error', failure: { code: 'TIMEOUT', message: 'Request timed out' } })
    }
  })
  const result = await fixture.verifier.start({ checker, webSearch: true })
  assert.equal(calls, 4)
  assert.equal(fixture.web.count, 1)
  assert.equal(result.done, 1)
  assert.equal(result.failed, 1)
  assert.equal(fixture.persisted[0].id, 'a')
  assert.deepEqual(fixture.persisted[0].evidence, [{ url: citation, fields: ['contextWindow'] }])
  assert.equal(result.batches[0].errorCode, 'TIMEOUT')
  assert.match(result.errors.join(), /Request timed out/)
})

test('online recovery retains complete cited rows from both truncated answers', async () => {
  let requests = 0
  const fixture = verifierFor(async function* (request) {
    if (++requests === 1) yield tool(0)
    else if (requests === 2) yield text('Lookup complete')
    else if (requests === 3) {
      assert.deepEqual(request.tools, [])
      yield text('[' + JSON.stringify(cited('a', 'input', ['image'])) + ',{"id":"b"')
      yield finish({ kind: 'max-tokens' })
    } else {
      assert.deepEqual(request.tools, [])
      yield text('[' + JSON.stringify(cited('b', 'contextWindow', 2000)) + ',{"id":"c"')
      yield finish({ kind: 'max-tokens' })
    }
  }, { ids: ['a', 'b', 'c'], efforts: ['low', 'off'] })
  const state = await fixture.verifier.start({ checker, webSearch: true })
  assert.equal(state.done, 2)
  assert.equal(state.failed, 1)
  assert.equal(fixture.web.count, 1)
  assert.equal(requests, 5)
  assert.equal(fixture.calls[2].reasoningEffort, 'off')
  assert.deepEqual(fixture.persisted.map(row => row.id), ['a', 'b'])
})

test('an 8192-token reasoning-only final splits unresolved IDs without repeating searches', async () => {
  const ids = ['gpt-6.2-sol', 'gpt-6.2-astra', 'qwen4-max-preview', 'gpt-image-2.6-flare', 'gemini-3.5-flash-low']
  const finals = []
  let lookup = 0
  const fixture = verifierFor(async function* (request) {
    if (request.tools.length) {
      if (++lookup === 1) yield tool(0)
      else yield text('LOOKUP_DRAFT')
      return
    }
    const message = request.messages[0].content[0].text
    assert.doesNotMatch(message, /LOOKUP_DRAFT|DO_NOT_CAPTURE_THOUGHT/)
    const asked = JSON.parse(message.split('\n')[1])
    finals.push(asked)
    if (asked.length > 3) {
      yield { type: 'reasoning-delta', text: 'DO_NOT_CAPTURE_THOUGHT' }
      yield finish({ kind: 'max-tokens' })
    } else {
      yield text(asked.map(id => cited(id, 'contextWindow', 65_536)))
      yield finish({ kind: 'stop' })
    }
  }, { ids, efforts: ['low', 'medium', 'high', 'xhigh'] })
  const state = await fixture.verifier.start({ checker, webSearch: true })
  assert.deepEqual(finals, [ids, ids.slice(0, 3), ids.slice(3)])
  assert.equal(fixture.web.count, 1)
  assert.deepEqual(fixture.calls.map(call => call.reasoningEffort), Array(5).fill('low'))
  assert.equal(state.done, 5)
  assert.equal(state.failed, 0)
  assert.deepEqual(fixture.persisted.map(row => row.id), ids)
})

test('truncated prefix recovery respects quoting and ignores incomplete or disconnected JSON', () => {
  const a = { id: 'a', nested: [{ x: 'escape \\ } ] " },' }] }
  assert.deepEqual(recoverCompleteCheckerRows('```json\n[' + JSON.stringify(a) + ', {"id":"b"'), [a])
  assert.deepEqual(recoverCompleteCheckerRows('[junk, {"id":"fake"}]'), [])
  assert.deepEqual(recoverCompleteCheckerRows('[' + JSON.stringify(a) + ' {"id":"fake"}]'), [a])
})


test('offline repair keeps the valid prefix and repairs only malformed or omitted IDs', async () => {
  const requested = []
  const fixture = verifierFor(async function* (request) {
    requested.push(JSON.parse(request.messages[0].content[0].text.split('\n')[1]))
    if (requested.length === 1) yield text([{ id: 'a', input: ['image'] }, { id: 'c', contextWindow: 'bad' }])
    else yield text([{ id: 'b', contextWindow: 1024 }])
  }, { ids: ['a', 'b', 'c'] })
  const state = await fixture.verifier.start({ checker, webSearch: false })
  assert.deepEqual(requested, [['a', 'b', 'c'], ['b', 'c']])
  assert.deepEqual(fixture.persisted.map(row => row.id), ['a', 'b'])
  assert.deepEqual([state.done, state.failed, state.unknown], [2, 1, 0])
  assert.equal(state.batches[0].errorCode, 'CHECKER_FORMAT')
  assert.match(state.errors.join(), /missing ids: c/)
})

test('a stalled completion records already observed usage on cancellation exactly once', async () => {
  const controller = new AbortController()
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const spend = []
  const task = callChecker({ ...checkerArgs, signal: controller.signal, noteUsage: entry => spend.push(entry), llm: prepared(async function* () {
    yield { type: 'usage', usage: { inputTokens: 17, outputTokens: 5 } }
    entered.resolve()
    await release.promise
  }) })
  await entered.promise
  controller.abort()
  await assert.rejects(task, { code: 'CANCELLED' })
  assert.deepEqual(spend, [{ usage: { inputTokens: 17, outputTokens: 5 } }])
  release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(spend.length, 1)
})


test('first lookup reasoning truncation searches only proven public IDs, then splits truncated finals without repeating search', async () => {
  const ids = ['public/model', 'private/model', 'public/second']
  const requests = []
  const queries = []
  const finals = []
  const fixture = verifierFor(async function* (request) {
    requests.push(request)
    if (request.tools.length) {
      assert.equal(requests.length, 1, 'public recovery never repeats the model lookup')
      yield { type: 'reasoning-delta', text: 'LOOKUP_REASONING' }
      yield finish({ kind: 'max-tokens' })
      return
    }
    const message = request.messages[0].content[0].text
    assert.doesNotMatch(message, /LOOKUP_REASONING/)
    assert.match(message, /Model specifications/)
    const asked = JSON.parse(message.split('\n')[1])
    finals.push(asked)
    if (finals.length === 1) {
      yield { type: 'reasoning-delta', text: 'FINAL_REASONING' }
      yield finish({ kind: 'max-tokens' })
    } else {
      yield text(asked.map(id => id.startsWith('public/') ? cited(id, 'input', ['image']) : unknown(id)))
    }
  }, { ids, catalog: { 'public/model': { id: 'public/model', limit: { context: 32_768 } }, 'public/second': { id: 'public/second', limit: { context: 65_536 } } }, web: {
    async search(request) { queries.push(request); return { sources: [{ url: citation, snippet: 'Model specifications' }] } },
  } })
  const state = await fixture.verifier.start({ checker, webSearch: true })
  assert.deepEqual(queries, [{ query: '("public/model" OR "public/second") official model API specifications context input modalities', maxResults: 5 }])
  assert.deepEqual(finals, [ids, ids.slice(0, 2), ids.slice(2)])
  assert.deepEqual(state.searchBackends, { 'host-web': 1 })
  assert.deepEqual([state.done, state.unknown, state.failed], [2, 1, 0])
  assert.equal(requests.length, 4)
  assert.deepEqual(fixture.persisted.map(row => row.id), ['public/model', 'public/second'])
})

test('unknown-only recovery repeats the model lookup once and executes at most its first search tool', async () => {
  const queries = []
  const ids = ['private/model']
  let requests = 0
  const fixture = verifierFor(async function* (request) {
    if (++requests === 1) {
      yield { type: 'reasoning-delta', text: 'LOOKUP_REASONING' }
      yield finish({ kind: 'max-tokens' })
    } else if (requests === 2) {
      assert.ok(request.tools.length)
      assert.match(request.system, /exactly once now/)
      assert.doesNotMatch(request.messages[0].content[0].text, /LOOKUP_REASONING/)
      yield tool(0, 'first model-selected query')
      yield tool(1, 'do not dispatch second query')
    } else {
      assert.deepEqual(request.tools, [])
      yield text([cited(ids[0], 'input', ['image'])])
    }
  }, { ids, web: { async search(request) { queries.push(request); return { sources: [{ url: citation, snippet: 'Model documentation: accepts images' }] } } } })
  const state = await fixture.verifier.start({ checker, webSearch: true })
  assert.deepEqual(queries, [{ query: 'first model-selected query', maxResults: 5, llmProvider: 'relay' }])
  assert.equal(requests, 3)
  assert.equal(state.done, 1)
})

test('public-ID recovery stops on a search diagnostic and never sends its second query', async () => {
  const ids = Array.from({ length: 6 }, (_, index) => `public/${'m'.repeat(110)}-${index}`)
  const catalog = Object.fromEntries(ids.map(id => [id, { id, limit: { context: 32_768 } }]))
  let requests = 0
  const queries = []
  const fixture = verifierFor(async function* () {
    requests++
    yield { type: 'reasoning-delta', text: 'LOOKUP_REASONING' }
    yield finish({ kind: 'max-tokens' })
  }, { ids, catalog, web: { async search({ query }) { queries.push(query); return { sources: [], content: 'backend is unauthorized' } } } })
  const state = await fixture.verifier.start({ checker, webSearch: true })
  assert.equal(requests, 1)
  assert.equal(queries.length, 1)
  assert.ok(queries[0].length <= 500)
  assert.match(state.errors.join(), /backend is unauthorized/)
  assert.equal(state.batches[0].errorCode, 'CHECKER_SEARCH_UNAVAILABLE')
})


test('public-ID recovery uses no more than two distinct groups when the first search is empty', async () => {
  const ids = Array.from({ length: 12 }, (_, index) => `public/${'m'.repeat(110)}-${index}`)
  const queries = []
  let requests = 0
  const llm = prepared(async function* (request) {
    requests++
    assert.ok(request.tools.length)
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 8192, reasoningTokens: 8192 } }
    yield finish({ kind: 'max-tokens' })
  })
  await assert.rejects(callChecker({ ...checkerArgs, llm, publicSearchIds: ids, webSearch: true,
    web: { async search({ query }) { queries.push(query); return { sources: [] } } },
  }), { code: 'CHECKER_SEARCH_UNAVAILABLE' })
  assert.equal(requests, 1)
  assert.equal(queries.length, 2)
  assert.equal(new Set(queries).size, 2)
  assert.ok(queries.every(query => query.length <= 500))
})
