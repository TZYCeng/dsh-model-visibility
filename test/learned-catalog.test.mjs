/**
 * The learned local snapshot store: file round-trip, alias lookup, merge and
 * provenance.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createLearnedCatalog } from '../lib/learned-catalog.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mv-learned-'))
}

test('learned facts round-trip through the shadow file with provenance', () => {
  const home = tempHome()
  const file = path.join(home, 'dsh-model-visibility', 'learned.json')
  const store = createLearnedCatalog({ file })
  store.upsertEntries(
    [
      { id: 'grok-4.7', type: 'chat', input: ['text', 'image'], reasoning: true, contextWindow: 500000 },
    ],
    { origins: ['checker'], verifiedAt: 42 },
  )
  const reopened = createLearnedCatalog({ file })
  assert.equal(reopened.meta().models, 1)
  const fact = reopened.get('x-ai/grok-4.7')
  assert.equal(fact.type, 'chat')
  assert.deepEqual(fact.input, ['text', 'image'])
  assert.equal(fact.verifiedAt, 42)
  assert.deepEqual(fact.origins, ['checker'])
})

test('upsert merges field by field and keeps the freshest timestamp', () => {
  const store = createLearnedCatalog({ file: path.join(tempHome(), 'dsh-model-visibility', 'learned.json') })
  store.upsertEntries(
    [{ id: 'model-a', type: 'chat', contextWindow: 100000 }],
    { origins: ['checker'], verifiedAt: 10 },
  )
  store.upsertEntries(
    [{ id: 'model-a', input: ['text', 'image'], reasoning: true }],
    { origins: ['public'], verifiedAt: 5 },
  )
  const fact = store.get('model-a') ?? store.get('MODEL-A')
  assert.equal(fact.type, 'chat')
  assert.equal(fact.contextWindow, 100000)
  assert.deepEqual(fact.input, ['text', 'image'])
  assert.equal(fact.verifiedAt, 10)
  assert.deepEqual(fact.origins.sort(), ['checker', 'public'])
})

test('an older verification fills gaps without replacing newer facts', () => {
  const file = path.join(tempHome(), 'dsh-model-visibility', 'learned.json')
  const store = createLearnedCatalog({ file })
  store.upsertEntries(
    [{ id: 'model-a', contextWindow: 200000, input: ['text', 'image'] }],
    { origins: ['checker'], verifiedAt: 200 },
  )
  store.upsertEntries(
    [{ id: 'model-a', contextWindow: 100000, input: ['text'], reasoning: true }],
    { origins: ['public'], verifiedAt: 100 },
  )

  assert.deepEqual(store.get('model-a'), {
    id: 'model-a',
    contextWindow: 200000,
    input: ['text', 'image'],
    reasoning: true,
    verifiedAt: 200,
    origins: ['checker', 'public'],
  })
  const persisted = createLearnedCatalog({ file }).get('model-a')
  assert.equal(persisted.contextWindow, 200000)
  assert.deepEqual(persisted.input, ['text', 'image'])
})

test('an entry-level origin wins over the call-level stamp', () => {
  // The sweep flushes a whole batch in one call, so the call-level origin is a
  // default for entries that do not name their own. Before this, the batch
  // stamp overwrote the public/checker distinction the caller had just worked
  // out, and every public-only fact was recorded as a checker answer.
  const store = createLearnedCatalog({ file: path.join(tempHome(), 'dsh-model-visibility', 'learned.json') })
  store.upsertEntries([{ id: 'from-public', contextWindow: 1000, origins: ['public'] }], {
    verifiedAt: 1,
    origins: ['checker'],
  })
  store.upsertEntries([{ id: 'from-checker', contextWindow: 2000 }], {
    verifiedAt: 2,
    origins: ['checker'],
  })
  assert.deepEqual(store.get('from-public').origins, ['public'])
  assert.deepEqual(store.get('from-checker').origins, ['checker'])
})

test('an entry with no usable field is ignored', () => {
  const store = createLearnedCatalog({ file: path.join(tempHome(), 'dsh-model-visibility', 'learned.json') })
  store.upsertEntries([
    { id: 'empty-entry' },
    { model: 'no-kind-here' },
    null,
    'junk',
    { id: 'valid-one', type: 'image', outputs: ['image'] },
  ])
  const meta = store.meta()
  // `outputs` is not a recognized field, so only nothing usable survives.
  assert.equal(meta.models, 1)
})

test('degenerate facts default to zero-model metadata', () => {
  const store = createLearnedCatalog({ file: path.join(tempHome(), 'nonexistent', 'deep', 'learned.json') })
  assert.deepEqual(store.meta().models, 0)
  assert.equal(store.get('anything'), undefined)
})

test('hand-edited files are picked up by invalidation and mtimes', () => {
  const file = path.join(tempHome(), 'dsh-model-visibility', 'learned.json')
  const store = createLearnedCatalog({ file })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  // give the initial memoization a stable mtime baseline
  store.get('anything')
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      updatedAt: 5,
      models: {},
    })}\n`,
  )
  // re-key the memoization through the normal load path
  assert.equal(store.meta().models, 0)
  store.invalidate()
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      updatedAt: 5,
      models: {
        'model-b': { id: 'model-b', type: 'chat', reasoning: true, verifiedAt: 3, origins: ['checker'] },
      },
    })}\n`,
  )
  store.invalidate()
  assert.equal(store.get('model-b').reasoning, true)
})

test('learned evidence survives reopening with only safe fields and HTTPS URLs', () => {
  const file = path.join(tempHome(), 'learned.json')
  const store = createLearnedCatalog({ file })
  store.upsertEntries([{ id: 'a', input: ['image'], evidence: [
    { url: 'https://vendor.example/spec', fields: ['input', 'unrecognized'] },
    { url: 'file:///secret', fields: ['input'] },
  ] }])
  assert.deepEqual(createLearnedCatalog({ file }).get('a').evidence, [{ url: 'https://vendor.example/spec', fields: ['input'] }])
})

test('each learned field keeps only the citation for its winning declaration', () => {
  const file = path.join(tempHome(), 'learned.json')
  const store = createLearnedCatalog({ file })
  const input = { url: 'https://vendor.example/modalities', fields: ['input'] }
  const context = { url: 'https://vendor.example/limits', fields: ['contextWindow'] }
  store.upsertEntries({ id: 'a', input: ['image'], evidence: [input] }, { verifiedAt: 20 })
  store.upsertEntries({ id: 'a', contextWindow: 42, evidence: [context] }, { verifiedAt: 30 })
  store.upsertEntries({ id: 'a', input: ['text'], evidence: [input] }, { verifiedAt: 10 })
  assert.deepEqual(store.getExact('a').evidence, [input, context])
  store.upsertEntries({ id: 'a', input: ['text'] }, { verifiedAt: 40 })
  const reopened = createLearnedCatalog({ file }).getExact('a')
  assert.deepEqual(reopened.input, ['text'])
  assert.deepEqual(reopened.evidence, [context])
})

test('snapshot publication commits memory and footer metadata only after disk succeeds', () => {
  const home = tempHome()
  const file = path.join(home, 'learned.json')
  const checker = { provider: 'relay', model: 'checker' }
  const store = createLearnedCatalog({ file, now: () => 50 })
  fs.mkdirSync(`${file}.${process.pid}.tmp`)
  assert.throws(() => store.upsertEntries({ id: 'a', input: ['text'] }, { checker }), /Could not save/)
  assert.equal(store.meta().models, 0)
  fs.rmdirSync(`${file}.${process.pid}.tmp`)
  store.upsertEntries({ id: 'a', input: ['text'] }, { checker })
  assert.deepEqual(store.meta(), { file, models: 1, updatedAt: 50, checker })
  assert.deepEqual(createLearnedCatalog({ file }).meta(), store.meta())
})

test('exact learned identities do not share punctuation variants in either insertion order', () => {
  const files = ['alias', 'alias-reverse'];
  const facts = [{ id: 'foo-bar', type: 'chat' }, { id: 'foobar', type: 'image' }];
  for (const suffix of files) {
    const store = createLearnedCatalog({ file: path.join(tempHome(), suffix + '.json') });
    store.upsertEntries(suffix === 'alias' ? facts : [...facts].reverse());
    assert.equal(store.get('foobar').type, 'image');
    assert.equal(store.get('foo-bar').type, 'chat');
    assert.equal(store.getExact('foo.bar'), undefined);
    assert.equal(store.get('foo.bar'), undefined);
  }
});


test('newer reasoning disable clears old levels and stale replies cannot resurrect them', () => {
  const file = path.join(tempHome(), 'learned.json')
  const store = createLearnedCatalog({ file })
  const id = 'test-reasoning-disabled'
  store.upsertEntries({ id, reasoning: true, reasoningEfforts: ['high'], defaultEffort: 'high' }, { verifiedAt: 2 })
  store.upsertEntries({ id, reasoning: false }, { verifiedAt: 3 })
  store.upsertEntries({ id, reasoningEfforts: ['low'], defaultEffort: 'low' }, { verifiedAt: 1 })
  const reopened = createLearnedCatalog({ file }).get(id)
  assert.equal(reopened.reasoning, false)
  assert.equal(reopened.reasoningEfforts, undefined)
  assert.equal(reopened.defaultEffort, undefined)
})

test('a new ladder never inherits the default from a previous ladder', () => {
  const store = createLearnedCatalog({ file: path.join(tempHome(), 'learned.json') })
  const id = 'test-ladder-replaced'
  store.upsertEntries({ id, reasoningEfforts: ['high'], defaultEffort: 'high' }, { verifiedAt: 1 })
  store.upsertEntries({ id, reasoningEfforts: ['low', 'high'] }, { verifiedAt: 2 })
  const row = store.get(id)
  assert.equal(row.reasoning, true)
  assert.deepEqual(row.reasoningEfforts.map(level => level.id), ['low', 'high'])
  assert.equal(row.defaultEffort, undefined)
})


test('qualified identities survive reopening and ambiguous siblings never share facts', () => {
  const file = path.join(tempHome(), 'learned.json')
  const store = createLearnedCatalog({ file })
  store.upsertEntries([{ id: 'vendorA/shared', contextWindow: 999 }, { id: 'vendorB/shared', contextWindow: 123 }], { origins: ['public'] })
  const reopened = createLearnedCatalog({ file })
  assert.equal(reopened.getExact('vendorA/shared').contextWindow, 999)
  assert.equal(reopened.getExact('vendorB/shared').contextWindow, 123)
  assert.equal(reopened.get('vendorC/shared'), undefined)
  assert.equal(reopened.get('shared'), undefined)
})

test('learned lookups prioritize full case folds, scope aliases, and retain variant spelling', () => {
  const file = path.join(tempHome(), 'learned.json')
  const store = createLearnedCatalog({ file })
  store.upsertEntries([
    { id: 'Qwen/qwen4-max', contextWindow: 100 },
    { id: 'qwen/qwen4-max:free', contextWindow: 200 },
    { id: 'Qwen/qwen4-max-preview', contextWindow: 300 },
    { id: 'other/qwen4-max-preview', contextWindow: 400 },
    { id: 'qwen/qwen3.6-27b', contextWindow: 500 },
    { id: 'qwen/img-2-4k', contextWindow: 600 },
  ], { origins: ['checker'] })
  const reopened = createLearnedCatalog({ file })
  assert.equal(reopened.get('QWEN/QWEN4-MAX').contextWindow, 100)
  assert.equal(reopened.get('qwen/qwen4-max:free').contextWindow, 200)
  assert.equal(reopened.get('qwen/qwen4-max-preview:fast').contextWindow, 300)
  assert.equal(reopened.get('other/qwen4-max-preview:fast').contextWindow, 400)
  for (const id of ['qwen/qwen4-max:fast', 'qwen4-max-preview', 'x/qwen4-max-preview', 'openai.qwen4-max-preview',
    'qwen/qwen3.6', 'qwen/qwen36-27b', 'qwen/img-2-2k', 'qwen/img-2', 'qwen/qwen4-max:batch', 'qwen/qwen4-max:thinking']) {
    assert.equal(reopened.get(id), undefined, id)
  }
  assert.equal(reopened.getExact('qwen/qwen4-max-preview:fast'), undefined)
})

test('older public aliases require matching again but do not invalidate exact public rows', () => {
  const file = path.join(tempHome(), 'learned.json')
  const alias = { id: 'vendor/model:batch', input: ['image'], origins: ['public'], publicAlias: true }
  const exact = { id: 'vendor/model', input: ['image'], origins: ['public'] }
  fs.writeFileSync(file, JSON.stringify({ version: 2, models: { alias, exact } }))
  const store = createLearnedCatalog({ file })
  assert.equal(store.getExact(alias.id).legacyPublic, true, 'a fresh verification should not skip a stale alias')
  assert.equal(store.get(alias.id), undefined)
  assert.equal(store.get(exact.id).legacyPublic, undefined)
  const newAlias = 'vendor/model:free'
  store.upsertEntries({ ...alias, id: newAlias })
  const reopened = createLearnedCatalog({ file })
  assert.equal(reopened.get(newAlias).publicAlias, true)
  assert.equal(reopened.get(newAlias).legacyPublic, undefined)
  assert.equal(reopened.get('VENDOR/MODEL:FREE'), undefined, 'a public alias cannot propagate again')
  store.upsertEntries({ id: alias.id, input: ['text'], origins: ['public'] })
  assert.deepEqual(store.get(alias.id).input, ['text'])
  assert.equal(store.get(alias.id).publicAlias, undefined)
})

test('legacy public matches require a fresh exact result instead of being displayed', () => {
  const file = path.join(tempHome(), 'learned.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, models: { shared: { id: 'vendorB/shared', input: ['image'], origins: ['public'] } } }))
  const store = createLearnedCatalog({ file })
  assert.equal(store.getExact('vendorB/shared').legacyPublic, true)
  assert.equal(store.get('vendorB/shared'), undefined)
  store.upsertEntries({ id: 'vendorB/shared', input: ['text'] }, { origins: ['public'] })
  assert.deepEqual(store.get('vendorB/shared').input, ['text'])
  assert.equal(store.get('vendorB/shared').legacyPublic, undefined)
})
