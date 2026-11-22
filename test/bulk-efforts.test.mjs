import test from 'node:test'
import assert from 'node:assert/strict'
import { createBulkEffortService } from '../lib/bulk-efforts.js'

// Entire settings/adapter/config/learned fixture is in memory. Business and
// discovery APIs deliberately throw if the planner touches them.
const pub = (id, efforts = ['low','high'], time = 10) => ({ id, type: 'chat', origins: ['public'], publicFacts: {
  publicLookupId: id, reasoning: true, verifiedAt: time, fieldVerifiedAt: { reasoningEfforts: time }, reasoningCatalog: 'models.dev',
  fieldSources: { reasoningEfforts: 'models.dev/models.json' }, reasoningEfforts: efforts.map(id => ({ id })) } })
const route = (...ids) => ({ baseURL: 'https://gateway.invalid/v1', api: 'openai-completions', headers: { guard: 'private-marker' },
  models: ids.map(id => ({ id })) })
const fixture = (providers = { relay: route('one','two') }) => {
  const doc = { providers }, ns = 'include:llm-pi-ai', calls = []
  const facts = new Map(), manual = new Map(), applied = [], trace = [], cache = []
  const state = { rev: 7, now: 100, doc, calls, facts, manual, providers, applied, trace, cache }
  const editor = { configuration: () => [{ entry: { options: { id: ns, name: '@deepseek-ai/dsh-llm-pi-ai', config: state.raw ?? doc } },
    override: state.persisted ?? state.raw ?? doc, inherited: {} }] }
  const settings = { describe({ redactSecrets }) { assert.equal(redactSecrets, true); return [{ ns, value: doc, revision: state.rev }] },
    async mutate(targetNs, ops, revision) {
      assert.equal(targetNs, ns); calls.push({ ops: structuredClone(ops), revision })
      await state.onMutate?.()
      if (revision !== state.rev) throw Error('conflict (fixture details not for receipts)')
      if (state.noWrite) return
      for (const { op, path, value } of ops) {
        assert.equal(op, 'set'); let cursor = doc
        for (const p of path.slice(0,-1)) cursor = (cursor[p] ??= {})
        cursor[path.at(-1)] = structuredClone(value)
      }
      state.rev++
    } }
  const active = (provider, get = () => providers[provider]) => ({ current: () => state.rev,
    profileOf: () => ({ ...get(), provider }), modelOf: (_, p, id) => {
      const model = get().models.find(row => row.id === id)
      if (!model || provider !== p) throw Error('unknown')
      return { provider, id, name: model.name ?? id, api: get().api, baseUrl: get().baseURL }
    } })
  const adapters = new Map(Object.keys(providers).map(id => [id, { adapter: active(id) }]))
  const mustNotCall = () => { throw Error('discovery/inference was not authorized') }
  const llm = { adapters,
    listConfigurableProviders: () => state.directory ?? Object.keys(providers).map(provider => ({ provider, settingsNs: ns, declared: true, settingsPath: ['providers', provider] })),
    resolveModelInfo: mustNotCall, listModels: mustNotCall, discoverModels: mustNotCall, stream: mustNotCall }
  const bulk = createBulkEffortService({ settings, configEditor: editor, llm, now: () => state.now, ticketTtlMs: 500,
    learned: { getExact: id => facts.get(id), get: mustNotCall, assertReadable() { if (state.brokenLearned) throw Error('unreadable') } },
    overrides: { read() { if (state.brokenOverrides) throw Error('unreadable'); return { overrides: [...manual.values()] } }, upsert: mustNotCall },
    readCatalog: () => ({ groups: cache }), onApplied: (provider, model) => applied.push([provider, model]), trace: (...args) => trace.push(args) })
  return Object.assign(state, { bulk, adapters, llm, active })
}
const select = (value, model, provider = 'relay') => value.rows.find(row => row.provider === provider && row.model === model)

