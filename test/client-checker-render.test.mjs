/** Render checker source directly: no generated client.js reads or build side effects. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { DICT as BASE } from '../client-src/dict.mjs'
import { CHECKER_EN, CHECKER_ZH } from '../client-src/checker-dict.mjs'
import { CHECKER_CSS } from '../client-src/checker-style.mjs'
import { CSS } from '../client-src/css.mjs'
import * as diagnosticEvents from '../client-src/diagnostic-events.mjs'

const DICT = { en: { ...BASE.en, ...CHECKER_EN }, zh: { ...BASE.zh, ...CHECKER_ZH } }
import * as pure from '../client-src/pure.mjs'
import * as format from '../client-src/format.mjs'
import * as constants from '../client-src/constants.mjs'

/** Minimal ESM adapter for just the two React modules under test, entirely in memory. */
function loadComponent(name, requireModule, window, globals = {}) {
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
  return vm.runInNewContext(`(function(require, window) {\n${body}\nreturn { ${exports.join(', ')} }\n})`, globals,
    { filename: `${name}.mjs` })(requireModule, window)
}

function renderPanel(progress = {}, options = {}) {
  const { pick, storage, language = 'en', canFullScan = true, canSetMode = false, canSetSourceMode = false,
    pending = false, canUse = true, groups = [{ id: 'relay', name: 'Relay', models: [{ id: 'checker' }] }],
    startError, loadError = null, features = [], bulk } = options
  const slots = []
  const writes = []
  const starts = []
  const cancels = []
  const layouts = []
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
    useMemo: (fn) => fn(),
    useId: () => `test-id-${cursor++}`,
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
    useEffect: () => {},
    useLayoutEffect: (fn) => { layouts.push(fn) },
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
  modules['checker-bulk'] = loadComponent('checker-bulk', requireModule, window, { AbortController, Date, setTimeout, clearTimeout })
  const { VerifyPanel } = loadComponent('checker-view', requireModule, window)
  const verify = {
    bulk, subscribe: () => () => {},
    getSnapshot: () => ({ snapshot: { state: progress }, error: loadError, pending }),
    load: async () => { loads += 1 },
    start: async (payload) => {
      starts.push(JSON.parse(JSON.stringify(payload)))
      if (startError) throw startError
    },
    cancel: async (runId) => { cancels.push(runId) },
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
    layouts.length = 0
    if (options.bulkPart) {
      tree = modules['checker-bulk'][options.bulkPart]({ api: bulk, t, canUse, ...options.componentProps })
      return
    }
    tree = VerifyPanel({
      verify,
      catalog: { groups, learned: { features } },
      t,
      canUse,
      canFullScan,
      canSetMode,
      canSetSourceMode,
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
    render, findAll, byClass, text, writes, starts, cancels, t, layouts,
    open() { byClass('mvp_checkerHead')[0].props.onClick(); render() },
    checkbox(key) { return findAll((node) => node.type === 'input' && node.props['aria-label'] === t(key))[0] },
    field(key) { return findAll((node) => node.type === 'select' && node.props['aria-label'] === t(key))[0] },
    modes() { return findAll((node) => node.type === 'input' && node.props.type === 'radio') },
    chooseMode(mode) { this.modes().find((node) => node.props.value === mode).props.onChange(); render() },
    startControl() { return findAll((node) => node.type === 'button' && node.props.title === t('checker.startTitle'))[0] },
    start() { this.startControl().props.onClick() },
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
  skippedKnown: 9,
  searchCalls: 4,
  fetchCalls: 6,
  tokenUsage: [1200, 300],
}

for (const language of ['en', 'zh']) {
  test(`${language}: a compact summary does not repeat outcome and usage counts`, () => {
    const panel = renderPanel(RUNNING, { language })
    const summary = panel.text(panel.byClass('mvp_checkerSummary')[0])
    assert.match(summary, /7\/10/)
    panel.open()
    const bar = panel.findAll((node) => node.props.role === 'progressbar')[0]
    assert.equal(bar.props['aria-valuenow'], 7)
    assert.equal(bar.props['aria-valuemax'], 10)
    assert.equal(panel.byClass('mvp_progressFill')[0].props.style.width, '70%')
    assert.equal(panel.text().split('7/10').length - 1, 1)
    for (const part of language === 'en'
      ? ['3 valid', '2 unknown', '2 failed', '9 known skipped', '4 searches', '6 web-page reads', '1.5K tokens']
      : ['有效 3', '未知 2', '失败 2', '跳过已知 9', '搜索 4 次', '网页读取 6 次', '1.5K Token']) {
      assert.ok(!summary.includes(part), `summary must not repeat ${part}`)
      assert.equal(panel.text().split(part).length - 1, 1, `expanded view should report ${part} once`)
    }
  })
}

test('finished progress reports all processed models without a finished progress bar', () => {
  const panel = renderPanel({ ...RUNNING, running: false, phase: 'done', processed: 10, unknown: 4, failed: 3 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /10\/10 processed/)
  panel.open()
  assert.equal(panel.byClass('mvp_progressFill').length, 0)
  assert.match(panel.text(panel.byClass('mvp_checkerProgress')[0]), /3 valid · 4 unknown · 3 failed/)
})

test('a run that skipped every model reports the result without a zero-total bar', () => {
  const panel = renderPanel({ running: false, phase: 'done', total: 0, skippedKnown: 14 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /No new models to verify · 14 known skipped/)
  panel.open()
  assert.equal(panel.findAll((node) => node.props.role === 'progressbar').length, 0)
})

test('legacy snapshots fall back to done and absent counters render zero', () => {
  const panel = renderPanel({ running: false, phase: 'cancelled', done: 2, total: 5 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /2\/5 processed/)
  panel.open()
  assert.equal(panel.findAll((node) => node.props.role === 'progressbar').length, 0)
  assert.match(panel.text(panel.byClass('mvp_checkerProgress')[0]), /0 unknown · 0 failed/)
  assert.match(panel.text(), /0 searches\s+·\s+0 web-page reads/)
})

test('an explicit zero processed count wins over done; a plan with no known total has no zero-total bar', () => {
  const panel = renderPanel({ ...RUNNING, processed: 0 })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /0\/10 processed/)
  panel.open()
  assert.equal(panel.findAll((node) => node.props.role === 'progressbar')[0].props['aria-valuenow'], 0)
  assert.equal(panel.byClass('mvp_progressFill')[0].props.style.width, '0%')
  const listing = renderPanel({ running: true, phase: 'listing', mode: 'checker', total: 0 }, { canSetSourceMode: true })
  listing.open()
  assert.match(listing.text(listing.byClass('mvp_checkerSummary')[0]), /Reading model list · Online checker only/)
  assert.doesNotMatch(listing.text(), /0\/0|Reading public catalogs|assigned to the checker/)
  assert.equal(listing.findAll((node) => node.props.role === 'progressbar').length, 0)
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
  assert.deepEqual(panel.starts, [{ provider: 'relay', model: 'checker', writeBack: true, webSearch: false, concurrency: 4, fullScan: false }])
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
  assert.deepEqual(panel.starts[0], { provider: 'relay', model: 'checker', writeBack: false, webSearch: false, concurrency: 2, fullScan: false })
  panel.checkbox('checker.webSearch').props.onChange({ target: { checked: true } })
  panel.render()
  panel.start()
  assert.equal(panel.starts.at(-1).webSearch, true)
})

test('full search ignores stored opt-ins and is only applied once without changing web access', () => {
  const panel = renderPanel({}, { pick: { provider: 'relay', model: 'checker', webSearch: false, fullScan: true } })
  panel.open()
  assert.equal(panel.checkbox('checker.fullScan').props.checked, false)
  panel.checkbox('checker.fullScan').props.onChange({ target: { checked: true } })
  panel.render()
  assert.equal(panel.checkbox('checker.fullScan').props.checked, true)
  assert.equal(panel.writes.length, 0)
  panel.start()
  panel.render()
  assert.equal(panel.checkbox('checker.fullScan').props.checked, false)
  panel.start()
  assert.deepEqual(panel.starts.map(({ fullScan, webSearch }) => [fullScan, webSearch]), [[true, false], [false, false]])
})

test('old hosts do not show full search or receive an opt-in', () => {
  const panel = renderPanel({}, { canFullScan: false, pick: { provider: 'relay', model: 'checker', fullScan: true } })
  panel.open()
  assert.equal(panel.checkbox('checker.fullScan'), undefined)
  panel.start()
  assert.equal(panel.starts[0].fullScan, false)
})

test('run options remain disabled while verification is running or a mutation is pending', () => {
  for (const [progress, pending] of [[{ ...RUNNING, fullScan: true }, false], [{}, true]]) {
    const panel = renderPanel(progress, { pending })
    panel.open()
    assert.equal(panel.checkbox('checker.webSearch').props.disabled, true)
    assert.equal(panel.checkbox('checker.writeBack').props.disabled, true)
    assert.equal(panel.checkbox('checker.fullScan').props.disabled, true)
    assert.equal(panel.checkbox('checker.fullScan').props.checked, !pending)
  }
})

test('verification reports positive search backend counts separately from web reads', () => {
  const panel = renderPanel({ ...RUNNING, searchBackends: { 'dsh-free-search': 3, 'host-web': 1, other: 57 } })
  panel.open()
  const detail = panel.text()
  assert.match(detail, /4 searches · 6 web-page reads/)
  assert.match(detail, /Search breakdown: 3 DSH Free Search calls · 1 Host web search calls/)
  assert.doesNotMatch(detail, /57/)
  const partial = renderPanel({ ...RUNNING, searchBackends: { 'dsh-free-search': 0, 'host-web': 2 } })
  partial.open()
  const partialDetail = partial.text()
  assert.match(partialDetail, /2 Host web search calls/)
  assert.doesNotMatch(partialDetail, /DSH Free Search/)
})

test('checker translations stay in sync and explain web costs, errors and no target-model testing', () => {
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(DICT.en).sort())
  for (const key of Object.keys(DICT.zh)) {
    const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
    assert.deepEqual(placeholders(DICT.zh[key]), placeholders(DICT.en[key]), key)
  }
  assert.match(DICT.zh['checker.hint.supplement'], /联网额度.*Token/)
  assert.match(DICT.zh['checker.hint.checker'], /跳过公开目录.*全部符合条件/)
  assert.match(DICT.zh['checker.resultsScope'], /不实测目标模型.*联网不可用时会报告错误/)
  assert.match(DICT.en['checker.hint.supplement'], /web quota and model tokens/)
  assert.match(DICT.en['checker.hint.checker'], /all eligible models, bypassing public catalogs/)
  assert.match(DICT.en['checker.resultsScope'], /without direct tests of target models.*Unavailable web access is reported as an error/)
})

test('new checker markup uses only existing theme CSS classes', () => {
  const source = readFileSync(new URL('../client-src/checker-view.mjs', import.meta.url), 'utf8')
  const used = new Set([...source.matchAll(/mvp_[A-Za-z]+/g)].map((match) => match[0]))
  const defined = new Set([...CSS.matchAll(/\.(mvp_[A-Za-z]+)/g)].map((match) => match[1]))
  assert.deepEqual([...used].filter((name) => !defined.has(name)), [])
})


test('public-only mode starts without a checker or web search and honors alias opt-in', () => {
  const panel = renderPanel({}, { canSetMode: true })
  panel.open()
  assert.equal(panel.checkbox('checker.useChecker').props.checked, true)
  assert.equal(panel.checkbox('checker.fuzzyMatch').props.checked, false)
  panel.checkbox('checker.useChecker').props.onChange({ target: { checked: false } })
  panel.render()
  assert.equal(panel.checkbox('checker.webSearch'), undefined)
  panel.checkbox('checker.fuzzyMatch').props.onChange({ target: { checked: true } })
  panel.render()
  panel.start()
  assert.deepEqual(panel.starts[0], { writeBack: false, webSearch: false, useChecker: false, fuzzyMatch: true, concurrency: 2, fullScan: false })
})


test('new hosts offer three localized modes with supplement selected and no separate web switch', () => {
  const panel = renderPanel({}, { canSetSourceMode: true, canSetMode: true, language: 'zh' })
  panel.open()
  const modes = panel.byClass('mvp_checkerMode').map((node) => panel.text(node).trim())
  assert.deepEqual(modes, ['只用公开目录', '公开目录＋校验员补漏', '仅校验员联网'])
  assert.equal(panel.modes().find((node) => node.props.checked).props.value, 'supplement')
  assert.equal(panel.checkbox('checker.useChecker'), undefined)
  assert.equal(panel.checkbox('checker.webSearch'), undefined)
  assert.ok(panel.startControl().props.disabled)
  panel.start()
  assert.deepEqual(panel.starts, [])
  const advanced = panel.findAll((node) => node.type === 'details' && panel.text(node).includes(panel.t('checker.advanced')))[0]
  assert.ok(advanced)
  assert.equal(advanced.props.open, undefined)
  assert.ok(panel.findAll((node) => node === panel.checkbox('checker.fuzzyMatch'), advanced).length)
  assert.equal(panel.checkbox('checker.fuzzyMatch').props.checked, true)
  assert.equal(panel.checkbox('checker.writeBack').props.checked, false)
  panel.field('checker.provider').props.onChange({ target: { value: 'relay' } })
  panel.render()
  assert.ok(panel.startControl().props.disabled)
  panel.field('checker.model').props.onChange({ target: { value: 'checker' } })
  panel.render()
  assert.equal(panel.startControl().props.disabled, false)
  panel.start()
  assert.deepEqual(panel.starts, [{ provider: 'relay', model: 'checker', mode: 'supplement', fuzzyMatch: true,
    writeBack: false, fullScan: false, concurrency: 2 }])
})

test('public and online-only modes send only the relevant options and retain the chosen route', () => {
  const panel = renderPanel({}, { canSetSourceMode: true, pick: { provider: 'relay', model: 'checker', writeBack: true, fuzzyMatch: false, concurrency: 5 } })
  panel.open()
  panel.chooseMode('public')
  assert.equal(panel.field('checker.provider'), undefined)
  assert.equal(panel.field('checker.model'), undefined)
  assert.equal(panel.field('checker.concurrency'), undefined)
  assert.equal(panel.checkbox('checker.writeBack'), undefined)
  panel.checkbox('checker.fullScan').props.onChange({ target: { checked: true } })
  panel.render()
  panel.start()
  assert.deepEqual(panel.starts[0], { mode: 'public', writeBack: false, fuzzyMatch: false, concurrency: 5, fullScan: true })
  panel.chooseMode('checker')
  assert.equal(panel.field('checker.model').props.value, 'checker')
  assert.equal(panel.checkbox('checker.fullScan'), undefined)
  assert.equal(panel.checkbox('checker.fuzzyMatch'), undefined)
  assert.equal(panel.checkbox('checker.webSearch'), undefined)
  assert.match(panel.text(), /Provider write-back on/)
  panel.start()
  assert.deepEqual(panel.starts[1], { mode: 'checker', provider: 'relay', model: 'checker', writeBack: true,
    fuzzyMatch: false, concurrency: 5, fullScan: true })
  assert.equal(panel.writes.at(-1).value.mode, 'checker')
  panel.chooseMode('supplement')
  panel.start()
  assert.deepEqual(panel.starts[2], { mode: 'supplement', provider: 'relay', model: 'checker', writeBack: true,
    fuzzyMatch: false, concurrency: 5, fullScan: false })
})

test('legacy offline intent migrates without silently enabling web search; older hosts ignore the new mode', () => {
  for (const legacy of [{ webSearch: false }, { useChecker: false }]) {
    const panel = renderPanel({}, { canSetSourceMode: true, pick: { ...legacy, provider: 'relay', model: 'checker' } })
    panel.open()
    assert.equal(panel.modes().find((node) => node.props.checked).props.value, 'public')
    panel.start()
    assert.equal(panel.starts[0].mode, 'public')
  }
  const panel = renderPanel({}, { canSetMode: true, pick: { mode: 'checker', webSearch: false, provider: 'relay', model: 'checker' } })
  panel.open()
  assert.equal(panel.modes().length, 0)
  assert.equal(panel.checkbox('checker.webSearch').props.checked, false)
  panel.start()
  assert.deepEqual(panel.starts[0], { provider: 'relay', model: 'checker', writeBack: false, useChecker: true,
    webSearch: false, fuzzyMatch: false, concurrency: 2, fullScan: false })
})

test('run status shows the Host route and exact plan, including a known zero, not the locally selected mode', () => {
  const panel = renderPanel({ ...RUNNING, mode: 'supplement', checker: { provider: 'actual', model: 'remote' },
    catalogTargets: 10, catalogMatches: 10, checkerTargets: 0, publicOnly: 7 }, { canSetSourceMode: true, pick: { mode: 'public' } })
  panel.open()
  assert.equal(panel.modes().find((node) => node.props.checked).props.value, 'supplement')
  assert.ok(panel.modes().every((node) => node.props.disabled))
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /Public catalogs \+ checker/)
  assert.match(panel.text(), /Catalog lookup: 10 models · 10 catalog matches · 0 models assigned to the checker · Checker actual\/remote/)
  assert.match(panel.text(), /Catalog facts for 7 models/)
  const publicRun = renderPanel({ ...RUNNING, mode: 'public', checkerTargets: 0 }, { canSetSourceMode: true })
  publicRun.open()
  assert.doesNotMatch(publicRun.text(), /4 searches|1.5K tokens/)
})

test('short errors keep details accessible and action errors are bounded', async () => {
  const long = 'Request rejected: ' + 'verbose '.repeat(40)
  const panel = renderPanel({ phase: 'error', errors: [long, 'two', 'three', 'four'] },
    { canSetSourceMode: true, pick: { mode: 'public' }, startError: new Error(long) })
  panel.open()
  const [preview, full] = panel.byClass('mvp_errorList')
  assert.equal(panel.findAll((node) => node.type === 'li', preview).length, 3)
  assert.match(panel.text(preview), /…/)
  assert.doesNotMatch(panel.text(preview), /four/)
  assert.ok(panel.text(full).includes(long))
  assert.match(panel.text(full), /four/)
  panel.start()
  await new Promise(setImmediate)
  panel.render()
  const alert = panel.findAll((node) => node.props.role === 'alert')[0]
  assert.match(panel.text(alert), /Request rejected: .*…/)
  assert.ok(panel.text(panel.byClass('mvp_errorList')[1]).includes(long))
  assert.match(panel.text(panel.byClass('mvp_badge')[0]), /4 errors/)
})

test('a fatal run still reports partial outcomes and usage', () => {
  const panel = renderPanel({ ...RUNNING, running: false, phase: 'error', mode: 'checker', checkerTargets: 10,
    errors: ['could not save one batch'] }, { canSetSourceMode: true })
  assert.match(panel.text(panel.byClass('mvp_checkerSummary')[0]), /Verification failed · Online checker only · 7\/10 processed/)
  panel.open()
  assert.match(panel.text(), /3 valid.*6 web-page reads.*1.5K tokens/)
  assert.equal(panel.findAll((node) => node.props.role === 'progressbar').length, 0)
})

test('verification cancel remains visible when the enriched catalog is unavailable', () => {
  const panel = renderPanel(RUNNING, { canUse: false })
  const cancel = panel.findAll((node) => node.props.title === panel.t('checker.cancelTitle'))
  assert.equal(cancel.length, 1, 'a running sweep exposes cancel even before expanding')
  assert.equal(cancel[0].props.disabled, false)
  cancel[0].props.onClick()
  assert.deepEqual(panel.cancels, [undefined])
  const done = renderPanel({ phase: 'done' }, { canUse: false, pick: { provider: 'relay', model: 'checker' } })
  done.open()
  const start = done.findAll((node) => node.props.title === done.t('checker.startTitle'))[0]
  assert.equal(start.props.disabled, true)
  start.props.onClick()
  assert.equal(done.starts.length, 0)
})

test('incremental write-back explains skipped prior results without requesting an unsolicited full scan', () => {
  const panel = renderPanel({ phase: 'done', total: 0, writeBack: true, skippedKnown: 12 },
    { pick: { provider: 'relay', model: 'checker', writeBack: true } })
  panel.open()
  assert.match(panel.text(), /Recheck existing models to include earlier results/)
  assert.match(panel.text(), /12 known models were skipped and not written back/)
  panel.start()
  assert.equal(panel.starts[0].fullScan, false)
})

test('a cancelled sweep still shows a dispatched pending provider write', () => {
  const panel = renderPanel({ phase: 'cancelled', pendingWrite: { provider: 'relay', model: 'target', waitEnded: 'CANCELLED' } }, { canUse: false })
  const status = panel.findAll((node) => node.props.role === 'status')
  assert.equal(status.length, 1)
  assert.match(panel.text(status[0]), /still pending \(relay\/target\)/)
  const settled = renderPanel({ phase: 'cancelled', latestWriteSettlement: { provider: 'relay', model: 'target', finishedAt: 5, written: true } })
  settled.open()
  assert.match(settled.text(), /delayed provider write was applied/)
})

test('known non-chat models are absent from both selectors; invalid stored choices cannot start', () => {
  const groups = [{ id: 'images', models: [{ id: 'img', kind: 'image' }] }, { id: 'mixed', models: [
    { id: 'checker', kind: 'chat' }, { id: 'emb', kind: 'embedding' }, { id: 'old-no-kind' }, { id: 'video', kind: 'video' },
  ] }]
  const p = renderPanel({}, { groups, canSetSourceMode: true, pick: { provider: 'mixed', model: 'emb' } })
  p.open()
  assert.deepEqual(p.findAll(n => n.type === 'option', p.field('checker.provider')).map(n => n.props.value), ['', 'mixed'])
  assert.deepEqual(p.findAll(n => n.type === 'option', p.field('checker.model')).map(n => n.props.value), ['', 'checker', 'old-no-kind'])
  assert.equal(p.field('checker.model').props.value, '')
  assert.ok(p.startControl().props.disabled); p.start(); assert.equal(p.starts.length, 0)
})

test('scope is visible beside Start, counts deduplicate exact IDs, and warnings stay outside Advanced', () => {
  const groups = [{ id: 'a', models: [{ id: 'test' }, { id: 'same' }] }, { id: 'b', models: [{ id: 'same' }, { id: 'other' }] }]
  const p = renderPanel({}, { groups, pick: { provider: 'a', model: 'test', writeBack: true } })
  p.open()
  p.checkbox('checker.fullScan').props.onChange({ target: { checked: true } }); p.render()
  const id = p.startControl().props['aria-describedby']
  const [scope] = p.findAll(n => n.props.id === id)
  assert.match(p.text(scope), /2 providers and up to 2 distinct model IDs/)
  assert.match(p.text(scope), /Provider write-back on.*rechecks existing records/)
  assert.ok(!p.findAll(n => n.type === 'details').some(n => p.findAll(x => x === scope, n).length))
})

test('reported catalog matches, exact public imports, source failures and all four token buckets stay distinct', () => {
  const p = renderPanel({ ...RUNNING, mode: 'supplement', tokenUsage: [100, 200, 300, 400], catalogMatches: 7,
    publicOnly: 7, publicReliable: 0, aliasMatches: 1, sourceFailures: 2 })
  p.open()
  assert.match(p.text(), /7 catalog matches.*Reliably imported this run: 0/)
  assert.match(p.text(), /1K tokens/); assert.match(p.text(), /2 source reads failed.*not model failures/)
  assert.match(p.text(), /1 advisory alias matches/); assert.doesNotMatch(p.text(), /Catalog facts for 7 models/)
})

test('modern cancellation uses the displayed run ID, and a missing promised ID cannot cancel', () => {
  const p = renderPanel({ ...RUNNING, runId: 'run-7' }, { features: ['runId'] })
  p.findAll(n => n.props.title === p.t('checker.cancelTitle'))[0].props.onClick()
  assert.deepEqual(p.cancels, ['run-7'])
  const missing = renderPanel(RUNNING, { features: ['runId'] })
  const [blocked] = missing.findAll(n => n.props.title === missing.t('checker.stopNoId'))
  assert.equal(blocked.props.disabled, true); blocked.props.onClick(); assert.deepEqual(missing.cancels, [])
})

const PREVIEW = { ticket: 'opaque-one-use', expiresAt: Date.now() + 3600_000, scopeCount: 1,
  total: 1, eligible: 1, skipped: 0, rows: [{ provider: 'relay', model: 'x', status: 'pending', authorized: true, reason: 'ready' }] }
const bulkShape = () => ({ status: 'ready', epoch: 1, pending: false, snapshot: { enabled: false, running: false, rows: [],
  counts: { pending: 0, written: 0, failed: 0, skipped: 0 }, scopeCount: 0 } })
function bulkFixture(preview = Promise.resolve(PREVIEW)) {
  const state = bulkShape(), calls = []
  const api = { subscribe: () => () => {}, getSnapshot: () => state,
    preview(signal) { calls.push({ action: 'preview', signal }); return preview },
    async enable(ticket) { calls.push({ action: 'enable', ticket }); state.snapshot.enabled = true },
    async disable() { calls.push({ action: 'disable' }); state.snapshot.enabled = false },
    async load() { calls.push({ action: 'status' }) },
  }
  const p = renderPanel({}, { bulkPart: 'BulkEffortsControl', bulk: api })
  return { state, calls, api, p, toggle: () => p.findAll(n => n.props.role === 'switch')[0].props.onClick(),
    dialog: () => p.findAll(n => n.type?.name === 'BulkConfirmDialog')[0]?.props }
}

test('only the advertised/enabled panel mounts its bulk control, never an old Host or unopened panel', () => {
  const ctrls = (p) => p.findAll(n => n.type?.name === 'BulkEffortsControl')
  const api = bulkFixture().api
  const old = renderPanel({}, { bulk: api }); old.open(); assert.equal(ctrls(old).length, 0)
  const now = renderPanel({}, { bulk: api, features: ['bulkEfforts'] }); assert.equal(ctrls(now).length, 0)
  now.open(); assert.equal(ctrls(now).length, 1)
})

test('opening the switch only previews; cancellation/Escape cannot authorize a late preview', async () => {
  const d = Promise.withResolvers(), { calls, p, toggle, dialog } = bulkFixture(d.promise)
  toggle(); toggle(); p.render()
  assert.deepEqual(calls.map(x => x.action), ['preview'])
  assert.equal(p.findAll(n => n.props.role === 'switch')[0].props['aria-checked'], false)
  const modal = renderPanel({}, { bulkPart: 'BulkConfirmDialog', componentProps: dialog() })
  const [agree] = modal.findAll(n => n.type === 'button' && modal.text(n) === modal.t('bulk.agree'))
  assert.equal(agree.props.disabled, true); agree.props.onClick()
  const root = modal.findAll(n => n.type === 'dialog')[0]
  root.props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  assert.equal(calls[0].signal.aborted, true)
  d.resolve(PREVIEW); await new Promise(setImmediate); p.render()
  assert.equal(dialog(), undefined); assert.deepEqual(calls.map(x => x.action), ['preview'])
})

test('only explicit confirmation posts the reviewed ticket once; turning off never posts apply', async () => {
  const { calls, p, toggle, dialog, state } = bulkFixture()
  toggle(); await new Promise(setImmediate); p.render()
  const opts = dialog(); assert.ok(opts)
  const modal = renderPanel({}, { bulkPart: 'BulkConfirmDialog', componentProps: opts, language: 'zh' })
  const d = modal.findAll(n => n.type === 'dialog')[0]
  const [agree] = modal.findAll(n => n.type === 'button' && modal.text(n) === opts.t('bulk.agree'))
  assert.equal(d.props['aria-modal'], true)
  assert.ok(modal.text().includes('No external network')); assert.ok(modal.text().includes('Not a free pass'))
  assert.equal(agree.props.disabled, false); agree.props.onClick(); agree.props.onClick()
  await new Promise(setImmediate); p.render()
  assert.deepEqual(calls.map(x => x.action), ['preview', 'enable']); assert.equal(calls[1].ticket, PREVIEW.ticket)
  assert.equal(state.snapshot.enabled, true)
  toggle(); await new Promise(setImmediate); p.render(); assert.equal(state.snapshot.enabled, false)
  assert.deepEqual(calls.map(x => x.action), ['preview', 'enable', 'disable'])
})

test('a cancelled dialog cannot use its ticket after a new preview is opened on the same Host', async () => {
  const f = bulkFixture(); f.toggle(); await new Promise(setImmediate); f.p.render(); const previous = f.dialog()
  previous.close(); f.p.render(); f.toggle(); await new Promise(setImmediate); f.p.render()
  previous.agree(); assert.deepEqual(f.calls.map(c => c.action), ['preview', 'preview']); assert.ok(f.dialog())
})

test('an expired, replaced Host or zero-scope preview cannot enable; waiting-only scope can', async () => {
  for (const mode of ['expired', 'reset', 'empty', 'waiting']) {
    const data = { ...PREVIEW, ...(mode === 'expired' ? { expiresAt: 1 } : mode === 'empty' ? { scopeCount: 0 } : { eligible: 0, skipped: 1 }) }
    const f = bulkFixture(Promise.resolve(data)); f.toggle(); await new Promise(setImmediate); f.p.render()
    const stale = f.dialog(); if (mode === 'reset') f.state.epoch++
    stale.agree(); await new Promise(setImmediate)
    assert.equal(f.calls.some(v => v.action === 'enable'), mode === 'waiting', mode)
  }
})

for (const language of ['zh', 'en']) {
  test(`${language}: ending future authorization cannot erase or relabel an earlier confirmed write`, () => {
    const rows = ['disabled', 'target-changed', 'manual-protected'].map((authorizationReason, i) => ({
      provider: 'relay', model: `m${i}`, authorized: false, authorizationReason,
      status: 'written', reason: i === 0 ? 'partial' : 'verified', writtenEfforts: ['high'],
    }))
    const state = { ...bulkShape(), snapshot: { ...bulkShape().snapshot, rows, counts: { written: 3, skipped: 0, failed: 0, pending: 0 } } }
    const receipt = renderPanel({}, { bulkPart: 'BulkEffortsControl', language, bulk: { getSnapshot: () => state } })
    assert.ok(receipt.text().includes(receipt.t('bulk.receipt', state.snapshot.counts)))
    const list = renderPanel({}, { bulkPart: 'BulkRows', language, componentProps: { rows } })
    list.findAll(n => n.type === 'details')[0].props.onToggle({ currentTarget: { open: true } }); list.render()
    for (const [i,item] of list.findAll(n => n.type === 'li').entries()) {
      const text = list.text(item)
      assert.ok(text.includes(list.t('bulk.reason.' + rows[i].reason)))
      assert.ok(text.includes(list.t('bulk.writtenLevels', { levels: 'high' })))
      assert.ok(text.includes(list.t('bulk.authorizationStopped', { reason: list.t('bulk.reason.' + rows[i].authorizationReason) })))
    }
  })
  test(`${language}: unverified dispatched writes are separate from confirmed failures, pending writes and protected skips`, () => {
    const rows = [
      { provider: 'p', model: 'a', status: 'failed', reason: 'settings-unverified' }, // old Host: read-back-only code
      { provider: 'p', model: 'b', status: 'failed', reason: 'settings-failed', dispatched: true, outcomeUnknown: true },
      { provider: 'p', model: 'c', status: 'failed', reason: 'read-unavailable' }, // failed before dispatch
      { provider: 'p', model: 'd', status: 'pending', reason: 'dispatched', dispatched: true },
      { provider: 'p', model: 'e', status: 'skipped', reason: 'prior-write-unverified', authorized: false },
    ]
    const state = { ...bulkShape(), snapshot: { enabled: false, running: false, scopeCount: 0, rows,
      unverified: 2, counts: { written: 0, skipped: 1, failed: 3, pending: 1 } } }
    const p = renderPanel({}, { bulkPart: 'BulkEffortsControl', language, bulk: { getSnapshot: () => state } })
    // Count each model once; the Host's failed=3 includes the two unknown dispatches, but pending and skipped do not.
    assert.ok(p.text().includes(p.t('bulk.receiptUnverified', { written: 0, skipped: 1, failed: 1, unverified: 2, pending: 1 })))
    assert.match(p.text(), language === 'zh' ? /提供商设置逐项核对，勿重试/ : /in its provider settings; do not retry/)
    assert.doesNotMatch(p.text(), /本地设置已保留|本地已保存|local override was retained/i)
    const list = renderPanel({}, { bulkPart: 'BulkRows', language, componentProps: { rows } })
    list.findAll(n => n.type === 'details')[0].props.onToggle({ currentTarget: { open: true } }); list.render()
    const items = list.findAll(n => n.type === 'li').map(n => list.text(n))
    assert.ok(items[0].includes(list.t('bulk.status.unverified')) && items[0].includes(list.t('bulk.reason.settings-unverified')))
    assert.ok(items[1].includes(list.t('bulk.status.unverified')) && items[1].includes(list.t('bulk.reason.dispatch-unconfirmed')))
    assert.ok(items[2].includes(list.t('bulk.status.failed')) && !items[2].includes(list.t('bulk.status.unverified')))
    assert.ok(items[3].includes(list.t('bulk.status.pending')) && !items[3].includes(list.t('bulk.status.unverified')))
    assert.ok(items[4].includes(list.t('bulk.status.skipped')) && items[4].includes(list.t('bulk.reason.prior-write-unverified')))
    assert.doesNotMatch(list.text(), /本地设置已保留|本地已保存|local override was retained/i)
    assert.equal(list.findAll(n => n.type === 'button').length, 0, 'a receipt does not offer a write retry')
  })
}

test('native modal uses safe initial focus, Tab wrapping, Escape and restoration to the initiator', () => {
  const calls = []
  const button = (name) => ({ name, focus() { calls.push(name) }, getClientRects() { return [{}] } })
  const trigger = { current: { ...button('trigger'), isConnected: true } }
  const p = renderPanel({}, { bulkPart: 'BulkConfirmDialog', componentProps: { review: { data: PREVIEW }, trigger, close() { calls.push('cancel') }, agree() {} } })
  const d = p.findAll(n => n.type === 'dialog')[0]
  const [cancel] = p.findAll(n => n.type === 'button' && n.props.autoFocus)
  const a = button('first'), b = button('last')
  d.props.ref.current = { showModal() { calls.push('modal') }, close() { calls.push('closed') },
    querySelectorAll: () => [a, b], ownerDocument: { activeElement: b } }
  cancel.props.ref.current = button('safe')
  const cleanup = p.layouts[0]()
  const key = (key, shiftKey) => d.props.onKeyDown({ key, shiftKey, preventDefault() {}, stopPropagation() {} })
  key('Tab'); d.props.ref.current.ownerDocument.activeElement = a; key('Tab', true); key('Escape'); cleanup()
  assert.deepEqual(calls, ['modal', 'safe', 'first', 'last', 'cancel', 'closed', 'trigger'])
  assert.match(CHECKER_CSS, /max-height:[^;]+;overflow:auto/); assert.match(CHECKER_CSS, /::backdrop/)
})

test('full scope and receipts are inspectable in bounded pages without conflating same-name models', () => {
  const rows = Array.from({ length: 43 }, (_, i) => ({ model: 'same', provider: `p${i}`, authorized: i === 0,
    status: i ? 'skipped' : 'written', reason: i ? 'awaiting-evidence' : '', source: 'catalog' }))
  const p = renderPanel({}, { bulkPart: 'BulkRows', componentProps: { rows } })
  assert.equal(p.findAll(n => n.type === 'li').length, 0)
  p.findAll(n => n.type === 'details')[0].props.onToggle({ currentTarget: { open: true } }); p.render()
  assert.equal(p.findAll(n => n.type === 'li').length, 40); assert.match(p.text(), /Within scope.*Written.*Outside scope.*Skipped/)
  p.findAll(n => n.type === 'button')[0].props.onClick(); p.render()
  assert.equal(p.findAll(n => n.type === 'li').length, 43); assert.match(p.text(), /Provider: p42.*Model: same/)
})

function renderUsage(state, fetch) {
  let cursor = 0
  const slots = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], (value) => { slots[index] = value }]
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useEffect: () => {},
  }
  const modules = { react: React, constants, pure, hooks: { useSource: () => state } }
  const { UsageToolbar } = loadComponent('usage-view', (name) => modules[name], {}, { fetch, AbortSignal, AbortController, setTimeout, clearTimeout })
  const t = (key, params) => DICT.en[key].replace(/\{(\w+)\}/g, (_, name) => params[name])
  return () => {
    cursor = 0
    const tree = UsageToolbar({ usage: {}, t, features: ['usage'] })
    const elements = []
    const visit = (node) => {
      if (node && typeof node === 'object' && node.props) {
        elements.push(node)
        node.props.children.forEach(visit)
      }
    }
    visit(tree)
    return elements
  }
}

