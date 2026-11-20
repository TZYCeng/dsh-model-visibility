/**
 * Rendering smoke test for the shipped bundle.
 *
 * The unit suite passed 115/115 while every model switch on the settings page
 * threw `ReferenceError: FIELD is not defined`: the hygiene test only scans
 * `identifier(` call sites, and the bundle test only checks that the factory
 * returns `{ inject, apply }`. Neither ever RENDERS the section.
 *
 * This test evaluates the real `client.js` against a minimal React and a fake
 * `ctx`, renders the settings section with a loaded catalog, and clicks every
 * interactive control. A thrown handler fails the test.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const code = readFileSync(path.join(root, 'client.js'), 'utf8')

/** Catalog the render uses; shapes mirror lib/model-info.js output. */
const CATALOG = {
  ok: true,
  value: {
    groups: [
      {
        id: 'relay',
        name: 'Relay',
        models: [
          {
            id: 'grok-4.7',
            name: 'grok-4.7',
            kind: 'chat',
            inputModalities: ['text', 'image'],
            contextWindow: 500000,
            reasoningSupported: true,
            reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
            sources: { kind: 'config', modalities: 'config', context: 'config', reasoning: 'config' },
          },
          {
            id: 'plain-model',
            name: 'plain-model',
            kind: 'chat',
            inputModalities: ['text'],
            contextWindow: 128000,
            sources: { kind: 'snapshot', modalities: 'snapshot', context: 'snapshot', reasoning: 'unknown' },
          },
          {
            id: 'gpt-image-2',
            name: 'gpt-image-2',
            kind: 'image',
            inputModalities: ['text', 'image'],
            outputModalities: ['image'],
            sources: { kind: 'provider', modalities: 'provider', context: 'unknown', reasoning: 'unknown' },
          },
          {
            id: 'glm-5.3',
            name: 'glm-5.3',
            kind: 'chat',
            inputModalities: ['text'],
            sources: { kind: 'snapshot', modalities: 'official', context: 'unknown', reasoning: 'unknown' },
            correction: { id: 'glm-5.3', code: 'glm-5.3-text-only', note: 'text only', source: 'https://x' },
          },
        ],
      },
      { id: 'empty-route', name: 'Empty', models: [] },
    ],
    failures: [],
    providers: [
      { id: 'relay', host: 'relay.example', status: 'ok', models: 4, capabilities: 2, pricing: 'ok' },
    ],
    learned: {
      models: 3,
      updatedAt: Date.now(),
      features: ['applyInput', 'reload', 'overrides', 'verify', 'usage', 'checkerBudget', 'verifyWeb'],
    },
    generatedAt: 1,
  },
}

/**
 * Build one render pass against the real bundle.
 * @returns the harness: render(), elements collected in the last pass, and every
 *   handler that threw (which the test asserts is empty).
 */
