import assert from 'node:assert/strict'
import test from 'node:test'

import * as publicCatalog from '../lib/public-catalog.js'
import * as checkCatalog from '../lib/check-catalog.js'

const publicExports = [
  'PUBLIC_SOURCES',
  'HUGGING_FACE_HOSTS',
  'PUBLIC_BODY_LIMIT',
  'huggingFaceUrl',
  'readModelsDevRecord',
  'readModelsDev',
  'readOpenRouter',
  'kindOfPipelineTag',
  'readHuggingFace',
  'mergePublicSources',
  'publicFactToCapability',
  'lookupPublicFact',
  'publicOnlyFacts',
]

test('the standalone public catalog keeps every legacy export compatible', () => {
  assert.deepEqual(Object.keys(publicCatalog).sort(), [...publicExports, 'lookupPublicMatch'].sort())
  for (const name of publicExports) {
    assert.strictEqual(checkCatalog[name], publicCatalog[name], `${name} must be a re-export`)
  }
})

test('standalone public parsers merge only the same exact identity and preserve their source records', () => {
  const modelsDev = publicCatalog.readModelsDev({
    'vendor/model-a': {
      id: 'vendor/model-a',
      modalities: { input: ['text', 'image'] },
      limit: { context: 128000 },
      reasoning: false,
    },
  })
  const openRouter = publicCatalog.readOpenRouter({
    data: [{ id: 'model-a', context_length: 99999, top_provider: { max_completion_tokens: 8192 } }],
  })
  const huggingFace = publicCatalog.readHuggingFace([
    { id: 'vendor/model-a', pipeline_tag: 'text-generation', tags: ['reasoning'] },
    { id: 'vendor/model-b', pipeline_tag: 'text-to-image' },
  ])
  const original = structuredClone(modelsDev.get('vendor/model-a'))
  const merged = publicCatalog.mergePublicSources(modelsDev, openRouter, huggingFace)
  const fact = publicCatalog.lookupPublicFact(merged, 'vendor/model-a')

  assert.deepEqual(publicCatalog.publicFactToCapability(fact), {
    type: 'chat', input: ['text', 'image'], contextWindow: 128000, reasoning: false,
  })
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'vendor/model-a').exact, true)
  assert.equal(publicCatalog.lookupPublicMatch(merged, '~relay/model-a:free:batch', { fuzzy: true }), undefined)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'model-a', { fuzzy: true }), undefined, 'bare row conflicts with known qualified row')
  assert.deepEqual(modelsDev.get('vendor/model-a'), original)
  assert.deepEqual(
    publicCatalog.publicOnlyFacts(['model-b', 'vendor/model-b', 'unknown'], ['VENDOR/model-b'], merged, { fuzzy: true }),
    [
      { id: 'model-b', fact: { id: 'model-b', type: 'image', publicLookupId: 'vendor/model-b' }, origins: ['public'], writeFact: null, publicAlias: true },
      { id: 'vendor/model-b', fact: { id: 'vendor/model-b', type: 'image', publicLookupId: 'vendor/model-b' }, origins: ['public'], writeFact: { type: 'image' } },
    ],
  )
})

test('nested provider records stay separate and ambiguous bare rows are never eligible for writeback', () => {
  const index = publicCatalog.readModelsDev({
    models: { shared: { id: 'shared', modalities: { input: ['text', 'image'] } } },
    providers: {
      vendorA: { models: { shared: { id: 'shared', modalities: { input: ['text', 'image'] }, limit: { context: 999 } } } },
      vendorB: { models: { 'vendorB/shared': { id: 'shared', modalities: { input: ['text'] }, limit: { context: 123 } } } },
    },
    vendorC: { models: { shared: { id: 'vendorA/shared', limit: { context: 400 } } } },
  })
  assert.equal(publicCatalog.lookupPublicMatch(index, 'vendorA/shared').fact.contextWindow, 999)
  const exactB = publicCatalog.lookupPublicMatch(index, 'vendorB/shared', { fuzzy: true })
  assert.equal(exactB.exact, true)
  assert.deepEqual(publicCatalog.publicFactToCapability(exactB.fact), { input: ['text'], contextWindow: 123 })
  for (const model of ['shared', 'vendorC/shared', 'vendorX/shared', 'shared:free']) {
    assert.equal(publicCatalog.lookupPublicMatch(index, model, { fuzzy: true }), undefined, model)
  }
  assert.deepEqual(publicCatalog.publicOnlyFacts(['shared', 'vendorB/shared'], [], index, { fuzzy: true }), [{
    id: 'vendorB/shared', fact: { id: 'vendorB/shared', input: ['text'], contextWindow: 123, publicLookupId: 'vendorB/shared' },
    origins: ['public'], writeFact: { input: ['text'], contextWindow: 123 },
  }])
})

