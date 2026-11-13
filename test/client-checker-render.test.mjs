/** Render checker source directly: no generated client.js reads or build side effects. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { DICT } from '../client-src/dict.mjs'
import { CSS } from '../client-src/css.mjs'
import * as pure from '../client-src/pure.mjs'
import * as format from '../client-src/format.mjs'

/** Minimal ESM adapter for just the two React modules under test, entirely in memory. */
function loadComponent(name, requireModule, window) {
  const source = readFileSync(new URL(`../client-src/${name}.mjs`, import.meta.url), 'utf8')
  const exports = []
  const body = source
    .replace(/^import \{([^}]+)\} from '\.\/([^']+)\.mjs'.*$/gm,
      (_match, names, dependency) => `const {${names}} = require(${JSON.stringify(dependency)})`)
    .replace(/^export (function|const|class) (\w+)/gm, (_match, kind, symbol) => {
      exports.push(symbol)
      return `${kind} ${symbol}`
    })
    .replace(/^export \{([^}]+)\}.*$/gm, (_match, names) => {
      exports.push(...names.split(',').map((name) => name.trim()))
      return ''
    })
  return vm.runInNewContext(`(function(require, window) {\n${body}\nreturn { ${exports.join(', ')} }\n})`, {},
    { filename: `${name}.mjs` })(requireModule, window)
}

function renderPanel(progress = {}, { pick, storage, language = 'en' } = {}) {
  const slots = []
  const writes = []
  const starts = []
  let cursor = 0
  let loads = 0
  let tree
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => { slots[index] = value }]
    },
    useCallback: (fn) => fn,
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: () => {},
  }
  const window = {
    localStorage: storage ?? {
      getItem: () => pick === undefined ? null : JSON.stringify(pick),
      setItem: (key, value) => writes.push({ key, value: JSON.parse(value) }),
    },
  }
  const modules = { react: React, pure, format }
  const requireModule = (name) => {
    assert.ok(name in modules, `unexpected dependency: ${name}`)
    return modules[name]
  }
  modules.hooks = loadComponent('hooks', requireModule, window)
  const { VerifyPanel } = loadComponent('checker-view', requireModule, window)
  const verify = {
    subscribe: () => () => {},
    getSnapshot: () => ({ snapshot: { state: progress }, error: null }),
    load: async () => { loads += 1 },
    start: async (payload) => { starts.push(JSON.parse(JSON.stringify(payload))) },
    cancel: async () => {},
  }
  const t = (key, params = {}) => {
    assert.ok(key in DICT[language], `missing ${language} translation: ${key}`)
    return DICT[language][key].replace(/\{(\w+)\}/g, (_match, name) => {
      assert.ok(name in params, `missing ${key} parameter: ${name}`)
      return String(params[name])
    })
  }
  const render = () => {
    cursor = 0
    tree = VerifyPanel({
      verify,
      catalog: { groups: [{ id: 'relay', name: 'Relay', models: [{ id: 'checker' }] }] },
      t,
      canUse: true,
    })
  }
  const findAll = (predicate, node = tree, out = []) => {
    if (Array.isArray(node)) {
      node.forEach((child) => findAll(predicate, child, out))
    } else if (node && typeof node === 'object') {
      if (predicate(node)) out.push(node)
      findAll(predicate, node.props.children, out)
    }
    return out
  }
  const byClass = (className) => findAll((node) => node.props.className?.split(' ').includes(className))
  const text = (node = tree) => {
    if (Array.isArray(node)) return node.map(text).join(' ')
    if (node && typeof node === 'object') return text(node.props.children)
    return node === null || node === undefined || node === false ? '' : String(node)
  }
  render()
  return {
    render, findAll, byClass, text, writes, starts, t,
    open() { byClass('mvp_checkerHead')[0].props.onClick(); render() },
    checkbox(key) { return findAll((node) => node.type === 'input' && node.props['aria-label'] === t(key))[0] },
    start() { findAll((node) => node.type === 'button' && node.props.title === t('checker.startTitle'))[0].props.onClick() },
  }
}

const RUNNING = {
  running: true,
  phase: 'verifying',
  processed: 7,
  done: 3,
  total: 10,
  unknown: 2,
  failed: 2,
  searchCalls: 4,
  fetchCalls: 6,
  tokenUsage: [1200, 300],
}