function createHarness({ catalog = CATALOG, formValue = { hidden: ['relay/plain-model'], applyInput: true }, writable = true, overrideRead } = {}) {
  const postedOverrides = []
  const editorState = []
  let slots
  const elements = []
  const effects = []
  const state = []
  let cursor = 0

  const makeElement = (type, props, ...children) => {
    const element = { type, props: { ...(props ?? {}), children: children.flat() } }
    elements.push(element)
    return element
  }

  const react = {
    createElement: makeElement,
    Fragment: 'Fragment',
    useState: (initial) => {
      // Re-seed per render pass is not how React works; this harness keeps one
      // component instance alive across renders, which is what a click needs.
      const slot = cursor++
      const target = slots
      if (target[slot] === undefined) target[slot] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        target[slot] = typeof next === 'function' ? next(target[slot]) : next
      }
      return [target[slot], setter]
    },
    useEffect: (fn) => { effects.push(fn) },
    useLayoutEffect: (fn) => { effects.push(fn) },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (value) => {
      const slot = cursor++
      return slots[slot] ??= { current: value }
    },
    useId: () => 'test-id-' + cursor++,
    useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  }

  const formState = { value: { ...formValue }, writable }
  const writes = []
  const form = {
    getSnapshot: () => formState,
    subscribe: () => () => {},
    set(field, value) {
      writes.push({ field, value })
      return Promise.resolve(true)
    },
  }

  const registrations = { section: null }
  const remoteEvents = new Map()
  const fetches = []
  const effectScope = {
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
  }
  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on: () => () => {},
    inject: (_deps, callback) =>
      callback({ modelDirectories: { directoryFor: (id) => id }, effect: effectScope.effect }),
    locale: { register: () => () => {}, bind: () => (key) => key },
    configForms: { get: () => form },
    remote: {
      $on: (name, handler) => { remoteEvents.set(name, handler); return () => remoteEvents.delete(name) },
      session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) },
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (_options, component) => {
        registrations.section = component
        return () => {}
      },
    },
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          sandbox.__exported = definition.factory((name) => {
            if (name === 'react') return react
            throw new Error('unexpected require: ' + name)
          })
        },
      },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: {
      baseURI: 'http://127.0.0.1:1/',
      createElement: () => ({ dataset: {}, remove() {}, click() {}, textContent: '' }),
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
      querySelector: () => null,
    },
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: async (url, init) => {
      fetches.push(String(url))
      if (String(url).endsWith('/overrides') && init?.method === 'POST') {
        postedOverrides.push(JSON.parse(init.body))
        return { ok: true, status: 200, json: async () => ({ ok: true, value: { overrides: [], revisions: [] } }) }
      }
      if (String(url).endsWith('/overrides') && overrideRead) return overrideRead()
      return ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/usage')
          ? {
              ok: true,
              value: {
                generatedAt: 1,
                computing: false,
                progress: null,
                ranges: { today: [1, 2, 0, 0], week: [1, 2, 0, 0], month: [1, 2, 0, 0], total: [1, 2, 0, 0] },
                days: {},
                byModel: {},
              },
            }
          : String(url).includes('/overrides')
            ? { ok: true, value: { overrides: [], revisions: [] } }
            : String(url).includes('/verify')
              ? { ok: true, value: { state: { running: false, done: 0, total: 0 }, learned: { models: 0 } } }
              : catalog,
    }) },
  }

  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  const exported = sandbox.__exported
  exported.apply(ctx)
  const Section = registrations.section
  if (typeof Section !== 'function') throw new Error('the settings section did not register')

  const t = (key) => key
  const editorT = (key, values) => values ? `${key}: ${JSON.stringify(values)}`
    : key.startsWith('effort.') ? key.slice('effort.'.length) : key
  const render = () => {
    elements.length = 0
    slots = state
    cursor = 0
    return Section({ t })
  }
  const renderEditor = () => {
    render()
    const editor = elements.find((node) => node.type.name === 'ModelOverrideEditor')
    assert.ok(editor, 'settings row must open the editor')
    elements.length = 0
    slots = editorState
    cursor = 0
    return editor.type({ ...editor.props, t: editorT })
  }

  /** Every clickable control in the last render pass. */
  const controls = () =>
    elements.filter(
      (element) =>
        element.type === 'button' &&
        typeof element.props.onClick === 'function' &&
        element.props.disabled !== true,
    )

  return { render, renderEditor, effects, elements, controls, writes, postedOverrides, exported, formState, t, remoteEvents, fetches }
}

/** Run data effects so the section sees a loaded catalog. */
async function settle(harness) {
  for (const fn of harness.effects.splice(0)) await fn()
  await new Promise((resolve) => setTimeout(resolve, 20))
}

/** Values from the vm sandbox are a different realm; compare as plain JSON. */
function plain(value) {
  return JSON.parse(JSON.stringify(value))
}

test('the settings section renders a loaded catalog without throwing', async () => {
  const harness = createHarness()
  harness.render()
  await settle(harness)
  const tree = harness.render()
  assert.ok(tree !== null && tree !== undefined)
  const titles = harness.elements
    .filter((element) => String(element.props.className).includes('mvp_rowTitle'))
    .map((element) => [].concat(element.props.children).flat().join(''))
  assert.deepEqual(plain(titles), ['grok-4.7', 'plain-model', 'gpt-image-2', 'glm-5.3'])
})

