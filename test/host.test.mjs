/**
 * Host-half wiring test.
 *
 * Runs the real index.js against a fake ctx / llm / settings: the capability
 * route must expose the vendor correction, and the registered pi-ai adapter
 * must admit images only while `applyInput` is on.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

// index.js reads the shadow copy while the module is evaluated.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'model-visibility-test-'))
const { apply } = await import('../index.js')

function createHarness() {
  const providers = {
    relay: {
      baseURL: 'https://relay.example/v1',
      apiKeyEnv: 'RELAY_API_KEY',
      defaultInput: ['text'],
      models: [
        { id: 'deepseek/deepseek-v4.1-flash', input: [] },
        { id: 'deepseek/deepseek-v4.1-pro', input: ['text'] },
        { id: 'glm-5.3', input: [] },
        { id: 'glm-5.3-flash', input: [] },
        { id: 'mystery-model', input: [] },
      ],
    },
  }

  const adapter = Object.create({
    current: () => ({}),
    profileOf: () => ({}),
    modelOf: (_snapshot, provider, model) => ({
      provider,
      id: model,
      name: model,
      input: ['text'],
      contextWindow: 262144,
    }),
  })

  const llm = {
    adapters: new Map([['relay', { adapter }]]),
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => providers.relay.models.map((entry) => ({ id: entry.id, name: entry.id })),
    resolveModelInfo: async (provider, model) => adapter.modelOf({}, provider, model),
  }

  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', value: { providers } }],
    configure: () => {},
  }
  const route = { current: null }
  const scope = {
    llm,
    settings,
    connection: {
      fetch: {
        register(value) {
          route.current = value
          return () => {}
        },
      },
    },
    get: (name) => (name === 'settings' ? settings : undefined),
    on: () => () => {},
    effect(fn) {
      fn()
      return () => {}
    },
  }
  return {
    providers,
    adapter,
    llm,
    route,
    ctx: {
      logger: { warn() {} },
      on: () => () => {},
      effect(fn) {
        fn()
        return () => {}
      },
      inject(_deps, callback) {
        callback(scope)
      },
    },
  }
}

test('the Host route exposes the vendor correction and the gate aligns images', async () => {
  const harness = createHarness()
  const config = {
    hidden: { get: () => [] },
    probe: true,
    applyInput: { get: () => true },
  }
  apply(harness.ctx, config)

  assert.ok(harness.route.current !== null)
  const response = await harness.route.current.fetch(
    new Request('http://local/api/dsh-model-visibility/models'),
  )
  const body = await response.json()
  assert.equal(body.ok, true)
  const models = new Map(body.value.groups[0].models.map((model) => [model.id, model]))

  assert.deepEqual(models.get('glm-5.3').inputModalities, ['text'])
  assert.equal(models.get('glm-5.3').sources.modalities, 'official')
  assert.equal(models.get('glm-5.3').correction.code, 'glm-5.3-text-only')
  assert.deepEqual(models.get('glm-5.3-flash').inputModalities, ['text', 'image'])
  assert.deepEqual(models.get('deepseek/deepseek-v4.1-flash').inputModalities, ['text', 'image'])
  assert.deepEqual(models.get('deepseek/deepseek-v4.1-pro').inputModalities, ['text'])

  const inputOf = (id) => harness.adapter.modelOf({}, 'relay', id).input
  assert.deepEqual(inputOf('deepseek/deepseek-v4.1-flash'), ['text', 'image'])
  assert.deepEqual(inputOf('deepseek/deepseek-v4.1-pro'), ['text'])
  assert.deepEqual(inputOf('glm-5.3'), ['text'])
  assert.deepEqual(inputOf('glm-5.3-flash'), ['text', 'image'])
  assert.deepEqual(inputOf('mystery-model'), ['text'])

  config.applyInput = { get: () => false }
  assert.deepEqual(inputOf('deepseek/deepseek-v4.1-flash'), ['text'])
})
