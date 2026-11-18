/**
 * Provider write-back tests.
 *
 * `writeCapabilities` mirrors the writable parts of a manual override into the
 * `llm-pi-ai` provider config. The tests drive a tiny fake settings service
 * that applies path ops to a plain object, so they also document the exact
 * `settings.mutate` contract the Host relies on.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { mergeCapabilities } from '../lib/model-info.js'
import { sanitizeOverride } from '../lib/model-overrides.js'
import {
  effortsForProvider,
  findProviderEntry,
  providerPatch,
  stripWrittenFields,
  writeCapabilities,
} from '../lib/provider-write.js'

/** Set one path (array index or object key) on a plain document. */
function applyOp(document, path, value) {
  let current = document
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    current = current[key]
  }
  const last = path[path.length - 1]
  current[last] = value
}

/** Fake settings service recording every mutate call. */
function fakeSettings(providers) {
  const calls = []
  const document = { providers }
  return {
    calls,
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: document }],
    mutate: async (ns, ops, revision) => {
      calls.push({ ns, ops, revision })
      assert.equal(revision, 7)
      for (const op of ops) applyOp(document, op.path, op.value)
      return undefined
    },
  }
}

function sampleProviders() {
  return {
    relay: {
      baseURL: 'https://relay.example/v1',
      apiKeyEnv: 'RELAY_API_KEY',
      models: [
        { id: 'mystery-model', input: [] },
        { id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' },
      ],
    },
  }
}

test('an effort ladder maps off to null and keeps the rest as wire values', () => {
  assert.deepEqual(
    effortsForProvider({
      efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'xhigh' }],
    }),
    { off: null, low: 'low', high: 'high', xhigh: 'xhigh' },
  )
  assert.equal(effortsForProvider({ reasoningSupported: false }), false)
  assert.equal(effortsForProvider({ efforts: [{ id: 'off' }] }), undefined)
  assert.equal(effortsForProvider(undefined), undefined)
})

test('the provider patch only contains fields the provider schema can express', () => {
  assert.deepEqual(
    providerPatch({
      provider: 'relay',
      model: 'mystery-model',
      kind: 'image',
      defaultEffort: 'high',
      input: ['text', 'image'],
      contextWindow: 400000,
      efforts: [{ id: 'off' }, { id: 'high' }],
    }),
    {
      input: ['text', 'image'],
      contextWindow: 400000,
      reasoningEfforts: { off: null, high: 'high' },
    },
  )
  assert.deepEqual(providerPatch({ provider: 'relay', model: 'x', input: [] }), {})
})

test('findProviderEntry prefers the pi-ai namespace and exposes the model list', () => {
  const settings = {
    describe: () => [
      { ns: 'other', value: { providers: { relay: { models: [] } } } },
      { ns: 'llm-pi-ai', value: { providers: { relay: { models: [{ id: 'mystery-model' }] } } } },
    ],
  }
  const entry = findProviderEntry(settings, 'relay')
  assert.equal(entry.ns, 'llm-pi-ai')
  assert.equal(entry.models.length, 1)
  assert.equal(findProviderEntry(settings, 'missing'), undefined)
})

test('writeCapabilities edits the existing model entry by index', async () => {
  const providers = sampleProviders()
  const settings = fakeSettings(providers)
  const result = await writeCapabilities(settings, {
    provider: 'relay',
    model: 'mystery-model',
    input: ['text', 'image'],
    contextWindow: 400000,
    efforts: [{ id: 'off' }, { id: 'high' }],
  })

  assert.deepEqual(result, {
    written: true,
    fields: ['input', 'contextWindow', 'reasoningEfforts'],
    ns: 'llm-pi-ai',
  })
  assert.equal(settings.calls.length, 1)
  assert.deepEqual(settings.calls[0].ops.map((op) => op.path), [
    ['providers', 'relay', 'models', '0', 'input'],
    ['providers', 'relay', 'models', '0', 'contextWindow'],
    ['providers', 'relay', 'models', '0', 'reasoningEfforts'],
  ])
  assert.deepEqual(providers.relay.models[0].input, ['text', 'image'])
  assert.equal(providers.relay.models[0].contextWindow, 400000)
  assert.deepEqual(providers.relay.models[0].reasoningEfforts, { off: null, high: 'high' })
  // Sibling models are untouched.
  assert.deepEqual(providers.relay.models[1], { id: 'gpt-6.1-terra', name: 'gpt-6.1-terra' })
})

