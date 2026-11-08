/**
 * Manual capability overrides.
 *
 * Some relays publish almost nothing about a model: the OpenAI-compatible
 * `/models` listing may carry only an id, the built-in catalog snapshot may
 * predate the model, and the settings document may omit `reasoningEfforts`.
 * The page then shows "reasoning unknown / context unknown" for a model the
 * user knows perfectly well.
 *
 * This module owns the one evidence layer the user controls directly: a small
 * JSON file outside the profile patch (`$DSH_HOME/dsh-model-visibility/
 * overrides.json`) holding per-model facts that outrank every automatic source.
 * It is deliberately not a Config field: the values are structured objects,
 * they change on their own cadence, and a hand-edited file must keep working
 * even while the settings document is being rewritten.
 *
 * The Host reads the file synchronously (the request-side image gate needs a
 * synchronous answer) and re-reads it when the mtime changes, so editing the
 * JSON by hand is enough to apply a fix.
 *
 * @module lib/model-overrides
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MODEL_KINDS } from './capability-catalog.js'

/** Input modalities the page can declare for a model. */
export const OVERRIDE_MODALITIES = ['text', 'image', 'audio', 'video', 'file']

/**
 * Effort ids offered by the editor. The list is intentionally wider than the
 * `off/low/medium/high` ladder most adapters publish: relays and vendors also
 * use `minimal`, `max` and `xhigh`, and the whole point of a manual override is
 * to describe the upstream the adapter cannot describe.
 */
export const OVERRIDE_EFFORT_IDS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Neutral display names for the standard ids; custom ids fall back to the id. */
const EFFORT_NAMES = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

/** Upper bound on a manual ladder; protects the composer from a huge array. */
const MAX_EFFORTS = 16

/** Read a trimmed non-empty string, or undefined. */
export function text(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Unique known modalities, or undefined when the caller declared none. */
export function sanitizeModalities(value) {
  if (!Array.isArray(value)) return undefined
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || !OVERRIDE_MODALITIES.includes(item) || out.includes(item)) continue
    out.push(item)
  }
  return out.length > 0 ? out : undefined
}

/** Unique effort ids in the order the caller sent them. */
export function sanitizeEfforts(value) {
  if (!Array.isArray(value)) return undefined
  const ids = []
  for (const item of value) {
    const raw = item !== null && typeof item === 'object' ? item.id : item
    const id = text(raw)?.toLowerCase()
    if (id === undefined || !/^[a-z0-9][a-z0-9._-]{0,31}$/.test(id) || ids.includes(id)) continue
    ids.push(id)
    if (ids.length >= MAX_EFFORTS) break
  }
  if (ids.length === 0) return undefined
  return ids.map((id) => ({ id, name: EFFORT_NAMES[id] ?? id }))
}

/**
 * Normalize one override entry.
 *
 * An entry with no usable field returns undefined, which the store treats as
 * "remove this override": the editor can therefore clear everything by sending
 * empty checkboxes instead of a separate delete call.
 * @param input - wire value from the editor or the JSON file.
 * @returns a clean entry, or undefined when nothing was declared.
 */
export function sanitizeOverride(input) {
  if (input === null || typeof input !== 'object') return undefined
  const provider = text(input.provider)
  const model = text(input.model)
  if (provider === undefined || model === undefined) return undefined
  const entry = { provider, model }

  if (typeof input.kind === 'string' && MODEL_KINDS.includes(input.kind)) entry.kind = input.kind

  const contextWindow = Number(input.contextWindow)
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow

  const modalities = sanitizeModalities(input.input)
  if (modalities !== undefined) entry.input = modalities

  const efforts = sanitizeEfforts(input.efforts)
  if (efforts !== undefined) {
    entry.efforts = efforts
    const defaultEffort = text(input.defaultEffort)?.toLowerCase()
    if (defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort)) {
      entry.defaultEffort = defaultEffort
    }
  } else if (input.reasoningSupported === false) {
    entry.reasoningSupported = false
  }

  const declared =
    entry.kind !== undefined ||
    entry.contextWindow !== undefined ||
    entry.input !== undefined ||
    entry.efforts !== undefined ||
    entry.reasoningSupported !== undefined
  if (!declared) return undefined
  entry.updatedAt = Date.now()
  return entry
}

