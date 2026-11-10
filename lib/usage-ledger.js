/**
 * Token-usage ledger for the settings page.
 *
 * The page shows how many tokens the user burned today, this ISO week, this
 * calendar month and in total. DSH's own token-meter keeps per-session totals
 * (`session_projcache`), but the page needs per-day accounting with route
 * attribution, so this module rolls its own ledger from the durable session
 * logs under `$DSH_HOME/sessions/**`.
 *
 * Session logs are JSONL, line-batched into individually compressed Zstandard
 * frames (the same container `dsh-session-persistence-jsonl` writes). Each
 * `assistant/message` / `assistant/attempt` event carries provider-reported
 * usage plus the routed model, and `llm/retry-started` closes a replaced
 * attempt so the retried call adds instead of overwriting. The fold below is
 * byte-identical to the shipped projection on the reference logs (checked by
 * the test suite's fixture walk).
 *
 * Scans are incremental: a file whose (mtime, size) pair is unchanged reuses
 * its stored buckets. Events from the current month get their exact event-day
 * attribution; older events are attributed to the session's creation day (the
 * user accepted a rough month for history), while per-model attribution stays
 * exact because every event names its route.
 *
 * Nothing here reads credentials, and nothing but capability-free aggregate
 * numbers ever reaches the client.
 *
 * @module lib/usage-ledger
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Magic number of a complete Zstandard frame. */
const ZSTD_MAGIC = 4247762216

/**
 * Locate complete frames without decompressing their blocks (same structural
 * walk as the persistence backend: frame header, then block headers, then the
 * optional checksum). EOF inside a frame is reported as `tornStart`, not an
 * error, because the persistence writer can crash mid-append.
 * @param buffer - complete bytes of one session log.
 * @returns `{ frames: [{ start, end }], tornStart? }`.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
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
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`)
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

/**
 * Decode one session log into its JSON lines.
 *
 * Plaintext `.jsonl` files scan straight through; Zstandard files split into
 * frames and decompress each one. A corrupt frame is skipped rather than
 * failing the ledger (totals then under-count that session, matching what any
 * reader that survives the same container can recover).
 * @param buffer - the file bytes.
 * @param isZstd - whether the suffix promises a Zstandard container.
 * @returns an array of plain per-line strings.
 */
export function decodeLogLines(buffer, isZstd) {
  if (!isZstd) {
    return buffer
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
  }
  const lines = []
  let bad = 0
  let scan
  try {
    scan = scanZstdFrames(buffer)
  } catch (_error) {
    return lines
  }
  for (const { start, end } of scan.frames) {
    let text
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(start, end))
    } catch (_error) {
      bad += 1
      continue
    }
    for (const line of text.toString('utf8').split('\n')) {
      if (line !== '') lines.push(line)
    }
  }
  if (bad > 0 && lines.length === 0) return []
  return lines
}

/** Local-calendar `YYYY-MM-DD` key for one epoch-ms timestamp. */
export function dayKeyOf(time) {
  const date = new Date(time)
  if (Number.isNaN(date.getTime())) return undefined
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Local-calendar `YYYY-MM` prefix of a day key. */
export function monthKeyOf(dayKey) {
  return typeof dayKey === 'string' && dayKey.length >= 7 ? dayKey.slice(0, 7) : undefined
}

/** First day (Monday) of the local ISO week containing `now`. */
export function weekStartKey(now = Date.now()) {
  const date = new Date(now)
  const weekday = (date.getDay() + 6) % 7 // Monday = 0
  date.setDate(date.getDate() - weekday)
  return dayKeyOf(date.getTime())
}

/** Empty usage bucket. */
function zeroBuckets() {
  return [0, 0, 0, 0]
}

/** Add bucket source into destination, in place. */
function addInto(destination, source) {
  for (let index = 0; index < 4; index += 1) {
    if (source[index] !== undefined) destination[index] += source[index] ?? 0
  }
  return destination
}

/** Provider-reported usage record of one settlement event, or undefined. */
function usageOf(event) {
  const data = event?.data
  if (event?.type === 'assistant/message') {
    return data?.usage !== null && typeof data?.usage === 'object' ? data.usage : undefined
  }
  if (event?.type !== 'assistant/attempt') return undefined
  // The last usage chunk in the recorded stream is the settlement sample.
  const stream = Array.isArray(data?.stream) ? data.stream : []
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const chunk = stream[index]?.chunk
    if (chunk?.type === 'usage' && chunk?.usage !== null && typeof chunk?.usage === 'object') {
      return chunk.usage
    }
  }
  return undefined
}