test('every enabled control in the header and filters is safe to click', async () => {
  const harness = createHarness()
  harness.render()
  await settle(harness)
  harness.render()
  const baseline = harness.controls().length
  assert.ok(baseline >= 8, `expected the header and filter controls, got ${baseline}`)
  const thrown = []
  for (const control of harness.controls()) {
    try {
      control.props.onClick()
    } catch (error) {
      thrown.push(`${control.props.className}: ${error.message}`)
    }
  }
  assert.deepEqual(thrown, [])
})

test('the per-model switch writes the hidden list (the FIELD regression)', async () => {
  const harness = createHarness()
  harness.render()
  await settle(harness)
  harness.render()
  const switches = harness.elements.filter(
    (element) => element.type === 'button' && element.props.role === 'switch' && element.props['aria-label'] === 'grok-4.7',
  )
  assert.equal(switches.length, 1, 'the model row must expose a switch')
  // This is the exact call that threw `ReferenceError: FIELD is not defined`.
  switches[0].props.onClick()
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.writes[0].field, 'hidden')
  assert.deepEqual(plain(harness.writes[0].value).sort(), ['relay/grok-4.7', 'relay/plain-model'])
})

test('the group and page-level visibility buttons write the hidden list', async () => {
  const harness = createHarness()
  harness.render()
  await settle(harness)
  harness.render()
  const groupButton = harness.elements.find(
    (element) =>
      element.type === 'button' &&
      String(element.props.className).includes('mvp_button') &&
      Array.isArray(element.props.children) &&
      String(element.props.children[0]).startsWith('group.'),
  )
  assert.ok(groupButton !== undefined, 'the group toggle must render')
  groupButton.props.onClick()
  assert.equal(harness.writes.length, 1)
  assert.equal(harness.writes[0].field, 'hidden')

  const showAll = harness.elements.find(
    (element) =>
      element.type === 'button' &&
      Array.isArray(element.props.children) &&
      element.props.children[0] === 'page.showAll',
  )
  assert.ok(showAll !== undefined, 'the show-all control must render')
  showAll.props.onClick()
  assert.deepEqual(plain(harness.writes.at(-1).value), [])
})

test('visibility and other filters scope the group action to matching models', async () => {
  const harness = createHarness()
  const byLabel = (label) => harness.elements.find((element) => element.props['aria-label'] === label)
  const byText = (label) => harness.elements.find((element) => element.props.children[0] === label)
  const titles = () => harness.elements
    .filter((element) => element.props.className === 'mvp_rowTitle')
    .map((element) => element.props.children[0])
  harness.render()
  await settle(harness)
  harness.render()
  assert.equal(byLabel('page.visibility.label').props.value, 'all')
  byLabel('page.visibility.label').props.onChange({ target: { value: 'disabled' } })
  harness.render()
  assert.deepEqual(titles(), ['plain-model'])
  byLabel('page.searchPlaceholder').props.onInput({ target: { value: 'grok' } })
  harness.render()
  assert.deepEqual(titles(), [])
  assert.ok(byText('page.filterEmpty'))
  byLabel('page.visibility.label').props.onChange({ target: { value: 'enabled' } })
  harness.render()
  assert.deepEqual(titles(), ['grok-4.7'])
  assert.equal(byText('group.hideAll'), undefined)
  byText('group.hideFiltered').props.onClick()
  assert.equal(harness.writes[0].field, 'hidden')
  assert.deepEqual(plain(harness.writes[0].value).sort(), ['relay/grok-4.7', 'relay/plain-model'])
  byLabel('page.visibility.label').props.onChange({ target: { value: 'all' } })
  harness.render()
  assert.ok(byText('group.hideFiltered'), 'a search alone changes group wording')
})

test('the applyInput switch writes its own field', async () => {
  const harness = createHarness()
  harness.render()
  await settle(harness)
  harness.render()
  const toggle = harness.elements.find(
    (element) =>
      element.type === 'button' &&
      element.props.role === 'switch' &&
      element.props['aria-label'] === 'page.applyInput',
  )
  assert.ok(toggle !== undefined)
  toggle.props.onClick()
  assert.equal(harness.writes[0].field, 'applyInput')
})

