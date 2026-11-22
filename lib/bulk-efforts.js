/** Session-local (one Host mount) authority for additive edits to *existing*
 * pi-ai model rows. Inspect, preview, opening the page, and cold start do not
 * write. Only an exact one-shot ticket or an explicit subsequent verifier
 * settlement can start work. No timers, network probes, or persistent opt-in. */
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { writeCapabilities } from './provider-write.js'
import { enumerateBulk, planBulkRow, readBulkWorld, routeKey } from './bulk-efforts-plan.js'

const issue = code => Object.assign(new Error(code), { code: `bulk-efforts/${code}` })
const sameGuard = (a, b) => !!a && !!b && a.registration === b.registration && a.adapter === b.adapter &&
  a.ns === b.ns && a.index === b.index && a.before === b.before && a.localRevision === b.localRevision
const visible = ({ guard, ...safe }) => safe
const withIdentity = (world, identity) => ({ ...identity, ...planBulkRow(world, identity) })
const identityOf = ({ provider, model }) => ({ provider, model })
const keyOf = identity => routeKey(identity.provider, identity.model)
const enqueue = fn => Promise.resolve().then(fn)

export function createBulkEffortService(options = {}) {
  const { settings, llm, configEditor, onApplied, now = Date.now, ticketTtlMs = 120_000 } = options
  let enabled = false, disposed = false, epoch = 0, runner = null, inFlight = null, offer = null, followup = null
  let grants = new Map(), rows = new Map()
  // A transport rejection or failed readback is not proof that nothing was
  // persisted. Never offer this exact target for a second write on this mount.
  const uncertain = new Set()
  const planned = (world, identity) => uncertain.has(keyOf(identity))
    ? { ...identity, authorized: false, status: 'skipped', reason: 'prior-write-unverified' }
    : withIdentity(world, identity)
  const trace = (step, data) => { try { options.trace?.('bulk-efforts', step, data) } catch { /* diagnostic only */ } }
  const totals = list => {
    const counts = { pending: 0, written: 0, skipped: 0, failed: 0 }
    for (const row of list) counts[row.status]++
    return { counts, total: list.length, eligible: counts.pending, skipped: counts.skipped,
      unverified: list.filter(row => row.status === 'failed' && row.outcomeUnknown).length,
      scopeCount: list.filter(row => row.authorized).length }
  }
  function inspect() {
    // GET never returns the ticket. Each preview belongs to just one review;
    // other open pages cannot silently confirm or replay it via a status read.
    const list = [...rows.values()].map(visible)
    return { enabled, running: runner !== null, ...totals(list), rows: structuredClone(list) }
  }
  function world(strict) {
    try { return readBulkWorld(options, strict) } catch { throw issue('read-unavailable') }
  }
  function preview() {
    if (disposed) throw issue('disposed')
    if (enabled || runner) throw issue('busy')
    offer = null
    const snapshot = world(true)
    const list = enumerateBulk(snapshot).map(identity => planned(snapshot, identity))
    const ticket = randomUUID(), expiresAt = now() + ticketTtlMs
    offer = { ticket, expiresAt, list }
    trace('preview', { total: list.length, eligible: list.filter(row => row.status === 'pending').length })
    return { enabled, running: false, ...totals(list), rows: structuredClone(list.map(visible)), ticket, expiresAt }
  }
  const replace = (key, props) => { rows.set(key, { ...rows.get(key), ...props }) }
  const revoke = (key, reason, status = 'skipped') => {
    grants.delete(key)
    if (rows.get(key)?.status === 'written') replace(key, { authorized: false, authorizationReason: reason })
    else replace(key, { authorized: false, status, reason })
  }
  const active = generation => !disposed && enabled && generation === epoch

  // Real mutations are awaited (never abandoned on timeout). A hung settings
  // dispatcher remains visible as pending and owns the only slot. Disabling
  // or disposing is immediate, but cannot retroactively cancel that call.
  async function perform(key, expected, generation, revisions) {
    if (!active(generation) || !grants.has(key)) return
    const current = withIdentity(world(false), identityOf(expected))
    const grant = grants.get(key)
    if (!current.authorized || !sameGuard(grant, current.guard) || current.guard.revision !== revisions.get(grant.ns)) {
      revoke(key, current.authorized ? 'target-changed' : current.reason); return
    }
    if (current.status !== 'pending' || !isDeepStrictEqual(expected.additions, current.additions) || expected.source !== current.source ||
        !isDeepStrictEqual(expected.guard.patch, current.guard.patch)) {
      replace(key, { status: 'skipped', reason: 'evidence-changed' }); return
    }
    const { provider, model, additions, guard } = current
    const result = await writeCapabilities(settings, { provider, model, efforts: additions }, {
      directEffort: true, referencePrefill: true, llm, configEditor,
      confirmedTarget: guard,
      onDispatch() {
        if (!active(generation) || !grants.has(key)) throw issue('disabled')
        inFlight = key
        replace(key, { status: 'pending', reason: 'dispatched', dispatched: true })
        trace('write.dispatch', { provider, model, efforts: additions, writing: true })
      },
    })
    const dispatched = inFlight === key
    if (dispatched) inFlight = null
    if (dispatched && !disposed) { try { onApplied?.(provider, model) } catch { /* unrelated cache callback */ } }
    if (!result.written) {
      const reason = result.reasoningConflict ?? result.reason ?? 'write-failed'
      if (dispatched) { uncertain.add(key); replace(key, { dispatched: true, outcomeUnknown: true }) }
      revoke(key, reason, dispatched || ['settings-failed', 'settings-unverified', 'describe-failed'].includes(reason) ? 'failed' : 'skipped')
      trace('write.refused', { provider, model, reason, readBack: false }); return
    }
    replace(key, { status: 'written', reason: current.unresolvedEfforts?.length ? 'partial' : 'verified', writtenEfforts: [...additions] })
    trace('write.verified', { provider, model, efforts: additions, readBack: true })
    if (!active(generation)) return
    // Advance only the newly verified state we predicted. Do NOT adopt a
    // third-party replacement/config change made during this awaited write.
    let after
    try { after = withIdentity(world(false), { provider, model }) }
    catch { revoke(key, 'read-unavailable'); return }
    if (after.authorized && sameGuard({ ...grant, before: guard.after }, after.guard)) {
      grants.set(key, after.guard)
      revisions.set(grant.ns, after.guard.revision)
    } else revoke(key, after.reason === 'already-mapped' || after.authorized ? 'target-changed' : after.reason)
  }

  async function runBatch(batch, generation) {
    const revisions = new Map(batch.map(row => [row.guard.ns, row.guard.revision]))
    for (const row of batch) {
      if (!active(generation)) break
      const key = keyOf(row)
      try { await perform(key, row, generation, revisions) }
      catch {
        const sent = inFlight === key
        if (sent) {
          inFlight = null; uncertain.add(key); replace(key, { dispatched: true, outcomeUnknown: true })
        }
        revoke(key, sent ? 'write-failed' : 'read-unavailable', 'failed')
      }
    }
  }

  // No auto-retry: only models independently named by a successful *new*
  // verifier pass can acquire additions after the confirmation snapshot.
  function collectReconciled(events) {
    const snapshot = world(true)
    const next = []
    for (const [key, grant] of [...grants]) {
      const old = rows.get(key)
      const row = withIdentity(snapshot, identityOf(old))
      if (!row.authorized || !sameGuard(grant, row.guard)) { revoke(key, row.authorized ? 'target-changed' : row.reason); continue }
      if (row.status !== 'pending') {
        // A read-only reconciliation doesn't turn a verified receipt into a
        // skipped one just because our own fields are now already present.
        if (old.status !== 'written') rows.set(key, row)
        continue
      }
      if (!events.has(row.model) || !(row.verifiedAt >= events.get(row.model))) continue
      next.push(row); rows.set(key, row)
    }
    return next
  }
  function start(batch) {
    if (!batch.length) return
    const generation = epoch
    runner = enqueue(async () => {
      let next = batch
      for (;;) {
        await runBatch(next, generation)
        if (!active(generation) || !followup) break
        const events = followup; followup = null
        next = collectReconciled(events)
      }
    }).catch(() => {
      // A failed refresh is not evidence of permission. Halt all remaining
      // authorized work; don't persist the old grant or schedule a retry.
      disable('read-unavailable')
    }).finally(() => { runner = null; inFlight = null; followup = null })
  }

  function enable({ ticket } = {}) {
    if (disposed) throw issue('disposed')
    if (enabled || runner) throw issue('busy')
    if (!offer || typeof ticket !== 'string' || ticket !== offer.ticket) throw issue('ticket-invalid')
    const review = offer; offer = null
    if (now() >= review.expiresAt) throw issue('ticket-expired')
    const allowed = review.list.filter(row => row.authorized)
    if (!allowed.length) throw issue('empty-scope')
    const snapshot = world(true)
    // Compare the whole approved set *before* admitting its first mutation.
    // Never replace a stale preview with a wider plan in the confirmation call.
    for (const before of allowed) {
      const latest = withIdentity(snapshot, identityOf(before))
      if (!sameGuard(before.guard, latest.guard) || before.guard.revision !== latest.guard.revision ||
        !isDeepStrictEqual(visible(before), visible(latest)) || !isDeepStrictEqual(before.guard.patch, latest.guard.patch)) throw issue('preview-stale')
    }
    enabled = true; epoch++
    rows = new Map(review.list.map(row => [keyOf(row), row]))
    grants = new Map(allowed.map(row => [keyOf(row), row.guard]))
    start(allowed.filter(row => row.status === 'pending'))
    trace('enable', { enabled: true, count: allowed.length, running: runner !== null })
    return inspect()
  }
  function disable(reason = 'disabled') {
    enabled = false; epoch++; offer = null; grants.clear(); followup = null
    for (const [key, row] of rows) {
      if (row.status === 'pending') replace(key, key === inFlight ? { authorized: false, reason: 'dispatched' } : { authorized: false, status: 'skipped', reason })
      else if (row.authorized) replace(key, { authorized: false, authorizationReason: reason })
    }
    trace('disable', { enabled: false, pending: inFlight ? 1 : 0 })
    return inspect()
  }
  function reconcile({ modelIds = [], startedAt } = {}) {
    if (disposed || !enabled) return inspect()
    const events = new Map()
    if (Array.isArray(modelIds) && Number.isSafeInteger(startedAt) && startedAt > 0) {
      const inScope = new Set([...grants.keys()].map(key => rows.get(key).model))
      for (const model of modelIds) if (inScope.has(model)) events.set(model, startedAt)
    }
    if (runner) {
      if (events.size) {
        followup ??= new Map()
        for (const [id, time] of events) followup.set(id, Math.max(followup.get(id) ?? 0, time))
      }
    } else { start(collectReconciled(events)) }
    return inspect()
  }
  function dispose() { disposed = true; disable('disposed') }
  return { inspect, preview, enable, disable, reconcile, dispose,
    // Test/maintenance join; never required by an HTTP request or plugin unload.
    whenSettled: async () => { await runner; return inspect() },
  }
}