test('preview is read-only, all confirmed IDs are reviewable, verified writes are additive and sequential on a shared revision', async () => {
  const f = fixture(); f.facts.set('one', pub('one', ['off','low','high','custom'])); f.facts.set('two', pub('two',['minimal']))
  const model = f.providers.relay.models[0]; model.reasoningEfforts = { off:null, low:'vendor-low', medium:'mid' }; model.compat = { supportsStore:false }
  assert.throws(() => f.bulk.enable({}), { code:'bulk-efforts/ticket-invalid' })
  const preview = await f.bulk.preview(); assert.equal(preview.scopeCount,2); assert.equal(preview.eligible,2); assert.equal(preview.total,2)
  assert.deepEqual(select(preview,'one').additions,['high']); assert.deepEqual(select(preview,'one').unresolvedEfforts,['custom'])
  assert.equal(select(preview,'one').source,'models.dev/models.json'); assert.equal(f.calls.length,0)
  assert.deepEqual(f.bulk.inspect().rows,[]); assert.equal(f.bulk.inspect().ticket,undefined)
  assert.doesNotMatch(JSON.stringify(preview),/private-marker|gateway.invalid|vendor-low|apiKey|__jsExpr/)
  const status = f.bulk.enable({ ticket: preview.ticket }); assert.equal(status.running,true); assert.equal(status.counts.pending,2)
  assert.throws(() => f.bulk.enable({ ticket:preview.ticket }), { code:'bulk-efforts/busy' })
  const result = await f.bulk.whenSettled(); assert.deepEqual(result.counts,{ pending:0,written:2,skipped:0,failed:0 })
  assert.deepEqual(f.calls.map(c => c.revision),[7,8]); assert.equal(select(result,'one').reason,'partial')
  assert.deepEqual(model.reasoningEfforts,{ off:null,low:'vendor-low',medium:'mid',high:'high' }); assert.deepEqual(model.compat,{supportsStore:false,thinkingFormat:'openai',supportsReasoningEffort:true})
  assert.deepEqual(f.applied,[['relay','one'],['relay','two']]); f.bulk.reconcile(); await f.bulk.whenSettled(); assert.equal(f.calls.length,2)
  const last = f.bulk.disable(); const again = await f.bulk.preview(); assert.equal(again.eligible,0); assert.deepEqual(f.bulk.inspect(),last,'review is not a new receipt'); f.bulk.dispose()
})

test('ticket expiry, stolen/overwritten review, ledger read failure and stale consent never dispatch any edit', () => {
  const f = fixture(); f.facts.set('one', pub('one'))
  const old = f.bulk.preview(); const next = f.bulk.preview(); assert.notEqual(old.ticket,next.ticket)
  assert.throws(() => f.bulk.enable({ticket:old.ticket}),{code:'bulk-efforts/ticket-invalid'})
  f.now+=501; assert.throws(() => f.bulk.enable({ticket:next.ticket}),{code:'bulk-efforts/ticket-expired'})
  for (const act of [() => f.rev++, () => { f.facts.set('one', pub('one',['minimal'])) }, () => { f.providers.relay.baseURL += '/moved' },
    () => { f.adapters.set('relay', { adapter: f.active('relay') }) }, () => { f.providers.relay.models.reverse() },
    () => { f.manual.set('one',{provider:'relay',model:'one',reasoningSupported:false}) }]) {
    const preview = f.bulk.preview(); act(); assert.throws(() => f.bulk.enable({ticket:preview.ticket}),{code:'bulk-efforts/preview-stale'})
    assert.equal(f.bulk.inspect().enabled,false)
  }
  const preview = f.bulk.preview(); f.brokenLearned=true
  assert.throws(() => f.bulk.enable({ticket:preview.ticket}),{code:'bulk-efforts/read-unavailable'})
  f.brokenLearned=false; f.brokenOverrides=true; assert.throws(() => f.bulk.preview(),{code:'bulk-efforts/read-unavailable'}); assert.equal(f.calls.length,0)
})

