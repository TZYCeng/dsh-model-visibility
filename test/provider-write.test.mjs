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
  createStandardEffortAvailability as standardAvailable,
  effortsForProvider,
  findProviderEntry,
  findProviderTarget,
  providerPatch,
  stripWrittenFields,
  writeCapabilities as performWrite,
} from '../lib/provider-write.js'

/** Set one path (array index or object key) on a plain document. */
function applyOp(document, path, value) {
  let current = document
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    current = current[key] ?? (current[key] = {})
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
    configEditor: { configuration: () => [{ entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: document } }, override: document, inherited: {} }] },
    describe: () => [{ ns: 'llm-pi-ai', revision: 7, value: document }],
    mutate: async (ns, ops, revision) => {
      calls.push({ ns, ops, revision })
      assert.equal(revision, 7)
      for (const op of ops) applyOp(document, op.path, op.value)
      return undefined
    },
  }
}

function writeCapabilities(settings, override, options = {}) {
  return performWrite(settings, override, { llm: routeOwner(override.provider), configEditor: settings?.configEditor, ...options })
}

function createStandardEffortAvailability(settings, llm) {
  return standardAvailable(settings, llm, settings.configEditor)
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

test('a manual ladder preserves configured wire tokens and never invents values', () => {
  const override = { efforts: ['off', 'low', 'high'] }
  const configured = { reasoningEfforts: { off: 'no-thought', low: 'brief', high: 'detailed' } }
  assert.deepEqual(effortsForProvider(override, configured), configured.reasoningEfforts)
  assert.deepEqual(effortsForProvider(override, configured, { off: null, high: ' deep ', xhigh: 'not-declared' }), {
    off: null, low: 'brief', high: ' deep ',
  })
  assert.equal(effortsForProvider(override), undefined)
  assert.equal(effortsForProvider({ reasoningSupported: false }), false)
  assert.equal(effortsForProvider({ efforts: ['off'], reasoningEffortMappings: { off: null } }), undefined)
  assert.equal(effortsForProvider({ efforts: ['low'], reasoningEffortMappings: { low: null } }), undefined)
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
      reasoningEffortMappings: { off: null, high: 'vendor-high' },
    }),
    {
      input: ['text', 'image'],
      contextWindow: 400000,
      reasoningEfforts: { off: null, high: 'vendor-high' },
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
  providers.relay.models[0].reasoningEfforts = { off: 'disabled', high: 'thorough' }
  const result = await writeCapabilities(settings, {
    provider: 'relay',
    model: 'mystery-model',
    input: ['text', 'image'],
    contextWindow: 400000,
    efforts: [{ id: 'off' }, { id: 'high' }],
  }, { reasoningEffortMappings: { off: null } })

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
  assert.deepEqual(providers.relay.models[0].reasoningEfforts, { off: null, high: 'thorough' })
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
    configEditor: settings.configEditor,
    mutate: async () => {
      throw new Error('Config field is not volatile')
    },
  }
  const rejected = await writeCapabilities(rejecting, { provider: 'relay', model: 'mystery-model', contextWindow: 8 })
  assert.equal(rejected.written, false)
  assert.equal(rejected.reason, 'settings-failed')
  assert.match(rejected.message, /not volatile/)
})

function routeOwner(provider = 'relay', declared = true, settingsNs = 'llm-pi-ai') {
  return { listConfigurableProviders: () => [{ provider, declared, settingsNs, settingsPath: ['providers', provider] }] }
}

test('automatic write-back fills only missing fields, preserving explicit config and wire choices', async () => {
  const providers = sampleProviders()
  const model = providers.relay.models[0]
  model.input = ['text']
  model.reasoningEfforts = { off: null, high: 'vendor-full' }
  const settings = fakeSettings(providers)
  const override = {
    provider: 'relay', model: model.id, input: ['text', 'image'], contextWindow: 400000,
    efforts: ['high', 'max'], reasoningEffortMappings: { high: 'wrong', max: 'wrong' },
  }
  const options = { automatic: true, llm: routeOwner() }
  const result = await writeCapabilities(settings, override, options)
  assert.deepEqual(result.fields, ['contextWindow'])
  assert.deepEqual(result.protectedFields, ['input'])
  assert.deepEqual(result.localOnly, ['reasoningEfforts'])
  assert.deepEqual(model.input, ['text'])
  assert.deepEqual(model.reasoningEfforts, { off: null, high: 'vendor-full' })
  assert.equal(model.contextWindow, 400000)
  assert.equal((await writeCapabilities(settings, { ...override, contextWindow: 8, reasoningSupported: false }, options)).written, false)
  assert.equal(model.contextWindow, 400000)
  assert.equal(settings.calls.length, 1)
  const bare = providers.relay.models[1]
  await writeCapabilities(settings, { ...override, model: bare.id, reasoningSupported: false }, options)
  assert.equal(bare.reasoningEfforts, undefined)
  assert.deepEqual(bare.input, ['text', 'image'])
})

