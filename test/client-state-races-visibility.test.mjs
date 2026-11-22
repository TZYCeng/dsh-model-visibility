import assert from 'node:assert/strict'
import test from 'node:test'
import { editHiddenRoutes, hiddenIndex, routeFields, routeKey } from '../client-src/visibility-codec.mjs'
import { writeHiddenRoutes, canWriteHidden } from '../client-src/visibility-identity.mjs'
import { hiddenSetOf, keyOf } from '../client-src/format.mjs'
import { patchDirectoryStore } from '../client-src/composer-filter.mjs'
import { toModelListCsv } from '../lib/export-csv.js'

const route = (provider, model) => ({ provider, model })
const left = route('a/b', 'c'), right = route('a', 'b/c'), other = route('other', 'm')
const routes = [left, right, other]
const groups = routes.map(({ provider: id, model }) => ({ id, models: [{ id: model }] }))
const states = list => routes.map(({ provider, model }) => hiddenSetOf({ value: { hidden: list } }).has(keyOf(provider, model)))

test('simple keys are unchanged; exact route tags are injective and disjoint from every old key', () => {
  assert.equal(keyOf('relay', 'm'), 'relay/m')
  const cases = [...routes, route('a%', '/b,c'), route('a%2F', 'b/c'), route('a/', 'b%2Fc'),
    route('mv2:hide:["a","b"]', '../x%2f'), route('\ud800', 'path/name'), route('p\0x', 'm\n/"'), route('p', 'a//b')]
  const keys = cases.map(({ provider, model }) => routeKey(provider, model))
  assert.equal(new Set(keys).size, cases.length)
  for (const [i, r] of cases.entries()) {
    assert.deepEqual(routeFields(keys[i]), [r.provider, r.model]);
    if ([r.provider, r.model].some(x => x.includes('/'))) assert.equal(keys[i].includes('/'), false)
  }
  assert.equal(routeFields('a/b/c'), null, 'unattributable old usage rows must not be split')
})

test('old slash blankets retain all baseline routes even across partial catalogs; current selection alone is retained', () => {
  const old = ['gone/m', 'a/b/c', 'future-metadata']
  assert.deepEqual(states(old), [true, true, false])
  const partial = editHiddenRoutes(old, [left], true) // only one of the routes was even present in this editor
  assert.deepEqual(states(partial), [false, true, false])
  assert.ok(partial.includes('a/b/c') && partial.includes('gone/m') && partial.includes('future-metadata'))
  assert.deepEqual(old, ['gone/m', 'a/b/c', 'future-metadata'])
  let hidden = old
  const form = { getSnapshot: () => ({ value: { hidden } }) }
  const store = { getSnapshot: () => base }; let base = { groups, current: left }
  const record = patchDirectoryStore(store, form)
  const ids = () => store.getSnapshot().groups.flatMap(g => g.models.map(m => [g.id,m.id]))
  assert.deepEqual(ids(), [['a/b','c'],['other','m']])
  base = { ...base, current: right }; assert.deepEqual(ids(), [['a','b/c'],['other','m']])
  hidden = partial; base = { ...base, current: null }; assert.deepEqual(ids(), [['a/b','c'],['other','m']])
  assert.deepEqual(toModelListCsv({ groups }, { hidden }).trim().split('\r\n').slice(1).map(row => row.split(',')[2]), ['0','1','0'])
  record.restore(); assert.equal(store.getSnapshot(), base)
  // The legacy shadow is safe to remove when EVERY possible split was explicitly shown.
  assert.deepEqual(editHiddenRoutes(partial, [right], true), ['gone/m', 'future-metadata'])
})