test('writeCapabilities explains every refusal instead of throwing', async () => {
  const providers = sampleProviders()
  const settings = fakeSettings(providers)

  assert.deepEqual(await writeCapabilities(settings, { provider: 'relay', model: 'x' }), {
    written: false,
    fields: [],
    reason: 'nothing',
  })
  assert.equal((await writeCapabilities({ describe: () => [] }, { provider: 'relay', model: 'x', contextWindow: 8 })).reason, 'unsupported')
  assert.equal((await writeCapabilities(settings, { provider: 'nope', model: 'x', contextWindow: 8 })).reason, 'provider-missing')
  assert.equal((await writeCapabilities(settings, { provider: 'relay', model: 'nope', contextWindow: 8 })).reason, 'model-missing')

  const broken = {
    describe: () => {
      throw new Error('no settings')
    },
    mutate: async () => {},
  }
  assert.equal((await writeCapabilities(broken, { provider: 'relay', model: 'x', contextWindow: 8 })).reason, 'describe-failed')

  const rejecting = {
    describe: settings.describe,
    mutate: async () => {
      throw new Error('Config field is not volatile')
    },
  }
  const rejected = await writeCapabilities(rejecting, { provider: 'relay', model: 'mystery-model', contextWindow: 8 })
  assert.equal(rejected.written, false)
  assert.equal(rejected.reason, 'settings-failed')
  assert.match(rejected.message, /not volatile/)
})

test('stripWrittenFields keeps what the provider cannot store', () => {
  const remaining = stripWrittenFields(
    {
      provider: 'relay',
      model: 'mystery-model',
      kind: 'image',
      defaultEffort: 'high',
      input: ['text', 'image'],
      contextWindow: 400000,
      efforts: [{ id: 'off' }, { id: 'high' }],
    },
    ['input', 'contextWindow', 'reasoningEfforts'],
  )
  assert.deepEqual(remaining, { provider: 'relay', model: 'mystery-model', kind: 'image', defaultEffort: 'high' })
})

test('a revision conflict does not apply an index captured before model reorder', async () => {
  const providers = sampleProviders()
  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: { providers } }],
    mutate: async (_ns, ops, revision) => {
      providers.relay.models.reverse()
      if (revision !== undefined && revision !== 8) throw new Error('revision conflict')
      for (const op of ops) applyOp({ providers }, op.path, op.value)
    },
  }
  const result = await writeCapabilities(settings, { provider: 'relay', model: 'mystery-model', contextWindow: 8 })
  assert.equal(result.written, false)
  assert.equal(result.reason, 'settings-failed')
  assert.match(result.message, /revision conflict/)
  assert.equal(providers.relay.models.every((model) => model.contextWindow === undefined), true)
})

test('partial writeback preserves custom ladders and a standalone manual default', async () => {
  for (const efforts of [['off', 'high'], ['custom', 'high', 'off']]) {
    const providers = sampleProviders()
    const settings = fakeSettings(providers)
    const saved = sanitizeOverride({ provider: 'relay', model: 'mystery-model', efforts, defaultEffort: efforts[0] })
    const result = await writeCapabilities(settings, saved)
    assert.equal(result.written, true)
    const configured = providers.relay.models[0]
    assert.deepEqual(configured.reasoningEfforts, { high: 'high', off: null })
    const local = sanitizeOverride(stripWrittenFields(saved, result.fields))
    assert.equal(local.defaultEffort, efforts[0])
    if (efforts.includes('custom')) assert.deepEqual(local.efforts, saved.efforts)
    else assert.equal(local.efforts, undefined)
    const adapter = { reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } }
    const base = { id: saved.model, name: saved.model }
    const record = mergeCapabilities(base, { configured, adapter, override: local })
    assert.equal(record.reasoning.defaultEffort, efforts[0])
    assert.deepEqual(record.reasoning.efforts.map(({ id }) => id), efforts)
    const unmatched = mergeCapabilities(base, { configured, adapter, override: { defaultEffort: 'not-in-ladder' } })
    assert.equal(unmatched.reasoning.defaultEffort, 'high')
  }
})
