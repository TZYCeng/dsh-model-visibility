/**
 * Assemble `client.js` from the `client-src/*.mjs` modules.
 *
 * The DSH client runtime is a single hand-written ModuleLoader bundle: the
 * startup combo script only delivers the package's `client.js` entry, and each
 * factory receives a shell-provided `require`. Cross-module sources therefore
 * cannot stay native ESM at runtime; this script performs a strictly
 * mechanical ESM → CJS-dialect rewrite (no parsing, no whitespace-sensitive
 * logic):
 *
 * - `import { A, B } from './x.mjs'` → `const { A, B } = require('x')`
 *   (unknown names fall back to the shell require, e.g. `react`),
 * - `export const NAME = …` → `exports.NAME = …`,
 * - `export function NAME` / `export class NAME` → `exports.NAME = function
 *   NAME(…)` / `exports.NAME = class NAME {…}`,
 * - `export { A, B }` → `exports.A = A; exports.B = B;`,
 * - any other `import`/`export` shape aborts the build loudly.
 *
 * Output is deterministic: same sources in, same bytes out.
 *
 * @usage node scripts/build-client.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)))
const sourceDir = path.join(root, 'client-src')
const outFile = path.join(root, 'client.js')

/** The bundle entry id; must equal `package.json`'s `name`. */
const PKG_ID = '@tzyc/dsh-model-visibility'

function assertSupported(line, file) {
  if (/^\s*import\s+(?:\*|\w+\s*,)/.test(line)) {
    throw new Error(`${file}: namespace/default imports are not supported: ${line.trim()}`)
  }
  if (/^\s*import\s+'/.test(line)) {
    throw new Error(`${file}: side-effect-only imports are not supported: ${line.trim()}`)
  }
  if (/^\s*export\s+default/.test(line)) {
    throw new Error(`${file}: default exports are not supported: ${line.trim()}`)
  }
  if (/^\s*import\s+\w+\s+from/.test(line)) {
    throw new Error(`${file}: default imports are not supported: ${line.trim()}`)
  }
}

function transform(source, file) {
  const out = []
  for (const line of source.split('\n')) {
    assertSupported(line, file)
    const relative = /^\s?import\s+\{([^}]*)\}\s+from\s+'\.\/([^']+\.mjs)'.*$/.exec(line)
    if (relative !== null) {
      const names = relative[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
      const required = relative[2].replace(/\.mjs$/, '')
      out.push(`const { ${names.join(', ')} } = require(${JSON.stringify(required)})`)
      continue
    }
    if (/^\s*export\s+const\s+/.test(line)) {
      out.push(line.replace(/^(\s*)export\s+const\s+(\w+)\s*=/, `$1exports.$2 =`))
      continue
    }
    if (/^\s*export\s+(function|class)\s+\w+/.test(line)) {
      out.push(line.replace(/^(\s*)export\s+(function|class)\s+(\w+)/, `$1exports.$3 = $2 $3`))
      continue
    }
    const exportList = /^(\s*)export\s*\{([^}]*)\}\s*;?\s*$/.exec(line)
    if (exportList !== null) {
      const names = exportList[2]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
      for (const name of names) out.push(`${exportList[1]}exports.${name} = ${name}`)
      continue
    }
    out.push(line)
  }
  return out.join('\n')
}

const files = fs
  .readdirSync(sourceDir)
  .filter((name) => name.endsWith('.mjs') && name !== 'index.mjs')
  .sort()

/** Registry preamble inside the bundle factory. */
const registry = `
const cache = new Map()
const definitions = new Map()
const define = (name, factory) => {
  definitions.set(name, factory)
}
const moduleRequire = (name) => {
  if (!definitions.has(name)) return require(name)
  if (cache.has(name)) return cache.get(name)
  if (cache.has(name + ':pending')) {
    throw new Error('client bundles may not require "' + name + '" cyclically')
  }
  cache.set(name + ':pending', true)
  const module = { exports: {} }
  definitions.get(name)(moduleRequire, module, module.exports)
  cache.set(name, module.exports)
  return module.exports
}
`.trim()

const parts = [
  '/**',
  ' * Assembled by scripts/build-client.mjs from client-src/*.mjs — the sources',
  ' * are the readable place; this file must not be edited by hand.',
  ' */',
  `window.__ModuleLoader__.load({`,
  `  id: ${JSON.stringify(PKG_ID)},`,
  `  factory(require) {`,
  indent(registry, 4),
]

const emittedModules = [...files.map((file) => file.replace(/\.mjs$/, '')), 'entry']
for (const name of emittedModules) {
  const tag = `// -------------------------------------------------------- ${name}`
  const sourceFile = name === 'entry' ? 'index.mjs' : `${name}.mjs`
  const body = transform(fs.readFileSync(path.join(sourceDir, sourceFile), 'utf8'), sourceFile)
  parts.push(`  ${tag}`)
  parts.push(`  define(${JSON.stringify(name)}, function (require, module, exports) {`)
  parts.push(indent(body, 4))
  parts.push(`  })`)
  parts.push('')
}

parts.push(indent(
  ['const entryModule = moduleRequire("entry")', 'return { inject: entryModule.inject, apply: entryModule.apply }'].join('\n'),
  4,
))
parts.push(`  },`, `})`)

fs.writeFileSync(outFile, parts.join('\n') + '\n')
process.stdout.write(`wrote ${outFile} from ${emittedModules.length} modules\n`)

function indent(text, spaces) {
  const pad = ' '.repeat(spaces)
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n')
}
