import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCapabilityVerifier, PUBLIC_SOURCES } from '../lib/check-catalog.js'
import { createLearnedCatalog, PUBLIC_CATALOG_REVISION } from '../lib/learned-catalog.js'
import { createModelInfoService, mergeCapabilities } from '../lib/model-info.js'
import { readProviderProfiles } from '../lib/provider-probe.js'
import { withStoreLock } from '../lib/store-lock.js'

const quiet = { warn() {} }
const checker = { provider: 'relay', model: 'checker' }
const stubLearned = () => ({ upsertEntries() {}, meta() { return {} } })
const storeFor = t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-verify-reg-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  return createLearnedCatalog({ file: path.join(home, 'learned.json'), logger: quiet })
}
const urls = { ...PUBLIC_SOURCES }
const catalogs = ({ free = {}, api = {}, open = {}, hub = [] } = {}) => async url => Response.json(
  url === urls.modelsDevModels ? free : url === urls.modelsDevApi ? api : url === urls.openRouter ? open : hub)

// Real parser, matcher, file store and reopen. In particular neither an empty
// list nor the union of origins says who supplied a *particular* field.
test('a mixed sweep keeps exact public facts apart from disagreeing checker values, aliases and empty source fields', async t => {
  const id = 'vendor/model', alias = id + ':free', learned = storeFor(t)
  const v = createCapabilityVerifier({ learned, logger: quiet,
    llm: {
      listProviders: () => [{ id: checker.provider }], listModels: async () => [{ id }, { id: alias }],
      prepareCall: async config => ({ config, async *stream() {
        yield { type: 'text-delta', text: JSON.stringify([{ id, input: ['text'], kind: 'chat', contextWindow: 4096 }, { id: alias }]) }
      } }),
    },
    fetch: catalogs({
      free: { [id]: { modalities: { input: [' ', 'not-a-modality'], output: [] }, limit: { context: 128000 } } },
      api: { vendor: { models: { model: { reasoning_options: [{ type: 'effort', values: ['low', 'high'] }] } } } },
      open: { data: [{ id, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }] },
    }),
  })
  const state = await v.start({ checker, fuzzyMatch: true })
  assert.deepEqual([state.done, state.publicReliable, state.aliasMatches], [2, 1, 1])
  const again = createLearnedCatalog({ file: learned.file })
  const row = again.getExact(id)
  assert.deepEqual(row.origins, ['public', 'checker'])
  assert.deepEqual(row.input, ['text'], 'checker snapshot remains separately attributable')
  assert.equal(row.contextWindow, 4096)
  assert.equal(row.type, 'chat')
  const pub = row.publicFacts
  assert.equal(pub.publicLookupId, id)
  assert.deepEqual(pub.input, ['text', 'image'])
  assert.equal(pub.contextWindow, 128000)
  assert.equal(pub.type, undefined, 'a checker-only field does not become a catalog field')
  assert.deepEqual(pub.fieldSources, { input: 'OpenRouter', output: 'OpenRouter', contextWindow: 'models.dev/models.json',
    reasoning: 'models.dev/api.json', reasoningEfforts: 'models.dev/api.json' })
  assert.ok(pub.fieldVerifiedAt.input >= state.startedAt)
  const merged = mergeCapabilities({ id, name: id }, { learned: row })
  assert.deepEqual([merged.sources.modalities, merged.inputModalities, merged.contextWindow], ['public', ['text', 'image'], 128000])
  assert.equal(merged.sources.kind, 'snapshot')
  assert.equal(again.getExact(alias).publicAlias, true)
  assert.equal(again.getExact(alias).publicLookupId, id)
  assert.equal(again.getExact(alias).publicFacts, undefined, 'alias is never independent exact evidence')
})