test('only currently owned, unique, writable chat records and reliable exact reference fields qualify', async () => {
  const f = fixture({relay:route('pinned','mismatch','dup','dup','disabled','manual','expression','drift','ambiguous','chat-image','alias','mixed','cited','uncited','waiting','learned-manual'),
    other:{...route('mismatch'),api:'anthropic-messages'}, native:route('native-id'), foreign:route('other-id')})
  const { relay } = f.providers; relay.models.find(m=>m.id==='disabled').reasoningEfforts=false
  f.raw=structuredClone(f.doc); f.raw.providers.relay.models.find(m=>m.id==='expression').reasoningEfforts={__jsExpr:'inert'}
  f.raw.providers.relay.models.find(m=>m.id==='drift').id='swapped'
  f.cache.push({ id:'relay', models:[{id:'ambiguous',kind:'chat'}, {id:'ambiguous',kind:'chat'}] })
  f.manual.set('manual',{provider:'relay',model:'manual',efforts:[{id:'high'}]})
  f.facts.set('pinned',pub('pinned')); f.facts.set('mismatch',{...pub('mismatch'),provider:'other'})
  f.facts.set('alias',{...pub('alias'),publicAlias:true}); f.facts.set('mixed',{id:'mixed',origins:['public','checker'],publicLookupId:'mixed',reasoningCatalog:'models.dev',reasoningEfforts:['high']})
  f.facts.set('uncited',{id:'uncited',origins:['checker'],reasoningEfforts:['high'],evidence:[{url:'https://docs.invalid/x',fields:['reasoning']}]})
  f.facts.set('cited',{id:'cited',origins:['checker'],reasoning:true,reasoningEfforts:['max'],verifiedAt:18,evidence:[{url:'https://docs.invalid/x',fields:['reasoningEfforts']}]})
  f.facts.set('learned-manual',{...pub('learned-manual'),origins:['manual','public'],manualFields:['reasoningEfforts']})
  f.directory=f.llm.listConfigurableProviders().map(row => ({...row, declared:row.provider!=='native'})); f.adapters.delete('foreign')
  const preview=f.bulk.preview(); assert.equal(preview.eligible,2)
  const reasons={ mismatch:'reference-mismatch',dup:'model-ambiguous',disabled:'reasoning-disabled',manual:'manual-protected',expression:'expression-backed',drift:'config-provenance-unavailable',ambiguous:'model-ambiguous','chat-image':'non-chat',alias:'reference-alias',mixed:'awaiting-evidence',uncited:'awaiting-evidence',waiting:'awaiting-evidence','learned-manual':'manual-protected' }
  for (const [id,reason] of Object.entries(reasons)) assert.equal(select(preview,id).reason,reason,id)
  assert.equal(select(preview,'mismatch','other').reason,'protocol-unmapped'); assert.equal(select(preview,'native-id','native').reason,'native-catalog')
  assert.equal(select(preview,'other-id','foreign').reason,'provider-unverified'); assert.equal(select(preview,'cited').source,'checker')
  assert.equal(select(preview,'waiting').authorized,true); assert.equal(select(preview,'alias').authorized,false); assert.equal(f.calls.length,0)
})

test('an unscoped checker row cannot be applied across identically named deployments; scoped or independent public values can', async () => {
  const f = fixture({relay:route('shared'),second:route('shared')})
  const check = {id:'shared',origins:['checker'],reasoningEfforts:['high'],evidence:[{url:'https://docs.invalid/test',fields:['reasoningEfforts']}]}
  f.facts.set('shared',check)
  const ambiguous=f.bulk.preview(); assert.equal(ambiguous.eligible,0); assert.ok(ambiguous.rows.every(row=>row.reason==='reference-mismatch'))
  check.provider='second'; assert.equal(f.bulk.preview().eligible,1)
  f.facts.set('shared',pub('shared',['high'])); assert.equal(f.bulk.preview().eligible,2); assert.equal(f.calls.length,0)
})

test('field-specific public evidence outranks stale checker metadata but never an actual manual disable', async () => {
  const f = fixture(); const row = pub('one',['high'],30)
  row.origins = ['checker','public']; row.type = 'image'; row.reasoning = false; row.publicFacts.type = 'chat'
  f.facts.set('one',row); f.facts.set('two',{...row,id:'two',publicFacts:{...row.publicFacts,publicLookupId:'two'}})
  f.manual.set('two',{provider:'relay',model:'two',reasoningSupported:false})
  const preview = f.bulk.preview()
  assert.equal(select(preview,'one').reason,'ready'); assert.equal(select(preview,'two').reason,'manual-protected')
  const { ticket } = preview; f.bulk.enable({ticket}); await f.bulk.whenSettled(); assert.equal(f.calls.length,1)
})

test('per-field timestamp, not an unrelated public refresh timestamp, gates newly learned efforts', async () => {
  const f = fixture({relay:route('one')}); f.bulk.enable({ticket:f.bulk.preview().ticket})
  const row = pub('one',['low'],10); row.publicFacts.verifiedAt=50; f.facts.set('one',row)
  f.bulk.reconcile({modelIds:['one'],startedAt:40}); await f.bulk.whenSettled(); assert.equal(f.calls.length,0)
  row.publicFacts.fieldVerifiedAt.reasoningEfforts=50; f.bulk.reconcile({modelIds:['one'],startedAt:40}); await f.bulk.whenSettled(); assert.equal(f.calls.length,1)
})