test('a verified (snapshot) source renders a dashed tag, not a declaration', async () => {
  const harness = createHarness()
  harness.render()
  await settle(harness)
  harness.render()
  const tags = harness.elements.filter(
    (element) => typeof element.props.className === 'string' && element.props.className.startsWith('mvp_tag'),
  )
  // plain-model and glm-5.3 both carry snapshot-sourced facts.
  const inferred = tags.filter((element) => element.props.className.includes('mvp_tag--inferred'))
  assert.ok(
    inferred.length > 0,
    'a snapshot-sourced tag must carry mvp_tag--inferred (dashed), otherwise an LLM answer looks like a declaration',
  )
  // A config-sourced tag on grok-4.7 must stay solid.
  const solid = tags.filter(
    (element) => !element.props.className.includes('mvp_tag--inferred') && element.props.title === 'tag.contextTitle',
  )
  assert.ok(solid.length > 0, 'a config-sourced tag must stay solid')
})

test('every referenced mvp_ class has a CSS rule and every rule is used', async () => {
  const { CSS } = await import('../client-src/css.mjs')
  const harness = createHarness()
  harness.render()
  await settle(harness)
  harness.render()
  const moduleSources = ['settings-section', 'checker-view', 'usage-view', 'override-editor', 'tags'].map((name) =>
    readFileSync(path.join(root, 'client-src', name + '.mjs'), 'utf8'),
  )
  const used = new Set()
  for (const source of moduleSources) {
    for (const match of source.matchAll(/mvp_[A-Za-z]+/g)) used.add(match[0])
  }
  const defined = new Set()
  for (const match of CSS.matchAll(/\.(mvp_[A-Za-z]+)/g)) defined.add(match[1])
  const missing = [...used].filter((name) => !defined.has(name))
  assert.deepEqual(missing, [], 'these classes are referenced but have no CSS rule')
})

/* ------------------------------------------------------- verify panel */

/**
 * Render the verify panel itself, including its nested components.
 *
 * The section-level harness above records `h(VerifyPanel, …)` without calling
 * it, so the whole panel was invisible to the tests. This helper renders
 * nested function components with a per-instance hook frame, which is enough
 * to assert on real markup.
 */