test('a new exact hidden route writes an old-client shadow; stale metadata cannot resurrect another route', () => {
  let list = editHiddenRoutes([], [left], false)
  assert.deepEqual(states(list), [true, false, false]); assert.ok(new Set(list).has('a/b/c'), 'old menu remains hidden')
  list = editHiddenRoutes(list, [right], false)
  assert.deepEqual(states(list), [true, true, false])
  list = editHiddenRoutes(list, [left], true)
  assert.deepEqual(states(list), [false, true, false]); assert.ok(list.includes('a/b/c'))
  const oldClientShow = list.filter(key => key !== 'a/b/c')
  assert.deepEqual(states(oldClientShow), [false, false, false])
  list = editHiddenRoutes(oldClientShow, [left], false)
  assert.deepEqual(states(list), [true, false, false]); assert.deepEqual(editHiddenRoutes(list, [left], true), [])
  const noEdit = ['a/b/c','old','old']; assert.equal(editHiddenRoutes(noEdit, [left], false), noEdit)
  assert.equal(hiddenIndex(['mv2:hide:!malformed','legacy']).hasRoute('p', 'm'), false)
})

// A ConfigForm-shaped mirror of a CAS server. Separate forms simulate two
// browsers, not merely two callbacks sharing a JS heap or an optimistic Set.
function formFor(server, onSend = async () => {}) {
  let mirror = { ...server, status: 'ready', writable: true }
  const calls = []
  return { calls, getSnapshot: () => mirror,
    async mutate(ops, revision) {
      calls.push({ ops, revision }); await onSend()
      assert.deepEqual(ops[0].path, ['hidden']); assert.equal(ops[0].op, 'set')
      const accepted = revision === server.revision
      if (accepted) { server.value = { ...server.value, hidden: ops[0].value }; server.revision++ }
      mirror = { ...server, status: 'ready', writable: true }; return accepted
    },
  }
}
test('two simultaneous component edits queue intents and rebase on accepted form values', async () => {
  const server = { revision: 8, value: { hidden: ['gone/old'], applyInput: true } }
  const entered = Promise.withResolvers(), wait = Promise.withResolvers()
  const form = formFor(server, () => { entered.resolve(); return wait.promise })
  const a = writeHiddenRoutes(form, [left], false)
  const b = writeHiddenRoutes(form, [other], false)
  await entered.promise; assert.equal(form.calls.length, 1)
  wait.resolve(); assert.deepEqual(await Promise.all([a, b]), [true, true])
  assert.deepEqual(form.calls.map(x => x.revision), [8,9]); assert.deepEqual(states(server.value.hidden), [true,false,true]);
  assert.ok(server.value.hidden.includes('gone/old')); assert.ok(server.value.applyInput)
})

test('a genuinely concurrent other browser edit between read and host commit survives CAS recovery', async () => {
  const server = { revision: 0, value: { hidden: ['gone/old','a/b/c'] } }
  const entered = Promise.withResolvers(), wait = Promise.withResolvers()
  const a = formFor(server, () => { entered.resolve(); return wait.promise }), b = formFor(server)
  const show = writeHiddenRoutes(a, [left], true)
  await entered.promise; await writeHiddenRoutes(b, [other], false); wait.resolve(); assert.equal(await show, true)
  assert.deepEqual(a.calls.map(x => x.revision), [0,1]); assert.deepEqual(states(server.value.hidden), [false,true,true])
  assert.ok(server.value.hidden.includes('gone/old'))
})

test('missing or refused CAS never falls back to a stale form.set; a failed queued edit does not poison successors', async () => {
  const ready = { status:'ready', writable:true, revision:0, value:{ hidden:[] } }
  for (const snapshot of [ready,{ ...ready, revision:undefined },{ ...ready, status:'unavailable' }]) {
    let sets=0; const form = { getSnapshot:()=>snapshot, set(){sets++} }
    assert.equal(canWriteHidden(form, snapshot), false); assert.equal(await writeHiddenRoutes(form,[left],false),false); assert.equal(sets,0)
  }
  let calls=0
  const form = { getSnapshot:()=>ready, async mutate() { if (++calls === 1) throw Error('offline'); return false } }
  const failed = writeHiddenRoutes(form,[left],false), refused = writeHiddenRoutes(form,[other],false)
  await assert.rejects(failed,/offline/); assert.equal(await refused,false); assert.equal(calls,2)
})
