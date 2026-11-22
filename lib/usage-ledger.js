/** Token usage by local calendar day and model route, derived from durable DSH sessions. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createHash, randomUUID } from 'node:crypto'
import { withStoreLock } from './store-lock.js'
import { boundedOperation } from './async-operation.js'
import { routeKey } from './visibility-identity.js'
import { streamDiskLog } from './usage-disk.js'

const ZSTD_MAGIC = 4247762216
const UTF8 = new TextDecoder('utf-8', { fatal: true })
const SESSION_VERSION = 4
const RETENTION_MONTHS = 14
// v3 rebuilds v1/v2 session records (old attribution and premature pruning).
// The plugin's own settlements are independent of the session cache version.
const FILE_CACHE_VERSION = 3
const PLUGIN_FLUSH_DELAY_MS = 250

/** Locate complete frames, retaining the good prefix on structural damage. */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, error: `invalid Zstandard frame at byte ${offset}` }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 24) !== 0) return { frames, error: `invalid Zstandard frame header at byte ${offset - 1}` }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryBytes = (descriptor & 3) === 3 ? 4 : descriptor & 3
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, error: `invalid Zstandard block at byte ${offset - 3}` }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function decodeLog(buffer, isZstd) {
  const lines = []
  const append = (bytes) => {
    const end = bytes.lastIndexOf(10)
    // These logs are LF-terminated records. Do not commit even a valid JSON
    // object without the terminator: it may still be an in-flight append.
    const text = UTF8.decode(bytes.subarray(0, end + 1))
    if (end >= 0) {
      for (const line of text.slice(0, -1).split('\n')) lines.push(line)
    }
    return end + 1 === bytes.length
  }
  if (!isZstd) {
    try {
      if (!append(buffer)) return { lines, error: 'incomplete JSONL tail' }
    } catch {
      // Find the valid prefix by line if the whole buffer was not valid UTF-8.
      let start = 0
      for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
        try { append(buffer.subarray(start, end + 1)) } catch { break }
        start = end + 1
      }
      return { lines, error: 'invalid UTF-8 in JSONL log' }
    }
    return { lines }
  }
  const scan = scanZstdFrames(buffer)
  for (const { start, end } of scan.frames) {
    try {
      if (!append(zlib.zstdDecompressSync(buffer.subarray(start, end)))) {
        return { lines, error: `incomplete JSONL record in Zstandard frame at byte ${start}` }
      }
    } catch {
      return { lines, error: `could not decode Zstandard frame at byte ${start}` }
    }
  }
  const error = scan.error ?? (scan.tornStart === undefined ? undefined : 'incomplete Zstandard tail')
  return { lines, error }
}

/** Complete JSONL records from the readable prefix of either encoding. */
export function decodeLogLines(buffer, isZstd) {
  return decodeLog(buffer, isZstd).lines
}

/** Local-calendar `YYYY-MM-DD` key for one epoch-ms timestamp. */
export function dayKeyOf(time) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return undefined
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function monthKeyOf(dayKey) {
  return typeof dayKey === 'string' && dayKey.length >= 7 ? dayKey.slice(0, 7) : undefined
}

export function weekStartKey(now = Date.now()) {
  const date = new Date(now)
  date.setDate(date.getDate() - (date.getDay() + 6) % 7)
  return dayKeyOf(date.getTime())
}

/** Subtract local calendar months, clamping to the target month's last day. */
function retentionStartKey(stamp) {
  const date = new Date(stamp)
  const day = date.getDate()
  date.setDate(1)
  date.setMonth(date.getMonth() - RETENTION_MONTHS)
  const last = new Date(date)
  last.setMonth(last.getMonth() + 1, 0)
  date.setDate(Math.min(day, last.getDate()))
  return dayKeyOf(date.getTime())
}

const dictionary = () => Object.create(null)
const zeroBuckets = () => [0, 0, 0, 0]
const nonempty = (value) => typeof value === 'string' && value !== ''
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isTokenCount = (value) => Number.isSafeInteger(value) && value >= 0
const dateOf = (value) => isTokenCount(value) ? dayKeyOf(value) : undefined

function addInto(target, source, factor = 1) {
  for (let i = 0; i < 4; i += 1) target[i] += factor * source[i]
}