test('an incremental supplement can refresh a missing ladder without spending again on the known checker row', async t => {
  const learned = storeFor(t), id = 'proprietary/model'
  let modelCalls = 0, webCalls = 0, downloads = 0
  const trace = []
  const doc = 'https://docs.example/model'
  const v = createCapabilityVerifier({ learned, logger: quiet, trace: (module, step, data) => trace.push({ module, step, data }),
    llm: { listProviders: () => [{ id: 'relay' }], listModels: async () => [{ id }, { id: checker.model }],
      prepareCall: async config => ({ config, async *stream(request) {
        modelCalls++
        if (request.tools.length && request.messages.length === 1) yield { type: 'block-end', index: 0,
          block: { type: 'tool-call', name: 'search_model_docs', id: 'call', arguments: '{"query":"model specification"}' } }
        else if (!request.tools.length) yield { type: 'text-delta', text: JSON.stringify([{ id, contextWindow: 4096, reasoning: true, evidence: { contextWindow: doc, reasoning: doc } }]) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } }),
    },
    web: { search: async () => { webCalls++; return { sources: [{ url: doc, snippet: '4096 tokens with reasoning support' }] } } },
    fetch: async () => { downloads++; return Response.json([]) },
  })
  const run = (fullScan = false) => v.start({ mode: 'supplement', checker, fullScan })
  assert.equal((await run()).done, 1)
  assert.equal(learned.getExact(id).reasoningEfforts, undefined)
  assert.deepEqual([modelCalls, webCalls], [3, 1])
  const firstDownloads = downloads
  const second = await run()
  assert.deepEqual([second.catalogTargets, second.catalogMatches, second.checkerTargets, second.skippedKnown, second.total, second.processed, second.unknown], [1, 0, 0, 1, 0, 0, 0])
  assert.ok(downloads > firstDownloads, 'new public ladders can still be found')
  assert.deepEqual([modelCalls, webCalls], [3, 1], 'a public miss is not an instruction to buy a duplicate search and model call')
  assert.equal((await run(true)).checkerTargets, 1)
  assert.deepEqual([modelCalls, webCalls], [6, 2], 'the explicitly requested full check still works')
  for (const step of ['checker-request', 'checker-tool', 'checker-output', 'checker-parse']) assert.ok(trace.some(e => e.step === step), step)
  assert.doesNotMatch(JSON.stringify(trace), /https?:\/\/|model specification|"contextWindow":4096|reasoning supported|block-end|content|snippet/i)
})

// Use the real writer, per-model arbiter, provenance and overwritten settings
// verification. Two routes share exact IDs: evidence winning on one is not
// permission to write to the other. No real settings, probe or LLM are used.
test('write-back uses only this run’s independently confirmed, finally winning route fields', async t => {
  const learned = storeFor(t)
  const fresh = 'vendor/fresh', manual = 'vendor/manual', official = 'z-ai/glm-5.3', onlyCtx = 'vendor/ctx', observed = 'vendor/observed'
  const unique = 'vendor/unique'
  const ids = [fresh, manual, official, onlyCtx, observed, unique]
  for (const id of ids) learned.upsertEntries({ id, input: ['text'], contextWindow: 4096, origins: ['checker'] }, { verifiedAt: 5 })
  const providers = Object.fromEntries(['relay', 'other'].map(route => [route, { models: ids
    .filter(id => route === 'relay' || id !== unique).map(id => ({ id, input: route === 'other' && id === fresh ? ['text'] : [] })) }]))
  const settings = { describe: () => [{ ns: 'llm-pi-ai', revision: 14, value: { providers } }],
    mutate: async (_ns, ops, revision) => {
      assert.equal(revision, 14)
      for (const { path: [, route, , index, field], value } of ops) providers[route].models[Number(index)][field] = value
    },
  }
  const configEditor = { configuration: () => [{ entry: { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers } } }, override: { providers } }] }
  const llm = { listProviders: () => Object.keys(providers).map(id => ({ id })),
    listConfigurableProviders: () => Object.keys(providers).map(provider => ({ provider, declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })),
    listModels: async route => providers[route].models, resolveModelInfo: async (provider, id) => ({ provider, id }),
    prepareCall: async config => ({ config, async *stream() {
      yield { type: 'text-delta', text: JSON.stringify(ids.map(id => ({ id, ...(id === observed ? { input: ['image'] } : {}) }))) }
    } }),
  }
  const overrides = { get: (route, id) => route === 'relay' && id === manual ? { input: ['text'], contextWindow: 33 } : undefined }
  const discovered = new Map([['relay', new Map([[observed, { id: observed, inputModalities: ['text'] }]])]])
  const service = createModelInfoService(llm, { settings, configEditor, learned, overrides, context: () => ({ learned, overrides, discovered,
    profiles: readProviderProfiles(settings.describe(), { llm, configEditor }) }) })
  const free = Object.fromEntries(ids.filter(id => id !== observed).map(id => [id, {
    limit: { context: 128000 }, ...(id !== onlyCtx ? { modalities: { input: ['text', 'image'] } } : {}),
  }]))
  const verifier = createCapabilityVerifier({ llm, settings, configEditor, learned, logger: quiet,
    automaticWriteFact: service.automaticWriteFact, fetch: catalogs({ free }) })
  const state = await verifier.start({ checker, fullScan: true, writeBack: true })
  assert.equal(state.done, ids.length)
  assert.equal(state.publicReliable, 5)
  assert.deepEqual(providers.relay.models.map(({ id, input, contextWindow }) => [id, input, contextWindow]), [
    [fresh, [], undefined], [manual, [], undefined], [official, [], undefined], [onlyCtx, [], undefined], [observed, [], undefined],
    [unique, ['text', 'image'], 128000],
  ])
  assert.deepEqual(providers.other.models.map(({ id, input, contextWindow }) => [id, input, contextWindow]), [
    [fresh, ['text'], undefined], [manual, [], undefined], [official, [], undefined], [onlyCtx, [], undefined], [observed, [], undefined],
  ])
  assert.deepEqual(state.batches.flatMap(batch => batch.written ?? []), [`relay/${unique}`])
  assert.equal(learned.getExact(fresh).publicFacts.contextWindow, 128000)
  assert.equal(learned.getExact(onlyCtx).publicFacts.input, undefined, 'old checker input is not re-verified on a catalog context-only match')
  assert.equal(learned.getExact(observed).publicFacts, undefined)
})

