/**
 * Regenerate `lib/model-catalog.js` from an installed pi-ai data snapshot.
 *
 * The DSH runtime ships pi-ai with a models.dev-derived catalog at
 * `<pi-ai>/dist/providers/data/*.json`. That catalog already knows input
 * modalities, reasoning support, context windows, output modalities and model
 * kind for ~1,300 models, which is exactly the metadata DSH's `resolveModelInfo`
 * drops for custom relay providers. This script distills it into one compact
 * module that the plugin can import without depending on pi-ai at runtime.
 *
 * Usage:
 *   node scripts/build-catalog.mjs [--data <dir>] [--out <file>]
 *   PI_AI_DATA_DIR=<dir> node scripts/build-catalog.mjs
 *
 * The default directory is `.tools/extract/pi-ai/dist/providers/data`, which is
 * what `node .tools/asar.mjs extract ... pi-ai` produces from a desktop install.
 * `--data` accepts either the data directory itself or a pi-ai package root.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function argValue(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? undefined : value
}

/** Resolve a data directory from an explicit path, a package root, or the env. */
function dataDir() {
  const explicit = argValue('--data') ?? process.env.PI_AI_DATA_DIR
  if (explicit) {
    const candidates = [
      path.resolve(explicit),
      path.join(path.resolve(explicit), 'dist/providers/data'),
      path.join(path.resolve(explicit), 'providers/data'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(candidate, '.manifest.json'))) return candidate
    }
    throw new Error(`no pi-ai data manifest under ${explicit}`)
  }
  const fallback = path.join(root, '.tools/extract/pi-ai/dist/providers/data')
  if (fs.existsSync(path.join(fallback, '.manifest.json'))) return fallback
  throw new Error('pi-ai data not found; pass --data <pi-ai package or data dir>')
}

const OFFICIAL = new Set([
  'anthropic',
  'openai',
  'google',
  'google-vertex',
  'xai',
  'deepseek',
  'moonshotai',
  'moonshotai-cn',
  'minimax',
  'minimax-cn',
  'zai',
  'zai-coding-cn',
  'mistral',
  'meta',
  'nvidia',
  'groq',
  'fireworks',
  'together',
  'baseten',
  'cerebras',
  'huggingface',
  'ant-ling',
  'xiaomi',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'kimi-coding',
  'radius',
])

/** Strip vendor/region prefixes and request suffixes used by aggregator catalogs. */
export function canonicalId(raw) {
  let id = String(raw).trim().toLowerCase()
  if (id === '') return ''
  id = id.replace(/^~/, '')
  id = id.replace(/:(batch|free|extended|thinking|online|nitro)$/g, '')
  id = id.replace(/^(global|us|eu|apac|jp|au|ca)\./, '')
  const slash = id.lastIndexOf('/')
  if (slash !== -1) id = id.slice(slash + 1)
  id = id.replace(/^(anthropic|openai|google|xai|x-ai|meta|mistralai|moonshotai|minimax|nvidia|qwen|z-ai|zai|deepseek|bytedance-seed)\./, '')
  id = id.replace(/-(free|batch)$/, '')
  return id
}

/** The catalog key keeps dots but drops resolution/variant suffixes. */
function stableId(raw) {
  return canonicalId(raw).replace(/-(4k|2k|8k|hd|uhd)$/, '')
}

function modalityList(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '') continue
    if (!out.includes(item)) out.push(item)
  }
  return out.length > 0 ? out : undefined
}

