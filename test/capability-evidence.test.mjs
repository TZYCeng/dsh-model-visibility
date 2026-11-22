import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelInfoService, imageInputDecision, mergeCapabilities, selectAutomaticWriteFact } from '../lib/model-info.js'
import { referenceLadder } from '../lib/evidence-policy.js'

const id = 'vendor/fixture'
const base = { id, name: 'Fixture' }
const levels = (...ids) => ids.map(id => ({ id, name: id.toUpperCase() }))
const exactDocs = {
  publicLookupId: id, type: 'chat', input: ['text'], output: ['text'], contextWindow: 64000, maxTokens: 8192,
  reasoning: true, reasoningEfforts: levels('low', 'high'), reasoningCatalog: 'models.dev', defaultEffort: 'high',
  verifiedAt: 17, fieldSources: { type: 'Hugging Face', input: 'models.dev/models.json', contextWindow: 'OpenRouter', reasoningEfforts: 'models.dev/api.json' },
}
const learned = {
  id, origins: ['checker', 'public'], type: 'image', input: ['text', 'image'], output: ['image'], contextWindow: 100000, maxTokens: 16384,
  reasoning: true, reasoningEfforts: levels('max'), defaultEffort: 'max', verifiedAt: 19, publicFacts: exactDocs,
  evidence: [{ url: 'https://doc.example/checker', fields: ['input', 'maxTokens'] }],
}
const discovered = { id, kind: 'image', inputModalities: ['text', 'image'], outputModalities: ['image'], contextWindow: 99000, maxTokens: 9999, reasoning: false }
const profile = { id: 'relay', catalogModels: false, catalogProvider: false, baseURL: 'https://fixture.invalid/v1', defaultInput: ['text'], models: new Map([[id, { id }]]) }

// A public reference, a checker and the relay all disagree; the adapter's
// actual usable effort is yet another set. Check all fields, not just a footer.
test('independent exact documentation wins field by field without becoming a request ladder or a measured field', () => {
  const row = mergeCapabilities(base, { profile, discovered, learned, adapter: { reasoning: { efforts: levels('balanced') } } })
  assert.deepEqual([row.kind, row.inputModalities, row.outputModalities, row.contextWindow, row.defaultMaxTokens], ['chat', ['text'], ['text'], 64000, 8192])
  assert.deepEqual(row.requestReasoning.efforts, levels('balanced'))
  assert.deepEqual(row.reasoning.efforts, levels('balanced'))
  assert.deepEqual(row.referenceReasoning, { efforts: levels('low', 'high'), defaultEffort: 'high' })
  for (const key of ['kind', 'modalities', 'output', 'context', 'maxTokens', 'referenceReasoning']) assert.equal(row.sources[key], 'public', key)
  assert.deepEqual(row.fieldEvidence.modalities, { source: 'public', lookupId: id, catalog: 'models.dev/models.json', urls: ['https://models.dev/models.json'], verifiedAt: 17 })
  assert.equal(row.fieldEvidence.referenceReasoning.catalog, 'models.dev/api.json')
  assert.equal(row.fieldEvidence.referenceReasoning.alias, undefined)
  assert.equal(JSON.stringify(row.fieldEvidence).includes('doc.example/checker'), false)
  assert.equal(row.sources.reasoning, 'adapter')
  assert.deepEqual(selectAutomaticWriteFact(row, { input: ['text'], contextWindow: 100000, efforts: ['max'] }), { input: ['text'] })
  assert.equal(selectAutomaticWriteFact(row, { input: ['text', 'image'] }), null)
  assert.equal(imageInputDecision('relay', id, { profile, discovered, learned }).allowed, false)
})

test('a verified checker fills only genuinely missing fields and keeps only that field’s links', () => {
  const row = mergeCapabilities(base, { profile, learned: { ...learned, publicFacts: { ...exactDocs, input: undefined, maxTokens: undefined } }, discovered: { id, inputModalities: ['text'] } })
  assert.equal(row.sources.modalities, 'provider')
  assert.equal(row.sources.maxTokens, 'snapshot')
  assert.deepEqual(row.fieldEvidence.maxTokens.urls, ['https://doc.example/checker'])
  assert.equal(row.fieldEvidence.modalities.urls, undefined)
  assert.equal(row.referenceReasoningSource, 'models.dev')
  const unknownField = mergeCapabilities(base, { profile, learned: { ...learned, origins: ['public', 'checker'], publicFacts: undefined }, discovered: { id, contextWindow: 17 } })
  assert.equal(unknownField.sources.context, 'provider', 'a union of origins alone cannot promote an ordinary snapshot')
})

