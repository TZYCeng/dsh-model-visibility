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
import { createHash, randomUUID } from 'node:crypto'

import { MODEL_KINDS } from './capability-catalog.js'
import { withStoreLock } from './store-lock.js'

/** Input modalities the page can declare for a model. */
export const OVERRIDE_MODALITIES = ['text', 'image', 'audio', 'video', 'file']

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

/** Validate standard and custom ids using the same rules. */
function sanitizeEffortId(value) {
  const id = text(value)?.toLowerCase()
  return id !== undefined && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(id) ? id : undefined
}

/** Unique effort ids in the order the caller sent them. */
export function sanitizeEfforts(value) {
  if (!Array.isArray(value)) return undefined
  const ids = []
  for (const item of value) {
    const raw = item !== null && typeof item === 'object' ? item.id : item
    const id = sanitizeEffortId(raw)
    if (id === undefined || ids.includes(id)) continue
    ids.push(id)
    if (ids.length >= MAX_EFFORTS) break
  }
  if (ids.length === 0) return undefined
  return ids.map((id) => ({ id, name: Object.hasOwn(EFFORT_NAMES, id) ? EFFORT_NAMES[id] : id }))
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
  const defaultEffort = sanitizeEffortId(input.defaultEffort)
  if (efforts !== undefined) {
    entry.efforts = efforts
    if (defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort)) {
      entry.defaultEffort = defaultEffort
    }
  } else if (input.reasoningSupported === false) {
    entry.reasoningSupported = false
  } else if (defaultEffort !== undefined) {
    // The ladder may already have been mirrored into provider settings. The
    // capability merge will validate membership against the effective ladder.
    entry.defaultEffort = defaultEffort
  }

  // Provenance belongs to the retained reasoning declaration, not to a button
  // in the current editor. Never make a provenance marker alone an override.
  if (input.referencePrefill === true && (entry.efforts || entry.defaultEffort || entry.reasoningSupported === false)) {
    entry.referencePrefill = true
  }

  const declared =
    entry.kind !== undefined ||
    entry.contextWindow !== undefined ||
    entry.input !== undefined ||
    entry.efforts !== undefined ||
    entry.defaultEffort !== undefined ||
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

/** Collision-free provider/model identity; model ids may contain slashes. */
function keyOf(provider, model) {
  return JSON.stringify([provider, model])
}

/**
 * A small read-through store around the override file.
 *
 * Reads are memoized by mtime, so the hot path (one synchronous call per model
 * on the request side) stays cheap while a hand edit still takes effect on the
 * next read.
 * @param options - `{ file?, home?, logger? }`.
 * @returns `{ file, list, get, read, snapshot, compareAndCommit, upsert, remove, invalidate }`.
 */