/** Same last usage sample as DSH's tokenUsage projection. */
function usageOf(event) {
  const data = event.data
  if (event.type === 'assistant/message' && data?.usage !== undefined) return data.usage
  if (!Array.isArray(data?.stream)) return undefined
  for (let i = data.stream.length - 1; i >= 0; i -= 1) {
    const record = data.stream[i]
    if (record?.type === 'chunk' && record.chunk?.type === 'usage') return record.chunk.usage
  }
}

function bucketsOf(usage) {
  const values = [usage?.inputTokens, usage?.outputTokens, usage?.cacheReadTokens ?? 0, usage?.cacheWriteTokens ?? 0]
  return values.every(isTokenCount) ? values : undefined
}

function routeOf(data) {
  return nonempty(data?.provider) && nonempty(data?.model) ? routeKey(data.provider, data.model) : undefined
}

// A checkpoint is a derived, process-local projection: no message text,
// prompt, stream, or event graph survives a page. Clone on resume so a
// failed/cancelled tail never mutates published totals or the last good cut.
function createFold({ createdAt, from, inheritedEventCount = 0, checkpoint } = {}) {
  const creationDay = dateOf(createdAt)
  let buckets = dictionary()
  for (const [day, routes] of Object.entries(checkpoint?.buckets ?? {})) {
    if (from && day < from) continue
    buckets[day] = dictionary()
    for (const [key, tuple] of Object.entries(routes)) buckets[day][key] = [...tuple]
  }
  let last = checkpoint?.last ?? null
  const headerRoutes = new Map(checkpoint?.headerRoutes)
  const stepRoutes = new Map(checkpoint?.stepRoutes)
  let headerRoute = checkpoint?.headerRoute
  let contextRoute = checkpoint?.contextRoute
  let error
  let index = checkpoint?.offset ?? 0
  let hasInheritedMarker = checkpoint?.hasInheritedMarker ?? false
  const stepKey = (data) => isTokenCount(data?.turn) && isTokenCount(data?.step) ? `${data.turn}:${data.step}` : undefined

  const record = (dayKey, route, values, factor = 1) => {
    if (dayKey === undefined || (from !== undefined && dayKey < from)) return
    const byModel = buckets[dayKey] ?? (buckets[dayKey] = dictionary())
    addInto(byModel[route] ?? (byModel[route] = zeroBuckets()), values, factor)
    addInto(byModel['*'] ?? (byModel['*'] = zeroBuckets()), values, factor)
    if (factor < 0) {
      if (byModel[route].every((n) => n === 0)) delete byModel[route]
      if (byModel['*'].every((n) => n === 0)) delete buckets[dayKey]
    }
  }

  const accept = (event) => {
    if (error) return
    if (!isRecord(event) || !nonempty(event.type)) {
      error = 'invalid session event'
      return
    }
    const inherited = index++ < inheritedEventCount
    const data = event.data
    if (event.type === 'request/header') {
      headerRoute = routeOf(data?.header?.config)
      contextRoute = undefined
      if (isTokenCount(event.seq)) headerRoutes.set(event.seq, headerRoute)
      const key = stepKey(data)
      if (key !== undefined) stepRoutes.set(key, headerRoute)
    } else if (event.type === 'request/context') {
      contextRoute = routeOf(data)
      const key = stepKey(data)
      if (key !== undefined) stepRoutes.set(key, contextRoute)
    } else if (event.type === 'developer/message' && isTokenCount(data?.headerSeq)) {
      // rc.5 tool-registration developers can name the exact earlier header.
      const key = stepKey(data)
      if (key !== undefined) stepRoutes.set(key, headerRoutes.get(data.headerSeq))
    } else if (event.type === 'session/end-seed' && data?.inherited === true) {
      // Keep request metadata in force across the seed boundary, but discard
      // inherited settlements. A later untagged restore marker has no effect.
      hasInheritedMarker = true
      stepRoutes.clear()
      buckets = dictionary()
      last = null
    } else if (inherited) {
      return
    } else if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === data?.turn && last.step === data?.step) last = null
      stepRoutes.delete(stepKey(data))
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const usage = usageOf(event)
      if (usage === undefined) return
      const values = bucketsOf(usage)
      if (values === undefined || !isTokenCount(data?.turn) || !isTokenCount(data?.step)) {
        error = 'invalid assistant usage settlement'
        return
      }
      const ownRoute = (data.message?.source?.kind === 'model' ? routeOf(data.message.source) : undefined) ?? routeOf(data)
      const key = stepKey(data)
      const requestRoute = isTokenCount(data.headerSeq)
        ? headerRoutes.get(data.headerSeq)
        : stepRoutes.has(key) ? stepRoutes.get(key) : contextRoute ?? headerRoute
      const route = ownRoute ?? requestRoute ?? 'unknown'
      const routeRank = ownRoute !== undefined ? 2 : requestRoute !== undefined ? 1 : 0
      const previous = last !== null && last.turn === data.turn && last.step === data.step ? last : null
      let dayKey = dateOf(event.time) ?? creationDay
      if (previous !== null) {
        if (previous.values.every((n, i) => n === values[i])) {
          // DSH keeps the first identical sample. An explicit message route can
          // improve attribution without changing that sample's event day.
          if (routeRank <= previous.routeRank || route === previous.route) return
          dayKey = previous.dayKey
        }
        record(previous.dayKey, previous.route, previous.values, -1)
      }
      record(dayKey, route, values)
      last = { turn: data.turn, step: data.step, dayKey, route, routeRank, values }
    }
  }
  return { accept, get error() { return error }, finish: () => ({ buckets, hasInheritedMarker, error }),
    checkpoint: () => ({ buckets, hasInheritedMarker, offset: index, last, headerRoute, contextRoute, headerRoutes, stepRoutes, createdAt, inheritedEventCount, from }) }
}