test('automatic write-back does not shadow inherited catalog or explicit route defaults', async () => {
  const providers = sampleProviders()
  const settings = fakeSettings(providers)
  const override = { provider: 'relay', model: 'mystery-model', input: ['text', 'image'], contextWindow: 400000 }
  const native = await writeCapabilities(settings, override, { automatic: true, llm: routeOwner('relay', false) })
  assert.equal(native.reason, 'native-catalog')
  const unverified = await performWrite(settings, override, { automatic: true })
  assert.equal(unverified.reason, 'provider-unverified')
  providers.relay.defaultInput = ['text']
  providers.relay.defaultContextWindow = 1_000_000
  const describe = settings.describe
  settings.describe = () => describe().map((entry) => ({
    ...entry, user: { providers: { relay: { defaultInput: ['text'], defaultContextWindow: 1_000_000 } } },
  }))
  const explicit = await writeCapabilities(settings, override, { automatic: true, llm: routeOwner() })
  assert.equal(explicit.reason, 'protected')
  assert.deepEqual(explicit.protectedFields, ['input', 'contextWindow'])
  settings.describe = () => describe().map((entry) => ({ ...entry, base: { providers } }))
  const inherited = await writeCapabilities(settings, override, { automatic: true, llm: routeOwner() })
  assert.deepEqual(inherited.protectedFields, ['input', 'contextWindow'])
  assert.equal(settings.calls.length, 0)
  assert.equal(findProviderTarget(routeOwner('relay', true, 'other-adapter'), 'relay'), null)
})

test('partial manual mappings preserve configured wire values and cannot shadow an inherited map', async () => {
  const providers = sampleProviders()
  const model = providers.relay.models[0]
  model.reasoningEfforts = { off: null, medium: 'vendor-mid', high: 'vendor-full' }
  const settings = fakeSettings(providers)
  const override = { provider: 'relay', model: model.id, efforts: ['off', 'high', 'max'], contextWindow: 8000 }
  const mappings = { off: 'stop' }
  const result = await writeCapabilities(settings, override, { reasoningEffortMappings: mappings, llm: routeOwner() })
  assert.deepEqual(result.unresolvedEfforts, ['max'])
  assert.deepEqual(model.reasoningEfforts, { off: 'stop', medium: 'vendor-mid', high: 'vendor-full' })
  assert.deepEqual(stripWrittenFields(override, result.fields, result.localOnly).efforts, override.efforts)
  const bareModel = providers.relay.models[1]
  const inherited = await writeCapabilities(settings, { ...override, model: bareModel.id }, {
    llm: routeOwner('relay', false), reasoningEffortMappings: { off: null, high: 'vendor-high' },
  })
  assert.deepEqual(inherited.fields, ['contextWindow'])
  assert.deepEqual(inherited.unresolvedEfforts, ['max'])
  assert.equal(bareModel.reasoningEfforts, undefined)
})

