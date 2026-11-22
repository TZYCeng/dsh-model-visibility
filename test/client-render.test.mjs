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
import { readFileSync, readdirSync } from 'node:fs'
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
function createHarness({ catalog = CATALOG, formValue = { hidden: ['relay/plain-model'], applyInput: true }, writable = true, revision = 7, overrideRead, overrideWrite, collapsed = [] } = {}) {
  const postedOverrides = []
  const editorState = []
  const usageFrame = []
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
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const slot = cursor++
      if (!(slot in slots)) slots[slot] = subscribe(() => {})
      return getSnapshot()
    },
  }

  const formState = { value: { ...formValue }, writable, status: 'ready', revision }
  const writes = []
  const form = {
    getSnapshot: () => formState,
    subscribe: () => () => {},
    mutate(ops, expectedRevision) {
      assert.equal(ops.length, 1); assert.equal(ops[0].op, 'set'); assert.deepEqual(plain(ops[0].path), ['hidden'])
      if (!formState.writable || expectedRevision !== formState.revision) return Promise.resolve(false)
      const field = 'hidden', value = plain(ops[0].value)
      writes.push({ field, value, expectedRevision }); formState.value = { ...formState.value, [field]: value }; formState.revision++
      return Promise.resolve(true)
    },
    set(field, value) {
      assert.notEqual(field, 'hidden', 'visibility must never replace the whole form through unrevisioned set')
      writes.push({ field, value }); formState.value = { ...formState.value, [field]: value }; formState.revision++
      return Promise.resolve(true)
    },
  }

  const registrations = { section: null }
  const remoteEvents = new Map()
  const lifecycleEvents = new Map()
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
    on: (name, handler) => { lifecycleEvents.set(name, handler); return () => lifecycleEvents.delete(name) },
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
      localStorage: { getItem: (key) => key.includes('collapsed-groups') ? JSON.stringify(collapsed) : null, setItem: () => {} },
    },
    document: {
      baseURI: 'http://127.0.0.1:1/',
      createElement: () => ({ dataset: {}, remove() {}, click() {}, textContent: '' }),
      head: { appendChild() {} },
      body: { appendChild() {}, removeChild() {} },
      querySelector: () => null,
    },
    URL, AbortController, AbortSignal, DOMException,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: async (url, init) => {
      fetches.push(String(url))
      if (String(url).endsWith('/overrides') && init?.method === 'POST') {
        const body = JSON.parse(init.body)
        postedOverrides.push(body)
        return overrideWrite ? overrideWrite(body) : Response.json({ ok: true, value: { overrides: [], revisions: [] } })
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

  const t = (key, params) => /^(group\.(count|matchCount|show|hide)|row\.visibilityNamed|page\.(show|confirm|doEnable|doDisable|matchCount)|override\.(providerWritten|providerSkipped|localOnly|localRetained|unresolvedEfforts|reusedEfforts|referencePreservedEfforts))/.test(key) && params
    ? key + ':' + JSON.stringify(params) : key
  const editorT = (key, values) => values ? `${key}: ${JSON.stringify(values)}`
    : key.startsWith('effort.') ? key.slice('effort.'.length) : key
  const render = () => {
    elements.length = 0
    slots = state
    cursor = 0
    return Section({ t })
  }
  const renderUsage = (snapshot) => {
    render(); const toolbar = elements.find(node => node.type?.name === 'UsageToolbar'); assert.ok(toolbar)
    slots = usageFrame; cursor = 0; elements.length = 0
    return toolbar.type({ ...toolbar.props, usage: { getSnapshot: () => ({ snapshot }), subscribe: () => () => {} } })
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

  return { render, renderEditor, renderUsage, effects, elements, controls, writes, postedOverrides, exported, formState, t, remoteEvents, lifecycleEvents, fetches }
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

const pause = () => new Promise(setImmediate)
const byClass = (harness, name) => harness.elements.find(node => node.props.className?.split(' ').includes(name))
const hasKey = (child, key) => typeof child === 'string' && (child === key || child.startsWith(key + ':'))
const byText = (harness, key) => harness.elements.find(node => node.props.children.some(child => hasKey(child, key)))
const byRole = (harness, name) => harness.elements.find(node => node.type?.name === name)
const settingField = (harness, key) => harness.elements.find(node => node.props['aria-label'] === key)
const titles = (harness) => harness.elements.filter(node => node.props.className === 'mvp_rowTitle').map(node => node.props.children[0])
async function loaded(config) { const harness = createHarness(config); harness.render(); await settle(harness); harness.render(); return harness }
const toggleFor = (harness, name) => harness.elements.find(node => node.props.role === 'switch' && node.props['aria-label']?.includes('"name":"' + name + '"'))
const search = (harness, value) => { harness.render(); settingField(harness, 'page.searchPlaceholder').props.onInput({ target: { value } }); harness.render() }

test('the per-model switch commits an explicit, revisioned visibility edit (the FIELD regression)', async () => {
  const ui = await loaded()
  const toggle = toggleFor(ui, 'grok-4.7')
  assert.ok(toggle); toggle.props.onClick(); await pause()
  assert.deepEqual(plain(ui.writes), [{ field: 'hidden', expectedRevision: 7, value: ['relay/plain-model', 'relay/grok-4.7'] }])
})

test('both group and page-level changes list affected identities and can be cancelled without writing', async () => {
  const ui = await loaded({ formValue: { hidden: ['relay/plain-model', 'missing-provider/keep-this'] } })
  for (const button of ['group.showAll', 'page.showAll']) {
    assert.match(byText(ui, button).props.children[0], /"count":1/)
    byText(ui, button).props.onClick(); ui.render()
    const dialog = byRole(ui, 'SettingsConfirm'); assert.ok(dialog)
    assert.deepEqual(plain(dialog.props.targets), [{ provider: 'relay', model: 'plain-model' }]); assert.match(dialog.props.title, /"count":1/)
    assert.deepEqual(ui.writes, []); dialog.props.onCancel(); ui.render(); assert.equal(byRole(ui, 'SettingsConfirm'), undefined)
  }
  byText(ui, 'page.showAll').props.onClick(); ui.render(); byRole(ui, 'SettingsConfirm').props.onConfirm(); await pause()
  assert.equal(ui.writes.length, 1); assert.deepEqual(plain(ui.writes[0].value), ['missing-provider/keep-this'])
})

test('filtering to two of 239 hidden routes never presents a global reset or writes a nonmatch', async () => {
  const catalog = structuredClone(CATALOG)
  const models = Array.from({ length: 239 }, (_, i) => ({ id: i < 2 ? `match-${i}` : `other-${i}`, name: i < 2 ? `match-${i}` : `other-${i}`, kind: 'chat' }))
  catalog.value.groups = [{ id: 'relay', name: 'Relay', models }]
  const ui = await loaded({ catalog, formValue: {hidden: models.map(m => 'relay/' + m.id)}, collapsed:['relay'] })
  assert.deepEqual(titles(ui), []); search(ui, 'match-')
  assert.deepEqual(titles(ui), ['match-0', 'match-1'], 'folded hits expand temporarily')
  assert.match(byText(ui, 'group.matchCount').props.children[0], /"matches":2,"total":239,"enabled":0/)
  assert.equal(byText(ui, 'page.showAll'), undefined); assert.match(byText(ui, 'page.showMatches').props.children[0], /"count":2/)
  byText(ui, 'page.showMatches').props.onClick(); ui.render(); const dialog = byRole(ui, 'SettingsConfirm')
  assert.deepEqual(plain(dialog.props.targets).map(x => x.model), ['match-0', 'match-1']); assert.deepEqual(ui.writes, [])
  dialog.props.onConfirm(); await pause(); assert.deepEqual(plain(ui.writes[0].value), models.slice(2).map(m => 'relay/' + m.id))
  search(ui, ''); assert.deepEqual(titles(ui), [], 'clearing the search restores the unfiltered fold preference')
})

test('when the confirmed targets change identity but not count, confirmation is invalidated', async () => {
  const ui = await loaded()
  byText(ui, 'page.showAll').props.onClick(); ui.render()
  ui.formState.value = { hidden: ['relay/glm-5.3'] }; ui.formState.revision++
  ui.render(); const { props } = byRole(ui, 'SettingsConfirm'); assert.ok(props.changed)
  props.onConfirm(); await pause(); assert.deepEqual(ui.writes, [])
})

test('visibility, keyword and capability filters scope the group action; read-only forms cannot write', async () => {
  const ui = await loaded()
  settingField(ui, 'page.visibility.label').props.onChange({ target: { value: 'disabled' } }); ui.render()
  assert.deepEqual(titles(ui), ['plain-model']); search(ui, 'grok'); assert.deepEqual(titles(ui), []); assert.ok(byText(ui, 'page.filterEmpty'))
  settingField(ui, 'page.visibility.label').props.onChange({ target: { value: 'enabled' } }); ui.render()
  assert.deepEqual(titles(ui), ['grok-4.7']); assert.equal(byText(ui, 'group.hideAll'), undefined)
  byText(ui, 'group.hideFiltered').props.onClick(); ui.render(); byRole(ui, 'SettingsConfirm').props.onConfirm(); await pause()
  assert.deepEqual(plain(ui.writes[0].value).sort(), ['relay/grok-4.7', 'relay/plain-model'])
  const oldForm = await loaded({ revision: null }); const oldToggle = toggleFor(oldForm, 'grok-4.7'); assert.equal(oldToggle.props.disabled, true)
  oldToggle.props.onClick(); await pause(); assert.deepEqual(oldForm.writes, [])
})

test('cold, scanning, failed and settled usage share the same reserved status row', async () => {
  const { CSS } = await import('../client-src/css.mjs'); const ui = await loaded()
  const layout = snapshot => {
    const tree = ui.renderUsage(snapshot); const status = byClass(ui, 'mvp_usageStatus')
    assert.ok(status && status.props.role === 'status'); assert.equal(tree.props.children.at(-1), status)
    return tree.props.children.map(node => node.props.className)
  }
  const initial = layout(null)
  for (const state of [{ computing: true }, { computing: false, error: 'long diagnostic' }, { computing: false, ranges: { today: [12, 2, 0, 0] } }]) {
    assert.deepEqual(layout(state), initial)
  }
  assert.match(CSS, /\.mvp_usageStatus\s*\{[^}]*\bheight:[^;}]+/)
  assert.match(CSS, /\.mvp_usageStatus\s*\{[^}]*overflow:auto/)
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
  const dir = path.join(root, 'client-src')
  const files = readdirSync(dir).filter(name => name.endsWith('.mjs'))
  const styleFiles = files.filter(name => name === 'css.mjs' || name.endsWith('-style.mjs') || name.endsWith('-styles.mjs') || name.endsWith('-css.mjs'))
  const moduleSources = files.filter(name => !styleFiles.includes(name)).map(name => readFileSync(path.join(dir, name), 'utf8'))
  const localStyles = moduleSources.flatMap(source => [...source.matchAll(/const css = `([^`]+)`/g)].map(match => match[1]))
  const CSS = [...styleFiles.map(name => readFileSync(path.join(dir, name), 'utf8')), ...localStyles].join('\n')
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
    useSyncExternalStore: (subscribe, getSnapshot) => {
      const index = currentFrame.cursor++
      if (!(index in currentFrame.slots)) currentFrame.slots[index] = subscribe(() => {})
      return getSnapshot()
    },
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
    URL, AbortController, AbortSignal, DOMException,
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

async function referenceEditor({ eligible = true, currentHost = true, nonChat = false, allSelected = false, blank = false, provenance = false, overrideWrite } = {}) {
  const catalog = structuredClone(CATALOG)
  const [model] = catalog.value.groups[0].models
  if (nonChat) model.kind = 'embedding'
  model.standardEffort = eligible
  model.referenceReasoningSource = 'OpenRouter'
  model.referenceReasoning = { efforts: ['high', 'medium', 'off', 'none', 'opaque'].map((id) => ({ id, name: id })) }
  catalog.value.learned.features.push('standardEffort', 'reasoningMappings')
  if (currentHost) catalog.value.learned.features.push('referencePrefill', 'effortDirect')
  const override = { provider: 'relay', model: model.id, contextWindow: 2048, input: ['text'], defaultEffort: 'high',
    ...(provenance ? { referencePrefill: true } : {}), efforts: (allSelected ? ['high', 'medium', 'off', 'none', 'opaque'] : ['high']).map((id) => ({ id })) }
  const harness = await loaded({ catalog, overrideWrite, overrideRead: () => Response.json({ ok: true, value: {
    overrides: blank ? [] : [override], revisions: blank ? [] : [{ provider: override.provider, model: override.model, revision: 'r1' }],
  } }) })
  const focused = []
  settingField(harness, 'row.edit: grok-4.7').props.onClick({ currentTarget: { focus: () => focused.push('edit') } })
  const element = (match) => harness.elements.find(match)
  const text = (key) => element((node) => node.props.children.some((child) => typeof child === 'string' && (child === key || child.startsWith(key + ': '))))
  const button = (key) => element((node) => node.type === 'button' && node.props.children.some((child) => typeof child === 'string' && (child === key || child.startsWith(key + ' · '))))
  const field = (key) => element((node) => node.props['aria-label'] === key || node.props['aria-label']?.startsWith(key + ': '))
  const wire = (level) => field(`override.wireValue: {"level":"${level}"}`)
  const render = () => harness.renderEditor()
  const click = (key) => { const node = button(key); assert.ok(node && node.props.disabled !== true, key); node.props.onClick(); render() }
  render()
  return { harness, render, element, text, field, wire, button, click, focused }
}

test('reference preview is reversible; only confirmed levels enter a local draft with preserved provenance and revision', async () => {
  const ui = await referenceEditor()
  assert.equal(ui.wire('high'), undefined); assert.equal(ui.element(n => n.type === 'input' && n.props.type === 'checkbox'), undefined)
  ui.click('override.useReference'); assert.equal(ui.button('override.useReference').props['aria-expanded'], true)
  assert.match(ui.text('override.referenceSource').props.children[0], /OpenRouter/); assert.match(ui.text('override.referenceDraft').props.children[0], /opaque/)
  assert.equal(ui.button('medium').props['aria-pressed'], false); assert.equal(ui.button('override.saveLocal').props.disabled, true)
  ui.element((node) => node.props.className === 'mvp_editor').props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); ui.render()
  assert.equal(ui.button('override.useReference').props['aria-expanded'], false); assert.equal(ui.button('medium').props['aria-pressed'], false)
  assert.deepEqual(ui.harness.postedOverrides, []); ui.click('override.useReference'); ui.click('override.confirmReference')
  assert.equal(ui.button('medium').props['aria-pressed'], true); assert.equal(ui.field('override.defaultEffort').props.value, 'high')
  ui.button('override.saveLocal').props.onClick(); await pause()
  assert.deepEqual(ui.harness.postedOverrides, [{ provider: 'relay', model: 'grok-4.7', contextWindow: 2048, input: ['text'],
    efforts: ['high', 'medium', 'off', 'none', 'opaque'].map((id) => ({ id })), defaultEffort: 'high', applyToProvider: false, referencePrefill: true, expectedRevision: 'r1' }])
})

test('one direct click uses Host intent and optional explicit mapping; prefill does not replace a custom value', async () => {
  const ui = await referenceEditor({ allSelected: true })
  assert.equal(ui.button('override.saveProvider').props.disabled, false)
  assert.equal(ui.element(n => n.props.children.includes('override.standardWire') || n.props.children.includes('override.provider')), undefined)
  ui.click('override.writeDetails'); ui.wire('high').props.onChange({ target: { value: 'typed-value' } }); ui.render()
  ui.click('override.useReference'); ui.click('override.confirmReference'); assert.equal(ui.wire('high').props.value, 'typed-value')
  assert.equal(ui.wire('off').props.value, ''); assert.equal(ui.wire('opaque'), undefined)
  const write = ui.button('override.saveProvider'); write.props.onClick(); write.props.onClick(); await pause()
  assert.equal(ui.harness.postedOverrides.length, 1); const [payload] = ui.harness.postedOverrides
  assert.deepEqual(payload.reasoningEffortMappings, { high: 'typed-value' }); assert.equal(payload.applyToProvider, true); assert.equal(payload.directEffort, true)
  assert.equal(payload.referencePrefill, true); assert.equal(payload.standardEffort, undefined); assert.equal(payload.expectedRevision, 'r1')
})

test('an untouched model with advisory levels can write them with a single explicit click; editing context never auto-adds levels', async () => {
  const ui = await referenceEditor({ blank: true })
  assert.match(ui.text('override.directReference').props.children[0], /medium/); assert.equal(ui.button('override.saveLocal').props.disabled, true)
  ui.button('override.saveProvider').props.onClick(); await pause(); const [p] = ui.harness.postedOverrides
  assert.equal(p.expectedRevision, null); assert.equal(p.referencePrefill, true); assert.equal(p.directEffort, true)
  assert.deepEqual(p.efforts.map(e => e.id), ['high', 'medium', 'off', 'none', 'opaque']); assert.equal(p.reasoningEffortMappings, undefined)
  const edited = await referenceEditor({ blank: true }); edited.field('override.context').props.onInput({ target: { value: '12345' } }); edited.render()
  assert.equal(edited.text('override.directReference'), undefined); edited.button('override.saveProvider').props.onClick(); await pause()
  assert.deepEqual(edited.harness.postedOverrides[0], { provider: 'relay', model: 'grok-4.7', contextWindow: 12345, applyToProvider: true, directEffort: true, expectedRevision: null })
})

test('opaque, old and non-chat routes retain conservative behavior, and reopening retains protected reference provenance', async () => {
  const opaque = await referenceEditor({ eligible: false, provenance: true })
  assert.ok(opaque.text('override.referenceApplied')); assert.equal(opaque.wire('opaque'), undefined)
  opaque.button('override.saveProvider').props.onClick(); await pause(); const [p] = opaque.harness.postedOverrides
  assert.equal(p.directEffort, true); assert.equal(p.referencePrefill, true); assert.equal(p.standardEffort, undefined); assert.equal(p.reasoningEffortMappings, undefined)
  const old = await referenceEditor({ currentHost: false }); assert.equal(old.button('override.saveProvider').props.disabled, true)
  old.button('override.saveProvider').props.onClick(); old.click('override.useReference'); old.click('override.confirmReference')
  assert.equal(old.button('override.saveProvider').props.disabled, true); assert.ok(old.text('override.directOldHost')); assert.deepEqual(old.harness.postedOverrides, [])
  old.button('override.saveLocal').props.onClick(); await pause(); assert.equal(old.harness.postedOverrides[0].applyToProvider, false); assert.equal(old.harness.postedOverrides[0].referencePrefill, true)
  const nonChat = await referenceEditor({ nonChat: true }); assert.equal(nonChat.button('override.useReference'), undefined); assert.ok(nonChat.field('override.kind'))
})

test('a partial provider receipt names confirmed fields, local fields and unresolved/protected levels, not full success', async () => {
  const provider = { written: true, fields: ['contextWindow'], localOnly: ['reasoningEfforts'], unresolvedEfforts: ['opaque'], protectedEfforts: ['high'] }
  const ui = await referenceEditor({ overrideWrite: () => Response.json({ ok: true, value: { overrides: [], revisions: [], provider } }) })
  ui.button('override.saveProvider').props.onClick(); await pause(); ui.harness.render(); search(ui.harness, 'no-such-model')
  const note = byClass(ui.harness, 'mvp_receipt'); assert.equal(note.props.role, 'status'); const message = note.props.children.filter(x => typeof x === 'string').join(' ')
  assert.match(message, /providerWritten.*contextWindow/); assert.match(message, /localOnly.*reasoningEfforts/); assert.match(message, /unresolvedEfforts.*opaque/); assert.match(message, /referencePreservedEfforts.*high/)
  const missing = await referenceEditor(); missing.button('override.saveProvider').props.onClick(); await pause(); missing.harness.render()
  assert.match(byClass(missing.harness, 'mvp_receipt').props.children.join(' '), /providerUnconfirmed/)
})

test('confirmed reuse is not called a new write, a skip or an entirely local ladder', async () => {
  const receipt = async (provider) => {
    const ui = await referenceEditor({ overrideWrite: () => Response.json({ ok: true, value: { overrides: [], revisions: [], provider } }) })
    ui.button('override.saveProvider').props.onClick(); await pause(); ui.harness.render()
    return byClass(ui.harness, 'mvp_receipt').props.children.filter(x => typeof x === 'string').join(' ')
  }
  const same = await receipt({ written: false, fields: [], reason: 'already-mapped', reusedEfforts: ['high'] })
  assert.match(same, /reason\.already-mapped/); assert.match(same, /reusedEfforts.*high/)
  assert.doesNotMatch(same, /providerSkipped|providerWritten|"fields":"[^"]*reasoningEfforts/)
  const mixed = await receipt({ written: true, fields: ['contextWindow'], localOnly: ['reasoningEfforts'], unresolvedEfforts: ['opaque'], reusedEfforts: ['high'] })
  assert.match(mixed, /providerWritten:.*contextWindow/); assert.match(mixed, /reusedEfforts.*high/); assert.match(mixed, /unresolvedEfforts.*opaque/)
  assert.match(mixed, /ladderRetained/); assert.doesNotMatch(mixed, /partialEfforts|"fields":"[^"]*reasoningEfforts/)
})

test('an overlapping written/local reasoning map reports partial coverage only, with exact omitted and protected levels', async () => {
  const provider = { written: true, fields: ['contextWindow', 'reasoningEfforts'], localOnly: ['reasoningEfforts'], unresolvedEfforts: ['opaque'], protectedEfforts: ['high'] }
  const ui = await referenceEditor({ overrideWrite: () => Response.json({ ok: true, value: { overrides: [], revisions: [], provider } }) })
  ui.button('override.saveProvider').props.onClick(); await pause(); ui.harness.render()
  const msg = byClass(ui.harness, 'mvp_receipt').props.children.filter(x => typeof x === 'string').join(' ')
  assert.match(msg, /override\.partialEfforts/); assert.match(msg, /providerWritten:\{"fields":"contextWindow"\}/)
  assert.doesNotMatch(msg, /"fields":"[^"]*reasoningEfforts/); assert.match(msg, /unresolvedEfforts.*opaque/); assert.match(msg, /referencePreservedEfforts.*high/)
})

test('the same keyed editor stays mounted through collapse, search and visibility changes; hidden models remain editable', async () => {
  const ui = await loaded()
  const edit = () => settingField(ui, 'row.edit: plain-model')
  assert.equal(edit().props.disabled, false); assert.equal(toggleFor(ui, 'plain-model').props['aria-checked'], false)
  edit().props.onClick(); ui.renderEditor()
  settingField(ui, 'override.context').props.onInput({ target: { value: '54321' } })
  let originalKey
  const check = (detached) => {
    ui.render(); const editor = byRole(ui, 'ModelOverrideEditor'); assert.ok(editor); assert.equal(editor.props.detached, detached)
    const parent = byClass(ui, 'mvp_groups'); assert.ok(parent.props.children.includes(editor), 'draft must retain the same parent even when its row is gone')
    if (!originalKey) originalKey = editor.props.key
    assert.equal(editor.props.key, originalKey); ui.renderEditor(); assert.equal(settingField(ui, 'override.context').props.value, '54321')
  }
  check(false); ui.render(); byClass(ui, 'mvp_groupTitle').props.onClick(); check(true)
  search(ui, 'grok'); check(true); search(ui, 'plain'); check(false)
  ui.render(); settingField(ui, 'page.visibility.label').props.onChange({ target: { value: 'enabled' } }); check(true)
  ui.render(); byText(ui, 'page.clearFilters').props.onClick(); check(true)
  ui.render(); byClass(ui, 'mvp_groupTitle').props.onClick(); check(false)
  ui.render(); settingField(ui, 'row.edit: grok-4.7').props.onClick(); ui.render(); assert.ok(byRole(ui, 'SettingsConfirm'), 'switching away from a dirty draft requires consent')
  byRole(ui, 'SettingsConfirm').props.onCancel(); check(false); assert.deepEqual(ui.writes, []); assert.deepEqual(ui.postedOverrides, [])
})

test('a reconnect preserves a draft but fences the old Host even when the model and revision are identical', async () => {
  const ui = await referenceEditor({ blank: true }); ui.field('override.context').props.onInput({ target: { value: '54321' } })
  ui.harness.lifecycleEvents.get('connection/reset')(); await pause(); ui.render()
  assert.equal(ui.field('override.context').props.value, '54321'); assert.ok(ui.text('override.conflict'))
  assert.equal(ui.button('override.saveProvider').props.disabled, true); ui.button('override.saveProvider').props.onClick(); await pause(); assert.deepEqual(ui.harness.postedOverrides, [])
})

test('field-level aliases remain advisory and do not contaminate an adapter ladder', async () => {
  const catalog = structuredClone(CATALOG); const row = catalog.value.groups[0].models[0]
  row.requestReasoning = row.reasoning; row.learned = { publicAlias: true }; row.fieldEvidence = { context: { source: 'public', alias: true, lookupId: 'vendor/candidate' } }; row.sources.context = 'public'
  const ui = await loaded({ catalog }); const tagged = ui.elements.filter(x => x.props.className?.split(' ').includes('mvp_tag'))
  const alias = tagged.filter(x => String(x.props.children[0]).includes('tag.aliasReference'))
  assert.equal(alias.length, 1); assert.ok(alias[0].props.children[0].startsWith('tag.context')); assert.ok(alias[0].props.className.includes('mvp_tag--inferred'))
  assert.ok(tagged.some(x => String(x.props.children[0]).startsWith('tag.effort Low/High') && !x.props.className.includes('mvp_tag--inferred')))
})

test('the published ladder and the reasoning support flag cite their own fields', async () => {
  const catalog = structuredClone(CATALOG); const row = catalog.value.groups[0].models[1]
  row.requestReasoning = null; row.reasoningSupported = true; row.reasoning = { efforts: [{ id: 'high', name: 'HIGH' }] }
  row.fieldEvidence = { reasoning: { source: 'config' }, reasoningEfforts: { source: 'public', alias: true, catalog: 'Example catalog' } }
  const ui = await loaded({ catalog }); const tags = ui.elements.filter(n => n.props.className?.split(' ').includes('mvp_tag'))
  const ladder = tags.find(n => n.props.children[0].startsWith('tag.effortPublicReference HIGH'))
  assert.ok(ladder); assert.match(ladder.props.children[0], /tag.aliasReference/); assert.match(ladder.props.title, /Example catalog/)
  assert.ok(!tags.find(n => n.props.children[0] === 'tag.reasoningReference')?.props.title.includes('tag.aliasReferenceTitle'))
  settingField(ui, 'row.edit: plain-model').props.onClick(); ui.render(); assert.equal(byRole(ui, 'ModelOverrideEditor').props.referenceAlias, true)
  assert.equal(byRole(ui, 'ModelOverrideEditor').props.referenceSource, 'Example catalog')
})

test('Debug is above the catalog and About follows verification as the very last section', async () => {
  const ui = await loaded(); const children = ui.render().props.children
  assert.ok(children.findIndex(c => c?.type?.name === 'DebugPanel') < children.findIndex(c => c?.props.className === 'mvp_groups')); assert.equal(children.at(-1).type.name, 'AboutPanel')
  assert.equal(children.at(-2).type.name, 'VerifyPanel')
})

test('model updates are observed lazily and refresh only an active settings catalog', async () => {
  const ui = createHarness(); const notify = ui.remoteEvents.get('llm/models-updated'); assert.equal(typeof notify, 'function')
  notify(); await pause(); assert.deepEqual(ui.fetches, [], 'no requests while the page is not observing')
  ui.render(); await settle(ui); const urls = () => ui.fetches.map((url) => url.slice(url.lastIndexOf('/')))
  assert.equal(urls().filter(x => x === '/models?fresh=1').length, 1)
  notify(); await pause(); assert.equal(urls().filter(x => x === '/models?fresh=1').length, 2)
})