async function renderVerifyPanel(verifyValue, { pick, extraFeatures = [] } = {}) {
  const { readFileSync: read } = await import('node:fs')
  const code = read('client.js', 'utf8')
  const elements = []
  const effects = []
  const frames = new Map()
  let currentFrame

  const React = {
    Fragment: 'Fragment',
    useCallback: (fn) => fn,
    useMemo: (factory) => factory(),
    useId: () => `test-id-${currentFrame.cursor++}`,
    useRef: (value) => ({ current: value }),
    useEffect: (fn) => {
      effects.push(fn)
    },
    useLayoutEffect: (fn) => {
      effects.push(fn)
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useState(initial) {
      const frame = currentFrame
      if (frame === undefined) throw new Error('useState outside a component')
      const slot = frame.cursor
      frame.cursor += 1
      if (frame.slots[slot] === undefined) {
        frame.slots[slot] = typeof initial === 'function' ? initial() : initial
      }
      return [
        frame.slots[slot],
        (next) => {
          frame.slots[slot] = typeof next === 'function' ? next(frame.slots[slot]) : next
        },
      ]
    },
    createElement(type, props, ...children) {
      const element = { type, props: { ...(props ?? {}), children: children.flat(Infinity) } }
      elements.push(element)
      if (typeof type === 'function') {
        let frame = frames.get(type)
        if (frame === undefined) {
          frame = { slots: [], cursor: 0 }
          frames.set(type, frame)
        }
        frame.cursor = 0
        const previous = currentFrame
        currentFrame = frame
        try {
          return type({ ...element.props })
        } finally {
          currentFrame = previous
        }
      }
      return element
    },
  }

  const catalog = {
    ok: true,
    value: {
      groups: [{ id: 'relay', name: 'Relay', models: [{ id: 'grok-4.7', name: 'grok-4.7', kind: 'chat', sources: {} }] }],
      failures: [],
      providers: [],
      learned: { models: 1, features: ['applyInput', 'reload', 'overrides', 'verify', 'usage', 'checkerBudget', 'verifyWeb', ...extraFeatures] },
      generatedAt: 1,
    },
  }
  const formState = { value: { hidden: [], applyInput: true }, writable: true }
  const form = { getSnapshot: () => formState, subscribe: () => () => {}, set: () => Promise.resolve(true) }
  let Section
  const effect = (fn) => {
    const dispose = fn()
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }
  const ctx = {
    effect,
    on: () => () => {},
    inject: (_deps, callback) => callback({ modelDirectories: { directoryFor: (id) => id }, effect }),
    locale: { register: () => () => {}, bind: () => (key) => key },
    configForms: { get: () => form },
    remote: { $on: () => () => {}, session: { modelCatalog: async () => ({ ok: true, value: { groups: [] } }) } },
    slots: { inject: (_n, cb) => cb(), register: (_o, component) => { Section = component; return () => {} } },
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          sandbox.__exported = definition.factory((name) => {
            if (name === 'react') return React
            throw new Error('unexpected require: ' + name)
          })
        },
      },
      localStorage: {
        getItem: () => JSON.stringify({ provider: 'relay', model: 'grok-4.7', writeBack: true, concurrency: 4, ...(pick ?? {}) }),
        setItem: () => {},
      },
    },
    document: {
      baseURI: 'http://127.0.0.1:1/',
      createElement: () => ({ dataset: {}, remove() {}, click() {}, textContent: '' }),
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
      querySelector: () => null,
    },
    URL,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/verify') ? verifyValue
          : String(url).includes('/usage') ? { ok: true, value: { ranges: {}, days: {}, byModel: {}, computing: false } }
            : String(url).includes('/overrides') ? { ok: true, value: { overrides: [] } }
              : catalog,
    }),
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  sandbox.__exported.apply(ctx)
  const t = (key, params) => (params ? `${key}(${Object.values(params).join(',')})` : key)
  const render = () => React.createElement(Section, { t })

  let tree = render()
  await Promise.all(effects.splice(0).map((fn) => fn()))
  await new Promise((resolve) => setTimeout(resolve, 30))
  tree = render()

  const find = (node, needle, out = []) => {
    if (node === null || node === undefined || node === false) return out
    if (Array.isArray(node)) {
      for (const child of node) find(child, needle, out)
      return out
    }
    if (typeof node === 'object' && node.props !== undefined) {
      if (typeof node.props.className === 'string' && node.props.className.includes(needle)) out.push(node)
      find(node.props.children, needle, out)
    }
    return out
  }
  const open = () => {
    const head = find(tree, 'mvp_checkerHead')[0]
    if (head === undefined) throw new Error('the verify panel head did not render')
    head.props.onClick()
    tree = render()
  }
  const text = (needle) => {
    const out = []
    const visit = (node, depth) => {
      if (node === null || node === undefined || node === false) return
      if (Array.isArray(node)) {
        for (const child of node) visit(child, depth)
        return
      }
      if (typeof node === 'string') {
        if (node.trim() !== '') out.push(node)
        return
      }
      if (typeof node === 'object' && node.props !== undefined) visit(node.props.children, depth + 1)
    }
    visit(find(tree, needle)[0], 0)
    return out
  }
  return { find: (needle) => find(tree, needle), open, text }
}

const FINISHED_SWEEP = {
  ok: true,
  value: {
    state: {
      phase: 'done',
      running: false,
      total: 3,
      done: 2,
      concurrency: 4,
      tokenUsage: [1200, 300, 0, 0],
      batches: [{ ids: ['a', 'b'], status: 'ok' }],
      publicOnly: 2,
      sources: [
        { name: 'models.dev/models.json', status: 'ok', models: 1244 },
        { name: 'openrouter', status: 'ok', models: 767 },
        { name: 'huggingface huggingface.co', status: 'failed', models: 0, message: '连接超时' },
        { name: 'models.dev/api.json', status: 'ok', models: 4384 },
        { name: 'huggingface hf-mirror.com', status: 'ok', models: 1930, message: '已回退（huggingface.co 不可用）' },
      ],
      errors: ['batch 2: the checker reply contained no JSON'],
    },
    learned: { models: 12 },
  },
}

