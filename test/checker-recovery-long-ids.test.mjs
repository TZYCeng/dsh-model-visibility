import test from 'node:test'
import assert from 'node:assert/strict'
import { createCapabilityVerifier } from '../lib/check-catalog.js'

const checker = { provider: 'relay', model: 'checker' }
const longIds = [
  'subscription:magpie/openrouter/thinkingmachines/inkling-2-small:free',
  'subscription:magpie/openrouter/liquid/lfm-3-1.7b:free',
  'subscription:magpie/openrouter/recursive/flint-v1.0:free',
  'subscription:magpie/openrouter/xingchen-agi/xing4.0-29b-a4b:free',
  'subscription:magpie/openrouter/nvidia/nemotron-3.5-super-vl:free',
  'subscription:magpie/openrouter/example/last-model:free',
]
const cite = 'https://vendor.example/spec'
const valueFor = id => 4096 + longIds.indexOf(id)
const text = value => ({ type: 'text-delta', text: JSON.stringify(value) })

function fixture({ webSearch = false, repeatFailure = false } = {}) {
  const finals = [], persisted = []
  let lookup = 0, searches = 0
  const verifier = createCapabilityVerifier({
    llm: {
      listProviders: () => [{ id: 'relay' }],
      listModels: async () => [...longIds, checker.model].map(id => ({ id })),
      prepareCall: async config => ({ config, async *stream(request) {
        if (request.tools.length) {
          if (++lookup === 1) yield { type: 'block-end', index: 0, block: {
            type: 'tool-call', id: 'search-once', name: 'search_model_docs', arguments: '{"query":"model specifications"}',
          } }
        } else {
          const prompt = request.messages[0].content[0].text
          const ids = JSON.parse(prompt.split('\n')[1])
          finals.push({ ids, prompt })
          const rows = ids.map((id, i) => ({ ref: i + 1, contextWindow: valueFor(id),
            ...(webSearch ? { evidence: { contextWindow: cite } } : {}) }))
          // The first answer is complete JSON, but the checker omitted the tail.
          // In the persistent failure case both repairs still omit all their rows.
          yield text(finals.length === 1 ? rows.slice(0, 1) : repeatFailure ? [] : rows.reverse())
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }),
    },
    learned: { meta: () => ({}), upsertEntries: rows => persisted.push(...rows) },
    web: { async search() { searches++; return { sources: [{ url: cite, snippet: 'Model specifications' }] } } },
    fetch: async () => Response.json({}),
    logger: { warn() {} },
    batchSize: 6,
    concurrency: 1,
  })
  return { run: () => verifier.start({ checker, webSearch }), finals, persisted, searchCount: () => searches, lookupCount: () => lookup }
}

for (const webSearch of [false, true]) {
  test(`long routed IDs repair only missing refs (${webSearch ? 'online' : 'offline'})`, async () => {
    const { run, finals, persisted, searchCount, lookupCount } = fixture({ webSearch })
    const state = await run()
    assert.equal(state.phase, 'done')
    assert.deepEqual([state.done, state.failed, state.unknown], [6, 0, 0])
    assert.deepEqual(finals.map(call => call.ids), [longIds, longIds.slice(1, 4), longIds.slice(4)])
    for (const { ids, prompt } of finals) for (const id of longIds) {
      assert.equal(prompt.split(id).length - 1, ids.includes(id) ? 1 : 0, 'ID appears only in the current reference array')
    }
    assert.deepEqual(persisted.map(row => [row.id, row.contextWindow]), longIds.map(id => [id, valueFor(id)]))
    assert.equal(searchCount(), webSearch ? 1 : 0, 'repair never re-searches')
    assert.equal(lookupCount(), webSearch ? 2 : 0, 'repair never replays tool-enabled lookup')
  })
}

test('both repairs can fail without replaying the batch or losing a valid sibling', async () => {
  const { run, finals, persisted } = fixture({ repeatFailure: true })
  const state = await run()
  assert.deepEqual([state.done, state.failed, state.unknown], [1, 5, 0])
  assert.equal(state.batches[0].errorCode, 'CHECKER_FORMAT')
  assert.deepEqual(finals.map(call => call.ids), [longIds, longIds.slice(1, 4), longIds.slice(4)])
  assert.deepEqual(persisted.map(row => row.id), [longIds[0]])
})