test('the write arbiter uses explicitly scoped learned facts only on the owning route', async t => {
  const learned = storeFor(t), id = 'vendor/scoped'
  const profiles = new Map(['relay', 'other'].map(provider => [provider, { id: provider, catalogModels: false, models: new Map([[id, { id }]]) }]))
  const llm = { resolveModelInfo: async (provider, id) => ({ provider, id }) }
  const service = createModelInfoService(llm, { learned, context: { profiles, learned } })
  const facts = { input: ['text', 'image'], contextWindow: 16000 }
  learned.upsertEntries({ id, provider: 'other', origins: ['checker'], ...facts })
  assert.deepEqual(await service.automaticWriteFact('other', id, facts), facts)
  assert.equal(await service.automaticWriteFact('relay', id, facts), null)
  await service.dispose()
})

test('write-back cannot reuse its listing when a custom route adds the same ID during resolution', async t => {
  const learned = storeFor(t), id = 'vendor/model'
  const providers = { relay: { models: [{ id, input: [] }] }, other: { models: [{ id: 'other-model', input: [] }] } }
  let mutations = 0, resolutions = 0
  const settings = { describe: () => [{ ns: 'llm-pi-ai', revision: 14, value: { providers } }],
    mutate: () => { mutations++ } }
  const configEditor = { configuration: () => [{ entry: { options: { id: 'llm-pi-ai', config: { providers } } }, override: { providers } }] }
  const llm = { listProviders: () => Object.keys(providers).map(id => ({ id })),
    listConfigurableProviders: () => Object.keys(providers).map(provider => ({ provider, declared: true, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider] })),
    listModels: async route => providers[route].models,
    resolveModelInfo: async (provider, model) => {
      resolutions++
      providers.other.models.push({ id, input: [] })
      return { provider, id: model }
    },
    prepareCall: async config => ({ config, async *stream() {
      yield { type: 'text-delta', text: JSON.stringify([{ id, input: ['text', 'image'], contextWindow: 16000 }, { id: 'other-model' }]) }
    } }),
  }
  // Keep the service context stale to exercise the verifier's separate dispatch guard.
  const profiles = readProviderProfiles(settings.describe(), { llm, configEditor })
  const service = createModelInfoService(llm, { settings, configEditor, learned, context: { profiles, learned } })
  const verifier = createCapabilityVerifier({ llm, settings, configEditor, learned, logger: quiet,
    automaticWriteFact: service.automaticWriteFact, fetch: catalogs() })
  const state = await verifier.start({ checker, fullScan: true, writeBack: true })
  assert.equal(state.done, 1)
  assert.equal(learned.getExact(id).contextWindow, 16000, 'the unscoped fact remains advisory')
  assert.deepEqual([resolutions, mutations], [1, 0])
  assert.ok(state.batches.every(batch => batch.written === undefined))
  assert.deepEqual(providers.relay.models, [{ id, input: [] }])
  await service.dispose()
})

