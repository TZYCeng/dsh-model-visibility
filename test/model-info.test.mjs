/**
 * Unit tests for the Host-side capability probe.
 *
 * Run with `npm test` (Node's built-in test runner, no extra dependency).
 * The probe only touches a small slice of `ctx.llm`, so every test drives it
 * with a plain object — no DSH runtime and no network.
 *
 * DSH_HOME is redirected to a scratch directory before the modules load: the
 * merge falls back to `$DSH_HOME/dsh-model-visibility/learned.json` when a test
 * does not inject a learned store, and the machine's real snapshot otherwise
 * changes assertions such as "an unconfigured model has no context window".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-model-info-'))

import {
  createModelInfoService,
  describeCatalog,
  describeModel,
  describeResolvedModel,
  detachModalities,
  detachReasoning,
  imageInputDecision,
  mergeCapabilities,
} from '../lib/model-info.js'

/** A resolved-model record with every optional field populated. */
const FULL_INFO = {
  provider: 'acme',
  id: 'acme-large',
  name: 'Acme Large',
  description: 'A multimodal reasoner',
  inputModalities: ['text', 'image'],
  context: { contextWindow: 200000 },
  defaultMaxTokens: 8192,
  reasoning: {
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low', description: 'Quick answers' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'medium',
  },
}

/** Minimal `ctx.llm` stand-in. */
function fakeLlm({ providers = [], models = {}, info = {}, listError = null } = {}) {
  const calls = { listModels: 0, resolve: 0 }
  return {
    calls,
    listProviders: () => providers,
    async listModels(provider) {
      calls.listModels += 1
      if (listError !== null) throw listError
      return models[provider] ?? []
    },
    async resolveModelInfo(provider, model) {
      calls.resolve += 1
      const value = info[`${provider}/${model}`]
      if (value instanceof Error) throw value
      return value ?? { provider, id: model, name: model }
    },
  }
}

test('detachReasoning keeps valid efforts and drops malformed ones', () => {
  const reasoning = detachReasoning({
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'low', name: 'Duplicate' },
      { id: '', name: 'Empty id' },
      { id: 'high', name: '' },
      { id: 'medium', name: 'Medium', description: 'Balanced' },
    ],
    defaultEffort: 'medium',
  })
  assert.deepEqual(reasoning, {
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium', description: 'Balanced' },
    ],
    defaultEffort: 'medium',
  })
  assert.equal(detachReasoning({ efforts: [], defaultEffort: 'low' }), undefined)
  assert.equal(detachReasoning(undefined), undefined)
})

test('detachReasoning drops a default that no effort publishes', () => {
  const reasoning = detachReasoning({
    efforts: [{ id: 'low', name: 'Low' }],
    defaultEffort: 'max',
  })
  assert.deepEqual(reasoning, { efforts: [{ id: 'low', name: 'Low' }] })
})

test('detachModalities keeps strings once and falls back to undefined', () => {
  assert.deepEqual(detachModalities(['text', 'image', 'text', 42, '']), ['text', 'image'])
  assert.equal(detachModalities([]), undefined)
  assert.equal(detachModalities('text'), undefined)
})

test('describeResolvedModel projects every capability field', () => {
  const record = describeResolvedModel({ id: 'acme-large', name: 'Acme Large' }, FULL_INFO)
  assert.equal(record.id, 'acme-large')
  assert.equal(record.name, 'Acme Large')
  assert.equal(record.description, 'A multimodal reasoner')
  assert.equal(record.contextWindow, 200000)
  assert.equal(record.defaultMaxTokens, 8192)
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.reasoning.efforts.length, 4)
  assert.equal(record.reasoning.defaultEffort, 'medium')
  assert.equal(record.infoError, undefined)
})

test('describeResolvedModel falls back to the catalog entry for modalities', () => {
  const record = describeResolvedModel(
    { id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] },
    { provider: 'acme', id: 'vision', name: 'Vision', inputModalities: undefined },
  )
  assert.deepEqual(record.inputModalities, ['text', 'image'])
})

