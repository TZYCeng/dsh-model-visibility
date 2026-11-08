/**
 * Static cross-module hygiene for `client-src`.
 *
 * The bundle transform only rewrites *declared* imports, so a helper that is
 * referenced but never imported stays invisible until React happens to render
 * the section (a real `probeOf` leak showed that). This test re-checks the
 * plan cheaply: every identifier a module uses that some other module exports
 * must be either defined in the module itself or imported from the module
 * that owns it.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** identifier -> Set of defining modules. */
function exportIndex(modules) {
  const index = new Map()
  for (const [name, source] of modules) {
    for (const match of source.matchAll(/export\s+(?:function|class|const)\s+([A-Za-z_$][\w$]*)/g)) {
      const key = match[1]
      if (!index.has(key)) index.set(key, new Set())
      index.get(key).add(name)
    }
  }
  return index
}

/** Names the module declares itself (including function params of record). */
function declaredOf(source) {
  const names = new Set()
  for (const match of source.matchAll(
    /(?:(?:export|const|let|var|function\*?|class)\s+|,\s*|\(\s*|const\s*\[)([A-Za-z_$][\w$]*)/g,
  )) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/\{([^{}]*)\}\s*=?\s*\(?/g)) {
    for (const part of match[1].split(',')) {
      const bound = part.trim().match(/([A-Za-z_$][\w$]*)\s*(?::|[)}],?$|$)/)
      if (bound !== null) names.add(bound[1])
    }
  }
  for (const match of source.matchAll(/\(([A-Za-z_$][\w$]*)\)\s*=>/g)) names.add(match[1])
  return names
}

test('every shared helper each module uses is declared or imported there', () => {
  const dir = path.join(root, 'client-src')
  const modules = new Map()
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'))) {
    modules.set(file.replace(/\.mjs$/, ''), fs.readFileSync(path.join(dir, file), 'utf8'))
  }
  const declarations = exportIndex(modules)

  const problems = []
  for (const [name, source] of modules) {
    const declared = declaredOf(source)
    for (const match of source.matchAll(/(?<![\w$.'])([A-Za-z_$][\w$]{2,})\s*\(/g)) {
      const identifier = match[1]
      if (declared.has(identifier)) continue
      const owners = declarations.get(identifier)
      if (owners !== undefined && !owners.has(name)) {
        problems.push(`${name}: uses ${identifier}() without importing it (defined in ${[...owners].join(', ')})`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

test('the bundle factory only falls back to the shell require for react', () => {
  const bundle = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
  const registry = new Set()
  for (const match of bundle.matchAll(/define\("([^"]+)"/g)) {
    registry.add(match[1])
  }
  const required = new Set()
  for (const match of bundle.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
    required.add(match[2])
  }
  // Everything the transformed sources require must be either an in-bundle
  // module or the shell-provided react.
  const external = [...required].filter((name) => !registry.has(name))
  assert.deepEqual(external, ['react'])
})
