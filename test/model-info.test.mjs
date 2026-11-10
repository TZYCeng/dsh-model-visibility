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
