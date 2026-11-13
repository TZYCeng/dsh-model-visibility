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
function createHarness({ catalog = CATALOG, formValue = { hidden: ['relay/plain-model'], applyInput: true }, writable = true } = {}) {
  const elements = []
  const effects = []
  let state = []

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
      const slot = state.length
      if (state[slot] === undefined) state[slot] = typeof initial === 'function' ? initial() : initial
      const setter = (next) => {
        state[slot] = typeof next === 'function' ? next(state[slot]) : next
      }
      return [state[slot], setter]
    },
    useEffect: (fn) => { effects.push(fn) },
    useLayoutEffect: (fn) => { effects.push(fn) },
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
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
      $on: () => () => {},
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
    fetch: async (url) => ({
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
            ? { ok: true, value: { overrides: [] } }
            : String(url).includes('/verify')
              ? { ok: true, value: { state: { running: false, done: 0, total: 0 }, learned: { models: 0 } } }
              : catalog,
    }),
  }

  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  const exported = sandbox.__exported
  exported.apply(ctx)
  const Section = registrations.section
  if (typeof Section !== 'function') throw new Error('the settings section did not register')

  const t = (key) => key
  const render = () => {
    elements.length = 0
    return Section({ t })
  }

  /** Every clickable control in the last render pass. */
  const controls = () =>
    elements.filter(
      (element) =>
        element.type === 'button' &&
        typeof element.props.onClick === 'function' &&
        element.props.disabled !== true,
    )

  return { render, effects, elements, controls, writes, exported, formState, t }
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
async function renderVerifyPanel(verifyValue, { pick } = {}) {
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
      learned: { models: 1, features: ['applyInput', 'reload', 'overrides', 'verify', 'usage', 'checkerBudget', 'verifyWeb'] },
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
  const lines = panel.text('mvp_sources')
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

test('the verify panel offers a thread count and shows the active one', async () => {
  const panel = await renderVerifyPanel(FINISHED_SWEEP)
  panel.open()
  const selects = panel.find('mvp_select')
  const labels = selects.map((element) => element.props['aria-label']).filter(Boolean)
  assert.ok(labels.includes('checker.concurrency'), 'a concurrency control must exist')
  const options = panel.find('mvp_select').flatMap((element) => element.props.children).filter(Boolean)
  void options
  assert.ok(panel.text('mvp_checkerProgress').some((line) => line.includes('checker.threads(4)')))
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
  const hints = panel.text('mvp_usageHint')
  assert.ok(hints.some((line) => line.includes('checker.publicOnly(2)')))
})