test('describeModel reports a resolver failure as infoError and keeps the row', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'acme', name: 'Acme' }],
    models: { acme: [{ id: 'broken', name: 'Broken' }] },
    info: { 'acme/broken': new Error('adapter exploded') },
  })
  const record = await describeModel(llm, 'acme', { id: 'broken', name: 'Broken' })
  assert.equal(record.id, 'broken')
  assert.equal(record.name, 'Broken')
  assert.equal(record.infoError, 'adapter exploded')
  assert.equal(record.reasoning, undefined)
  assert.equal(record.contextWindow, undefined)
})

test('describeCatalog groups models, isolates providers and drops empty groups', async () => {
  const llm = fakeLlm({
    providers: [
      { id: 'acme', name: 'Acme' },
      { id: 'empty', name: 'Empty' },
      { id: 'down', name: 'Down' },
    ],
    models: {
      acme: [
        { id: 'acme-large', name: 'Acme Large' },
        { id: 'broken', name: 'Broken' },
      ],
      empty: [],
    },
    info: {
      'acme/acme-large': FULL_INFO,
      'acme/broken': new Error('no metadata'),
    },
    listError: null,
  })
  // `down` throws only for its own provider; the fake uses one flag, so
  // override it for that route.
  const baseList = llm.listModels
  llm.listModels = async (provider) => {
    if (provider === 'down') throw new Error('endpoint unreachable')
    return baseList(provider)
  }

  const catalog = await describeCatalog(llm)
  assert.equal(catalog.groups.length, 1)
  assert.equal(catalog.groups[0].id, 'acme')
  assert.equal(catalog.groups[0].models.length, 2)
  assert.equal(catalog.groups[0].models[0].contextWindow, 200000)
  assert.equal(catalog.groups[0].models[1].infoError, 'no metadata')
  assert.deepEqual(
    catalog.failures.map((failure) => failure.id),
    ['down'],
  )
})

test('describeCatalog reports listProviders failure without throwing', async () => {
  const catalog = await describeCatalog({
    listProviders() {
      throw new Error('registry offline')
    },
  })
  assert.deepEqual(catalog.groups, [])
  assert.equal(catalog.failures[0].message, 'registry offline')
})

test('createModelInfoService caches, honours fresh and invalidates', async () => {
  let clock = 1000
  const llm = fakeLlm({
    providers: [{ id: 'acme', name: 'Acme' }],
    models: { acme: [{ id: 'acme-large', name: 'Acme Large' }] },
    info: { 'acme/acme-large': FULL_INFO },
  })
  const service = createModelInfoService(llm, { ttlMs: 1000, now: () => clock })

  const first = await service.read()
  assert.equal(llm.calls.listModels, 1)
  clock += 500
  const cached = await service.read()
  assert.equal(llm.calls.listModels, 1)
  assert.equal(cached, first)

  clock += 600 // past the TTL
  await service.read()
  assert.equal(llm.calls.listModels, 2)

  await service.read({ fresh: true })
  assert.equal(llm.calls.listModels, 3)

  service.invalidate()
  await service.read()
  assert.equal(llm.calls.listModels, 4)
})

test('createModelInfoService shares one in-flight sweep', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'acme', name: 'Acme' }],
    models: { acme: [{ id: 'acme-large', name: 'Acme Large' }] },
    info: { 'acme/acme-large': FULL_INFO },
  })
  const service = createModelInfoService(llm, { ttlMs: 0 })
  const [left, right] = await Promise.all([service.read(), service.read()])
  assert.equal(llm.calls.listModels, 1)
  assert.equal(left, right)
})

test('invalidate during an in-flight sweep discards that sweep', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let calls = 0
  const service = createModelInfoService(
    {
      listProviders: () => [{ id: 'acme', name: 'Acme' }],
      listModels: async () => [{ id: 'acme-large', name: 'Acme Large' }],
      resolveModelInfo: async () => {
        calls += 1
        await gate
        return FULL_INFO
      },
    },
    { ttlMs: 60_000 },
  )

  const first = service.read()
  service.invalidate()
  release()
  const stale = await first
  assert.equal(stale.groups[0].models[0].contextWindow, 200000)

  // The late sweep must not have repopulated the cache, so this read probes again.
  await service.read()
  assert.equal(calls, 2)
})

