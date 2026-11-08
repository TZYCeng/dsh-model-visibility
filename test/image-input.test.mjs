/**
 * Request-side image-input gate.
 *
 * The gate must be able to add `image` to a pi-ai relay model without touching
 * any other adapter or any configuration, and it must be reversible.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { installImageInputGate } from '../lib/image-input-gate.js'
import { createModelInfoService, imageInputDecision } from '../lib/model-info.js'

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
  const proto = {
    current() {
      return {}
    },
    profileOf() {
      return {}
    },
    modelOf(_snapshot, provider, model) {
      return { provider, id: model, name: model, input: [...input] }
    },
  }
  return Object.create(proto)
}

test('imageInputDecision follows the same evidence as the page', () => {
  const profile = relayProfile(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3', 'mystery-model'])
  const learned = {
    id: 'deepseek-v4.1-flash',
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

test('createModelInfoService exposes the same image decision', () => {
  const profile = relayProfile(['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3'])
  const service = createModelInfoService(
    { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => undefined },
    {
      context: () => ({
        profiles: new Map([['relay', profile]]),
        discovered: new Map(),
        learned: {
          id: 'deepseek-v4.1-flash',
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

  assert.deepEqual(adapter.modelOf({}, 'relay', 'vision-model').input, ['text', 'image'])
  assert.deepEqual(adapter.modelOf({}, 'relay', 'text-model').input, ['text'])
  assert.deepEqual(adapter.modelOf({}, 'other', 'vision-model').input, ['text'])

  gate.dispose()
  assert.deepEqual(adapter.modelOf({}, 'relay', 'vision-model').input, ['text'])
})

test('installImageInputGate refreshes newly registered adapters and keeps other shapes alone', () => {
  const pi = piAiAdapter(['text'])
  const deepseek = { resolveModel() {}, stream() {} }
  const llm = { adapters: new Map() }
  const gate = installImageInputGate(llm, { allow: () => true })

  llm.adapters.set('relay', { adapter: pi })
  llm.adapters.set('deepseek-account', { adapter: deepseek })
  gate.refresh()

  assert.deepEqual(pi.modelOf({}, 'relay', 'm').input, ['text', 'image'])
  assert.equal(deepseek.modelOf, undefined)
  gate.dispose()
})
