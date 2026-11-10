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
