import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const code = readFileSync(join(root, 'client.js'), 'utf8')

/** Minimal React surface needed by the factory's top level. */
const react = {
  createElement: () => ({}),
  createContext: () => ({ Provider: null, Consumer: null }),
  Fragment: 'Fragment',
  useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
}

/** Evaluate client.js against a fake `window.__ModuleLoader__`. */
function loadClient() {
  const registered = []
  let exported
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          registered.push(definition.id)
          exported = definition.factory((name) => {
            if (name === 'react') return react
            throw new Error('unexpected require: ' + name)
          })
        },
      },
    },
    document: { baseURI: 'http://127.0.0.1:1/' },
    URL,
    console,
    setTimeout,
    clearTimeout,
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  return { registered, exported }
}

test('client.js registers under the exact package name', () => {
  const { registered } = loadClient()
  assert.deepEqual(registered, [pkg.name])
})

test('client.js factory returns a usable module', () => {
  const { exported } = loadClient()
  assert.ok(Array.isArray(exported.inject))
  assert.ok(exported.inject.includes('slots'))
  assert.ok(exported.inject.includes('locale'))
  assert.equal(typeof exported.apply, 'function')
})