test('exact, case-sensitive identities retain version spelling; fuzzy references stay within a vendor', () => {
  const openRouter = publicCatalog.readOpenRouter({ data: [
    { id: 'vendor/model:free', context_length: 100 },
    { id: 'vendor/model', context_length: 200 },
    { id: 'other/model', context_length: 300 },
    { name: 'vendor/no-api-id', context_length: 400 },
  ] })
  const hub = publicCatalog.readHuggingFace([
    { id: 'Qwen/Qwen-Small-Instruct', pipeline_tag: 'text-generation' },
    { modelId: 'different/Qwen-Small-Instruct-v2', pipeline_tag: 'text-to-image' },
    { id: 'Unqualified', pipeline_tag: 'text-generation' },
  ])
  const merged = publicCatalog.mergePublicSources(openRouter, hub)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'vendor/model:free').fact.contextWindow, 100)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'vendor/model').fact.contextWindow, 200)
  const mismatched = new Map([['other/model', { id: 'vendor/model', contextWindow: 200 }]])
  assert.equal(publicCatalog.lookupPublicMatch(mismatched, 'other/model', { fuzzy: true }), undefined)
  assert.equal(publicCatalog.lookupPublicMatch(merged, '~vendor/model:fast', { fuzzy: true }).fact.id, 'vendor/model', 'prefer the unsuffixed model')
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'VENDOR/MODEL', { fuzzy: true }).fact.contextWindow, 200, 'full case fold precedes near IDs')
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'other/model:batch', { fuzzy: true }), undefined)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'other/model:fast', { fuzzy: true }).exact, false)
  for (const model of ['vendor/no-api-id', 'Qwen/Qwen-Small-Instruct-v2', 'different/Qwen-Small-Instruct', 'QwenSmallInstruct', 'Unqualified']) {
    assert.equal(publicCatalog.lookupPublicMatch(merged, model, { fuzzy: true }), undefined, model)
  }
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'Qwen/Qwen-Small-Instruct').exact, true)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'qwen/qwen-small-instruct'), undefined)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'qwen/qwen-small-instruct', { fuzzy: true }).exact, false)
  assert.equal(publicCatalog.lookupPublicMatch(merged, 'Qwen-Small-Instruct', { fuzzy: true }).exact, false)
})

test('public matching preserves exact variants but can fall back to the base model', () => {
  const index = publicCatalog.readOpenRouter({ data: [
    { id: 'qwen/qwen3.6', context_length: 3 },
    { id: 'qwen/qwen4-max', context_length: 4 },
    { id: 'qwen/qwen4-max-preview', context_length: 5 },
    { id: 'other/image-2', context_length: 6 },
    { id: 'other/model-5-1', context_length: 7 },
  ] })
  const lookup = (id) => publicCatalog.lookupPublicMatch(index, id, { fuzzy: true })
  assert.equal(lookup('qwen/qwen4-max-preview').fact.contextWindow, 5)
  for (const id of ['Qwen/Qwen4-max-preview-fast', 'qwen/qwen4-max-preview:free']) {
    assert.deepEqual(lookup(id), { fact: index.get('qwen/qwen4-max-preview'), exact: false })
  }
  for (const [id, contextWindow] of [
    ['qwen/qwen3.6-27b', 3], ['qwen/qwen4-max-preview-27b', 5],
    ['other/image-2-4k', 6], ['other/image-2-2k', 6], ['other/image-2-1024x1536', 6],
  ]) {
    assert.equal(lookup(id).fact.contextWindow, contextWindow, id)
    assert.equal(lookup(id).exact, false)
  }
  for (const id of ['other/model-5.1', 'qwen/qwen4-max:batch', 'qwen/qwen4-max:thinking',
    'other/qwen4-max-preview-fast', 'openai.qwen4-max:fast']) assert.equal(lookup(id), undefined, id)
  assert.equal(publicCatalog.lookupPublicMatch(index, 'Qwen/Qwen4-max-preview-fast'), undefined)
})

