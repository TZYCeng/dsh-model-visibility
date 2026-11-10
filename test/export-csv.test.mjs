/**
 * CSV exporter contract.
 *
 * `lib/export-csv.js` shipped with zero tests, and the model-list exporter
 * threw `reasoning.join is not a function` for every model carrying an effort
 * ladder — i.e. the "export models CSV" button 500'd on any real relay.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { toModelListCsv, toUsageCsv } from '../lib/export-csv.js'

/** Split a CRLF CSV body into rows of raw cells (naive, good enough for asserts). */
function rowsOf(body) {
  return body.split('\r\n').filter((line) => line !== '')
}

const model = (overrides = {}) => ({
  id: 'grok-4.7',
  name: 'grok-4.7',
  kind: 'chat',
  inputModalities: ['text', 'image'],
  contextWindow: 500000,
  sources: { kind: 'config', modalities: 'config', context: 'config', reasoning: 'config' },
  ...overrides,
})

test('the model list exports a model that carries a reasoning ladder', () => {
  const catalog = {
    groups: [
      {
        id: 'relay',
        name: 'Relay',
        models: [
          model({
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
            reasoningSupported: true,
          }),
        ],
      },
    ],
  }
  const body = toModelListCsv(catalog, { hidden: [] })
  const [header, row] = rowsOf(body)
  assert.equal(header, 'provider,model,hidden,kind,inputModalities,contextWindow,reasoning,reasoningSupported,sources')
  assert.equal(row, 'relay,grok-4.7,0,chat,text|image,500000,low|high,yes,config;config;config')
})

test('a model without a ladder exports empty reasoning columns, not a crash', () => {
  const catalog = { groups: [{ id: 'relay', name: 'Relay', models: [model({ reasoning: undefined, reasoningSupported: false })] }] }
  const body = toModelListCsv(catalog, { hidden: [] })
  const [, row] = rowsOf(body)
  assert.equal(row.split(',')[6], '')
  assert.equal(row.split(',')[7], 'no')
})

test('hidden models are marked and the column set is stable', () => {
  const catalog = { groups: [{ id: 'relay', name: 'Relay', models: [model()] }] }
  const body = toModelListCsv(catalog, { hidden: ['relay/grok-4.7'] })
  const [, row] = rowsOf(body)
  assert.equal(row.split(',')[2], '1')
  assert.equal(body.split('\r\n')[0].split(',').length, 9)
})

test('usage CSV expands each window into the four numeric columns', () => {
  const summary = {
    ranges: { today: [1, 2, 3, 4], week: [5, 6, 0, 0], month: [7, 8, 0, 0], total: [9, 10, 0, 0] },
    days: { '2026-11-09': [9, 10, 0, 0], '2026-11-08': [1, 1, 0, 0] },
    byModel: { 'relay/grok-4.7': [9, 10, 0, 0] },
  }
  const rows = rowsOf(toUsageCsv(summary))
  assert.equal(rows[0], 'section,range,input,output,cacheRead,cacheWrite')
  assert.equal(rows[1], 'sum,today,1,2,3,4')
  assert.equal(rows[4], 'sum,total,9,10,0,0')
  const dataRows = rows.filter((row) => row.startsWith('2026-'))
  assert.deepEqual(dataRows, ['2026-11-08,1,1,0,0', '2026-11-09,9,10,0,0'])
  assert.ok(rows.includes('provider/model,input,output,cacheRead,cacheWrite'))
  assert.ok(rows.includes('relay/grok-4.7,9,10,0,0'))
})

test('the real ledger shape (a tuple per day) does not crash the exporter', () => {
  // `read()` returns `days: { dayKey: [in,out,cr,cw] }`; the exporter used to
  // iterate it as `{ dayKey: { route: tuple } }` and threw
  // "values.every is not a function" on the very first real ledger.
  const snapshot = {
    ranges: { today: [5, 1, 0, 0], week: [5, 1, 0, 0], month: [5, 1, 0, 0], total: [5, 1, 0, 0] },
    days: { '2026-11-09': [5, 1, 0, 0] },
    byModel: { 'relay/a': [5, 1, 0, 0], '*': [5, 1, 0, 0] },
  }
  assert.doesNotThrow(() => toUsageCsv(snapshot))
  const rows = rowsOf(toUsageCsv(snapshot))
  assert.ok(rows.includes('2026-11-09,5,1,0,0'))
  // The `*` convenience row must never be exported as a route.
  assert.equal(rows.some((row) => row.startsWith('*,')), false)
})

test('both exporters quote commas, quotes and newlines', () => {
  const catalog = { groups: [{ id: 'relay,inc', name: 'R', models: [model({ id: 'a"b' })] }] }
  const body = toModelListCsv(catalog, { hidden: [] })
  assert.ok(body.includes('"relay,inc"'))
  assert.ok(body.includes('"a""b"'))

  const usage = toUsageCsv({
    ranges: { today: [1, 0, 0, 0], week: [0, 0, 0, 0], month: [0, 0, 0, 0], total: [1, 0, 0, 0] },
    days: { '2026-11-09': [1, 0, 0, 0] },
    byModel: { 'relay/a,b': [1, 0, 0, 0] },
  })
  assert.ok(usage.includes('"relay/a,b"'), 'the route column must be quoted')
})

test('formula-looking model ids are defused for spreadsheets', () => {
  const catalog = {
    groups: [
      {
        id: 'relay',
        name: 'R',
        models: [
          model({ id: '=HYPERLINK("http://x","y")' }),
          model({ id: '@SUM(A1)' }),
          model({ id: '+cmd|calc' }),
        ],
      },
    ],
  }
  const body = toModelListCsv(catalog, { hidden: [] })
  // The exporter writes the id, not the display name; both leading = and @
  // are neutralised so Excel does not evaluate the cell.
  assert.ok(body.includes('"\'=HYPERLINK('), 'a leading = must be neutralised')
  assert.ok(body.includes("'@SUM(A1)"), 'a leading @ must be neutralised')
  assert.ok(body.includes("'+cmd|calc"), 'a leading + must be neutralised')
})

test('empty and malformed catalogs still produce a header', () => {
  assert.equal(rowsOf(toModelListCsv({ groups: [] }))[0].startsWith('provider,model'), true)
  assert.equal(rowsOf(toModelListCsv(undefined))[0].startsWith('provider,model'), true)
  assert.equal(rowsOf(toUsageCsv(undefined))[0].startsWith('section,range'), true)
})