test('unknown file formats, invalid JSON and stat failures keep last-good reads, and all writer entry points fail closed', async t => {
  const store = storeFor(t), id = 'model', row = { id, contextWindow: 2048, publicAlias: true, origins: ['public'] }
  store.upsertEntries(row)
  const good = fs.readFileSync(store.file, 'utf8')
  const model = store.getExact(id)
  for (const bytes of ['{', 'null', '[]', '{"version":3,"models":{}}', '{"models":{}}', '{"version":2,"models":[]}', '{"version":2,"records":{}}']) {
    fs.writeFileSync(store.file, bytes)
    store.invalidate()
    assert.deepEqual(store.getExact(id), model)
    assert.match(store.meta().readError, /^LEARNED_(FORMAT|UNREADABLE)$/)
    assert.throws(() => store.assertReadable(), /refusing to overwrite/)
    assert.throws(() => store.dropPublicAliases(), /refusing to overwrite/)
    assert.throws(() => store.upsertEntries({ id: 'other', type: 'chat' }), /refusing to overwrite/)
    assert.equal(fs.readFileSync(store.file, 'utf8'), bytes)
    const cold = createLearnedCatalog({ file: store.file, logger: quiet })
    assert.equal(cold.meta().models, 0)
    assert.throws(() => cold.upsertEntries(row), /refusing to overwrite/)
  }
  const noWork = () => assert.fail('reject before listing, downloading, spending or mutating')
  const verifier = createCapabilityVerifier({ llm: { listProviders: noWork, prepareCall: noWork }, learned: store, logger: quiet, fetch: noWork })
  assert.equal((await verifier.start({ mode: 'checker', checker })).phase, 'error')
  fs.writeFileSync(store.file, good)
  store.assertReadable()
  assert.equal(store.meta().readError, undefined)
  const stat = fs.statSync
  const stub = t.mock.method(fs, 'statSync', (file, ...rest) => {
    if (file === store.file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return stat(file, ...rest)
  })
  assert.deepEqual(store.getExact(id), model)
  assert.throws(() => store.upsertEntries({ id: 'x', type: 'video' }), { code: 'LEARNED_UNREADABLE' })
  stub.mock.restore()
  withStoreLock(store.file, () => {
    assert.throws(() => store.upsertEntries({ id: 'x', type: 'chat' }), { code: 'STORE_BUSY' })
    assert.throws(() => store.dropPublicAliases(), { code: 'STORE_BUSY' })
  })
  assert.equal(fs.readFileSync(store.file, 'utf8'), good)
  fs.unlinkSync(store.file)
  assert.equal(store.getExact(id), undefined, 'real ENOENT intentionally resets the old view')
  store.upsertEntries({ id: 'new', type: 'audio' })
  assert.deepEqual(store.list().map(row => row.id), ['new'])
})

test('each sweep owns its UUID, listing slots, and single nonblocking post-commit notification', { timeout: 2500 }, async () => {
  const entered = Promise.withResolvers(), gate = Promise.withResolvers(), hook = Promise.withResolvers()
  const hooks = [], trace = [], pending = new Set(), publicData = { 'vendor/a': { reasoning: false } }
  let stall = true, peak = 0
  const verifier = createCapabilityVerifier({ learned: stubLearned(), logger: quiet, listConcurrency: 2, listTimeoutMs: 60,
    llm: { listProviders: () => ['stuck', 'early', 'late', 'empty'].map(id => ({ id })),
      listModels: async id => {
        assert.ok(!pending.has(id), 'never double-dispatch an uncancellable listing')
        pending.add(id); peak = Math.max(peak, pending.size)
        try {
          if (id === 'stuck' && stall) { entered.resolve(); await gate.promise }
          return id === 'early' ? [{ id: 'vendor/a' }] : id === 'late' ? [{ id: 'vendor/a:free' }] : []
        } finally { pending.delete(id) }
      }, prepareCall: () => assert.fail('no checker'),
    }, fetch: catalogs({ free: publicData }), trace: (module, step, data) => trace.push({ module, step, data }),
    onLearned: event => { hooks.push(event); return hook.promise },
  })
  const first = verifier.start({ mode: 'public' })
  const old = verifier.snapshot().runId
  await entered.promise
  assert.deepEqual(verifier.cancel(old), { cancelled: true, reason: 'cancelled', runId: old })
  assert.equal((await first).phase, 'cancelled')
  const second = verifier.start({ mode: 'public' })
  const active = verifier.snapshot().runId
  assert.notEqual(active, old)
  assert.deepEqual(verifier.cancel(old), { cancelled: false, reason: 'stale-run', runId: active })
  const state = await second
  assert.match(state.errors.join(), /route stuck: listing capacity held/)
  // An uncancellable old listing cannot be adopted by the new run after a route swap.
  assert.deepEqual([state.done, state.aliasMatches, state.publicReliable, state.runId], [2, 1, 1, active])
  assert.equal(peak, 2)
  assert.deepEqual(hooks, [{ runId: active, mode: 'public', startedAt: state.startedAt, count: 1, ids: ['vendor/a'], effortIds: [] }])
  assert.deepEqual(verifier.cancel(active), { cancelled: false, reason: 'not-running', runId: active })
  assert.ok(trace.some(e => e.step === 'list' && e.data.status === 'busy'))
  assert.ok(trace.some(e => e.step === 'commit' && e.data.count > 0))
  assert.ok(trace.every(e => e.module === 'verify' && [old, active].includes(e.data.runId)))
  assert.doesNotMatch(JSON.stringify(trace), /https?:\/\/|systemPrompt|wireValue|apiKey/i)
  stall = false; gate.resolve(); hook.resolve(); await verifier.dispose()
})

test('a fresh hung listing really times out, without delaying one healthy route behind every other adapter', { timeout: 2500 }, async () => {
  const releases = [], events = [], names = ['stalled', 'healthy-1', 'healthy-2', 'healthy-3']
  const reply = Promise.withResolvers()
  const v = createCapabilityVerifier({ learned: stubLearned(), logger: quiet, listConcurrency: 2, listTimeoutMs: 50,
    llm: { listProviders: () => names.map(id => ({ id })), listModels: async provider => {
      if (provider === 'stalled') await reply.promise
      else releases.push(provider)
      return [{ id: provider }]
    } }, fetch: catalogs(), trace: (_module, step, data) => { if (step === 'list') events.push(data) },
  })
  const state = await v.start({ mode: 'public' })
  assert.equal(state.phase, 'done')
  assert.match(state.errors.join(), /list models stalled timed out/)
  assert.deepEqual(releases, names.slice(1))
  assert.equal(events.at(-1).status, 'timeout')
  assert.equal(state.catalogTargets, 3)
  reply.resolve(); await v.dispose()
})

test('v2 opaque rows/known row extensions survive unrelated writes and a colliding update is refused byte-for-byte', t => {
  const store = storeFor(t), opaque = { id: 'future-id', tokenAccountingV3: { rules: [42] } }
  const initial = { version: 2, futureHeader: { color: 0 }, models: {
    oldStorageKey: { id: 'known', input: ['text'], origins: ['checker'], extra: { nested: ['untouched'] } }, anotherKey: opaque,
  } }
  fs.writeFileSync(store.file, JSON.stringify(initial))
  store.upsertEntries({ id: 'known', contextWindow: 23, origins: ['checker'] })
  const after = JSON.parse(fs.readFileSync(store.file, 'utf8'))
  assert.deepEqual(after.futureHeader, initial.futureHeader)
  assert.equal(after.models.oldStorageKey.contextWindow, 23)
  assert.deepEqual(after.models.oldStorageKey.extra, initial.models.oldStorageKey.extra)
  assert.equal(after.models.known, undefined)
  assert.deepEqual(after.models.anotherKey, opaque)
  assert.equal(store.getExact(opaque.id), undefined, 'preservation does not turn opaque rows into capability evidence')
  const good = fs.readFileSync(store.file)
  for (const id of ['anotherKey', opaque.id, 'oldStorageKey']) {
    assert.throws(() => store.upsertEntries({ id, input: ['image'] }), { code: 'LEARNED_FORMAT' })
    assert.deepEqual(fs.readFileSync(store.file), good)
  }
})

test('a partial refresh notifies about exact submitted models but never offers an old unrelated ladder to bulk', async t => {
  const store = storeFor(t), old = 'vendor/old', exact = 'vendor/new', alias = 'vendor/new:free', events = []
  store.upsertEntries({ id: old, reasoningEfforts: ['low'], origins: ['checker'], evidence: [{ url: 'https://example.org/spec', fields: ['reasoningEfforts'] }] })
  const v = createCapabilityVerifier({ learned: store, logger: quiet,
    llm: { listProviders: () => [{ id: 'r' }], listModels: () => [old, exact, alias].map(id => ({ id })), prepareCall: () => assert.fail('no paid checker') },
    fetch: catalogs({ free: { [old]: { limit: { context: 9000 } }, [exact]: { reasoningEfforts: ['medium'] } } }),
    onLearned: event => events.push(event),
  })
  const state = await v.start({ mode: 'supplement', checker })
  assert.equal(state.publicReliable, 2)
  assert.equal(state.aliasMatches, 1)
  assert.deepEqual(events[0].ids, [old, exact])
  assert.deepEqual(events[0].effortIds, [exact])
  assert.equal(store.getExact(old).publicFacts.reasoningEfforts, undefined)
})

test('a source failure counts catalogs, never models, and a failed flush cannot notify the bulk writer', async () => {
  let notified = 0
  const v = createCapabilityVerifier({ llm: { listProviders: () => [{ id: 'r' }], listModels: async () => [{ id: 'a' }] },
    learned: { upsertEntries() { throw new Error('disk full') }, meta() {} }, logger: quiet, huggingFaceHosts: ['https://test.example'],
    fetch: async url => new Response(url === urls.modelsDevModels ? '{"a":{"reasoning":true}}' : 'unparseable'), onLearned: () => notified++,
  })
  const result = await v.start({ mode: 'public' })
  assert.deepEqual([result.phase, result.catalogMatches, result.sourceFailures, result.publicReliable, result.done, notified], ['error', 1, 3, 0, 0, 0])
})

test('catalog refresh preserves field times, publishers, manual priority and genuine checker citations without contaminating public facts', t => {
  const store = storeFor(t), id = 'v/m', origins = ['public'], revision = PUBLIC_CATALOG_REVISION
  const up = (fields, verifiedAt) => store.upsertEntries({ id, ...fields, origins, publicCatalogRevision: revision,
    publicFacts: { ...fields, publicLookupId: id } }, { verifiedAt })
  store.upsertEntries({ id, input: ['text'], origins: ['manual'] }, { verifiedAt: 1 })
  up({ contextWindow: 300, reasoningEfforts: ['low', 'high'], defaultEffort: 'high', reasoningCatalog: 'OpenRouter',
    fieldSources: { contextWindow: 'models.dev/api.json', reasoningEfforts: 'OpenRouter' } }, 3)
  up({ input: ['image'], fieldSources: { input: 'Hugging Face' } }, 5)
  // An older arrival may fill an unknown field, not overwrite a newer one.
  up({ maxTokens: 80, contextWindow: 200 }, 2)
  store.upsertEntries({ id, reasoningEfforts: ['medium'], evidence: [{ url: 'https://example.org/spec', fields: ['reasoningEfforts'] }], origins: ['checker'] }, { verifiedAt: 6 })
  const row = createLearnedCatalog({ file: store.file }).getExact(id)
  assert.equal(row.reasoningCatalog, undefined, 'the checker ladder cannot inherit an old public publisher')
  assert.equal(row.publicFacts.reasoningCatalog, 'OpenRouter')
  assert.deepEqual(row.publicFacts.reasoningEfforts.map(level => level.id), ['low', 'high'])
  assert.equal(row.publicFacts.contextWindow, 300)
  assert.deepEqual(row.publicFacts.fieldVerifiedAt, { input: 5, contextWindow: 3, maxTokens: 2, reasoning: 3, reasoningEfforts: 3, defaultEffort: 3 })
  assert.deepEqual(row.publicFacts.fieldSources, { input: 'Hugging Face', contextWindow: 'models.dev/api.json', reasoningEfforts: 'OpenRouter' })
  assert.deepEqual(row.evidence, [{ url: 'https://example.org/spec', fields: ['reasoningEfforts'] }])
  assert.deepEqual(row.manualFields, ['input'])
  const merged = mergeCapabilities({ id, name: id }, { learned: row })
  assert.deepEqual([merged.sources.modalities, merged.inputModalities], ['manual', ['text']])
  up({ reasoning: false }, 7)
  assert.equal(store.getExact(id).publicFacts.reasoningEfforts, undefined, 'an explicit negative drops the old public ladder')
  up({ reasoningEfforts: ['max'] }, 4)
  assert.equal(store.getExact(id).publicFacts.reasoningEfforts, undefined, 'late evidence cannot resurrect disabled levels')
})