test('public display names are normalized, scoped advisory aliases', () => {
  const index = publicCatalog.readModelsDev({ providers: {
    qwen: { models: {
      checkpoint: { name: 'Qwen4 Max Preview', limit: { context: 400 } },
      'other-checkpoint': { name: 'Qwen4 Max', limit: { context: 300 } },
    } },
    other: { models: { checkpoint: { name: 'Qwen4 Max Preview', limit: { context: 200 } } } },
    vendor: { models: { special: { name: 'Special Model', limit: { context: 100 } } } },
  } })
  const lookup = (id, name) => publicCatalog.lookupPublicMatch(index, id, { fuzzy: true, name })
  assert.equal(lookup('Special Model').fact.id, 'vendor/special')
  assert.equal(lookup('vendor/Special Model').fact.id, 'vendor/special')
  assert.equal(lookup('qwen/special', 'Special Model'), undefined)
  assert.equal(lookup('qwen/relay-id', 'Qwen4 Max Preview').fact.id, 'qwen/checkpoint')
  assert.equal(lookup('qwen/relay-id', 'other/Qwen4 Max Preview'), undefined)
  assert.equal(lookup('Qwen4 Max Preview').fact.id, 'qwen/checkpoint', 'the brand identifies its vendor')
  assert.equal(lookup('qwen/checkpoint-fast', 'Qwen4 Max').exact, false)
  assert.equal(lookup('qwen/Qwen4-Max-Preview').fact.id, 'qwen/checkpoint')
  assert.equal(lookup('qwen/checkpoint', 'Qwen4 Max').exact, true, 'exact advertised ID wins even with a conflicting name')
  assert.deepEqual(publicCatalog.publicOnlyFacts(['qwen/relay-id'], [], index, {
    fuzzy: true, names: new Map([['qwen/relay-id', 'Qwen4 Max Preview']]),
  }), [{
    id: 'qwen/relay-id', fact: { id: 'qwen/relay-id', contextWindow: 400, publicLookupId: 'qwen/checkpoint' },
    origins: ['public'], writeFact: null, publicAlias: true,
  }])
})

test('recognized public modifiers may fall back and equal-rank distinct variants stay ambiguous', () => {
  const refs = publicCatalog.readOpenRouter({ data: [
    { id: 'qwen/qwen4-max', context_length: 100 },
    { id: 'qwen/qwen4-max-preview', context_length: 500 },
  ] })
  const lookup = id => publicCatalog.lookupPublicMatch(refs, id, { fuzzy: true })
  assert.equal(lookup('千问四max').fact.contextWindow, 100)
  assert.equal(lookup('千问4 max .preview').fact.contextWindow, 500)
  assert.equal(lookup('qwen4-max-27 b').fact.contextWindow, 100)
  const noBase = publicCatalog.readOpenRouter({ data: [
    { id: 'qwen/qwen4-max-preview', context_length: 500 },
    { id: 'qwen/qwen4-max-27b', context_length: 200 },
  ] })
  assert.equal(publicCatalog.lookupPublicMatch(noBase, '千问四max', { fuzzy: true }), undefined)
})

