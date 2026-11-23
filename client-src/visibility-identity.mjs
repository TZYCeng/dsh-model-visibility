import { FIELD } from './constants.mjs'
import { editHiddenRoutes } from './visibility-codec.mjs'
import { clientTrace } from './diagnostic-events.mjs'

// One FIFO per shared ConfigForm, not per mounted settings component. Queue
// intents only and compute each replacement against the latest accepted view.
// The fixed revision fences other browser tabs and other editors of the field.
const writes = new WeakMap()

function queueOf(form) {
  let queue = writes.get(form)
  if (!queue) { queue = { epoch: Symbol('visibility Host epoch'), tail: null }; writes.set(form, queue) }
  return queue
}

export function visibilityEpoch(form) { return queueOf(form).epoch }

export function resetVisibilityWrites(form) {
  // Keep the tail: ConfigForm internally serializes too, but doesn't accept
  // our epoch guard. Do not hand it another mutation while one may be queued
  // or in flight there. Once it settles, old entries skip and new ones run.
  const queue = writes.get(form)
  if (queue) queue.epoch = Symbol('visibility Host epoch')
}

export function canWriteHidden(form, snapshot) {
  return typeof form?.mutate === 'function' && snapshot?.status === 'ready' && snapshot.writable === true &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 && Array.isArray(snapshot.value?.[FIELD])
}

async function commit(form, routes, visible, isCurrent) {
  // The official form reloads its mirror on a latest refused write. Rebase on
  // a changed revision ONLY within the same connection; a different Host can
  // expose the same form and revision numbers.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!isCurrent()) return false
    const snapshot = form.getSnapshot()
    if (!canWriteHidden(form, snapshot)) return false
    const original = snapshot.value[FIELD]
    const value = editHiddenRoutes(original, routes, visible)
    if (value === original) return true
    const accepted = await form.mutate([{ op: 'set', path: [FIELD], value }], snapshot.revision)
    // A reset is not a rollback of a write already handed to the former Host.
    if (accepted === true) return true
    if (!isCurrent() || form.getSnapshot().revision === snapshot.revision) return false
  }
  return false
}

export function queueVisibilityWrite(form, epoch, work) {
  const queue = queueOf(form)
  const isCurrent = () => queue.epoch === epoch
  if (!isCurrent()) return Promise.resolve(false)
  const result = (queue.tail ?? Promise.resolve()).then(() => isCurrent() ? work(isCurrent) : false)
  // A failed write must not poison the queue or produce an unhandled rejection.
  const tail = result.then(() => {}, () => {})
  queue.tail = tail
  void tail.then(() => { if (queue.tail === tail) queue.tail = null })
  return result
}

/** Explicit desired visibility of the specified routes, never a stale whole list. */
export function writeHiddenRoutes(form, routes, visible, epoch = visibilityEpoch(form)) {
  if (!Array.isArray(routes) || typeof visible !== 'boolean' || !routes.every(item =>
    typeof item?.provider === 'string' && item.provider !== '' && typeof item.model === 'string' && item.model !== '')) {
    return Promise.reject(new TypeError('Invalid model visibility edit'))
  }
  const owned = routes.map(({ provider, model }) => ({ provider, model }))
  return queueVisibilityWrite(form, epoch, async (isCurrent) => {
    let accepted
    try { accepted = await commit(form, owned, visible, isCurrent); return accepted }
    finally { if (isCurrent()) clientTrace('visibility', accepted ? 'accepted' : 'refused', { count: owned.length, enabled: visible }) }
  })
}
