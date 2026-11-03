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

  /** Set one path on the fake settings document (same contract as the Host). */
  const applyOp = (path, value) => {
    let current = { providers }
    for (let index = 0; index < path.length - 1; index += 1) current = current[path[index]]
    current[path[path.length - 1]] = value
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

  let resolveCalls = 0
  const llm = {
    adapters: new Map([['relay', { adapter }]]),
    listProviders: () => [{ id: 'relay', name: 'Relay' }],
    listModels: async () => providers.relay.models.map((entry) => ({ id: entry.id, name: entry.id })),
    resolveModelInfo: async (provider, model) => {
      resolveCalls += 1
      return adapter.modelOf({}, provider, model)
    },
  }

  const settings = {
    describe: () => [{ ns: 'llm-pi-ai', revision: 1, value: { providers } }],
    configure: () => {},
    calls: [],
    async mutate(ns, ops) {
      settings.calls.push({ ns, ops })
      for (const op of ops) applyOp(op.path, op.value)
    },
  }
  const route = { current: null, overrides: null }
  const scope = {
    llm,
    settings,
    connection: {
      fetch: {
        register(value) {
          if (String(value.path).endsWith('/overrides')) route.overrides = value
          else route.current = value
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
    settings,
    resolveCalls: () => resolveCalls,
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

test('a hard reload drops the cache and advertises the reload feature', async () => {
  const harness = createHarness()
  apply(harness.ctx, {
    hidden: { get: () => [] },
    probe: true,
    applyInput: { get: () => true },
  })

  const read = async (url) => {
    const response = await harness.route.current.fetch(new Request(url))
    return response.json()
  }

  await read('http://local/api/dsh-model-visibility/models')
  const afterFirst = harness.resolveCalls()
  assert.ok(afterFirst > 0)

  await read('http://local/api/dsh-model-visibility/models')
  assert.equal(harness.resolveCalls(), afterFirst)

  const reloaded = await read('http://local/api/dsh-model-visibility/models?fresh=1&reload=1')
  assert.equal(harness.resolveCalls(), afterFirst * 2)
  assert.ok(reloaded.value.catalog.features.includes('reload'))
})

test('the override route persists manual capabilities and feeds the gate', async () => {
  const harness = createHarness()
  apply(harness.ctx, {
    hidden: { get: () => [] },
    probe: true,
    applyInput: { get: () => true },
  })

  assert.ok(harness.route.overrides !== null)
  const call = async (url, body) => {
    const response = await harness.route.overrides.fetch(
      new Request(url, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    )
    return response.json()
  }
  const base = 'http://local/api/dsh-model-visibility/overrides'

  const initial = await call(base)
  assert.equal(initial.ok, true)
  assert.ok(Array.isArray(initial.value.overrides))

  const saved = await call(base, {
    provider: 'relay',
    model: 'mystery-model',
    input: ['text', 'image'],
    contextWindow: 400000,
    applyToProvider: false,
  })
  assert.equal(saved.ok, true)
  assert.equal(saved.value.overrides.length, 1)

  const models = await (
    await harness.route.current.fetch(
      new Request('http://local/api/dsh-model-visibility/models?fresh=1'),
    )
  ).json()
  const model = models.value.groups[0].models.find((entry) => entry.id === 'mystery-model')
  assert.deepEqual(model.inputModalities, ['text', 'image'])
  assert.equal(model.contextWindow, 400000)
  assert.equal(model.sources.modalities, 'manual')
  assert.equal(model.sources.context, 'manual')

  assert.deepEqual(harness.adapter.modelOf({}, 'relay', 'mystery-model').input, ['text', 'image'])

  const removed = await call(base, { remove: true, provider: 'relay', model: 'mystery-model' })
  assert.equal(removed.ok, true)
  assert.deepEqual(removed.value.overrides, [])
  assert.deepEqual(harness.adapter.modelOf({}, 'relay', 'mystery-model').input, ['text'])
})

test('a manual override is written through to the provider settings', async () => {
  const harness = createHarness()
  apply(harness.ctx, {
    hidden: { get: () => [] },
    probe: true,
    applyInput: { get: () => true },
  })

  const base = 'http://local/api/dsh-model-visibility/overrides'
  const response = await harness.route.overrides.fetch(
    new Request(base, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'relay',
        model: 'mystery-model',
        input: ['text', 'image'],
        contextWindow: 400000,
        efforts: [{ id: 'off' }, { id: 'high' }],
      }),
    }),
  )
  const saved = await response.json()
  assert.equal(saved.ok, true)
  assert.deepEqual(saved.value.provider, {
    written: true,
    fields: ['input', 'contextWindow', 'reasoningEfforts'],
    ns: 'llm-pi-ai',
  })
  // Everything was mirrored, so nothing has to stay in the local override file.
  assert.deepEqual(saved.value.overrides, [])

  const entry = harness.providers.relay.models.find((model) => model.id === 'mystery-model')
  assert.deepEqual(entry.input, ['text', 'image'])
  assert.equal(entry.contextWindow, 400000)
  assert.deepEqual(entry.reasoningEfforts, { off: null, high: 'high' })
  assert.equal(harness.settings.calls.length, 1)

  const models = await (
    await harness.route.current.fetch(
      new Request('http://local/api/dsh-model-visibility/models?fresh=1'),
    )
  ).json()
  const model = models.value.groups[0].models.find((item) => item.id === 'mystery-model')
  assert.deepEqual(model.inputModalities, ['text', 'image'])
  assert.equal(model.contextWindow, 400000)
  assert.equal(model.sources.modalities, 'config')
  assert.equal(model.sources.context, 'config')

  // The request-side gate reads the provider declaration, so the composer sees
  // the image modality even though the manual override file is empty.
  assert.deepEqual(harness.adapter.modelOf({}, 'relay', 'mystery-model').input, ['text', 'image'])
})

test('write-through keeps fields with no provider equivalent in the local override', async () => {
  const harness = createHarness()
  apply(harness.ctx, {
    hidden: { get: () => [] },
    probe: true,
    applyInput: { get: () => true },
  })

  const response = await harness.route.overrides.fetch(
    new Request('http://local/api/dsh-model-visibility/overrides', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'relay',
        model: 'mystery-model',
        kind: 'image',
        input: ['text', 'image'],
      }),
    }),
  )
  const saved = await response.json()
  assert.equal(saved.value.provider.written, true)
  // `kind` has no provider field, so only it stays local.
  assert.equal(saved.value.overrides.length, 1)
  const [rest] = saved.value.overrides
  assert.equal(rest.provider, 'relay')
  assert.equal(rest.model, 'mystery-model')
  assert.equal(rest.kind, 'image')
  assert.equal(rest.input, undefined)
  assert.deepEqual(
    harness.providers.relay.models.find((model) => model.id === 'mystery-model').input,
    ['text', 'image'],
  )

  const models = await (
    await harness.route.current.fetch(
      new Request('http://local/api/dsh-model-visibility/models?fresh=1'),
    )
  ).json()
  const model = models.value.groups[0].models.find((item) => item.id === 'mystery-model')
  assert.equal(model.kind, 'image')
  assert.equal(model.sources.kind, 'manual')
})

test('applyToProvider:false keeps the override local', async () => {
  const harness = createHarness()
  apply(harness.ctx, {
    hidden: { get: () => [] },
    probe: true,
    applyInput: { get: () => true },
  })

  const base = 'http://local/api/dsh-model-visibility/overrides'
  const response = await harness.route.overrides.fetch(
    new Request(base, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'relay',
        model: 'mystery-model',
        input: ['text', 'image'],
        applyToProvider: false,
      }),
    }),
  )
  const saved = await response.json()
  assert.equal(saved.value.provider.written, false)
  assert.equal(saved.value.provider.reason, 'skipped')
  assert.equal(saved.value.overrides.length, 1)
  assert.equal(harness.settings.calls.length, 0)
})