test('factless names and exact IDs block conflicting public name aliases', () => {
  const one = publicCatalog.readOpenRouter({ data: [{ id: 'v1/model', name: 'Display', context_length: 100 }] })
  const blockers = publicCatalog.readModelsDev({ providers: { v2: { models: { model: { name: 'Display' } } } } })
  assert.equal(blockers.size, 0)
  assert.equal(publicCatalog.lookupPublicMatch(one, 'Display', { fuzzy: true }).exact, false)
  assert.equal(publicCatalog.lookupPublicMatch(publicCatalog.mergePublicSources(one, blockers), 'Display', { fuzzy: true }), undefined)
  const exact = publicCatalog.readModelsDev({ Display: { id: 'Display' } })
  assert.equal(publicCatalog.lookupPublicMatch(publicCatalog.mergePublicSources(one, exact), 'Display', { fuzzy: true }), undefined)
  assert.equal(publicCatalog.lookupPublicMatch({ input: ['image'] }, 'unrelated', { fuzzy: true }), undefined)
})

test('public catalogs publish ladders only from explicit levels and validate default membership', () => {
  const index = publicCatalog.readOpenRouter({ data: [
    { id: 'vendor/full', reasoning_efforts: [' HIGH ', 'xhigh', '!bad', 'HIGH'], default_effort: 'xhigh' },
    { id: 'vendor/flag', supported_parameters: ['reasoning_effort'], default_effort: 'high' },
    { id: 'vendor/no-default', reasoningEfforts: ['low'], defaultEffort: 'high' },
    { id: 'vendor/disabled', reasoning: false, reasoningEfforts: ['high'] },
  ] })
  const lookup = (id) => publicCatalog.publicFactToCapability(publicCatalog.lookupPublicFact(index, id))
  assert.deepEqual(lookup('vendor/full'), {
    reasoning: true, reasoningEfforts: [{ id: 'high', name: 'High' }, { id: 'xhigh', name: 'XHigh' }], defaultEffort: 'xhigh', reasoningCatalog: 'OpenRouter',
  })
  assert.deepEqual(lookup('vendor/flag'), { reasoning: true })
  assert.equal(lookup('vendor/no-default').defaultEffort, undefined)
  assert.deepEqual(lookup('vendor/disabled'), { reasoning: false })
})

test('factless advertised IDs can veto an otherwise unique alias without inflating fact count', () => {
  const openRouter = publicCatalog.readOpenRouter({ data: [{ id: 'vendorA/shared', context_length: 200 }] })
  const hub = publicCatalog.readHuggingFace([{ id: 'vendorB/shared' }])
  const bare = publicCatalog.readModelsDev({ shared: { id: 'shared', limit: { context: 200 } } })
  assert.equal(hub.size, 0)
  assert.equal(publicCatalog.lookupPublicMatch(openRouter, 'shared', { fuzzy: true }).exact, false)
  for (const index of [publicCatalog.mergePublicSources(openRouter, hub), publicCatalog.mergePublicSources(bare, openRouter, hub)]) {
    assert.equal(publicCatalog.lookupPublicMatch(index, 'shared', { fuzzy: true }), undefined)
    assert.equal(publicCatalog.lookupPublicMatch(index, 'vendorA/shared').exact, true)
  }
  assert.equal(publicCatalog.lookupPublicMatch(hub, 'vendorB/shared', { fuzzy: true }), undefined)
})

test('reference indexes are invalidated when parser output is edited', () => {
  const index = publicCatalog.readHuggingFace([{ id: 'Owner/Model', pipeline_tag: 'text-generation' }])
  const lookup = () => publicCatalog.lookupPublicMatch(index, 'Model', { fuzzy: true })
  assert.equal(lookup().exact, false)
  index.set('Other/Model', { id: 'Other/Model', kind: 'embedding' })
  assert.equal(lookup(), undefined)
  index.delete('Other/Model')
  assert.equal(lookup().fact.kind, 'chat')
  index.clear()
  assert.equal(lookup(), undefined)
})