test('an invalidated sweep does not clear the newer in-flight slot', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  let releaseSecond
  const secondGate = new Promise((resolve) => {
    releaseSecond = resolve
  })
  let calls = 0
  const service = createModelInfoService(
    {
      listProviders: () => [{ id: 'acme', name: 'Acme' }],
      listModels: async () => [{ id: 'acme-large', name: 'Acme Large' }],
      resolveModelInfo: async () => {
        calls += 1
        await (calls === 1 ? firstGate : secondGate)
        return FULL_INFO
      },
    },
    { ttlMs: 60_000 },
  )

  const first = service.read()
  service.invalidate()
  const second = service.read()
  releaseFirst()
  await first

  // The old sweep's finally must not free the slot owned by the new sweep.
  const third = service.read()
  assert.equal(calls, 2)
  assert.equal(third, second)

  releaseSecond()
  await second
  await third
})

test('specialist IDs beat generic relay/snapshot chat while keeping vision chat intact', async () => {
  const cases = [
    ['gemini-3-pro-image-preview', 'Gemini 3 Pro', 'image'],
    ['ideogram-4', 'Image Creator', 'image'],
    ['text-embedding-3-small', 'OpenAI Small', 'embedding'],
    ['text-embedding-3-large', 'OpenAI Large', 'embedding'],
    ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro', 'chat'],
  ]
  const llm = { resolveModelInfo: async () => FULL_INFO }
  for (const [id, name, kind] of cases) {
    const model = { id, name }
    const discovered = new Map([[`vendor/${id}:free`, { id: `vendor/${id}:free`, kind: 'chat', inputModalities: ['text', 'image'], outputModalities: ['text'], reasoning: true }]])
    const learned = { id, type: 'chat', reasoning: true, reasoningEfforts: FULL_INFO.reasoning.efforts, publicAlias: true }
    const profile = { models: new Map([[id, model]]) }
    const context = { profile, discovered, learned, standardEffort: true }
    const row = await describeModel(llm, 'relay', model, context)
    assert.equal(row.kind, kind, id)
    assert.equal(imageInputDecision('relay', id, context).allowed, kind === 'chat', id)
    if (kind === 'chat') {
      assert.equal(row.reasoningSupported, true)
      assert.equal(row.standardEffort, true)
    } else {
      assert.equal(row.sources.kind, 'inferred')
      assert.equal(row.requestReasoning, null)
      for (const field of ['reasoning', 'reasoningSupported', 'reasoningWireDisabled', 'referenceReasoning', 'standardEffort']) {
        assert.equal(row[field], undefined, `${id}: ${field}`)
      }
    }
  }
})

test('manual and explicit route kinds still win over identifier inference', () => {
  const model = { id: 'text-embedding-3-small', name: 'OpenAI Small' }
  const snapshot = { type: 'chat', id: model.id, origins: ['public'] }
  const weakChat = { id: model.id, kind: 'chat', weakKind: true }
  assert.equal(mergeCapabilities(model, { discovered: weakChat, learned: snapshot }).kind, 'embedding')
  assert.equal(mergeCapabilities(model, { discovered: { kind: 'chat' } }).sources.kind, 'provider')
  assert.equal(mergeCapabilities({ id: 'new-route' }, { discovered: weakChat, learned: { type: 'rerank' } }).kind, 'rerank')
  const discovered = { kind: 'embedding' }
  const efforts = [{ id: 'custom', name: 'Custom' }]
  const override = { kind: 'chat', efforts }
  const chat = mergeCapabilities(model, { discovered, override })
  assert.equal(chat.kind, 'chat')
  assert.equal(chat.sources.kind, 'manual')
  assert.deepEqual(chat.reasoning.efforts, efforts)
  const embedding = mergeCapabilities(model, { discovered, override: { ...override, kind: 'embedding' } })
  assert.equal(embedding.sources.kind, 'manual')
  assert.equal(embedding.reasoning, undefined)
})