for (const language of ['en', 'zh']) {
  test(`${language}: summary and progress separate processed, valid, unknown, failed and web calls`, () => {
    const panel = renderPanel(RUNNING, { language })
    const summary = panel.text(panel.byClass('mvp_checkerSummary')[0])
    assert.match(summary, /7\/10/)
    for (const part of language === 'en'
      ? ['3 valid', '2 unknown', '2 failed', '4 searches', '6 reads', '1.5K tokens']
      : ['有效 3', '未知 2', '失败 2', '搜索 4', '读取 6', '1.5K Token']) {
      assert.ok(summary.includes(part), `summary must contain ${part}`)
    }
    panel.open()
    const bar = panel.findAll((node) => node.props.role === 'progressbar')[0]
    assert.equal(bar.props['aria-valuenow'], 7)
    assert.equal(bar.props['aria-valuemax'], 10)
    assert.equal(panel.byClass('mvp_progressFill')[0].props.style.width, '70%')
    const details = panel.text(panel.byClass('mvp_checkerProgress')[0])
    assert.ok(details.includes('7/10'))
    assert.ok(details.includes(language === 'en' ? '3 valid' : '有效 3'))
    assert.ok(details.includes(language === 'en' ? '2 unknown' : '未知 2'))
    assert.ok(details.includes(language === 'en' ? '2 failed' : '失败 2'))
    assert.ok(details.includes(language === 'en' ? '6 web-page reads' : '网页读取 6 次'))
  })
}