test('the verify panel reports every public catalog source', async () => {
  const panel = await renderVerifyPanel(FINISHED_SWEEP)
  panel.open()
  const lines = panel.text('mvp_sourceList')
  assert.ok(lines.some((line) => line.includes('models.dev/models.json')), 'a source name must render')
  assert.ok(lines.some((line) => line.includes('hf-mirror.com')), 'the fallback host must render')
  assert.ok(
    lines.some((line) => line.includes('连接超时')),
    'a failed source must show its reason, not just its name',
  )
  assert.ok(
    lines.some((line) => line.includes('已回退')),
    'the panel must explain why a mirror was used',
  )
})

test('the verify panel keeps the chosen thread count under advanced options', async () => {
  const panel = await renderVerifyPanel(FINISHED_SWEEP)
  panel.open()
  const concurrency = panel.find('mvp_select').find((element) => element.props['aria-label'] === 'checker.concurrency')
  assert.ok(concurrency, 'a concurrency control must exist')
  assert.equal(concurrency.props.value, '4')
  assert.ok(panel.text('mvp_checkerDetails').includes('checker.advanced'))
})

test('the verify panel lists failed batch reasons instead of a bare count', async () => {
  const panel = await renderVerifyPanel(FINISHED_SWEEP)
  panel.open()
  assert.ok(panel.find('mvp_errorList').length > 0)
  const reasons = panel.text('mvp_errorList')
  assert.ok(reasons.some((line) => line.includes('contained no JSON')))
})

test('a sweep resolved only from public catalogs is announced', async () => {
  const panel = await renderVerifyPanel(FINISHED_SWEEP)
  panel.open()
  assert.ok(panel.find('mvp_checkerProgressText').some((hint) => hint.props.children.includes('checker.catalogResults(2)')))
})

test('Settings exposes source modes only when the Host advertises verifySourceModes', async () => {
  const oldHost = await renderVerifyPanel(FINISHED_SWEEP, { extraFeatures: ['verifyModes'] })
  oldHost.open()
  assert.equal(oldHost.find('mvp_checkerModes').length, 0)
  const newHost = await renderVerifyPanel(FINISHED_SWEEP, { extraFeatures: ['verifyModes', 'verifySourceModes'] })
  newHost.open()
  assert.deepEqual(newHost.text('mvp_checkerModes'), ['checker.sourceMode', 'checker.mode.public', 'checker.mode.supplement', 'checker.mode.checker'])
})



test('only adapter levels are shown as selectable; unmatched evidence is reference-only', async () => {
  const catalog = structuredClone(CATALOG)
  const [active, estimated] = catalog.value.groups[0].models
  active.requestReasoning = active.reasoning
  active.reasoningWireDisabled = true
  active.reasoning = { efforts: [{ id: 'max', name: 'Max' }] }
  active.sources.reasoning = 'manual'
  estimated.reasoningSupported = true
  estimated.reasoning = { efforts: [{ id: 'medium', name: 'Medium' }] }
  estimated.requestReasoning = null
  estimated.sources.reasoning = 'snapshot'
  const harness = createHarness({ catalog })
  harness.render()
  await settle(harness)
  harness.render()
  const tags = harness.elements.filter(element => String(element.props.className).split(' ').includes('mvp_tag'))
    .map(element => ({ label: element.props.children.join(''), className: element.props.className }))
  assert.deepEqual(tags.filter(tag => tag.label.startsWith('tag.effort ')).map(tag => tag.label), ['tag.effort Low/High'])
  const references = tags.filter(tag => tag.label.startsWith('tag.effortReference '))
  assert.deepEqual(references.map(tag => tag.label), ['tag.effortReference Max', 'tag.effortReference Medium'])
  assert.ok(references.every(tag => tag.className.includes('mvp_tag--inferred')))
  assert.ok(tags.some(tag => tag.label === 'tag.effortWireOff'))
})


test('override editor stays closed until a revisioned list arrives', async () => {
  const initial = Promise.withResolvers()
  const row = { provider: 'relay', model: 'grok-4.7', contextWindow: 1234 }
  const harness = createHarness({ overrideRead: () => initial.promise })
  const edit = () => harness.elements.find((node) => node.props['aria-label'] === 'row.edit: grok-4.7')
  const editor = () => harness.elements.find((node) => node.type.name === 'ModelOverrideEditor')
  harness.render()
  await settle(harness)
  harness.render()
  assert.equal(edit().props.disabled, true)
  edit().props.onClick()
  harness.render()
  assert.equal(editor(), undefined)
  initial.resolve(Response.json({ ok: true, value: { overrides: [row], revisions: [{ provider: row.provider, model: row.model, revision: 'r1' }] } }))
  await new Promise(setImmediate)
  harness.render()
  assert.equal(edit().props.disabled, false)
  edit().props.onClick()
  harness.render()
  assert.equal(editor().props.entry.contextWindow, 1234)
  assert.equal(editor().props.revision, 'r1')
})

