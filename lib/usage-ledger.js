/** Token usage by local calendar day and model route, derived from durable DSH sessions. */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

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
  return nonempty(data?.provider) && nonempty(data?.model) ? `${data.provider}/${data.model}` : undefined
}

function foldEvents(events, { createdAt, from, inheritedEventCount = 0 } = {}) {
  const creationDay = dateOf(createdAt)
  let buckets = dictionary()
  let last = null
  const headerRoutes = new Map()
  const stepRoutes = new Map()
  let headerRoute
  let contextRoute
  let error
  let index = 0
  let hasInheritedMarker = false
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

  for (const event of events) {
    if (!isRecord(event) || !nonempty(event.type)) {
      error = 'invalid session event'
      break
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
      continue
    } else if (event.type === 'llm/retry-started') {
      if (last !== null && last.turn === data?.turn && last.step === data?.step) last = null
      stepRoutes.delete(stepKey(data))
    } else if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const usage = usageOf(event)
      if (usage === undefined) continue
      const values = bucketsOf(usage)
      if (values === undefined || !isTokenCount(data?.turn) || !isTokenCount(data?.step)) {
        error = 'invalid assistant usage settlement'
        break
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
          if (routeRank <= previous.routeRank || route === previous.route) continue
          dayKey = previous.dayKey
        }
        record(previous.dayKey, previous.route, previous.values, -1)
      }
      record(dayKey, route, values)
      last = { turn: data.turn, step: data.step, dayKey, route, routeRank, values }
    }
  }
  return { buckets, hasInheritedMarker, error }
}