function positive(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function score(entry, provider, model) {
  let value = 0
  if (OFFICIAL.has(provider)) value += 8
  if (entry.type !== undefined) value += 4
  if (entry.output !== undefined) value += 3
  if (Array.isArray(entry.input) && entry.input.includes('image')) value += 2
  if (entry.contextWindow !== undefined) value += 2
  if (entry.maxTokens !== undefined) value += 1
  if (entry.reasoning !== undefined) value += 1
  // A model whose id says "image" must not be represented by a chat alias.
  const idText = String(model.id ?? '').toLowerCase()
  if (/(^|[-_/])(image|imagen|dall-e|flux|nano-banana|seedream|ideogram|recraft|midjourney)([-_/]|$)/.test(idText)) {
    if (entry.type === 'image') value += 10
    else if (entry.type === 'chat') value -= 4
  }
  if (provider === 'openrouter' && entry.type === 'image') value += 2
  return value
}

/** Build one canonical entry per stable id from every provider snapshot. */
function build(data) {
  const groups = new Map()
  for (const file of fs.readdirSync(data).filter((name) => name.endsWith('.json'))) {
    const provider = file.replace(/\.json$/, '')
    const body = JSON.parse(fs.readFileSync(path.join(data, file), 'utf8'))
    for (const [namespace, models] of Object.entries(body)) {
      if (models === null || typeof models !== 'object') continue
      for (const [key, model] of Object.entries(models)) {
        if (model === null || typeof model !== 'object') continue
        const rawId = typeof model.id === 'string' ? model.id : key
        const id = stableId(rawId)
        if (id === '') continue
        const list = groups.get(id) ?? []
        list.push({ provider, namespace, rawId, entry: model })
        groups.set(id, list)
      }
    }
  }

  const catalog = {}
  const kinds = { chat: 0, image: 0, classifier: 0 }
  for (const [id, list] of groups) {
    list.sort((left, right) => score(right.entry, right.provider, right.entry) - score(left.entry, left.provider, left.entry))
    const best = list[0]
    const entry = best.entry
    const type = entry.type === 'image' ? 'image' : entry.type === 'classifier' ? 'classifier' : 'chat'
    const record = { type }
    const input = modalityList(entry.input)
    if (input !== undefined) record.input = input
    const output = modalityList(entry.output)
    if (output !== undefined) record.output = output
    if (typeof entry.reasoning === 'boolean') record.reasoning = entry.reasoning
    const contextWindow = positive(entry.contextWindow)
    if (contextWindow !== undefined) record.contextWindow = contextWindow
    const maxTokens = positive(entry.maxTokens)
    if (maxTokens !== undefined) record.maxTokens = maxTokens
    const provider = typeof entry.lab === 'string' ? entry.lab.toLowerCase() : best.provider
    record.provider = provider
    catalog[id] = record
    kinds[type] += 1
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(data, '.manifest.json'), 'utf8'))
  const version = readPiAiVersion(data)
  return { catalog, kinds, generatedAt: manifest.generatedAt, schemaVersion: manifest.schemaVersion, piAiVersion: version }
}

function readPiAiVersion(data) {
  let dir = data
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(dir, 'package.json')
    if (fs.existsSync(candidate)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (typeof pkg.version === 'string' && String(pkg.name ?? '').includes('pi-ai')) return pkg.version
      } catch (_error) {
        // keep climbing
      }
    }
    dir = path.dirname(dir)
  }
  return undefined
}

function render({ catalog, kinds, generatedAt, schemaVersion, piAiVersion }) {
  const ids = Object.keys(catalog).sort()
  const lines = []
  lines.push('/**')
  lines.push(' * Capability snapshot distilled from the pi-ai / models.dev catalog.')
  lines.push(' *')
  lines.push(' * Generated by `node scripts/build-catalog.mjs`; do not edit by hand.')
  lines.push(' * It only fills gaps: anything the installed adapter or the relay')
  lines.push(' * endpoint reports wins over this table.')
  lines.push(' *')
  lines.push(` * Source: @earendil-works/pi-ai ${piAiVersion ?? '(unknown version)'} provider data`)
  lines.push(` * Data generated at: ${generatedAt ?? 'unknown'}`)
  lines.push(` * Schema version: ${schemaVersion ?? 'unknown'}; models: ${ids.length} (${kinds.chat} chat, ${kinds.image} image, ${kinds.classifier} classifier)`)
  lines.push(' */')
  lines.push('')
  lines.push(`export const CATALOG_GENERATED_AT = ${JSON.stringify(generatedAt ?? null)}`)
  lines.push(`export const CATALOG_PI_AI_VERSION = ${JSON.stringify(piAiVersion ?? null)}`)
  lines.push('')
  lines.push('/** Short keys keep the module small: t=type, i=input, o=output, r=reasoning, c=context, m=max output, p=source provider. */')
  lines.push('export const MODEL_CATALOG = {')
  for (const id of ids) {
    lines.push(`  ${JSON.stringify(id)}: ${JSON.stringify(catalog[id])},`)
  }
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

const data = dataDir()
const built = build(data)
const out = path.resolve(argValue('--out') ?? path.join(root, 'lib/model-catalog.js'))
fs.writeFileSync(out, render(built))
console.log(`wrote ${out}`)
console.log(`models: ${Object.keys(built.catalog).length}`)
console.log(`kinds: ${JSON.stringify(built.kinds)}`)
console.log(`bytes: ${fs.statSync(out).size}`)
