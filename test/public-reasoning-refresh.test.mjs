import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCapabilityVerifier, PUBLIC_SOURCES } from '../lib/check-catalog.js'
import { createLearnedCatalog, PUBLIC_CATALOG_REVISION } from '../lib/learned-catalog.js'
import { mergeCapabilities } from '../lib/model-info.js'
import { lookupPublicMatch, mergePublicSources, readModelsDev, readOpenRouter } from '../lib/public-catalog.js'

const gemini = ['low', 'medium', 'high', 'xhigh']
const astra = [...gemini, 'max']
const names = ['gemini-4-hydrogen', 'gemini-4-neon', 'gpt-6.2-astra']
const vendor = id => id.startsWith('gemini') ? 'google' : 'openai'
const record = (id, levels) => ({ id, reasoning: true, reasoning_options: [{ type: 'toggle' }, { type: 'effort', values: levels }, { type: 'budget_tokens', max: 4096 }] })
const api = {
  google: { models: { [names[0]]: record(names[0], gemini), [names[1]]: record(names[1], gemini) } },
  openai: { models: { [names[2]]: record(names[2], astra) } },
  gateway: { models: Object.fromEntries(names.map(id => [`${vendor(id)}/${id}`, { ...record(`${vendor(id)}/${id}`, ['low']), canonical_model_id: `${vendor(id)}/${id}` }])) },
}
const slim = Object.fromEntries(names.map(id => [`${vendor(id)}/${id}`, { reasoning: true }]))
const router = { data: names.map(id => ({ id: `${vendor(id)}/${id}`, reasoning: { supported_efforts: [...(vendor(id) === 'google' ? gemini : astra)].reverse(), default_effort: 'medium' } })) }

test('native models.dev ladders match the reported bare routes without importing OpenRouter defaults', () => {
  const rows = mergePublicSources(readModelsDev(slim), readModelsDev(api), readOpenRouter(router))
  for (const id of names) {
    const match = lookupPublicMatch(rows, id, { fuzzy: true })
    assert.equal(match.exact, false)
    assert.equal(match.fact.id, `${vendor(id)}/${id}`)
    assert.deepEqual(match.fact.reasoningEfforts.map(level => level.id), vendor(id) === 'google' ? gemini : astra)
    assert.equal(match.fact.reasoningCatalog, 'models.dev')
    assert.equal(match.fact.defaultEffort, undefined)
  }
  const openRouterOnly = lookupPublicMatch(readOpenRouter(router), names[0], { fuzzy: true }).fact
  assert.equal(openRouterOnly.reasoningCatalog, 'OpenRouter')
  assert.equal(openRouterOnly.defaultEffort, 'medium')
})

test('canonical Alibaba and OpenRouter Qwen spellings use one reference, not gateway defaults as native', () => {
  const free = readModelsDev({ 'alibaba/qwen4-max': { reasoning: true, limit: { context: 1_000_000 } } })
  const nested = readModelsDev({ gateway: { models: { 'qwen4-max': { ...record('qwen4-max', ['low']), canonical_model_id: 'alibaba/qwen4-max' } } } })
  const open = readOpenRouter({ data: [{ id: 'qwen/qwen4-max', reasoning: { supported_efforts: ['high', 'low'], default_effort: 'high' } }] })
  const rows = mergePublicSources(free, nested, open)
  for (const id of ['千问4 max .preview', '千问四max', 'Qwen4 MAX-27 b']) {
    const match = lookupPublicMatch(rows, id, { fuzzy: true })
    assert.equal(match.exact, false)
    assert.equal(match.fact.id, 'alibaba/qwen4-max')
    assert.equal(match.fact.reasoningCatalog, 'OpenRouter')
  }
})

test('one ordinary public run upgrades the old snapshot without overriding exact route facts', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-public-revision-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const file = path.join(home, 'learned.json')
  const id = names[0]
  fs.writeFileSync(file, JSON.stringify({ version: 2, models: { [id]: { id, input: ['text'], contextWindow: 8_000, origins: ['public', 'checker'] } } }))
  const learned = createLearnedCatalog({ file })
  let calls = 0
  const verifier = createCapabilityVerifier({
    learned, logger: { warn() {} }, huggingFaceHosts: ['https://hub.example'],
    llm: { listProviders: () => [{ id: 'relay' }], listModels: async () => [{ id }], prepareCall() { assert.fail('public mode must not call a checker') } },
    fetch: async url => { calls++; return new Response(JSON.stringify(url === PUBLIC_SOURCES.modelsDevApi ? api : {})) },
  })
  assert.equal((await verifier.start({ mode: 'public' })).done, 1)
  const updated = createLearnedCatalog({ file }).getExact(id)
  assert.equal(updated.contextWindow, 8_000)
  assert.deepEqual(updated.input, ['text'])
  assert.equal(updated.publicCatalogRevision, PUBLIC_CATALOG_REVISION)
  assert.equal(updated.publicReasoning.publicLookupId, `google/${id}`)
  const model = mergeCapabilities({ id, name: id }, { learned: updated, discovered: { reasoning: true } })
  assert.deepEqual(model.reasoning.efforts.map(level => level.id), gemini)
  assert.equal(model.requestReasoning, null)
  assert.equal(model.reasoningCatalog, 'models.dev')
  const previous = calls
  assert.equal((await verifier.start({ mode: 'public' })).skippedKnown, 1)
  assert.equal(calls, previous)
})