test('a manual override outranks every automatic capability layer', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'relay', name: 'Relay' }],
    models: { relay: [{ id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' }] },
  })
  const override = {
    kind: 'chat',
    input: ['text', 'image'],
    contextWindow: 400000,
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'high',
  }
  const record = await describeModel(
    llm,
    'relay',
    { id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' },
    { override },
  )
  assert.equal(record.kind, 'chat')
  assert.deepEqual(record.inputModalities, ['text', 'image'])
  assert.equal(record.contextWindow, 400000)
  assert.equal(record.reasoningSupported, true)
  assert.deepEqual(
    record.reasoning.efforts.map((effort) => effort.id),
    ['low', 'high'],
  )
  assert.equal(record.reasoning.defaultEffort, 'high')
  assert.equal(record.sources.kind, 'manual')
  assert.equal(record.sources.modalities, 'manual')
  assert.equal(record.sources.context, 'manual')
  assert.equal(record.sources.reasoning, 'manual')
})

test('a manual kind also suppresses chat name inference', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'relay', name: 'Relay' }],
    models: { relay: [{ id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' }] },
  })
  const record = await describeModel(
    llm,
    'relay',
    { id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' },
    { override: { kind: 'image' } },
  )
  assert.equal(record.kind, 'image')
  assert.equal(record.sources.kind, 'manual')
  assert.deepEqual(record.inputModalities, undefined)
})

test('a manual "no reasoning" statement hides an adapter ladder', async () => {
  const llm = fakeLlm({
    providers: [{ id: 'acme', name: 'Acme' }],
    models: { acme: [{ id: 'acme-large', name: 'Acme Large' }] },
    info: { 'acme/acme-large': FULL_INFO },
  })
  const record = await describeModel(
    llm,
    'acme',
    { id: 'acme-large', name: 'Acme Large' },
    { override: { reasoningSupported: false } },
  )
  assert.equal(record.reasoning, undefined)
  assert.equal(record.reasoningSupported, false)
  assert.equal(record.sources.reasoning, 'manual')
})

test('the image-input gate honours manual image modalities', () => {
  const profile = { models: new Map() }
  const plain = imageInputDecision('relay', 'mystery-model', { profile })
  assert.equal(plain.allowed, false)
  const manual = imageInputDecision('relay', 'mystery-model', {
    profile,
    override: { input: ['text', 'image'] },
  })
  assert.equal(manual.allowed, true)
  assert.equal(manual.reason, 'image')
  assert.equal(manual.record.sources.modalities, 'manual')
})

test('explicit provider reasoning off outranks the adapter, relay, and learned ladder', async () => {
  const model = { id: 'acme-large', name: 'Acme Large' }
  const profile = { models: new Map([[model.id, { ...model, reasoningEfforts: false }]]) }
  const discovered = new Map([[model.id, { ...model, reasoning: true }]])
  const learned = { reasoning: true, reasoningEfforts: FULL_INFO.reasoning.efforts }
  for (const [info, relay] of [[FULL_INFO, discovered], [undefined, discovered], [undefined, undefined]]) {
    const llm = { resolveModelInfo: async () => info }
    const record = await describeModel(llm, 'acme', model, { profile, discovered: relay, learned })
    assert.equal(record.reasoning, undefined)
    assert.equal(record.requestReasoning, null)
    assert.equal(record.reasoningSupported, false)
    assert.equal(record.sources.reasoning, 'config')
  }
  const manual = await describeModel({ resolveModelInfo: async () => FULL_INFO }, 'acme', model, {
    profile,
    override: { efforts: [{ id: 'custom', name: 'Custom' }], defaultEffort: 'custom' },
  })
  assert.equal(manual.reasoning.defaultEffort, 'custom')
  assert.equal(manual.sources.reasoning, 'manual')
})


test('request reasoning stays adapter-owned despite an unrelated manual ladder', () => {
  const model = { id: 'scoped-levels', name: 'scoped-levels' }
  const row = mergeCapabilities(model, {
    adapter: { reasoning: FULL_INFO.reasoning },
    learned: { reasoning: true, reasoningEfforts: [{ id: 'low', name: 'Low' }], reasoningCatalog: 'models.dev' },
    override: { efforts: [{ id: 'custom', name: 'Custom' }], defaultEffort: 'custom' },
    profile: { api: 'openai-completions', compat: { supportsReasoningEffort: false } },
  })
  assert.equal(row.reasoning.defaultEffort, 'custom')
  assert.equal(row.requestReasoning.defaultEffort, FULL_INFO.reasoning.defaultEffort)
  assert.equal(row.reasoningWireDisabled, true)
  assert.deepEqual(row.referenceReasoning.efforts, [{ id: 'low', name: 'Low' }])
  assert.equal(row.referenceReasoningSource, 'models.dev')
  const reference = mergeCapabilities(model, { learned: { reasoning: true, reasoningEfforts: [{ id: 'low', name: 'Low' }] } })
  assert.equal(reference.reasoningSupported, true)
  assert.deepEqual(reference.reasoning.efforts.map(level => level.id), ['low'])
  assert.equal(reference.requestReasoning, null)
  const disabled = mergeCapabilities(model, { learned: { reasoning: false, reasoningEfforts: [{ id: 'high', name: 'High' }] } })
  assert.equal(disabled.reasoningSupported, false)
  assert.equal(disabled.reasoning, undefined)
})

