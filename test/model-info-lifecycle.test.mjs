import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelInfoService } from '../lib/model-info.js'
import { installImageInputGate } from '../lib/image-input-gate.js'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('120 resolutions use one bounded pool across all routes, preserve order and redact trace data', async () => {
  const names = Array.from({ length: 6 }, (_, i) => `SECRET_ROUTE_${i}`)
  const models = Array.from({ length: 20 }, (_, i) => ({ id: `SECRET_MODEL_${i}` }))
  const trace = []
  let active = 0, listing = 0, peak = 0, listPeak = 0, total = 0
  const service = createModelInfoService({
    listProviders: () => names.map(id => ({ id })),
    listModels: async () => { listPeak = Math.max(listPeak, ++listing); await tick(); listing--; return models },
    resolveModelInfo: async (provider, id) => { total++; peak = Math.max(peak, ++active); await tick(); active--; return { provider, id, inputModalities: ['text'] } },
  }, { learned: { get: () => undefined }, trace: (m, s, d) => trace.push([m, s, d]) })
  const catalog = await service.read()
  assert.equal(total, 120)
  assert.equal(peak, 8)
  assert.equal(listPeak, 4)
  assert.deepEqual(catalog.groups.map(g => g.id), names)
  for (const group of catalog.groups) assert.deepEqual(group.models.map(row => row.id), models.map(row => row.id))
  for (const feature of ['effortDirect', 'bulkEfforts', 'runId', 'diagnostics', 'versionInfo', 'visibilityIdentity', 'reload']) assert.ok(catalog.learned.features.includes(feature))
  assert.ok(trace.length <= 5)
  assert.doesNotMatch(JSON.stringify(trace), /SECRET_/)
  await service.dispose()
})

test('enabled detail trace includes bounded useful per-model decisions but not arbitrary upstream strings', async () => {
  const traces = []
  const trace = Object.assign((module, step, data) => traces.push({ module, step, data }), { enabled: true })
  const learned = { get: id => ({ id, input: ['text'], contextWindow: 2000, origins: ['checker'] }) }
  const provider = 'legit-route'
  const ids = ['vendor/legit-model', 'sk-forbidden-access-key', 'bad-row', ...Array.from({ length: 150 }, (_, i) => `opaque-${i}`)]
  const profile = { catalogModels: false, baseURL: 'https://secret.invalid/v1', models: new Map(ids.map(id => [id, { id }])) }
  const service = createModelInfoService({ listProviders: () => [{ id: provider }], listModels: () => ids.map(id => ({ id })),
    resolveModelInfo: (_p, id) => {
      if (id === 'bad-row') throw Error('raw secret response')
      return { reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'secret-custom-level', name: 'Never log this' }] } }
    },
  }, { learned, enrichment: { profiles: new Map([[provider, profile]]) }, context: { profiles: new Map([[provider, profile]]), learned }, trace })
  const read = await service.read()
  const sample = traces.find(e => e.step === 'model' && e.data.model === ids[0]).data
  assert.equal(sample.provider, 'legit-route')
  assert.equal(sample.source, 'snapshot')
  assert.equal(sample.contextWindow, 2000)
  assert.deepEqual(sample.efforts, ['high'])
  assert.ok(sample.sources.includes('reasoning:adapter'))
  assert.ok(traces.some(e => e.data.model === 'bad-row' && e.data.reason === 'adapter-failed'))
  assert.ok(traces.filter(e => e.step === 'model').length <= 24)
  assert.equal(service.peek(), read)
  assert.equal(service.imageInputAllowed(provider, ids[0]), false)
  assert.ok(traces.some(e => e.step === 'decision' && e.data.model === ids[0] && e.data.reason === 'text-only' && e.data.accepted === false))
  assert.doesNotMatch(JSON.stringify(traces), /secret|forbidden|invalid\/v1|Never log/i)
  await service.dispose()
  assert.equal(service.peek(), null)
})