/** Fold a JSONL log prefix. The scan uses `error` to avoid trusting it as complete. */
export function foldLogToBuckets(lines, { createdAt, from } = {}) {
  const events = []
  let header
  let error
  let lineNumber = 0
  for (const line of lines) {
    lineNumber += 1
    let event
    try {
      event = JSON.parse(line)
    } catch {
      error = `invalid JSONL at line ${lineNumber}`
      break
    }
    if (lineNumber === 1 && event?.type === 'session') {
      header = event
      if (header.version !== undefined && header.version !== SESSION_VERSION) {
        error = 'unsupported session log format'
        break
      }
    } else if (event?.type === 'session') {
      error = `unexpected session header at line ${lineNumber}`
      break
    } else {
      events.push(event)
    }
  }
  const creation = createdAt ?? header?.createdAt
  const folded = foldEvents(events, { createdAt: creation, from })
  const missingCut = header?.isSeeded === true && !folded.hasInheritedMarker
  return {
    createdAt: creation,
    hasHeader: header !== undefined,
    buckets: missingCut ? dictionary() : folded.buckets,
    error: error ?? folded.error ?? (missingCut ? 'missing inherited-session boundary' : undefined),
  }
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
export async function listSessionFiles(root) {
  const files = []
  const errors = []
  const directories = async (dir) => {
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

async function readDiskSession(meta, from) {
  const buffer = await fsp.readFile(meta.absPath)
  const stat = await fsp.stat(meta.absPath)
  if (meta.revision !== `${path.basename(meta.absPath)}:${diskRevision(stat)}`) {
    return { error: 'session log changed during scan' }
  }
  const decoded = decodeLog(buffer, meta.absPath.endsWith('.zstd'))
  const folded = foldLogToBuckets(decoded.lines, { from })
  return folded.hasHeader
    ? { buckets: folded.buckets, error: folded.error ?? decoded.error }
    : { error: decoded.error ?? 'missing session log header' }
}

async function readStoredSession(persistence, meta, from) {
  const handle = await persistence.open(meta.key, 'read')
  try {
    const { events } = await handle.read()
    return foldEvents(events, {
      from, createdAt: handle.header.createdAt, inheritedEventCount: handle.inheritedEventCount,
    })
  } finally {
    await handle.close()
  }
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
  const source = service ? `service:${process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE || home}` : `jsonl:${root}`
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // Service revisions are opaque and comparable only within this instance.
  const serviceRevisions = new Map()
  const retryKeys = new Set()
  let files = dictionary()
  let partials = dictionary()
  let pluginBuckets = dictionary()
  let loaded = false
  let scanInflight = null
  let scanProgress = null
  let completedScan = false
  let scanError
  let cacheError
  let pluginDirty = false
  let staleFileCache = false
  let flushTimer = null
  let disposeTask = null
  let disposed = false

  const warn = (message) => {
    if (typeof logger.warn === 'function') logger.warn(`model-visibility: ${message}`)
  }

  const load = () => {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!isRecord(parsed)) throw new Error('invalid cache')
      pluginBuckets = cleanBuckets(parsed.plugin)
      staleFileCache = parsed.version !== FILE_CACHE_VERSION || parsed.source !== source || parsed.timeZone !== timeZone
      if (!staleFileCache && isRecord(parsed.files)) {
        for (const [key, record] of Object.entries(parsed.files)) {
          if (!isRecord(record) || !validDay(record.from)) continue
          files[key] = { revision: record.revision, from: record.from, buckets: cleanBuckets(record.buckets) }
        }
      }
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
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const body = { version: FILE_CACHE_VERSION, source, timeZone, updatedAt: now(), plugin: pluginBuckets, files }
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(body)}\n`)
      fs.renameSync(temp, file)
      pluginDirty = false
      staleFileCache = false
      cacheError = undefined
      cancelFlush()
    } catch {
      cacheError = 'Could not save the usage cache; in-memory totals remain available.'
      warn(cacheError)
    }
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

  const list = async () => {
    if (!service) return listSessionFiles(root)
    const sessions = await service.list()
    return { files: sessions.map((session) => ({ key: session.header.id, revision: session.revision })), errors: [] }
  }

  /** Join the exact in-flight scan without a separate check-then-start race. */
  const rescan = ({ force = false } = {}) => {
    if (disposed) return Promise.resolve()
    load()
    if (scanInflight !== null) return scanInflight
    scanProgress = { done: 0, total: null }
    const run = async () => {
      const from = retentionStartKey(now())
      const listing = await list()
      if (disposed) return
      const problems = [...listing.errors]
      const scanned = Object.assign(dictionary(), files)
      const recovered = Object.assign(dictionary(), partials)
      const seen = new Set()
      let changed = false
      scanProgress.total = listing.files.length
      for (const meta of listing.files) {
        if (disposed) return
        seen.add(meta.key)
        const previous = scanned[meta.key]
        const revision = service ? serviceRevisions.get(meta.key) : previous?.revision
        if (meta.error || force || retryKeys.has(meta.key) || revision !== meta.revision || !previous || previous.from > from) {
          try {
            const result = meta.error ? { error: meta.error } : service
              ? await readStoredSession(service, meta, from)
              : await readDiskSession(meta, from)
            if (disposed) return
            if (result.error) {
              problems.push(result.error)
              // Keep the last good fold. On a first scan the valid prefix is
              // available in memory, but never persisted as a valid revision.
              if (!previous && result.buckets && Object.keys(result.buckets).length > 0 && !recovered[meta.key]) {
                recovered[meta.key] = result.buckets
              }
              retryKeys.add(meta.key)
              if (service) serviceRevisions.delete(meta.key)
            } else {
              scanned[meta.key] = { revision: service ? undefined : meta.revision, from, buckets: result.buckets }
              if (service) serviceRevisions.set(meta.key, meta.revision)
              retryKeys.delete(meta.key)
              delete recovered[meta.key]
              changed = true
            }
          } catch {
            problems.push('could not read a session log from storage')
            retryKeys.add(meta.key)
            if (service) serviceRevisions.delete(meta.key)
          }
        }
        scanProgress.done += 1
        if (scanProgress.done % 8 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
      if (disposed) return
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
          serviceRevisions.delete(key)
          retryKeys.delete(key)
          changed = true
        }
      }
      for (const [key, buckets] of Object.entries(recovered)) {
        prune(buckets, from)
        if (Object.keys(buckets).length === 0) delete recovered[key]
      }
      if (prune(pluginBuckets, from)) pluginDirty = true
      files = scanned
      partials = recovered
      completedScan = true
      scanError = problems.length === 0 ? undefined
        : `Usage scan incomplete (${problems.length} storage issue${problems.length === 1 ? '' : 's'}; ${problems[0]}). Last good totals were kept where available.`
      if (scanError !== undefined) warn(scanError)
      if (changed || pluginDirty || staleFileCache) persist()
    }
    scanInflight = run().catch(() => {
      if (disposed) return
      scanError = 'Could not list stored sessions for the usage scan. Last good totals were kept where available.'
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
    const byModel = pluginBuckets[day] ?? (pluginBuckets[day] = dictionary())
    addInto(byModel[route] ?? (byModel[route] = zeroBuckets()), values)
    addInto(byModel['*'] ?? (byModel['*'] = zeroBuckets()), values)
    pluginDirty = true
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (!disposed && pluginDirty) persist()
      }, PLUGIN_FLUSH_DELAY_MS)
      flushTimer.unref()
    }
  }

  const read = () => {
    load()
    const stamp = now()
    const retainedFrom = retentionStartKey(stamp)
    const todayKey = dayKeyOf(stamp)
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
    const error = scanError ?? cacheError
    return {
      generatedAt: stamp,
      computing: scanInflight !== null,
      progress: scanProgress === null ? null : { ...scanProgress },
      ...(error === undefined ? {} : { error }),
      ranges,
      days: { ...days },
      byModel: { ...byModel },
      byModelRange: `${monthPrefix}-01 through ${todayKey} (local dates, inclusive)`,
      todayKey,
      weekKey,
      monthPrefix,
      retainedFrom,
    }
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
      cancelFlush()
      disposeTask = (async () => {
        if (scanInflight !== null) await scanInflight
        if (pluginDirty) persist()
      })()
      return disposeTask
    },
  }
}
