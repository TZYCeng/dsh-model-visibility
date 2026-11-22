/**
 * Request-side image-input gate.
 *
 * The gate must be able to add `image` to a pi-ai relay model without touching
 * any other adapter or any configuration, and it must be reversible.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { installImageInputGate } from '../lib/image-input-gate.js'
import { createModelInfoService, describeModel, imageInputDecision } from '../lib/model-info.js'
import { parseModelListing, readProviderProfiles } from '../lib/provider-probe.js'

/** A relay profile whose per-model `input` is the empty DSH default. */
function relayProfile(models) {
  return {
    id: 'relay',
    api: 'openai-completions',
    baseURL: 'https://relay.example/v1',
    defaultInput: ['text'],
    models: new Map(models.map((id) => [id, { id, input: [] }])),
  }
}

/** A pi-ai shaped adapter whose modelOf lives on the prototype. */
function piAiAdapter(input = ['text']) {
  const snapshot = { profiles: new Map([['relay', { provider: 'relay' }]]) }
  const proto = {
    current() { return snapshot },
    profileOf(current, provider) { return current?.profiles?.get(provider) },
    modelOf(_snapshot, provider, model) {
      return { provider, id: model, name: model, input: [...input] }
    },
  }
  return Object.create(proto)
}

test('imageInputDecision follows the same evidence as the page', () => {
  const profile = relayProfile(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3', 'mystery-model'])
  const learned = {
    id: 'deepseek/deepseek-v4.1-flash',
    type: 'chat',
    input: ['text', 'image'],
    reasoning: true,
    origins: ['checker'],
    verifiedAt: 1,
  }
  assert.equal(
    imageInputDecision('relay', 'deepseek/deepseek-v4.1-flash', { profile, learned }).allowed,
    true,
  )
  assert.equal(imageInputDecision('relay', 'z-ai/glm-5.3', { profile }).allowed, false)
  assert.equal(imageInputDecision('relay', 'mystery-model', { profile }).allowed, false)
  assert.equal(imageInputDecision('builtin', 'grok-4.7', {}).allowed, false)
})

test('a public name alias is available for display and diagnostics but cannot admit images', async () => {
  const id = 'relay/custom-fast'
  const profile = relayProfile([id])
  const learned = { id, input: ['text', 'image'], origins: ['public'], publicAlias: true }
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  const display = await describeModel(llm, 'relay', { id }, { profile, learned })
  assert.deepEqual(display.inputModalities, ['text', 'image'])
  assert.equal(display.learned.publicAlias, true)
  assert.deepEqual(display.learned.origins, ['public'])
  assert.equal(imageInputDecision('relay', id, { profile, learned }).allowed, false)
})

test('a relay display name without an advertised ID is a reference, not a request fact', async () => {
  const id = 'opaque-label'
  const profile = relayProfile([id])
  const discovered = parseModelListing({ data: [{ name: id, input_modalities: ['text', 'image'] }] })
  assert.ok(discovered.get(id).nameOnly)
  const context = { profile, discovered, learned: {} }
  const shown = await describeModel({ resolveModelInfo: async () => ({}) }, 'relay', { id }, context)
  assert.deepEqual(shown.inputModalities, ['text', 'image'])
  assert.equal(shown.fieldEvidence.modalities.alias, true)
  assert.equal(imageInputDecision('relay', id, context).allowed, false)
})

test('an explicit text-only provider declaration blocks the gate', () => {
  const profile = {
    id: 'relay',
    defaultInput: ['text'],
    models: new Map([['deepseek/deepseek-v4.1-flash', { id: 'deepseek/deepseek-v4.1-flash', input: ['text'] }]]),
  }
  assert.equal(
    imageInputDecision('relay', 'deepseek/deepseek-v4.1-flash', { profile }).allowed,
    false,
  )
})

test('catalog modelOverrides enforce exact Provider declarations with or without baseURL', async () => {
  const model = { id: 'Vendor/Exact-Model', name: 'Gemini Compatible' }
  const learned = { input: ['text', 'image'], type: 'chat' }
  const discovery = new Map([[model.id, { id: model.id, inputModalities: ['text', 'image'] }]])
  for (const endpoint of [{ baseURL: 'https://example.test' }, {}]) {
    const profiles = readProviderProfiles([{ ns: 'llm-pi-ai', value: { providers: {
      relay: { ...endpoint, models: [], modelOverrides: {
        [model.id]: { input: ['text'], contextWindow: 32000 },
        'Vendor/Other': { contextWindow: 64000 },
      } },
    } } }])
    const profile = profiles.get('relay')
    assert.equal(profile.catalogModels, true)
    assert.equal(profile.models.get(model.id).id, model.id)
    assert.equal(profile.models.has(model.id.toLowerCase()), false)
    const llm = { resolveModelInfo: async () => ({
      inputModalities: ['text'], context: { contextWindow: 128000 }, defaultMaxTokens: 8192,
    }) }
    const context = { profile, discovered: discovery, learned }
    const display = await describeModel(llm, 'relay', model, context)
    assert.deepEqual(display.inputModalities, ['text'])
    assert.equal(display.sources.modalities, 'config')
    assert.equal(display.contextWindow, 32000)
    assert.equal(display.defaultMaxTokens, 8192)
    assert.equal(imageInputDecision('relay', model.id, { ...context, override: learned }).allowed, false)
    const untouched = await describeModel(llm, 'relay', { ...model, id: 'Vendor/Other' }, context)
    assert.deepEqual(untouched.inputModalities, ['text'])
    assert.equal(untouched.sources.modalities, 'adapter')
    assert.equal(imageInputDecision('relay', 'Vendor/Other', context).allowed, false)
  }
})

test('a tempting adapter display name alone cannot change real request admission', () => {
  const id = 'model-without-family-in-id'
  const adapter = piAiAdapter()
  const profile = { ...relayProfile([id]), catalogModels: false, inputProvenance: true, adapter, adapterSnapshot: adapter.current() }
  adapter.modelOf = (_snapshot, provider, id) => ({ provider, id, name: 'Gemini Vision', input: ['text'], api: profile.api, baseUrl: profile.baseURL })
  const llm = { adapters: new Map([['relay', { adapter }]]) }
  const service = createModelInfoService(llm, {
    context: { profiles: new Map([['relay', profile]]), learned: {} },
  })
  assert.equal(service.imageInputAllowed('relay', id), false)
  const gate = installImageInputGate(llm, { allow: service.imageInputAllowed })
  try {
    assert.deepEqual(adapter.modelOf(adapter.current(), 'relay', id).input, ['text'])
    assert.deepEqual(adapter.modelOf(adapter.current(), 'relay', 'other').input, ['text'])
  } finally {
    gate.dispose()
  }
})

test('createModelInfoService exposes the same image decision', () => {
  const profile = relayProfile(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3'])
  const service = createModelInfoService(
    { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => undefined },
    {
      context: () => ({
        profiles: new Map([['relay', profile]]),
        discovered: new Map(),
        learned: {
          id: 'deepseek/deepseek-v4.1-flash',
          type: 'chat',
          input: ['text', 'image'],
          reasoning: true,
          origins: ['checker'],
          verifiedAt: 1,
        },
      }),
    },
  )
  assert.equal(service.imageInputAllowed('relay', 'deepseek/deepseek-v4.1-flash'), true)
  assert.equal(service.imageInputAllowed('relay', 'z-ai/glm-5.3'), false)
  assert.equal(service.imageInputAllowed('other', 'deepseek/deepseek-v4.1-flash'), false)
  service.invalidate()
  assert.equal(service.imageInputAllowed('relay', 'deepseek/deepseek-v4.1-flash'), true)
})

test('installImageInputGate adds image only to allowed pi-ai relay models', () => {
  const adapter = piAiAdapter(['text'])
  const llm = { adapters: new Map([['relay', { adapter }]]) }
  const gate = installImageInputGate(llm, {
    allow: (provider, model) => provider === 'relay' && model === 'vision-model',
  })

  assert.deepEqual(adapter.modelOf(adapter.current(), 'relay', 'vision-model').input, ['text', 'image'])
  assert.deepEqual(adapter.modelOf(adapter.current(), 'relay', 'text-model').input, ['text'])
  assert.deepEqual(adapter.modelOf({}, 'other', 'vision-model').input, ['text'])

  gate.dispose()
  assert.deepEqual(adapter.modelOf(adapter.current(), 'relay', 'vision-model').input, ['text'])
})

test('installImageInputGate refreshes newly registered adapters and keeps other shapes alone', () => {
  const pi = piAiAdapter(['text'])
  const deepseek = { resolveModel() {}, stream() {} }
  const llm = { adapters: new Map() }
  const gate = installImageInputGate(llm, { allow: () => true })

  llm.adapters.set('relay', { adapter: pi })
  llm.adapters.set('deepseek-account', { adapter: deepseek })
  gate.refresh()

  assert.deepEqual(pi.modelOf(pi.current(), 'relay', 'm').input, ['text', 'image'])
  assert.equal(deepseek.modelOf, undefined)
  gate.dispose()
})

test('the UI and gate agree on raw listing aliases, exact rows and ambiguity', async () => {
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  const vision = { id: 'Vendor/MYSTERY-MODEL:free', inputModalities: ['text', 'image'] }
  const text = { id: 'mystery-model', inputModalities: ['text'] }
  const other = { id: 'Other/mystery-model:free', inputModalities: ['text'] }
  const profile = relayProfile([text.id])
  for (const [entries, allowed, source] of [
    [[vision], false, 'provider'],
    [[vision, text], false, 'provider'],
    [[vision, other], false, 'unknown'],
  ]) {
    const discovered = new Map(entries.map((entry) => [entry.id, entry]))
    const context = { profile, discovered, learned: {} }
    const ui = await describeModel(llm, 'relay', text, context)
    const gate = imageInputDecision('relay', text.id, context)
    assert.equal(ui.sources.modalities, source)
    assert.equal(gate.record.sources.modalities, source)
    assert.deepEqual(gate.record.inputModalities, ui.inputModalities)
    assert.equal(gate.allowed, allowed)
  }
})

test('refresh releases stale patches, restoring an own method or accessor exactly', () => {
  const original = piAiAdapter()
  const descriptor = { value: original.modelOf, configurable: false, writable: true, enumerable: true }
  Object.defineProperty(original, 'modelOf', descriptor)
  const replacement = piAiAdapter()
  const base = replacement.modelOf
  const accessor = { get: () => base, configurable: true, enumerable: true }
  Object.defineProperty(replacement, 'modelOf', accessor)
  const llm = { adapters: new Map([['relay', { adapter: original }], ['alias', { adapter: original }]]) }
  const gate = installImageInputGate(llm, { allow: () => true })
  const patched = original.modelOf
  assert.deepEqual(patched.call(original, original.current(), 'relay', 'm').input, ['text', 'image'])
  llm.adapters.set('relay', { adapter: replacement })
  gate.refresh()
  assert.equal(original.modelOf, patched, 'an adapter shared by another registration stays patched')
  assert.deepEqual(replacement.modelOf(replacement.current(), 'relay', 'm').input, ['text', 'image'])
  llm.adapters.delete('alias')
  gate.refresh()
  assert.deepEqual(Object.getOwnPropertyDescriptor(original, 'modelOf'), descriptor)
  assert.deepEqual(patched.call(original, original.current(), 'relay', 'm').input, ['text'], 'retained wrapper reference is inactive')
  gate.dispose()
  gate.refresh()
  assert.deepEqual(Object.getOwnPropertyDescriptor(replacement, 'modelOf'), { ...accessor, set: undefined })
})

test('release leaves another owner’s method in place', () => {
  const adapter = piAiAdapter()
  const llm = { adapters: new Map([['relay', { adapter }]]) }
  const gate = installImageInputGate(llm, { allow: () => true })
  const replacement = () => ({ input: ['audio'] })
  adapter.modelOf = replacement
  gate.dispose()
  assert.equal(adapter.modelOf, replacement)
})

test('qualified aliases reject other vendors even when a bare row advertises vision', async () => {
  const llm = { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
  const input = ['text', 'image']
  const run = async (id, listed, allowed, source) => {
    const profile = relayProfile([id])
    const discovered = new Map(listed.map(model => [model, { id: model, inputModalities: input }]))
    const context = { profile, discovered, learned: {} }
    const display = await describeModel(llm, 'relay', { id }, context)
    assert.equal(display.sources.modalities, source, id)
    assert.equal(imageInputDecision('relay', id, context).allowed, allowed, id)
  }
  await run('x/model', ['model', 'y/model'], false, 'unknown')
  await run('x/model', ['y/model'], false, 'unknown')
  await run('x/model', ['model', 'y/model', 'x/model'], true, 'provider')
  await run('model', ['model', 'y/model'], true, 'provider')
  await run('X/MODEL:free', ['x/model:fast', 'y/model'], false, 'provider')
  await run('x/MODEL:free', ['x/model:thinking', 'y/model'], false, 'unknown')
  await run('x/model', ['x/model:free', 'x/model:fast', 'model'], false, 'unknown')
  for (const suffix of ['-preview', '-27b', '-4k', '-2k', ':batch', ':thinking']) {
    await run(`x/model${suffix}`, ['x/model'], false, 'unknown')
  }
  await run('x/model-5.1', ['x/model-5-1'], false, 'unknown')
})

test('a route snapshot never uses newer declarations or another generation of the same route', () => {
  const id = 'mystery-model'
  const adapter = piAiAdapter()
  const previous = adapter.current()
  const current = { profiles: new Map(previous.profiles) }
  adapter.current = () => current
  const base = relayProfile([id])
  adapter.modelOf = (_snapshot, provider, id) => ({ provider, id, name: id, input: ['text'], api: base.api, baseUrl: base.baseURL })
  const llm = { adapters: new Map([['relay', { adapter }]]) }
  let profile = { ...base, catalogModels: false, inputProvenance: true, adapter, adapterSnapshot: previous }
  const service = createModelInfoService(llm, { context: () => ({ profiles: new Map([['relay', profile]]), overrides: { get: () => ({ input: ['text', 'image'] }) } }) })
  const gate = installImageInputGate(llm, { allow: service.imageInputAllowed })
  try {
    assert.deepEqual(adapter.modelOf(previous, 'relay', id).input, ['text'])
    assert.deepEqual(adapter.modelOf(current, 'relay', id).input, ['text'])
    profile = { ...profile, adapterSnapshot: current, models: new Map([[id, { id, input: ['text'] }]]) }
    assert.deepEqual(adapter.modelOf(current, 'relay', id).input, ['text'])
    profile = { ...profile, models: base.models, inputDefault: true }
    assert.deepEqual(adapter.modelOf(current, 'relay', id).input, ['text'])
    profile = { ...profile, inputDefault: false }
    assert.deepEqual(adapter.modelOf(current, 'relay', id).input, ['text', 'image'])
    assert.deepEqual(adapter.modelOf(previous, 'relay', id).input, ['text'])
  } finally {
    gate.dispose()
  }
})