test('turning off during an accepted mutate leaves it pending, cannot start a second run, and stops every later dispatch', async () => {
  const f=fixture(); for (const id of ['one','two']) f.facts.set(id,pub(id))
  const gate=Promise.withResolvers(), sent=Promise.withResolvers(); f.onMutate=() => { sent.resolve(); return gate.promise }
  f.bulk.enable({ticket:f.bulk.preview().ticket}); await sent.promise
  const disabled=f.bulk.disable(); assert.equal(disabled.enabled,false); assert.equal(disabled.running,true)
  assert.equal(select(disabled,'one').reason,'dispatched'); assert.equal(select(disabled,'two').reason,'disabled'); assert.equal(f.calls.length,1)
  assert.throws(()=>f.bulk.preview(),{code:'bulk-efforts/busy'}); gate.resolve()
  const end=await f.bulk.whenSettled(); assert.equal(select(end,'one').status,'written'); assert.equal(select(end,'two').status,'skipped'); assert.equal(f.calls.length,1)
  const preview=f.bulk.preview(); f.bulk.dispose(); assert.throws(()=>f.bulk.enable({ticket:preview.ticket}),{code:'bulk-efforts/disposed'})
})

test('reconcile requires an explicitly verified in-scope model and a current ladder; new routes and scope drift are not authorized', async () => {
  const f=fixture({relay:route('one','two','three')}); f.facts.set('one',pub('one',['low']))
  let state=f.bulk.enable({ticket:f.bulk.preview().ticket}); assert.equal(state.scopeCount,3); await f.bulk.whenSettled()
  f.providers.relay.models.push({id:'added'}); f.rev++; f.facts.set('added',pub('added',['max'],30)); f.facts.set('two',pub('two',['low','high'],30))
  f.bulk.reconcile(); await f.bulk.whenSettled(); assert.equal(f.calls.length,1)
  f.bulk.reconcile({modelIds:['added','two'],startedAt:31}); await f.bulk.whenSettled(); assert.equal(f.calls.length,1)
  f.bulk.reconcile({modelIds:['added','two'],startedAt:29}); state=await f.bulk.whenSettled()
  assert.equal(f.calls.length,2); assert.equal(select(state,'two').status,'written'); assert.equal(select(state,'added'),undefined)
  f.bulk.reconcile({modelIds:['two'],startedAt:29}); await f.bulk.whenSettled(); assert.equal(f.calls.length,2)
  // Editing the endpoint with the same adapter/row invalidates further grants.
  f.providers.relay.baseURL='https://changed.invalid'; f.rev++; f.facts.set('three',pub('three',['max'],40));
  const changed=f.bulk.reconcile({modelIds:['three'],startedAt:39}); assert.equal(select(changed,'three').reason,'target-changed'); assert.equal(f.calls.length,2)
  for (const name of ['one','two']) {
    const old = select(changed,name)
    assert.equal(old.status,'written'); assert.equal(old.reason,'verified'); assert.equal(old.authorized,false)
    assert.equal(old.authorizationReason,'target-changed'); assert.ok(old.writtenEfforts.length)
  }
})

test('a fulfilled but unapplied/reordered/concurrently edited mutation is never a verified success; untrusted messages do not leak', async () => {
  for (const mode of ['noop','reordered','rev-conflict']) {
    const f=fixture({relay:route('one','two')}); f.facts.set('one',pub('one')); f.facts.set('two',pub('two'))
    f.onMutate=() => { if (mode==='noop') f.noWrite=true; if (mode==='reordered') { f.providers.relay.models.reverse(); f.noWrite=true }; if(mode==='rev-conflict') f.rev++ }
    f.bulk.enable({ticket:f.bulk.preview().ticket}); const end=await f.bulk.whenSettled(); assert.equal(end.counts.written,0)
    assert.equal(select(end,'one').status,'failed'); assert.equal(select(end,'one').outcomeUnknown,true)
    assert.equal(select(end,'one').dispatched,true); assert.ok(end.unverified >= 1)
    assert.doesNotMatch(JSON.stringify(end),/fixture details|private-marker/)
    f.bulk.disable(); const again = f.bulk.preview()
    assert.equal(select(again,'one').authorized,false); assert.equal(select(again,'one').reason,'prior-write-unverified')
  }
})