test('manual, exact route config and native adapter outrank docs without replacing the public reference', () => {
  const configured = { input: ['text', 'image'], contextWindow: 12000 }
  const row = mergeCapabilities(base, { profile, configured, discovered, learned: { ...learned, manualFields: ['contextWindow'] } })
  assert.equal(row.contextWindow, 100000)
  assert.equal(row.sources.context, 'manual')
  assert.equal(row.sources.modalities, 'config')
  assert.equal(selectAutomaticWriteFact(row, { contextWindow: 100000, input: ['text', 'image'] }), null)
  const annotated = mergeCapabilities(base, { profile, learned: { ...learned, manualFields: ['reasoning', 'reasoningEfforts'] },
    adapter: { reasoning: { efforts: levels('balanced') } } })
  assert.deepEqual(annotated.reasoning.efforts, levels('max'))
  assert.equal(annotated.sources.reasoningEfforts, 'manual')
  assert.deepEqual(annotated.requestReasoning.efforts, levels('balanced'))
  assert.deepEqual(annotated.referenceReasoning.efforts, levels('low', 'high'))
  const native = mergeCapabilities(base, { learned, adapter: { inputModalities: ['text', 'image'], contextWindow: 12000 } })
  assert.deepEqual(native.inputModalities, ['text', 'image'])
  assert.equal(native.sources.modalities, 'adapter')
  assert.equal(native.contextWindow, 12000)
  const manual = mergeCapabilities(base, { profile, configured, learned, override: { input: ['audio'], contextWindow: 123, efforts: levels('custom') } })
  assert.equal(manual.contextWindow, 123)
  assert.deepEqual(manual.inputModalities, ['audio'])
  assert.deepEqual(manual.reasoning.efforts, levels('custom'))
  assert.equal(manual.requestReasoning, null)
})

test('reference levels never upgrade an alias, a legacy public row, or a stale conflicting lookup to exact', () => {
  for (const source of [
    { id, publicAlias: true, publicLookupId: 'vendor/other', reasoningEfforts: levels('high'), publicFacts: exactDocs },
    { id, legacyPublic: true, publicLookupId: id, reasoningEfforts: levels('high'), publicFacts: exactDocs },
    { id, origins: ['public'], reasoningEfforts: levels('high') },
    { id: 'other-id', origins: ['checker'], reasoningEfforts: levels('high') },
    { id, publicReasoning: { publicLookupId: 'another', reasoningEfforts: levels('high'), reasoningCatalog: 'OpenRouter' } },
  ]) {
    const ref = referenceLadder(source, id)
    assert.equal(ref.evidence.alias, true)
    assert.equal(mergeCapabilities(base, { profile, learned: source }).referenceReasoningAlias, true)
  }
  assert.equal(referenceLadder({ ...learned, publicFacts: { ...exactDocs, reasoning: false, reasoningEfforts: undefined } }, id), undefined, 'exact public no-reasoning vetoes stale checker levels')
  const exactChecker = { ...learned, publicFacts: { ...exactDocs, publicLookupId: 'other' } }
  assert.equal(referenceLadder(exactChecker, id).evidence.source, 'snapshot')
})

test('actual write arbiter consults current override, discovery, live owner and committed exact record', async () => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers()
  let hold = false, override, broken = false
  const llm = { resolveModelInfo: async () => { if (hold) { started.resolve(); await pending.promise } return { provider: 'relay', id, inputModalities: ['text'] } } }
  const service = createModelInfoService(llm, { context: () => ({ profiles: new Map([['relay', profile]]),
    discovered: new Map([['relay', new Map([[id, discovered]])]]), learned: { getExact: () => learned },
    overrides: { snapshot() { if (broken) throw Error('invalid override file'); return { entry: override } } } }) })
  assert.deepEqual(await service.automaticWriteFact('relay', id, { input: ['text'], contextWindow: 64000 }), { input: ['text'], contextWindow: 64000 })
  assert.equal(await service.automaticWriteFact('relay', id, { input: ['text', 'image'], contextWindow: 100000 }), null)
  override = { input: ['text', 'image'] }
  assert.deepEqual(await service.automaticWriteFact('relay', id, { input: ['text'], contextWindow: 64000 }), { contextWindow: 64000 })
  broken = true
  assert.equal(await service.automaticWriteFact('relay', id, { contextWindow: 64000 }), null)
  broken = false
  hold = true
  const retired = service.automaticWriteFact('relay', id, { contextWindow: 64000 })
  await started.promise
  service.invalidate()
  assert.equal(await retired, null)
  pending.resolve()
  await service.dispose()
  assert.equal(await service.automaticWriteFact('relay', id, { contextWindow: 64000 }), null)
})