/** Absolute path of the override file below `$DSH_HOME`. */
export function overrideFile(home) {
  const base = home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(base, 'dsh-model-visibility', 'overrides.json')
}

/** Identity key; provider ids never contain a NUL, model ids may contain "/". */
function keyOf(provider, model) {
  return provider + '\u0000' + model
}

/**
 * A small read-through store around the override file.
 *
 * Reads are memoized by mtime, so the hot path (one synchronous call per model
 * on the request side) stays cheap while a hand edit still takes effect on the
 * next read.
 * @param options - `{ file?, home?, logger? }`.
 * @returns `{ file, list, get, upsert, remove, invalidate }`.
 */
export function createOverrideStore(options = {}) {
  const file = options.file || overrideFile(options.home)
  const logger = options.logger ?? console
  let entries = []
  let loaded = false
  let loadedMtime = -Infinity

  const warn = (message, error) => {
    if (typeof logger.warn === 'function') {
      logger.warn(message)
      if (error !== undefined) logger.warn(error)
    }
  }

  /** mtime of the file, or -Infinity when it does not exist. */
  const mtimeOf = () => {
    try {
      return fs.statSync(file).mtimeMs
    } catch (_error) {
      return -Infinity
    }
  }

  const load = (force = false) => {
    const mtime = mtimeOf()
    if (!force && loaded && mtime === loadedMtime) return
    loaded = true
    loadedMtime = mtime
    if (mtime === -Infinity) {
      entries = []
      return
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.overrides) ? parsed.overrides : []
      const next = []
      for (const item of source) {
        const entry = sanitizeOverride(item)
        if (entry !== undefined) next.push(entry)
      }
      entries = next
    } catch (error) {
      warn('model-visibility: could not read model overrides; ignoring the file')
      warn(error)
      entries = []
    }
  }

  const write = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify({ version: 1, overrides: entries }, null, 2)}\n`)
    fs.renameSync(temp, file)
    loadedMtime = mtimeOf()
  }

  /** Public entries as detached copies, in file order. */
  const list = () => {
    load()
    return entries.map((entry) => ({ ...entry }))
  }

  /** One entry for a provider/model pair, or undefined. */
  const get = (provider, model) => {
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    load()
    const key = keyOf(provider, model)
    const found = entries.find((entry) => keyOf(entry.provider, entry.model) === key)
    return found === undefined ? undefined : { ...found }
  }

  /** Insert or replace one entry; an empty declaration removes it. */
  const upsert = (raw) => {
    const entry = sanitizeOverride(raw)
    load(true)
    if (entry === undefined) {
      if (raw !== null && typeof raw === 'object') {
        const provider = text(raw.provider)
        const model = text(raw.model)
        if (provider !== undefined && model !== undefined) return remove(provider, model)
      }
      return undefined
    }
    const key = keyOf(entry.provider, entry.model)
    const index = entries.findIndex((item) => keyOf(item.provider, item.model) === key)
    if (index === -1) entries.push(entry)
    else entries[index] = entry
    write()
    return { ...entry }
  }

  /** Drop one entry; returns true when the file changed. */
  const remove = (provider, model) => {
    load(true)
    const key = keyOf(provider, model)
    const next = entries.filter((entry) => keyOf(entry.provider, entry.model) !== key)
    if (next.length === entries.length) return false
    entries = next
    write()
    return true
  }

  /** Forget the memoized copy; the next read consults the file again. */
  const invalidate = () => {
    loaded = false
    loadedMtime = -Infinity
  }

  return { file, list, get, upsert, remove, invalidate }
}