test('usage distinguishes absent or cold data, measured zero, and scan errors', () => {
  const state = { snapshot: null, error: null }
  const render = renderUsage(state)
  const values = () => render().filter((node) => node.props.className === 'mvp_statValue').map((node) => node.props.children[0])
  assert.deepEqual(values(), ['—', '—', '—', '—'])
  state.snapshot = { ranges: { today: [0, 0, 0, 0] }, computing: true }
  assert.deepEqual(values(), ['—', '—', '—', '—'])
  assert.ok(render().some((node) => node.props.role === 'status' && node.props.children.some(child => child?.props?.children.includes('scanning…'))))
  state.snapshot.computing = false
  assert.deepEqual(values(), ['0', '—', '—', '—'])
  state.snapshot.error = 'could not read one log'
  assert.deepEqual(values(), ['—', '—', '—', '—'])
  assert.ok(render().some((node) => node.props.role === 'status' && node.props.title?.includes('one log')))
})

test('cold export shows progress and displays a same-origin CSV request failure', async () => {
  const reply = Promise.withResolvers()
  const calls = []
  const render = renderUsage({ snapshot: null, error: null }, (url, init) => { calls.push({ url, init }); return reply.promise })
  const button = render().find((node) => node.props.children[0] === 'Usage CSV')
  button.props.onClick()
  assert.match(calls[0].url, /\/export\?type=usage$/)
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.ok(render().some((node) => node.props.role === 'status' && node.props.title?.includes('preparing')))
  reply.resolve(Response.json({ error: { message: 'scan failed' } }, { status: 500 }))
  await new Promise(setImmediate)
  const failed = render()
  assert.ok(failed.some((node) => node.props.role === 'status' && node.props.title?.includes('scan failed')))
  assert.equal(failed.find((node) => node.props.children[0] === 'Usage CSV').props.disabled, false)
})