export function createOverrideStore(options = {}) {
  const file = options.file || overrideFile(options.home)
  const logger = options.logger ?? console
  let entries = []
  let document = { metadata: {}, source: [] }
  let signature
  let lastFailure

  const statSignature = () => {
    try {
      const stat = fs.statSync(file, { bigint: true, throwIfNoEntry: false })
      return stat === undefined ? null : [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw error
    }
  }

  const load = (strict = false) => {
    try {
      const current = statSignature()
      if (!strict && current === signature) return
      const parsed = current === null ? [] : JSON.parse(fs.readFileSync(file, 'utf8'))
      const source = Array.isArray(parsed) ? parsed : parsed?.overrides
      if (!Array.isArray(source) || (!Array.isArray(parsed) && parsed.version !== undefined && parsed.version !== 1)) {
        throw new Error('Unsupported override file format')
      }
      const next = []
      const seen = new Set()
      for (const raw of source) {
        const entry = sanitizeOverride(raw)
        if (entry === undefined) continue
        const key = keyOf(entry.provider, entry.model)
        if (seen.has(key)) throw new Error('Duplicate model override identity')
        seen.add(key)
        if (Number.isSafeInteger(raw.updatedAt)) entry.updatedAt = raw.updatedAt
        else delete entry.updatedAt
        next.push({ raw, entry })
      }
      if (statSignature() !== current) throw new Error('Override file changed while being read')
      // Keep unrecognized rows and top-level metadata through a targeted edit.
      // They are not evidence, but they belong to the user who wrote the file.
      entries = next
      document = { metadata: Array.isArray(parsed) ? {} : parsed, source }
      signature = current
      lastFailure = undefined
    } catch (error) {
      signature = undefined
      const failure = new Error('Could not read model overrides', { cause: error })
      failure.code = 'OVERRIDES_UNREADABLE'
      const reason = String(error?.code ?? error?.name ?? '')
      if (lastFailure !== reason) logger.warn?.('model-visibility: could not read model overrides; keeping the last good copy')
      lastFailure = reason
      if (strict) throw failure
    }
  }

  const write = (next) => {
    const targetSignature = signature
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify({ ...document.metadata, version: 1, overrides: next }, null, 2)}\n`, { flag: 'wx' })
      if (statSignature() !== targetSignature) {
        const error = new Error('Override file changed before it could be saved')
        error.code = 'OVERRIDES_CONFLICT'
        throw error
      }
      fs.renameSync(temp, file)
    } finally {
      try { fs.unlinkSync(temp) } catch (_error) { /* absent after rename */ }
    }
    signature = undefined
    load()
  }

  const revisionOf = (row) => row === undefined ? null
    : createHash('sha256').update(JSON.stringify(row.raw)).digest('hex')
  const find = (provider, model) => entries.find(({ entry }) => entry.provider === provider && entry.model === model)

  const list = () => {
    load()
    return entries.map(({ entry }) => structuredClone(entry))
  }
  const get = (provider, model) => {
    load()
    return structuredClone(find(provider, model)?.entry)
  }
  // Editor reads are strict: an unavailable file is not an empty document.
  const read = () => {
    load(true)
    return {
      overrides: entries.map(({ entry }) => structuredClone(entry)),
      revisions: entries.map((row) => ({ provider: row.entry.provider, model: row.entry.model, revision: revisionOf(row) })),
    }
  }
  const snapshot = (provider, model) => {
    load(true)
    const row = find(provider, model)
    return { entry: structuredClone(row?.entry), revision: revisionOf(row) }
  }

  const commit = (raw, expectedRevision, compare) => withStoreLock(file, () => {
    load(true)
    const provider = text(raw?.provider)
    const model = text(raw?.model)
    if (provider === undefined || model === undefined) throw new TypeError('Override identity is required')
    const old = find(provider, model)
    const previous = { entry: structuredClone(old?.entry), revision: revisionOf(old) }
    if (compare && previous.revision !== expectedRevision) return { ok: false, ...previous }
    // An older/reopened client might omit (or clear) the marker. Keep the
    // conservative policy while this local ladder survives. Removing all its
    // reasoning fields, or resetting the row, clears its provenance normally.
    const entry = sanitizeOverride(old?.entry.referencePrefill === true ? { ...raw, referencePrefill: true } : raw)
    if (entry === undefined && old === undefined) return { ok: true, ...previous }
    const next = [...document.source]
    const index = old === undefined ? -1 : next.indexOf(old.raw)
    // A write token distinguishes edits made in the same millisecond, including
    // replacing an override with identical fields in another open editor.
    const stored = entry === undefined ? undefined : { ...entry, revision: randomUUID() }
    if (index < 0) next.push(stored)
    else if (stored === undefined) next.splice(index, 1)
    else next[index] = stored
    try {
      write(next)
    } catch (error) {
      if (!compare || error?.code !== 'OVERRIDES_CONFLICT') throw error
      return { ok: false, ...snapshot(provider, model) }
    }
    return { ok: true, entry: structuredClone(entry), revision: revisionOf(stored === undefined ? undefined : { raw: stored }) }
  })

  const upsert = (raw) => {
    if (text(raw?.provider) === undefined || text(raw?.model) === undefined) return undefined
    const result = commit(raw, undefined, false)
    return result.entry
  }
  const remove = (provider, model) => {
    const previous = snapshot(provider, model)
    return previous.revision !== null && compareAndCommit({ provider, model }, previous.revision).ok
  }
  const compareAndCommit = (raw, expectedRevision) => commit(raw, expectedRevision, true)
  const invalidate = () => { signature = undefined }

  return { file, list, get, read, snapshot, compareAndCommit, upsert, remove, invalidate }
}