async function referenceEditor({ eligible = true, currentHost = true, nonChat = false, allSelected = false } = {}) {
  const catalog = structuredClone(CATALOG)
  const [model] = catalog.value.groups[0].models
  if (nonChat) model.kind = 'embedding'
  model.standardEffort = eligible
  model.referenceReasoningSource = 'OpenRouter'
  model.referenceReasoning = { efforts: ['high', 'medium', 'off', 'none', 'opaque'].map((id) => ({ id, name: id })) }
  catalog.value.learned.features.push('standardEffort', 'reasoningMappings')
  if (currentHost) catalog.value.learned.features.push('referencePrefill')
  const override = { provider: 'relay', model: model.id, contextWindow: 2048, input: ['text'], defaultEffort: 'high',
    efforts: (allSelected ? ['high', 'medium', 'off', 'none', 'opaque'] : ['high']).map((id) => ({ id })) }
  const harness = createHarness({ catalog, overrideRead: () => Response.json({ ok: true, value: {
    overrides: [override], revisions: [{ provider: override.provider, model: override.model, revision: 'r1' }],
  } }) })
  harness.render()
  await settle(harness)
  harness.render()
  const focused = []
  harness.elements.find((node) => node.props['aria-label'] === 'row.edit: grok-4.7').props.onClick({ currentTarget: { focus: () => focused.push('edit') } })
  const element = (match) => harness.elements.find(match)
  const text = (key) => element((node) => node.props.children.some((child) => typeof child === 'string' && (child === key || child.startsWith(key + ': '))))
  const button = (key) => element((node) => node.type === 'button' && node.props.children.includes(key))
  const check = (key) => element((node) => node.type === 'label' && node.props.children.some((child) => child === key || child?.props?.children?.includes(key)))?.props.children[0]
  const field = (key) => element((node) => node.props['aria-label'] === key || node.props['aria-label']?.startsWith(key + ': '))
  const wire = (level) => field(`override.wireValue: {"level":"${level}"}`)
  const render = () => harness.renderEditor()
  const click = (key) => { const node = button(key); assert.ok(node && node.props.disabled !== true, key); node.props.onClick(); render() }
  const toggle = (key, checked) => { const node = check(key); assert.ok(node && node.props.disabled !== true, key); node.props.onChange({ target: { checked } }); render() }
  render()
  return { harness, render, element, text, field, wire, button, check, click, toggle, focused }
}

test('reference preview is reversible; only confirmed levels enter local draft', async () => {
  const ui = await referenceEditor()
  ui.click('override.useReference')
  assert.equal(ui.button('override.useReference').props['aria-expanded'], true)
  assert.ok(ui.text('override.referenceSource').props.children[0].includes('OpenRouter'))
  assert.ok(ui.text('override.referenceDraft').props.children[0].includes('opaque'))
  assert.equal(ui.button('medium').props['aria-pressed'], false)
  assert.equal(ui.button('override.saveLocal').props.disabled, true)
  ui.element((node) => node.props.className === 'mvp_editor').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} })
  ui.render()
  assert.equal(ui.button('override.useReference').props['aria-expanded'], false)
  assert.equal(ui.button('medium').props['aria-pressed'], false)
  assert.deepEqual(ui.harness.postedOverrides, [])
  ui.click('override.useReference')
  ui.click('override.confirmReference')
  assert.equal(ui.button('medium').props['aria-pressed'], true)
  assert.equal(ui.field('override.defaultEffort').props.value, 'high')
  assert.equal(ui.check('override.provider').props.checked, false)
  assert.match(ui.wire('high').props.placeholder, /referenceWireBlank.*high/)
  assert.equal(ui.wire('high').props.value, '')
  assert.equal(ui.wire('off').props.placeholder, 'override.wireKeep')
  const saveLocal = ui.button('override.saveLocal')
  saveLocal.props.onClick()
  assert.deepEqual(ui.harness.postedOverrides, [{ provider: 'relay', model: 'grok-4.7', contextWindow: 2048, input: ['text'],
    efforts: ['high', 'medium', 'off', 'none', 'opaque'].map((id) => ({ id })), defaultEffort: 'high', applyToProvider: false, expectedRevision: 'r1' }])
})