/** Bucket values of a provider usage record. */
function bucketsOf(usage) {
  const input = usage?.inputTokens
  const output = usage?.outputTokens
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined
  return [
    Math.max(0, Math.trunc(input)),
    Math.max(0, Math.trunc(output)),
    Math.max(0, Math.trunc(usage?.cacheReadTokens ?? 0)),
    Math.max(0, Math.trunc(usage?.cacheWriteTokens ?? 0)),
  ]
}

/**
 * Fold one session's events into per-day per-model buckets.
 *
 * `preciseFrom` is the earliest day key that still earns exact event-day
 * attribution; older events keep exact totals but count on the session's
 * creation day. The fold keeps the shipped token-usage projection's
 * replacement and retry semantics.
 * @param lines - decoded JSONL strings of one session log.
 * @param options - `{ createdAt?, preciseFrom? }`.
 * @returns `{ createdAt?, buckets: { [dayKey]: { [route]: [in,out,cr,cw] } } }`.
 */
export function foldLogToBuckets(lines, options = {}) {
  const preciseFrom = options.preciseFrom
  const createdAtTime = Number.isSafeInteger(options.createdAt) ? options.createdAt : undefined
  let headerCreation = undefined
  const buckets = {}
  const totals = zeroBuckets()
  /** The sample the next same-(turn,step) settlement may replace. */
  let lastKey = null

  const routeOf = (event) => {
    const source = event?.data?.message?.source
    if (source !== null && typeof source === 'object' && source.kind === 'model') {
      const provider = typeof source.provider === 'string' && source.provider !== '' ? source.provider : undefined
      const model = typeof source.model === 'string' && source.model !== '' ? source.model : undefined
      return provider !== undefined && model !== undefined ? `${provider}/${model}` : model
    }
    const data = event?.data
    if (typeof data?.provider === 'string' && typeof data?.model === 'string') {
      return `${data.provider}/${data.model}`
    }
    return 'unknown'
  }

  const record = (dayKey, route, values) => {
    if (dayKey === undefined) return
    const byModel = buckets[dayKey] ?? (buckets[dayKey] = {})
    addInto(byModel[route] ?? (byModel[route] = zeroBuckets()), values)
    addInto(byModel['*'] ?? (byModel['*'] = zeroBuckets()), values)
    addInto(totals, values)
  }

  for (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch (_error) {
      continue
    }
    if (event === null || typeof event !== 'object') continue
    if (event.type === 'session') {
      headerCreation = Number.isSafeInteger(event.createdAt) && event.createdAt > 0 ? event.createdAt : headerCreation
      continue
    }
    if (event.type === 'llm/retry-started') {
      if (lastKey !== null && lastKey.turn === event.data?.turn && lastKey.step === event.data?.step) {
        lastKey = null
      }
      continue
    }
    const usage = usageOf(event)
    if (usage === undefined) continue
    const values = bucketsOf(usage)
    if (values === undefined) continue
    const turn = Number.isSafeInteger(event?.data?.turn) ? event.data.turn : -1
    const step = Number.isSafeInteger(event?.data?.step) ? event.data.step : -1
    const previous =
      lastKey !== null && lastKey.turn === turn && lastKey.step === step ? lastKey : undefined
    if (previous !== undefined) {
      const same =
        previous.buckets[0] === values[0] &&
        previous.buckets[1] === values[1] &&
        previous.buckets[2] === values[2] &&
        previous.buckets[3] === values[3]
      if (same) continue
      record(previous.dayKey, previous.route, [-previous.buckets[0], -previous.buckets[1], -previous.buckets[2], -previous.buckets[3]])
    }
    const time = Number.isSafeInteger(event?.time) && event.time > 0 ? event.time : undefined
    const fallbackTime = createdAtTime ?? headerCreation
    const eventDay = dayKeyOf(time)
    const dayKey =
      accurateDay(eventDay, preciseFrom) ?? dayKeyOf(fallbackTime) ?? eventDay
    record(dayKey, routeOf(event), values)
    lastKey = { turn, step, dayKey, route: routeOf(event), buckets: values }
  }
  return {
    ...(createdAtTime !== undefined ? { createdAt: createdAtTime } : {}),
    ...(buckets === undefined || Object.keys(buckets).length === 0 ? {} : { buckets }),
  }
}

/** Event-day attribution only below (and including) the precise window. */
function accurateDay(eventDay, preciseFrom) {
  if (eventDay === undefined) return undefined
  if (preciseFrom === undefined) return eventDay
  return eventDay >= preciseFrom ? eventDay : undefined
}

/** Absolute sessions directory for the ledger. */
function sessionsRoot(home) {
  return path.join(home, 'sessions')
}

const SESSION_FILES = ['session.v4.jsonl.zstd', 'session.v4.jsonl']