function createLineFold({ createdAt, from } = {}) {
  let header
  let fold
  let error
  let lineNumber = 0
  return {
    accept(line) {
      if (error) return false
      lineNumber++
      let event
      try { event = JSON.parse(line) } catch { error = `invalid JSONL at line ${lineNumber}`; return false }
      if (lineNumber === 1 && event?.type === 'session') {
        header = event
        if (header.version !== undefined && header.version !== SESSION_VERSION) error = 'unsupported session log format'
      } else if (event?.type === 'session') {
        error = `unexpected session header at line ${lineNumber}`
      } else {
        fold ??= createFold({ createdAt: createdAt ?? header?.createdAt, from })
        fold.accept(event)
        error = fold.error
      }
      return !error
    },
    finish() {
      const result = fold?.finish()
      const missingCut = header?.isSeeded === true && !result?.hasInheritedMarker
      return { createdAt: createdAt ?? header?.createdAt, hasHeader: header !== undefined,
        buckets: !missingCut && result ? result.buckets : dictionary(),
        error: error ?? (missingCut ? 'missing inherited-session boundary' : undefined) }
    },
  }
}

/** Fold a JSONL log prefix in one pass; retain no input event array. */
export function foldLogToBuckets(lines, options) {
  const fold = createLineFold(options)
  for (const line of lines) if (!fold.accept(line)) break
  return fold.finish()
}

function generationOf(name) {
  if (/^session\.jsonl(?:\.zstd)?$/.test(name)) return 0
  const match = /^session\.v([1-9]\d*)\.jsonl(?:\.zstd)?$/.exec(name)
  const generation = match ? Number(match[1]) : undefined
  return isTokenCount(generation) ? generation : undefined
}

function diskRevision({ size, mtimeMs, ctimeMs, ino }) {
  return `${size}:${mtimeMs}:${ctimeMs}:${ino}`
}