test('Provider save reconfirms and sends only explicit wire values plus Host fallback intent', async () => {
  const ui = await referenceEditor({ allSelected: true })
  ui.toggle('override.provider', true)
  ui.wire('high').props.onChange({ target: { value: 'typed-value' } })
  ui.render()
  ui.click('override.useReference')
  assert.match(ui.text('override.referenceFallbacks').props.children[0], /medium/)
  assert.doesNotMatch(ui.text('override.referenceFallbacks').props.children[0], /high|off|none|opaque/)
  ui.click('override.confirmReference')
  assert.equal(ui.wire('high').props.value, 'typed-value')
  assert.equal(ui.check('override.standardWire').props.checked, false)
  ui.toggle('override.standardWire', true)
  ui.click('override.saveProvider')
  assert.equal(ui.button('override.saveProvider').props['aria-expanded'], true)
  assert.match(ui.text('override.providerMappings').props.children[0], /typed-value/)
  assert.ok(ui.text('override.providerContext'))
  assert.ok(ui.text('override.providerInput'))
  assert.ok(ui.text('override.providerLocalDefault'))
  assert.ok(ui.text('override.providerStandardEnable'))
  assert.deepEqual(ui.harness.postedOverrides, [])
  ui.click('override.backToDraft')
  assert.equal(ui.wire('high').props.value, 'typed-value')
  ui.click('override.saveProvider')
  ui.button('override.confirmProviderSave').props.onClick()
  assert.equal(ui.harness.postedOverrides.length, 1)
  assert.deepEqual(ui.harness.postedOverrides[0].reasoningEffortMappings, { high: 'typed-value' })
  assert.equal(ui.harness.postedOverrides[0].applyToProvider, true)
  assert.equal(ui.harness.postedOverrides[0].referencePrefill, true)
  assert.equal(ui.harness.postedOverrides[0].standardEffort, true)
})

test('opaque routes have no standard mapping suggestion; old Host and non-chat fall back safely', async () => {
  const opaque = await referenceEditor({ eligible: false })
  opaque.click('override.useReference')
  assert.ok(opaque.text('override.referenceManualScope'))
  assert.equal(opaque.text('override.referenceFallbacks'), undefined)
  opaque.click('override.confirmReference')
  opaque.toggle('override.provider', true)
  assert.equal(opaque.check('override.standardWire'), undefined)
  assert.equal(opaque.wire('opaque'), undefined)
  opaque.click('override.saveProvider')
  opaque.button('override.confirmProviderSave').props.onClick()
  const [payload] = opaque.harness.postedOverrides
  assert.equal(payload.referencePrefill, true)
  assert.equal(payload.standardEffort, undefined)
  assert.equal(payload.reasoningEffortMappings, undefined)

  const old = await referenceEditor({ currentHost: false })
  old.toggle('override.provider', true)
  old.click('override.useReference')
  assert.ok(old.text('override.referenceOldHost'))
  old.click('override.confirmReference')
  assert.equal(old.check('override.provider').props.checked, false)
  assert.equal(old.check('override.provider').props.disabled, true)
  assert.ok(old.button('override.saveLocal'))

  const nonChat = await referenceEditor({ nonChat: true })
  assert.equal(nonChat.button('override.useReference'), undefined)
  assert.ok(nonChat.field('override.kind'), 'manual kind editing is still available')
})

test('the browser observes llm/models-updated and requests a fresh catalog', async () => {
  const harness = createHarness()
  assert.equal(typeof harness.remoteEvents.get('llm/models-updated'), 'function')
  harness.remoteEvents.get('llm/models-updated')()
  await new Promise(setImmediate)
  assert.deepEqual(harness.fetches.map((url) => url.slice(url.lastIndexOf('/'))), ['/models?fresh=1'])
})