/**
 * One recursive pass over the sessions tree collecting per-file candidates.
 * @param root - sessions directory.
 * @returns `{ root, files: [{ relPath, absPath, size, mtime }] }`.
 */
export async function listSessionFiles(root) {
  const files = []
  const walk = async (dir, relPrefix) => {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (_error) {
      return
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name)
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
      if (entry.isDirectory()) {
        await walk(child, rel)
        continue
      }
      if (!entry.isFile()) continue
      if (!SESSION_FILES.includes(entry.name)) continue
      try {
        const stat = await fsp.stat(child)
        files.push({ relPath: rel, absPath: child, size: stat.size, mtime: Math.trunc(stat.mtimeMs) })
      } catch (_error) {
        // A file vanishing mid-scan is ordinary.
      }
    }
  }
  await walk(root, '')
  return { root, files }
}

/**
 * The ledger state and scans behind the `/usage` route.
 *
 * Everything is best-effort: a scan never throws to the caller, errors land in
 * the diagnostics list, and a partially scanned ledger still answers.
 * @param options - `{ home?, file?, logger?, preciseMonths?, now? }`.
 */
export function createUsageLedger(options = {}) {
  const logger = options.logger ?? console
  const now = typeof options.now === 'function' ? options.now : Date.now
  const home = options.home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const file = options.file || path.join(home, 'dsh-model-visibility', 'usage-ledger.json')
  const root = options.sessionsRoot || sessionsRoot(home)
  /** Exact event-day attribution window, in one calendar month. */
  const preciseMonths = Number.isFinite(options.preciseMonths) ? Math.min(6, Math.max(1, options.preciseMonths)) : 1

  /** `{ files: { relPath: record } }` after the last successful load. */
  let stored = { files: {} }
  /** Longer-lived plugin-recorded usage: `{ dayKey: { route: buckets } }`. */
  let pluginBuckets = {}

  let loaded = false
  let scanInflight = null
  let scanProgress = null
  let lastError = undefined
  let dirty = false
  let disposed = false

  const warn = (message, error) => {
    lastError = message
    if (typeof logger.warn === 'function') {
      logger.warn(message)
      if (error !== undefined) logger.warn(error)
    }
  }

  const load = () => {
    if (loaded) return
    loaded = true
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      stored = parsed !== null && typeof parsed === 'object' ? parsed : null
      stored = { files: stored?.files !== null && typeof stored?.files === 'object' ? stored.files : {} }
      const plugin = parsed !== null && typeof parsed === 'object' ? parsed?.plugin : undefined
      pluginBuckets = plugin !== null && typeof plugin === 'object' ? plugin : {}
    } catch (_error) {
      stored = { files: {} }
      pluginBuckets = {}
    }
  }

  const persist = () => {
    if (disposed) return
    load()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const body = { version: 1, updatedAt: now(), plugin: pluginBuckets, files: stored.files }
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(body)}\n`)
      fs.renameSync(temp, file)
      dirty = false
    } catch (error) {
      warn('model-visibility: could not write the usage ledger', error)
    }
  }

  /** Merge one file's folded buckets into the stored records. */
  const absorb = (relPath, meta, folded) => {
    stored.files[relPath] = {
      ...(stored.files[relPath] ?? {}),
      mtime: meta.mtime,
      size: meta.size,
      createdAt: folded.createdAt,
      buckets: folded.buckets ?? {},
    }
  }

  /** Drop ledger entries long gone and month data past the retention window. */
  const prune = () => {
    const horizon = new Date(now())
    horizon.setMonth(horizon.getMonth() - 14)
    const horizonKey = dayKeyOf(horizon.getTime())
    let changed = false
    if (horizonKey !== undefined) {
      for (const record of Object.values(stored.files)) {
        const buckets = record.buckets ?? {}
        for (const key of Object.keys(buckets)) {
          if (key < horizonKey) {
            delete buckets[key]
            changed = true
          }
        }
      }
      for (const key of Object.keys(pluginBuckets)) {
        if (key < horizonKey) {
          delete pluginBuckets[key]
          changed = true
        }
      }
    }
    return changed
  }

  /**
   * Scan session files; incremental by (mtime, size).
   * @param options - `{ force? }` re-decodes every file when set.
   */
  const rescan = async ({ force = false } = {}) => {
    if (disposed) return
    load()
    if (scanInflight !== null) return scanInflight
    scanProgress = { done: 0, total: null }
    const stale = new Date(now())
    stale.setMonth(stale.getMonth() - preciseMonths)
    const preciseFrom = dayKeyOf(stale.getTime())
    const run = (async () => {
      const listing = await listSessionFiles(root)
      scanProgress.total = listing.files.length
      for (const meta of listing.files) {
        if (disposed) break
        const previous = force ? undefined : stored.files[meta.relPath]
        if (previous?.mtime === meta.mtime && previous?.size === meta.size) {
          // Already counted with the same content; keep the old buckets.
          scanProgress.done += 1
          continue
        }
        try {
          const buffer = await fsp.readFile(meta.absPath)
          const lines = decodeLogLines(buffer, meta.absPath.endsWith('.zstd'))
          const folded = foldLogToBuckets(lines, { preciseFrom })
          if (!disposed) absorb(meta.relPath, meta, { ...folded, createdAt: folded.createdAt })
        } catch (error) {
          warn(`model-visibility: session log scan failed for ${meta.relPath}`, error)
        }
        scanProgress.done += 1
        // Yield so a large tree cannot starve the loop it runs on.
        if (scanProgress.done % 8 === 0) await new Promise((resolve) => setImmediate(resolve))
      }
      // Persist whenever anything changed — including a clean first scan, so a
      // restart resumes from the ledger instead of re-reading every log.
      if (!disposed && (prune() || dirty || (scanProgress !== null && scanProgress.total > 0))) persist()
      scanProgress = null
    })().catch((error) => {
      // The scan never propagates: a failed pass still leaves the last ledger.
      warn('model-visibility: usage scan failed', error)
      scanProgress = null
    })
    const tracked = run.finally(() => {
      if (scanInflight !== null) scanInflight = null
    })
    scanInflight = tracked
    return tracked
  }

  /** Fold one plugin-attributed settlement (the verify sweep records itself). */
  const notePluginUsage = (entry) => {
    if (disposed) return
    load()
    const time = Number.isSafeInteger(entry?.time) ? entry.time : now()
    const dayKey = dayKeyOf(time)
    if (dayKey === undefined) return
    const values = bucketsOf(entry?.usage)
    if (values === undefined) return
    const route =
      typeof entry?.provider === 'string' && typeof entry?.model === 'string'
        ? `${entry.provider}/${entry.model}`
        : 'plugin'
    const byModel = pluginBuckets[dayKey] ?? (pluginBuckets[dayKey] = {})
    addInto(byModel[route] ?? (byModel[route] = zeroBuckets()), values)
    addInto(byModel['*'] ?? (byModel['*'] = zeroBuckets()), values)
    dirty = true
  }

  /**
   * Combined day/model bucket map for `$windowFrom`-and-after days.
   * @returns `{ days, byModel, newerThan? }`.
   */
  const collect = (windowFrom) => {
    load()
    const days = {}
    const byModel = {}
    const absorbMap = (map, from) => {
      for (const [dayKey, byRoute] of Object.entries(map)) {
        if (from !== undefined && dayKey < from) continue
        const day = days[dayKey] ?? (days[dayKey] = zeroBuckets())
        for (const [route, values] of Object.entries(byRoute)) {
          // `*` is a per-day convenience row only; aggregates derive from the
          // real routes so no sum ever double counts.
          if (route === '*') continue
          addInto(day, values)
          const row = byModel[route] ?? (byModel[route] = zeroBuckets())
          addInto(row, values)
        }
      }
    }
    const from = windowFrom
    for (const record of Object.values(stored.files)) {
      absorbMap(record.buckets ?? {}, from)
    }
    absorbMap(pluginBuckets, from)
    return { days, byModel }
  }

  const sumBuckets = (map) => {
    const total = zeroBuckets()
    for (const values of Object.values(map)) addInto(total, values)
    return total
  }

  /** The API the route serves: ranges resolved against the local calendar. */
  const read = (options2 = {}) => {
    load()
    const stamp = now()
    const todayKey = dayKeyOf(stamp)
    const weekKey = weekStartKey(stamp)
    const monthPrefix = todayKey.slice(0, 7)
    const total = collect()
    const month = collect(monthPrefix)
    const week = collect(weekKey)
    const day = collect(todayKey)
    const byModel = month.byModel
    delete byModel['*']
    return {
      generatedAt: stamp,
      computing: scanInflight !== null,
      progress: scanProgress,
      ...(lastError !== undefined ? { error: lastError } : {}),
      ranges: {
        today: sumBuckets(todayKey !== undefined && day.days[todayKey] ? [day.days[todayKey]] : []),
        week: sumBuckets(week.days),
        month: sumBuckets(month.days),
        total: sumBuckets(total.days),
      },
      days: total.days,
      byModel,
      todayKey,
      weekKey,
      monthPrefix,
    }
  }

  return {
    file,
    read,
    rescan,
    notePluginUsage,
    isScanning: () => scanInflight !== null,
    /** A final scan cannot write after the owning plugin scope is disposed. */
    async dispose() {
      disposed = true
      if (scanInflight !== null) await scanInflight
    },
  }
}