/** Scan only DSH's `<project>/<session>` directories, never older sibling generations. */
export async function listSessionFiles(root, { signal } = {}) {
  const files = []
  const errors = []
  const directories = async (dir) => {
    signal?.throwIfAborted()
    try {
      return await fsp.readdir(dir, { withFileTypes: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push('could not read a session directory')
      return []
    }
  }
  for (const project of await directories(root)) {
    if (!project.isDirectory()) continue
    const projectPath = path.join(root, project.name)
    for (const session of await directories(projectPath)) {
      if (!session.isDirectory()) continue
      const key = `${project.name}/${session.name}`
      const dir = path.join(projectPath, session.name)
      const candidates = (await directories(dir)).flatMap((entry) => {
        const version = generationOf(entry.name)
        return entry.isFile() && version !== undefined ? [{ name: entry.name, version }] : []
      })
      if (candidates.length === 0) continue
      candidates.sort((left, right) => right.version - left.version)
      const latest = candidates[0]
      if (latest.version !== SESSION_VERSION || candidates[1]?.version === latest.version) {
        files.push({ key, error: latest.version !== SESSION_VERSION ? 'unsupported session log generation' : 'conflicting session log encodings' })
        continue
      }
      const absPath = path.join(dir, latest.name)
      try {
        const stat = await fsp.stat(absPath)
        files.push({ key, absPath, revision: `${latest.name}:${diskRevision(stat)}` })
      } catch (error) {
        if (error?.code !== 'ENOENT') files.push({ key, error: 'could not stat the session log' })
      }
    }
  }
  return { files, errors }
}

async function readDiskSession(meta, from, options) {
  const fold = createLineFold({ from })
  const problem = await streamDiskLog(meta.absPath, fold.accept, options)
  options.signal.throwIfAborted()
  const stat = await fsp.stat(meta.absPath)
  if (meta.revision !== `${path.basename(meta.absPath)}:${diskRevision(stat)}`) {
    return { error: 'session log changed during scan' }
  }
  const folded = fold.finish()
  return folded.hasHeader ? { buckets: folded.buckets, error: folded.error ?? problem }
    : { error: problem ?? 'missing session log header' }
}

// close() itself is deliberately uncancellable. Start it even if the caller
// already aborted; bound only OUR wait. A late read handle is disposed once
// and is never allowed to publish a fold or start another backend read.
function closeReadHandle(handle, options) {
  let closing
  try { closing = Promise.resolve(handle.close()) } catch (error) { closing = Promise.reject(error) }
  closing.catch(() => {})
  return boundedOperation(() => closing, { label: 'usage close', timeoutMs: options.ioTimeoutMs, signal: options.signal })
}

async function readStoredSession(persistence, meta, from, options, previous) {
  const { signal, ioTimeoutMs: timeoutMs, pageSize, trace } = options
  const handle = await boundedOperation(async opSignal => {
    const opened = await persistence.open(meta.key, 'read', { signal: opSignal })
    if (opSignal.aborted) {
      void closeReadHandle(opened, options).catch(() => {})
      opSignal.throwIfAborted()
    }
    return opened
  }, { signal, timeoutMs, label: 'usage open' })
  try {
    signal.throwIfAborted()
    const createdAt = handle.header.createdAt, inheritedEventCount = handle.inheritedEventCount
    if (!isTokenCount(inheritedEventCount) || (meta.eventCount !== undefined && !isTokenCount(meta.eventCount))) {
      throw new Error('invalid usage session metadata')
    }
    // This cache is in-memory only, on the same append-only service instance.
    // On cold start/change of metadata (or an earlier retention window) replay
    // from zero. Never infer an append from a disk file's mtime/size alone.
    const checkpoint = previous && previous.createdAt === createdAt && previous.inheritedEventCount === inheritedEventCount &&
      previous.from <= from && (meta.eventCount === undefined || previous.offset <= meta.eventCount) ? previous : undefined
    let offset = checkpoint?.offset ?? 0
    const start = offset
    const fold = createFold({ createdAt, inheritedEventCount, from, checkpoint })
    let pages = 0
    // A short page is NOT necessarily the end: only a known sampled extent or
    // an empty page is authoritative. Validate every seq, not just the length,
    // so repeated first pages and holes cannot silently double-count a ledger.
    while (meta.eventCount === undefined || offset < meta.eventCount) {
      const length = Math.min(pageSize, (meta.eventCount ?? Infinity) - offset)
      const result = await boundedOperation(opSignal => handle.read(offset, length, { signal: opSignal }),
        { signal, timeoutMs, label: 'usage read' })
      signal.throwIfAborted()
      const events = result?.events
      if (!Array.isArray(events) || events.length > length || (!events.length && meta.eventCount !== undefined)) {
        throw new Error('invalid usage page')
      }
      pages++
      if (!events.length) break
      for (const event of events) {
        if (event?.seq !== offset++) throw new Error('noncontiguous usage page')
        fold.accept(event)
        if (fold.error) return fold.finish()
      }
      if (pages % 8 === 0) await new Promise(resolve => setImmediate(resolve))
    }
    if (offset < inheritedEventCount) throw new Error('incomplete inherited usage prefix')
    signal.throwIfAborted()
    trace?.('usage', 'session.read', { count: pages, processed: offset - start, skipped: start, total: offset })
    return { ...fold.finish(), checkpoint: fold.checkpoint() }
  } finally { await closeReadHandle(handle, options) }
}

const validDay = (key) => /^\d{4}-\d{2}-\d{2}$/.test(key)

function cleanBuckets(raw) {
  const clean = dictionary()
  if (!isRecord(raw)) return clean
  for (const [day, byRoute] of Object.entries(raw)) {
    if (!validDay(day) || !isRecord(byRoute)) continue
    for (const [route, values] of Object.entries(byRoute)) {
      if (Array.isArray(values) && values.length === 4 && values.every(isTokenCount)) {
        const byModel = clean[day] ?? (clean[day] = dictionary())
        byModel[route] = values
      }
    }
  }
  return clean
}

/** Cached, read-only usage snapshots. An explicit sessionsRoot selects disk scan. */
export function createUsageLedger(options = {}) {
  const logger = options.logger ?? console
  const now = typeof options.now === 'function' ? options.now : Date.now
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = options.file || path.join(home, 'dsh-model-visibility', 'usage-ledger.json')
  const root = path.resolve(options.sessionsRoot || path.join(home, 'sessions'))
  const service = options.sessionsRoot ? undefined : options.sessionPersistence
  const profile = options.profileScope ?? (process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || null)
  const source = service ? `service:${profile || home}` : `jsonl:${root}`
  const legacyFile = options.legacyFile && path.resolve(options.legacyFile) !== path.resolve(file) ? options.legacyFile : undefined
  const positive = (n, fallback, max) => Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback
  const ioTimeoutMs = positive(options.ioTimeoutMs, 15_000, 180_000)
  const scanTimeoutMs = positive(options.scanTimeoutMs, 4 * 60_000, 30 * 60_000)
  const pageSize = positive(options.pageSize, 256, 2048)
  const chunkBytes = positive(options.chunkBytes, 128 * 1024, 1024 * 1024)
  const trace = (module, step, data) => { try { options.trace?.(module, step, data) } catch { /* observation only */ } }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const lifetime = new AbortController()
  // Revisions and append projections are comparable only on this service instance.
  let serviceRevisions = new Map()
  let checkpoints = new Map()
  let retryKeys = new Set()
  let files = dictionary()
  let partials = dictionary()
  let pluginBuckets = dictionary()
  // Keep this writer's unsettled contribution separate: another Host can
  // publish its own checker spend between our load and delayed flush.
  let pluginDelta = dictionary()
  let fileFence = null
  let projection = null
  let loaded = false
  let scanInflight = null
  let scanProgress = null
  let completedScan = false
  let scanError
  let cacheError
  let migrationWarning
  let pluginDirty = false
  let staleFileCache = false
  let flushTimer = null
  let disposeTask = null
  let disposed = false

  const warn = (message) => {
    if (typeof logger.warn === 'function') logger.warn(`model-visibility: ${message}`)
  }

  const fingerprint = text => createHash('sha256').update(text).digest('hex')
  const load = () => {
    if (loaded) return
    loaded = true
    try {
      let parsed, importing = false
      try {
        const text = fs.readFileSync(file, 'utf8')
        parsed = JSON.parse(text)
        fileFence = fingerprint(text)
      }
      catch (error) {
        if (error?.code !== 'ENOENT' || !legacyFile) throw error
        parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); importing = true
      }
      if (!isRecord(parsed)) throw new Error('invalid cache')
      const sameSource = parsed.source === source
      const sameProfile = profile !== null && parsed.pluginScope === profile
      const plugin = cleanBuckets(parsed.plugin)
      if (!importing || sameProfile) pluginBuckets = plugin
      // v1–v3's unscoped checker bucket crossed sources even when its session
      // file map did not. The last writer's `source` does not prove who paid.
      const legacyUnassigned = importing && !sameProfile && Object.keys(plugin).length > 0
      if (legacyUnassigned || parsed.legacyUnassigned === true) {
        migrationWarning = 'Earlier shared checker usage could not be assigned to this profile. It remains in the original ledger and is not included here.'
      }
      staleFileCache = parsed.version !== FILE_CACHE_VERSION || !sameSource || parsed.timeZone !== timeZone
      if (!staleFileCache && isRecord(parsed.files)) {
        for (const [key, record] of Object.entries(parsed.files)) {
          if (!isRecord(record) || !validDay(record.from)) continue
          const buckets = cleanBuckets(record.buckets)
          files[key] = { revision: record.revision, from: record.from, buckets }
          // Existing v3 data remains readable. A legacy multi-slash aggregate
          // can only be attributed by replaying its source, never by splitting.
          if (Object.values(buckets).some(routes =>
            Object.keys(routes).some(route => route.indexOf('/') !== route.lastIndexOf('/')))) retryKeys.add(key)
        }
      }
      if (importing) staleFileCache = true
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        cacheError = 'Could not read the usage cache; recorded session usage will be rebuilt.'
        warn(cacheError)
      }
    }
  }

  const cancelFlush = () => {
    if (flushTimer !== null) clearTimeout(flushTimer)
    flushTimer = null
  }

  const persist = () => {
    let temp
    try {
      withStoreLock(file, () => {
        let current, token = null
        try { const text = fs.readFileSync(file, 'utf8'); token = fingerprint(text); current = JSON.parse(text) }
        catch (error) { if (error?.code !== 'ENOENT') throw error }
        if (token !== null && !isRecord(current)) throw new Error('Unreadable current ledger')
        if (token === null && fileFence !== null) throw new Error('Ledger was removed after opening')
        let plugin = pluginBuckets, mergedFiles = files
        if (token !== fileFence) {
          // Current file changed: do not publish a stale whole cache. Distinct
          // session keys can be merged, but opaque per-session revisions from
          // two services cannot be ordered. Keep disk's overlap until scanned
          // again and add only this writer's NEW counted settlements.
          if (current?.version !== FILE_CACHE_VERSION || current.source !== source ||
              current.timeZone !== timeZone || (current.pluginScope ?? null) !== profile || !isRecord(current.files)) {
            throw new Error('Incompatible usage ledger changed on disk')
          }
          plugin = cleanBuckets(current.plugin)
          for (const [day, routes] of Object.entries(pluginDelta)) {
            const dest = plugin[day] ??= dictionary()
            for (const [key, tuple] of Object.entries(routes)) addInto(dest[key] ??= zeroBuckets(), tuple)
          }
          prune(plugin, retentionStartKey(now()))
          mergedFiles = Object.assign(dictionary(), files)
          for (const [key, record] of Object.entries(current.files)) {
            if (!isRecord(record) || !validDay(record.from)) throw new Error('Invalid peer usage cache')
            mergedFiles[key] = { revision: record.revision, from: record.from, buckets: cleanBuckets(record.buckets) }
          }
        }
        const body = { version: FILE_CACHE_VERSION, routeFormat: 2, source, timeZone, updatedAt: now(),
          ...(profile ? { pluginScope: profile } : {}), ...(migrationWarning ? { legacyUnassigned: true } : {}), plugin, files: mergedFiles }
        const text = `${JSON.stringify(body)}\n`
        temp = `${file}.${process.pid}.${randomUUID()}.tmp`
        fs.writeFileSync(temp, text, { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); temp = undefined
        if (mergedFiles !== files) {
          for (const key of Object.keys(current.files)) {
            serviceRevisions.delete(key); checkpoints.delete(key); delete partials[key]; retryKeys.add(key)
          }
        }
        files = mergedFiles; pluginBuckets = plugin; pluginDelta = dictionary(); fileFence = fingerprint(text); projection = null
        pluginDirty = false; staleFileCache = false; cacheError = undefined
        cancelFlush()
      })
    } catch {
      cacheError = 'Could not save the usage cache; the existing file was not replaced. In-memory totals remain available.'
      warn(cacheError)
    } finally { if (temp) try { fs.unlinkSync(temp) } catch { /* cleanup is best effort */ } }
  }

  const prune = (buckets, from) => {
    let changed = false
    for (const day of Object.keys(buckets)) {
      if (day < from) {
        delete buckets[day]
        changed = true
      }
    }
    return changed
  }

  const list = async (signal) => {
    if (!service) return listSessionFiles(root, { signal })
    const sessions = await service.list({ signal })
    signal.throwIfAborted()
    return { files: sessions.map(session => ({ key: session.header.id, revision: session.revision, eventCount: session.eventCount })), errors: [] }
  }

  /** Join the exact in-flight scan without a separate check-then-start race. */
  const rescan = ({ force = false, signal: caller } = {}) => {
    if (disposed) return Promise.resolve()
    load()
    if (scanInflight !== null) return scanInflight
    const parent = caller ? AbortSignal.any([caller, lifetime.signal]) : lifetime.signal
    const progress = { done: 0, total: null }
    scanProgress = progress
    const started = Date.now()
    const run = async (signal) => {
      const from = retentionStartKey(now())
      trace('usage', 'scan.start', { source: service ? 'service' : 'disk', fresh: force })
      const listing = await boundedOperation(list, { signal, timeoutMs: ioTimeoutMs, label: 'usage list' })
      signal.throwIfAborted()
      const problems = [...listing.errors]
      const scanned = Object.assign(dictionary(), files)
      const recovered = Object.assign(dictionary(), partials)
      const revisions = new Map(serviceRevisions), nextRetry = new Set(retryKeys), nextCuts = new Map(checkpoints)
      const seen = new Set()
      let changed = false, reused = 0
      progress.total = listing.files.length
      for (const meta of listing.files) {
        signal.throwIfAborted()
        if (seen.has(meta.key)) { problems.push('duplicate session id in storage listing'); continue }
        seen.add(meta.key)
        const previous = scanned[meta.key]
        const revision = service ? revisions.get(meta.key) : previous?.revision
        if (meta.error || force || nextRetry.has(meta.key) || revision !== meta.revision || !previous || previous.from > from) {
          try {
            const result = meta.error ? { error: meta.error } : service
              ? await readStoredSession(service, meta, from, { signal, ioTimeoutMs, pageSize, trace }, !force && nextCuts.get(meta.key))
              : await boundedOperation(opSignal => readDiskSession(meta, from, { signal: opSignal, chunkBytes, trace }),
                  { signal, timeoutMs: scanTimeoutMs, label: 'usage disk read' })
            signal.throwIfAborted()
            if (result.error) {
              problems.push(result.error)
              // Keep the last good fold. On a first scan the valid prefix is
              // available in memory, but never persisted as a valid revision.
              if (!previous && result.buckets && Object.keys(result.buckets).length > 0 && !recovered[meta.key]) {
                recovered[meta.key] = result.buckets
              }
              nextRetry.add(meta.key)
              revisions.delete(meta.key)
            } else {
              scanned[meta.key] = { revision: service ? undefined : meta.revision, from, buckets: result.buckets }
              if (service) {
                revisions.set(meta.key, meta.revision)
                nextCuts.set(meta.key, result.checkpoint)
              }
              nextRetry.delete(meta.key)
              delete recovered[meta.key]
              changed = true
            }
          } catch (error) {
            signal.throwIfAborted()
            problems.push(error?.code === 'TIMEOUT' ? 'session storage operation timed out' : 'could not read a session log from storage')
            nextRetry.add(meta.key)
            revisions.delete(meta.key)
          }
        } else reused++
        progress.done += 1
        if (progress.done % 8 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
      signal.throwIfAborted()
      // Retain the last known usage for removed logs until it ages out, but
      // don't accumulate empty entries for deleted sessions forever.
      for (const [key, record] of Object.entries(scanned)) {
        if (record.from < from) {
          const buckets = Object.assign(dictionary(), record.buckets)
          prune(buckets, from)
          scanned[key] = { ...record, from, buckets }
          changed = true
        }
        if (!seen.has(key) && Object.keys(scanned[key].buckets).length === 0) {
          delete scanned[key]
          revisions.delete(key)
          nextRetry.delete(key)
          nextCuts.delete(key)
          changed = true
        }
      }
      for (const [key, buckets] of Object.entries(recovered)) {
        prune(buckets, from)
        if (Object.keys(buckets).length === 0) delete recovered[key]
      }
      if (prune(pluginBuckets, from)) pluginDirty = true
      // Cut metadata is only useful for live sessions; never retain references
      // to deleted logs' request/header/step maps for the retention window.
      for (const key of nextCuts.keys()) if (!seen.has(key)) { nextCuts.delete(key); revisions.delete(key) }
      files = scanned
      partials = recovered
      projection = null
      serviceRevisions = revisions; retryKeys = nextRetry; checkpoints = nextCuts
      completedScan = true
      scanError = problems.length === 0 ? undefined
        : `Usage scan incomplete (${problems.length} storage issue${problems.length === 1 ? '' : 's'}; ${problems[0]}). Last good totals were kept where available.`
      if (scanError !== undefined) warn(scanError)
      if (changed || pluginDirty || staleFileCache) persist()
      trace('usage', 'scan.complete', { processed: progress.done, skipped: reused, failed: problems.length, durationMs: Date.now() - started })
    }
    scanInflight = boundedOperation(run, { signal: parent, timeoutMs: scanTimeoutMs, label: 'usage scan' }).catch(error => {
      if (disposed) return
      scanError = error?.code === 'TIMEOUT' ? 'Usage scan timed out. Last good totals were kept.'
        : error?.code === 'CANCELLED' ? 'Usage scan cancelled. Last good totals were kept.'
        : 'Could not list stored sessions for the usage scan. Last good totals were kept where available.'
      trace('usage', 'scan.stopped', { processed: progress.done, reason: error?.code === 'TIMEOUT' ? 'timeout' : parent.aborted ? 'cancelled' : 'storage', durationMs: Date.now() - started })
      warn(scanError)
    }).finally(() => {
      scanProgress = null
      scanInflight = null
    })
    return scanInflight
  }

  const ensureScanned = () => scanInflight ?? (completedScan ? Promise.resolve() : rescan())

  const notePluginUsage = (entry) => {
    if (disposed) return
    load()
    const stamp = now()
    const day = Number.isSafeInteger(entry?.time) ? dateOf(entry.time) : dayKeyOf(stamp)
    if (day === undefined || day < retentionStartKey(stamp)) return
    const values = bucketsOf(entry?.usage)
    if (values === undefined) return
    const route = routeOf(entry) ?? 'plugin'
    for (const target of [pluginBuckets, pluginDelta]) {
      const byModel = target[day] ??= dictionary()
      addInto(byModel[route] ??= zeroBuckets(), values)
      addInto(byModel['*'] ??= zeroBuckets(), values)
    }
    projection = null
    pluginDirty = true
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (!disposed && pluginDirty) persist()
      }, PLUGIN_FLUSH_DELAY_MS)
      flushTimer.unref()
    }
  }

  const summarize = (stamp, todayKey) => {
    const retainedFrom = retentionStartKey(stamp)
    const weekKey = weekStartKey(stamp)
    const monthPrefix = monthKeyOf(todayKey)
    const days = dictionary()
    const byModel = dictionary()
    const ranges = { today: zeroBuckets(), week: zeroBuckets(), month: zeroBuckets(), total: zeroBuckets() }
    const absorb = (map) => {
      for (const [day, routes] of Object.entries(map)) {
        if (day < retainedFrom || day > todayKey) continue
        const total = days[day] ?? (days[day] = zeroBuckets())
        const month = day.startsWith(monthPrefix)
        for (const [route, values] of Object.entries(routes)) {
          if (route === '*') continue
          addInto(total, values)
          if (month) addInto(byModel[route] ?? (byModel[route] = zeroBuckets()), values)
        }
      }
    }
    for (const record of Object.values(files)) absorb(record.buckets)
    for (const buckets of Object.values(partials)) absorb(buckets)
    absorb(pluginBuckets)
    for (const [day, values] of Object.entries(days)) {
      if (day === todayKey) addInto(ranges.today, values)
      if (day >= weekKey) addInto(ranges.week, values)
      if (day.startsWith(monthPrefix)) addInto(ranges.month, values)
      addInto(ranges.total, values)
    }
    // Polls during a scan reuse accepted numbers without repeatedly visiting
    // every session/day/route. Freeze just this derived view, never input data.
    for (const map of [ranges, days, byModel]) {
      for (const tuple of Object.values(map)) Object.freeze(tuple)
      Object.freeze(map)
    }
    trace('usage', 'summary.fold', { count: Object.keys(files).length, total: Object.keys(days).length })
    return {
      ranges,
      days: Object.freeze({ ...days }),
      byModel: Object.freeze({ ...byModel }),
      byModelFormat: 'route-v2',
      byModelRange: `${monthPrefix}-01 through ${todayKey} (local dates, inclusive)`,
      todayKey,
      weekKey,
      monthPrefix,
      retainedFrom,
    }
  }

  const read = () => {
    load()
    const stamp = now(), todayKey = dayKeyOf(stamp)
    if (projection?.todayKey !== todayKey) projection = summarize(stamp, todayKey)
    const error = [scanError, cacheError, migrationWarning].filter(Boolean).join(' ') || undefined
    return { ...projection, generatedAt: stamp, computing: scanInflight !== null,
      progress: scanProgress === null ? null : { ...scanProgress }, ...(error ? { error } : {}) }
  }

  return {
    file,
    read,
    rescan,
    ensureScanned,
    notePluginUsage,
    isScanning: () => scanInflight !== null,
    dispose() {
      if (disposeTask !== null) return disposeTask
      disposed = true
      lifetime.abort()
      cancelFlush()
      disposeTask = (async () => {
        if (scanInflight !== null) await scanInflight
        if (pluginDirty) persist()
      })()
      return disposeTask
    },
  }
}