test('finished progress reaches 100% when some processed models were unknown or failed', () => {
  const panel = renderPanel({ ...RUNNING, running: false, phase: 'done', processed: 10, unknown: 4, failed: 3 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /10\/10 processed/)
  panel.open()
  assert.equal(panel.byClass('mvp_progressFill')[0].props.style.width, '100%')
})

test('legacy snapshots fall back to done and absent counters render zero', () => {
  const panel = renderPanel({ running: false, phase: 'cancelled', done: 2, total: 5 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /2\/5 processed/)
  panel.open()
  assert.equal(panel.findAll((node) => node.props.role === 'progressbar')[0].props['aria-valuenow'], 2)
  assert.equal(panel.byClass('mvp_progressFill')[0].props.style.width, '40%')
  assert.match(panel.text(panel.byClass('mvp_checkerProgress')[0]), /0 unknown · 0 failed/)
  assert.match(panel.text(panel.byClass('mvp_checkerProgress')[0]), /0 searches · 0 web-page reads/)
})

test('an explicit zero processed count wins over done, and empty totals are safe', () => {
  const panel = renderPanel({ ...RUNNING, processed: 0, total: 0 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /0\/0 processed/)
  panel.open()
  assert.equal(panel.findAll((node) => node.props.role === 'progressbar')[0].props['aria-valuenow'], 0)
  assert.equal(panel.byClass('mvp_progressFill')[0].props.style.width, '0%')
})

test('active batches show stages and model IDs in at most three rows', () => {
  const batches = [
    { ids: ['finished-model'], status: 'ok', stage: 'checker' },
    { ids: ['model-a', 'model-b'], status: 'running', stage: 'search' },
    { ids: ['failed-model'], status: 'failed', stage: 'fetch' },
    { ids: ['model-c'], status: 'running', stage: 'fetch' },
    { ids: ['model-d'], status: 'running', stage: 'writeBack' },
    { ids: ['hidden-active'], status: 'running', stage: 'flush' },
  ]
  const panel = renderPanel({ ...RUNNING, batches })
  panel.open()
  const active = panel.findAll((node) => node.props['aria-label'] === 'Active batches')[0]
  assert.ok(active)
  const lines = panel.findAll((node) => node.type === 'li', active)
  assert.equal(lines.length, 3)
  assert.match(panel.text(lines[0]), /Searching model-a, model-b/)
  assert.match(panel.text(lines[1]), /Reading web pages model-c/)
  assert.match(panel.text(lines[2]), /Writing settings model-d/)
  assert.match(panel.text(active), /1 more active batches/)
  assert.doesNotMatch(panel.text(active), /finished-model|failed-model|hidden-active/)
  const finished = renderPanel({ ...RUNNING, running: false, phase: 'done', batches })
  finished.open()
  assert.equal(finished.findAll((node) => node.props['aria-label'] === 'Active batches').length, 0)
})

test('all batch stages are translated, and a future stage remains readable', () => {
  for (const language of ['en', 'zh']) {
    for (const stage of ['checker', 'search', 'fetch', 'writeBack', 'flush', 'future-stage']) {
      const panel = renderPanel({ ...RUNNING, batches: [{ ids: ['model'], status: 'running', stage }] }, { language })
      panel.open()
      const expected = DICT[language][`checker.stage.${stage}`] ?? stage
      assert.equal(panel.text(panel.byClass('mvp_sourceState')[0]), expected)
    }
  }
})

test('new, missing-field and invalid stored picks default web search on and write-back off', () => {
  const cases = [
    {},
    { pick: { provider: 'relay', model: 'checker' } },
    { storage: { getItem: () => '{bad json', setItem() {} } },
    { storage: { getItem() { throw new Error('storage unavailable') }, setItem() {} } },
  ]
  for (const options of cases) {
    const panel = renderPanel({}, options)
    panel.open()
    assert.equal(panel.checkbox('checker.webSearch').props.checked, true)
    assert.equal(panel.checkbox('checker.writeBack').props.checked, false)
  }
})

test('explicit stored preferences survive and start sends webSearch with the selected pick', () => {
  const panel = renderPanel({}, { pick: { provider: 'relay', model: 'checker', writeBack: true, webSearch: false, concurrency: 4 } })
  panel.open()
  assert.equal(panel.checkbox('checker.writeBack').props.checked, true)
  assert.equal(panel.checkbox('checker.webSearch').props.checked, false)
  panel.start()
  assert.deepEqual(panel.starts, [{ provider: 'relay', model: 'checker', writeBack: true, webSearch: false, concurrency: 4 }])
})

test('web search can be disabled, persisted and passed to start without enabling write-back', () => {
  const panel = renderPanel({}, { pick: { provider: 'relay', model: 'checker' } })
  panel.open()
  panel.checkbox('checker.webSearch').props.onChange({ target: { checked: false } })
  panel.render()
  assert.equal(panel.checkbox('checker.webSearch').props.checked, false)
  assert.equal(panel.writes.at(-1).value.webSearch, false)
  assert.equal(panel.writes.at(-1).value.writeBack, false)
  panel.start()
  assert.deepEqual(panel.starts[0], { provider: 'relay', model: 'checker', writeBack: false, webSearch: false, concurrency: 2 })
  panel.checkbox('checker.webSearch').props.onChange({ target: { checked: true } })
  panel.render()
  panel.start()
  assert.equal(panel.starts.at(-1).webSearch, true)
})

test('run options remain disabled while verification is running', () => {
  const panel = renderPanel(RUNNING)
  panel.open()
  assert.equal(panel.checkbox('checker.webSearch').props.disabled, true)
  assert.equal(panel.checkbox('checker.writeBack').props.disabled, true)
})

test('checker translations stay in sync and explain web costs, errors and no target-model testing', () => {
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(DICT.en).sort())
  for (const key of Object.keys(DICT.zh)) {
    const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(placeholders(DICT.zh[key]), placeholders(DICT.en[key]), key)
  }
  assert.match(DICT.zh['checker.description'], /搜索和网页读取/)
  assert.match(DICT.zh['checker.description'], /联网服务额度.*Token/)
  assert.match(DICT.zh['checker.description'], /不对目标模型进行实测/)
  assert.match(DICT.zh['checker.description'], /联网不可用会报告错误/)
  assert.match(DICT.en['checker.description'], /search and read web pages/)
  assert.match(DICT.en['checker.description'], /web-service quota.*tokens/)
  assert.match(DICT.en['checker.description'], /target models are not tested directly/)
  assert.match(DICT.en['checker.description'], /Unavailable web access is reported as an error/)
})

test('new checker markup uses only existing theme CSS classes', () => {
  const source = readFileSync(new URL('../client-src/checker-view.mjs', import.meta.url), 'utf8')
  const used = new Set([...source.matchAll(/mvp_[A-Za-z]+/g)].map((match) => match[0]))
  const defined = new Set([...CSS.matchAll(/\.(mvp_[A-Za-z]+)/g)].map((match) => match[1]))
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [])
})