test('override editor saves the captured revision and preserves untouched fields and ladder order', () => {
  const slots = []
  const saves = []
  let cursor = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial } },
    useId: () => `test-id-${cursor++}`,
    useEffect: () => {},
  }
  const modules = { react: React, format, 'diagnostic-events': diagnosticEvents }
  const { ModelOverrideEditor } = loadComponent('override-editor', (name) => modules[name], {})
  const entry = { provider: 'relay', model: 'org/model', kind: 'chat', contextWindow: 32_000,
    input: ['image', 'text'], efforts: [{ id: 'custom' }, { id: 'high' }, { id: 'low' }], defaultEffort: 'high' }
  const render = (stale = false) => {
    cursor = 0
    const tree = ModelOverrideEditor({ entry, name: 'Model', revision: 'r1', stale, hasOverride: true,
      t: (key) => key, overrides: { save: async (payload, revision) => saves.push({ payload, revision }) } })
    const elements = []
    const visit = (node) => {
      if (node && typeof node === 'object' && node.props) {
        elements.push(node)
        node.props.children.forEach(visit)
      }
    }
    visit(tree)
    return elements
  }
  render().find((node) => node.props['aria-label'] === 'override.context').props.onInput({ target: { value: '64000' } })
  const staleSave = render(true).find((node) => node.props.children[0] === 'override.saveLocal')
  assert.equal(staleSave.props.disabled, true)
  staleSave.props.onClick()
  assert.equal(saves.length, 0)
  render().find((node) => node.props.children[0] === 'override.saveLocal').props.onClick()
  assert.deepEqual(JSON.parse(JSON.stringify(saves)), [{ revision: 'r1', payload: { ...entry,
    contextWindow: 64_000, applyToProvider: false } }])
})