test('standard opt-in in the catalog comes from the same live ownership as provider writes', async () => {
  const llm = fakeLlm({ providers: [{ id: 'relay' }], models: { relay: [{ id: 'first' }, { id: 'second' }, { id: 'from-adapter' }] } })
  const target = { provider: 'relay', settingsNs: 'include:llm-pi-ai', settingsPath: ['providers', 'relay'], declared: true }
  llm.listConfigurableProviders = () => [target]
  const profile = {
    api: 'openai-completions', baseURL: 'https://relay.example/v1',
    models: [{ id: 'first' }, { id: 'second', compat: { thinkingFormat: 'openai' }, reasoningEfforts: { high: 'high' } }],
  }
  const settings = { describe: () => [{ ns: target.settingsNs, revision: 1, value: { providers: { relay: profile } } }], mutate() {} }
  const document = { providers: { relay: profile } }
  const configEditor = { configuration: () => [{ entry: { options: { id: target.settingsNs, config: document } }, override: document }] }
  const service = createModelInfoService(llm, { settings, configEditor })
  const eligibleIds = async () => (await service.read({ fresh: true })).groups[0].models.filter(model => model.standardEffort).map(model => model.id)
  assert.deepEqual(await eligibleIds(), ['first', 'second'])
  profile.baseURL = 'https://relay.example/proxy/openrouter.ai/v1'
  assert.deepEqual(await eligibleIds(), ['second'])
  profile.baseURL = 'https://relay.example/v1'
  target.declared = false
  assert.deepEqual(await eligibleIds(), ['second'])
  target.settingsPath = ['not-providers', 'relay']
  assert.deepEqual(await eligibleIds(), [])
})

test('ambiguous public provenance remains visible but does not enable image attachment', async () => {
  const profile = { defaultInput: ['text'], models: new Map([['mystery-model', { id: 'mystery-model' }]]) }
  for (const provenance of [{ publicAlias: true }, { legacyPublic: true }]) {
    const learned = { id: 'public/shared', type: 'chat', input: ['text', 'image'], contextWindow: 12000, ...provenance }
    const model = { id: 'mystery-model' }
    const row = await describeModel({ resolveModelInfo: async () => ({ inputModalities: ['text'] }) }, 'relay', model, { profile, learned })
    assert.deepEqual(row.inputModalities, ['text', 'image'])
    assert.equal(row.sources.modalities, 'snapshot')
    assert.equal(row.sources.context, 'snapshot')
    for (const [key, value] of Object.entries(provenance)) assert.equal(row.learned[key], value)
    assert.equal(imageInputDecision('relay', model.id, { profile, learned }).allowed, false)
  }
  const discovered = { id: 'mystery-model', kind: 'chat', weakKind: true, inputModalities: ['text', 'image'] }
  assert.equal(imageInputDecision('relay', 'mystery-model', { profile, discovered }).allowed, true)
  assert.equal(imageInputDecision('relay', 'mystery-model', {
    profile, discovered, learned: { id: 'mystery-model', type: 'image', publicAlias: true },
  }).reason, 'non-chat')
  const alias = { id: 'mystery-model', input: ['text', 'image'], publicAlias: true }
  const localStore = { get: (id) => id === alias.id ? alias : undefined, meta: () => ({}) }
  await describeCatalog(fakeLlm(), { learned: localStore })
  assert.equal(imageInputDecision('relay', alias.id, { profile }).allowed, false)
})