test('manual reasoning cannot remove the route default or piggyback onto an unverified owner', async () => {
  const providers = sampleProviders()
  const model = providers.relay.models[0]
  model.reasoningEfforts = { low: 'short', high: 'long' }
  providers.relay.reasoning = 'high'
  const settings = fakeSettings(providers)
  const override = { provider: 'relay', model: model.id, contextWindow: 8000 }
  const disable = await writeCapabilities(settings, { ...override, reasoningSupported: false }, { llm: routeOwner() })
  assert.deepEqual(disable.fields, ['contextWindow'])
  assert.equal(disable.reasoningConflict, 'route-default')
  assert.deepEqual(disable.localOnly, ['reasoningEfforts'])
  assert.deepEqual(model.reasoningEfforts, { low: 'short', high: 'long' })
  const bare = providers.relay.models[1]
  const missingDefault = await writeCapabilities(settings, {
    ...override, model: bare.id, efforts: ['low'], reasoningEffortMappings: { low: 'short' },
  }, { llm: routeOwner() })
  assert.deepEqual(missingDefault.fields, ['contextWindow'])
  assert.equal(missingDefault.reasoningConflict, 'route-default')
  assert.equal(bare.reasoningEfforts, undefined)
  assert.equal((await writeCapabilities(settings, override, { llm: routeOwner('relay', true, 'other-adapter') })).reason, 'provider-unverified')
  const noRevision = { ...settings, describe: () => [{ ns: 'llm-pi-ai', value: { providers } }] }
  assert.equal((await writeCapabilities(noRevision, override)).reason, 'revision-unavailable')
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
    configEditor: fakeSettings(providers).configEditor,
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
    const result = await writeCapabilities(settings, saved, { reasoningEffortMappings: { off: null, high: 'thorough' } })
    assert.equal(result.written, true)
    const configured = providers.relay.models[0]
    assert.deepEqual(configured.reasoningEfforts, { high: 'thorough', off: null })
    const local = sanitizeOverride(stripWrittenFields(saved, result.fields, result.localOnly))
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


test('editing one explicit request value keeps all other configured levels', async () => {
  const providers = sampleProviders()
  providers.relay.models[0].reasoningEfforts = { off: null, low: 'vendor-low', high: 'vendor-old' }
  const settings = fakeSettings(providers)
  const { written } = await writeCapabilities(settings, {
    provider: 'relay', model: 'mystery-model', efforts: ['high'],
    reasoningEffortMappings: { high: 'vendor-new' },
  }, { llm: routeOwner() })
  assert.equal(written, true)
  assert.deepEqual(providers.relay.models[0].reasoningEfforts, { off: null, low: 'vendor-low', high: 'vendor-new' })
})


test('standard opt-in pins OpenAI and writes all non-off canonical IDs only to the named model', async () => {
  const providers = sampleProviders()
  const profile = providers.relay
  profile.api = 'openai-completions'
  profile.compat = { supportsReasoningEffort: false }
  const [model, sibling] = profile.models
  model.compat = { supportsStore: false }
  const settings = fakeSettings(providers)
  const levels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const entry = { provider: 'relay', model: model.id, efforts: ['off', ...levels] }
  const skipped = await writeCapabilities(settings, entry, { llm: routeOwner() })
  assert.equal(skipped.written, false)
  const saved = await writeCapabilities(settings, entry, { standardEffort: true, llm: routeOwner() })
  assert.deepEqual(saved.fields, ['reasoningEfforts', 'supportsReasoningEffort'])
  assert.deepEqual(saved.unresolvedEfforts, ['off'])
  assert.deepEqual(model.reasoningEfforts, Object.fromEntries(levels.map(id => [id, id])))
  assert.deepEqual(model.compat, { supportsStore: false, thinkingFormat: 'openai', supportsReasoningEffort: true })
  assert.equal(profile.compat.supportsReasoningEffort, false)
  assert.equal(sibling.compat, undefined)
  assert.deepEqual(settings.calls[0].ops.map(({ path }) => path), [
    ['providers', 'relay', 'models', '0', 'reasoningEfforts'],
    ['providers', 'relay', 'models', '0', 'compat', 'thinkingFormat'],
    ['providers', 'relay', 'models', '0', 'compat', 'supportsReasoningEffort'],
  ])
})

test('standard effort keeps explicit mappings and never enables unsupported formats', async () => {
  const providers = sampleProviders()
  const profile = providers.relay
  profile.api = 'openai-completions'
  const model = profile.models[0]
  model.reasoningEfforts = { low: 'brief', high: 'thorough' }
  const settings = fakeSettings(providers)
  const entry = { provider: 'relay', model: model.id, efforts: ['high', 'xhigh', 'max'] }
  const options = { standardEffort: true, reasoningEffortMappings: { max: 'maximum' }, llm: routeOwner() }
  await writeCapabilities(settings, entry, options)
  assert.deepEqual(model.reasoningEfforts, { low: 'brief', high: 'thorough', xhigh: 'xhigh', max: 'maximum' })
  for (const [api, thinkingFormat] of [['openai-completions', 'deepseek'], ['anthropic-messages', undefined]]) {
    profile.api = api
    model.compat = thinkingFormat ? { thinkingFormat } : {}
    delete model.reasoningEfforts
    const saved = await writeCapabilities(settings, entry, { ...options, reasoningEffortMappings: {} })
    assert.equal(saved.reasoningConflict, 'standard-format')
    assert.equal(model.compat.supportsReasoningEffort, undefined)
    assert.equal(model.reasoningEfforts, undefined)
  }
})

test('reference prefill preserves existing wire mappings and fills eligible gaps only', async () => {
  const providers = sampleProviders()
  providers.relay.api = 'openai-completions'
  const [model] = providers.relay.models
  model.reasoningEfforts = { low: 'vendor-low', high: 'vendor-high', off: null }
  const settings = fakeSettings(providers)
  const entry = { provider: 'relay', model: model.id, efforts: ['low', 'medium', 'none'] }
  const saved = await writeCapabilities(settings, entry, {
    llm: routeOwner(), referencePrefill: true, standardEffort: true,
    reasoningEffortMappings: { low: 'replacement' },
  })
  assert.equal(saved.written, true)
  assert.deepEqual(saved.protectedEfforts, ['low'])
  assert.deepEqual(saved.unresolvedEfforts, ['none'])
  assert.deepEqual(saved.localOnly, ['reasoningEfforts'])
  assert.deepEqual(model.reasoningEfforts, { low: 'vendor-low', medium: 'medium', high: 'vendor-high', off: null })
})

test('reference prefill preserves disabled reasoning even on an eligible relay', async () => {
  const providers = sampleProviders()
  providers.relay.api = 'openai-completions'
  const [model] = providers.relay.models
  model.reasoningEfforts = false
  const settings = fakeSettings(providers)
  const saved = await writeCapabilities(settings, { provider: 'relay', model: model.id, efforts: ['low'] }, {
    llm: routeOwner(), referencePrefill: true, standardEffort: true,
  })
  assert.equal(saved.written, false)
  assert.equal(saved.reasoningConflict, 'reference-disabled')
  assert.deepEqual(saved.localOnly, ['reasoningEfforts'])
  assert.equal(model.reasoningEfforts, false)
  assert.equal(settings.calls.length, 0)
})

test('reference prefill cannot write reasoning settings onto a specialist model', async () => {
  const providers = sampleProviders()
  providers.relay.api = 'openai-completions'
  const [model] = providers.relay.models
  model.id = 'text-embedding-3-large'
  const settings = fakeSettings(providers)
  const options = { llm: routeOwner(), referencePrefill: true, standardEffort: true }
  const saved = await writeCapabilities(settings, {
    provider: 'relay', model: model.id, efforts: ['low'], reasoningEffortMappings: { low: 'low' },
  }, options)
  assert.equal(saved.reasoningConflict, 'reference-nonchat')
  assert.equal(saved.written, false)
  assert.equal(settings.calls.length, 0)
})

test('full-URL vendor hints and inherited formats fail closed before a standard write', async () => {
  const providers = sampleProviders()
  const profile = providers.relay
  profile.api = 'openai-completions'
  profile.baseURL = 'https://relay.example/proxy/openrouter.ai/v1'
  const model = profile.models[0]
  const settings = fakeSettings(providers)
  const override = { provider: 'relay', model: model.id, efforts: ['low'], reasoningEffortMappings: { low: 'explicit' } }
  const standard = { standardEffort: true, llm: routeOwner() }
  assert.equal(createStandardEffortAvailability(settings, standard.llm)('relay', model.id), false)
  assert.equal((await writeCapabilities(settings, override, standard)).reasoningConflict, 'standard-format')
  assert.equal(settings.calls.length, 0, 'refused standard selection must not attempt a reasoning write')
  profile.baseURL = 'https://relay.example/v1'
  const native = { ...standard, llm: routeOwner('relay', false) }
  assert.equal(createStandardEffortAvailability(settings, native.llm)('relay', model.id), false)
  assert.equal((await writeCapabilities(settings, override, native)).reasoningConflict, 'inherited-ladder')
  model.compat = { thinkingFormat: 'openai' }
  assert.equal(createStandardEffortAvailability(settings, native.llm)('relay', model.id), false)
  assert.equal((await writeCapabilities(settings, override, native)).reasoningConflict, 'inherited-ladder')
  model.reasoningEfforts = { high: 'native-override' }
  assert.equal(createStandardEffortAvailability(settings, native.llm)('relay', model.id), true)
  assert.equal((await writeCapabilities(settings, override, native)).written, true)
  assert.deepEqual(model.reasoningEfforts, { high: 'native-override', low: 'explicit' })
})

test('standard eligibility requires ownership, an exact unique model, and the settings revision', async () => {
  const providers = sampleProviders()
  const profile = providers.relay
  profile.api = 'openai-completions'
  const settings = fakeSettings(providers)
  const modelId = profile.models[0].id
  let descriptions = 0
  const describe = settings.describe
  settings.describe = (...args) => { descriptions += 1; return describe(...args) }
  const available = createStandardEffortAvailability(settings, routeOwner())
  assert.equal(available('relay', modelId), true)
  assert.equal(available('relay', modelId.toUpperCase()), false)
  assert.equal(available('not-relay', modelId), false)
  assert.equal(descriptions, 1)
  assert.equal(createStandardEffortAvailability(settings, {})('relay', modelId), false)
  const noRevision = { ...settings, describe: () => describe().map(({ revision, ...row }) => row) }
  assert.equal(createStandardEffortAvailability(noRevision, routeOwner())('relay', modelId), false)
  profile.models.push({ id: modelId })
  assert.equal(createStandardEffortAvailability(settings, routeOwner())('relay', modelId), false)
  const refused = await writeCapabilities(settings, { provider: 'relay', model: modelId, efforts: ['low'] }, { standardEffort: true, llm: routeOwner() })
  assert.equal(refused.written, false)
  assert.equal(settings.calls.length, 0)
})

test('an automated result cannot opt in to standard wire fields', async () => {
  const providers = sampleProviders()
  providers.relay.api = 'openai-completions'
  const model = providers.relay.models[0]
  const settings = fakeSettings(providers)
  const saved = await writeCapabilities(settings, { provider: 'relay', model: model.id, efforts: ['high'] }, {
    automatic: true, standardEffort: true, llm: routeOwner(),
  })
  assert.equal(saved.written, false)
  assert.equal(model.reasoningEfforts, undefined)
  assert.equal(model.compat, undefined)
})

test('raw expression ancestors are refused before dispatch, including inherited effective expressions', async () => {
  const expression = { __jsExpr: '(literal)' }
  const paths = [
    ['providers'], ['providers', 'relay'], ['providers', 'relay', 'models'],
    ['providers', 'relay', 'models', '0'], ['providers', 'relay', 'models', '0', 'contextWindow'],
  ]
  for (const path of paths) {
    const providers = sampleProviders()
    const settings = fakeSettings(providers)
    const document = structuredClone({ providers })
    applyOp(document, path, { ...expression, ...path.length === 3 && { sibling: 'ignored by Loader' } })
    const configEditor = { configuration: () => [{ entry: { options: { id: 'llm-pi-ai', config: document } }, override: {} }] }
    const result = await writeCapabilities(settings, { provider: 'relay', model: 'mystery-model', contextWindow: 12345 }, { configEditor })
    assert.equal(result.reason, 'expression-backed', path.join('.'))
    assert.equal(settings.calls.length, 0)
  }
  const settings = fakeSettings(sampleProviders())
  const describe = settings.describe
  settings.describe = () => describe().map(row => ({ ...row, user: { providers: expression } }))
  assert.equal((await writeCapabilities(settings, { provider: 'relay', model: 'mystery-model', input: ['text', 'image'] }, { configEditor: undefined })).reason, 'expression-backed')
  assert.equal(settings.calls.length, 0)
})

test('an unrelated expression is safe; acknowledged no-op or nonpersisted fields are not written', async () => {
  const providers = sampleProviders()
  providers.relay.models[1].name = { __jsExpr: 'literal' }
  const settings = fakeSettings(providers)
  const target = { provider: 'relay', model: 'mystery-model', contextWindow: 12345 }
  let dispatched = 0
  const acknowledged = await writeCapabilities({ ...settings, mutate() {} }, target, { onDispatch: () => dispatched++ })
  assert.equal(acknowledged.reason, 'settings-unverified')
  assert.equal(dispatched, 1)
  const raw = settings.configEditor.configuration()[0]
  const notPersisted = { configuration: () => [{ ...raw, override: {} }] }
  assert.equal((await writeCapabilities(settings, target, { configEditor: notPersisted })).reason, 'settings-unverified')
  assert.equal((await writeCapabilities(settings, target)).written, true)
  assert.deepEqual(providers.relay.models[1].name, { __jsExpr: 'literal' })
  assert.equal((await writeCapabilities(settings, target, { configEditor: undefined })).reason, 'config-provenance-unavailable')
})

test('a catalog provider can contain one native ID and one hand-declared ID', async () => {
  const providers = sampleProviders()
  const settings = fakeSettings(providers)
  const llm = {
    ...routeOwner('relay', false),
    async discoverModels(ns, request) {
      assert.equal(ns, 'llm-pi-ai')
      assert.deepEqual(request, { provider: 'relay' })
      return [{ id: 'mystery-model' }]
    },
  }
  const write = model => writeCapabilities(settings, { provider: 'relay', model, input: ['text', 'image'] }, { automatic: true, llm })
  assert.equal((await write('mystery-model')).reason, 'native-catalog')
  assert.equal((await write('gpt-6.1-terra')).written, true)
  assert.equal(settings.calls.length, 1)
})