test('dispose aborts active resolves, stops queued models, and never starts another sweep', { timeout: 1500 }, async () => {
  const started = Promise.withResolvers(), oldWork = Promise.withResolvers()
  const signals = []
  let calls = 0
  const service = createModelInfoService({ listProviders: () => [{ id: 'relay' }],
    listModels: () => Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}` })),
    resolveModelInfo: async (_p, id, signal) => { signals.push(signal); if (++calls === 3) started.resolve(); await oldWork.promise; return { id } },
  }, { modelConcurrency: 3 })
  const stale = service.read()
  const rejected = assert.rejects(stale, /aborted|cancelled/i)
  await started.promise
  await service.dispose()
  await rejected
  assert.equal(calls, 3)
  assert.ok(signals.every(signal => signal.aborted))
  oldWork.resolve(); await tick()
  await assert.rejects(service.read(), /disposed/)
  assert.equal(calls, 3)
  assert.equal(service.imageInputAllowed('relay', 'model-1'), false)
})

test('an ignored abort never releases real resolver slots on a timeout or successive reads', { timeout: 1500 }, async () => {
  const release = Promise.withResolvers()
  let actual = 0, peak = 0, calls = 0
  const service = createModelInfoService({ listProviders: () => [{ id: 'relay' }],
    listModels: () => Array.from({ length: 120 }, (_, i) => ({ id: `model-${i}` })),
    resolveModelInfo: async () => { calls++; peak = Math.max(peak, ++actual); await release.promise; actual--; return {} },
  }, { modelConcurrency: 3, timeoutMs: 25, learned: {} })
  const first = await service.read()
  assert.equal(first.groups[0].models.length, 120)
  assert.ok(first.groups[0].models.every(m => m.infoError))
  service.invalidate()
  await service.read()
  assert.equal(calls, 3)
  assert.equal(peak, 3)
  release.resolve(); await tick()
  const recovered = await service.read({ fresh: true })
  assert.equal(calls, 123)
  assert.ok(recovered.groups[0].models.every(m => !m.infoError))
  await service.dispose()
})

test('a replaced registry owner recovers from an adapter that never acknowledged cancellation', { timeout: 1500 }, async () => {
  const retired = {}, replacement = {}, adapters = new Map([['relay', { adapter: retired }]])
  const pending = Promise.withResolvers()
  let oldCalls = 0
  const service = createModelInfoService({ adapters, listProviders: () => [{ id: 'relay' }], listModels: () => [{ id: 'm' }],
    resolveModelInfo() {
      if (adapters.get('relay').adapter === retired) { oldCalls++; return pending.promise }
      return { context: { contextWindow: 8192 } }
    },
  }, { modelConcurrency: 1, timeoutMs: 20, learned: {} })
  assert.match((await service.read()).groups[0].models[0].infoError, /timed out/)
  assert.match((await service.read({ fresh: true })).groups[0].models[0].infoError, /previous operations/)
  assert.equal(oldCalls, 1)
  adapters.set('relay', { adapter: replacement })
  service.invalidate()
  assert.equal((await service.read()).groups[0].models[0].contextWindow, 8192)
  pending.resolve(); await service.dispose()
})

test('trace from a frequently invoked gate is bounded, redacted and observational', () => {
  const provider = 'SECRET_ROUTE', id = 'SECRET_MODEL'
  const profile = { provider }
  const snapshot = { profiles: new Map([[provider, profile]]) }
  const adapter = { current: () => snapshot, profileOf: () => profile,
    modelOf: () => ({ provider, id, input: ['text'], name: 'SECRET_NAME', baseUrl: 'https://secret.invalid/' }) }
  const trace = []
  const gate = installImageInputGate({ adapters: new Map([[provider, { adapter }]]) }, {
    allow: () => true, trace(m, s, d) { trace.push([m, s, d]); throw Error('observer failure') },
  })
  for (let i = 0; i < 100; i++) assert.deepEqual(adapter.modelOf(snapshot, provider, id).input, ['text', 'image'])
  assert.deepEqual(trace, [['gate', 'admitted', { allowed: true }]])
  gate.dispose()
})
