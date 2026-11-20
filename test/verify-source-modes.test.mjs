import assert from 'node:assert/strict'
import test from 'node:test'
import { createCapabilityVerifier } from '../lib/check-catalog.js'

const checker = { provider: 'relay', model: 'chosen-checker' }
const url = 'https://docs.example/model-specs'
const target = { id: 'vendor/alpha-preview', name: 'Alpha Preview' }
const missing = { id: 'vendor/beta-27b', name: 'Beta 27B' }

function fixture({ rows = [target, missing], catalog = { [target.id]: { limit: { context: 32000 } } }, known = {} } = {}) {
  const calls = { fetch: [], llm: [], search: [], writes: [], saved: [] }
  const verifier = createCapabilityVerifier({
    llm: {
      listProviders: () => [{ id: checker.provider }],
      listModels: async () => [...rows, { id: checker.model }],
      prepareCall: async config => ({ config, async *stream(request) {
        const ids = JSON.parse(request.messages[0].content[0].text.split('\n')[1])
        calls.llm.push({ ids, tools: request.tools.length })
        if (request.tools.length) {
          if (request.messages.length === 1) {
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'search', name: 'search_model_docs', arguments: '{"query":"model documentation"}' } }
          } else yield { type: 'text-delta', text: 'not a final reply' }
        } else {
          yield { type: 'reasoning-delta', index: 0, text: '[{"id":"vendor/forged","contextWindow":1}]' }
          yield { type: 'text-delta', text: JSON.stringify({ models: ids.map(model => ({ model, contextWindow: 64000, evidence: { contextWindow: url } })) }) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }),
    },
    learned: {
      getExact: id => known[id], meta: () => ({}), upsertEntries(rows) { calls.saved.push(...rows) },
    },
    fetch: async url => {
      calls.fetch.push(url)
      return new Response(JSON.stringify(url.endsWith('/models.json') ? catalog : {}))
    },
    huggingFaceHosts: ['https://huggingface.example'],
    web: { async search(request) { calls.search.push(request); return { sources: [{ url, snippet: 'The model context window is 64000 tokens.' }] } } },
    settings: { mutate(...args) { calls.writes.push(args) } },
    logger: { warn() {} },
  })
  return { calls, verifier }
}

test('public mode imports named catalog rows offline without consulting the checker or writing settings', async () => {
  const { calls, verifier } = fixture({ catalog: { 'vendor/alpha-preview:free': { limit: { context: 32000 } } } })
  const state = await verifier.start({ mode: 'public', checker, webSearch: true, writeBack: true })
  assert.equal(state.mode, 'public')
  assert.equal(state.writeBack, false)
  assert.equal(state.webSearch, false)
  assert.equal(state.catalogMatches, 1)
  assert.equal(state.checkerTargets, 0)
  assert.ok(calls.fetch.length)
  assert.deepEqual(calls.llm, [])
  assert.deepEqual(calls.search, [])
  assert.deepEqual(calls.writes, [])
  assert.deepEqual(calls.saved.map(({ id, publicAlias, origins }) => [id, publicAlias, origins]), [[target.id, true, ['public']]])
})

test('supplement imports catalog hits and sends only missing exact model IDs to an isolated online final', async () => {
  const { calls, verifier } = fixture()
  const state = await verifier.start({ mode: 'supplement', checker, webSearch: false })
  assert.equal(state.mode, 'supplement')
  assert.deepEqual([state.total, state.processed, state.done, state.failed, state.catalogMatches, state.checkerTargets], [2, 2, 2, 0, 1, 1])
  assert.ok(calls.fetch.length)
  assert.equal(calls.search.length, 1)
  assert.ok(calls.llm.every(call => call.ids.length === 1 && call.ids[0] === missing.id))
  assert.deepEqual(calls.llm.map(call => call.tools), [2, 2, 0])
  assert.deepEqual(calls.saved.map(({ id, contextWindow, origins }) => [id, contextWindow, origins]), [
    [target.id, 32000, ['public']], [missing.id, 64000, ['checker']],
  ])
})

test('supplement with full public coverage avoids all model and web calls', async () => {
  const { calls, verifier } = fixture({ rows: [target] })
  const state = await verifier.start({ mode: 'supplement', checker })
  assert.equal(state.done, 1)
  assert.equal(state.checkerTargets, 0)
  assert.deepEqual(calls.llm, [])
  assert.deepEqual(calls.search, [])
})

test('checker-only skips every public download and checks both new and known IDs', async () => {
  const { calls, verifier } = fixture({ known: { [target.id]: { origins: ['checker'], contextWindow: 1024 } } })
  const state = await verifier.start({ mode: 'checker', checker, useChecker: false, fullScan: false })
  assert.deepEqual([state.total, state.catalogTargets, state.checkerTargets, state.done], [2, 0, 2, 2])
  assert.equal(state.fullScan, true)
  assert.equal(state.skippedKnown, 0)
  assert.deepEqual(state.sources, [])
  assert.deepEqual(calls.fetch, [])
  assert.equal(calls.search.length, 1)
  assert.deepEqual(calls.llm.at(-1), { ids: [target.id, missing.id], tools: 0 })
})

test('unknown modes are rejected without doing work', async () => {
  const { calls, verifier } = fixture()
  await assert.rejects(verifier.start({ mode: 'guess', checker }), /invalid verification mode/)
  assert.deepEqual(calls.fetch, [])
  assert.deepEqual(calls.llm, [])
})
