import { FIELD } from './constants.mjs'
import { editHiddenRoutes } from './visibility-codec.mjs'
import { clientTrace } from './diagnostic-events.mjs'

// One FIFO per shared ConfigForm, not per mounted settings component. Queue
// intents only and compute each replacement against the latest accepted view.
// The fixed revision fences other browser tabs and other editors of the field.
const writes = new WeakMap()

export function canWriteHidden(form, snapshot) {
  return typeof form?.mutate === 'function' && snapshot?.status === 'ready' && snapshot.writable === true &&
    Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 && Array.isArray(snapshot.value?.[FIELD])
}

async function commit(form, routes, visible) {
  // The official form reloads its mirror on a latest refused write. Retry an
  // unrelated revision change against that accepted value, but don't spin on
  // a read-only/missing/refused document or an endlessly moving revision.
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = form.getSnapshot()
    if (!canWriteHidden(form, snapshot)) return false
    const original = snapshot.value[FIELD]
    const value = editHiddenRoutes(original, routes, visible)
    if (value === original) return true
    const accepted = await form.mutate([{ op: 'set', path: [FIELD], value }], snapshot.revision)
    if (accepted === true) return true
    if (form.getSnapshot().revision === snapshot.revision) return false
  }
  return false
}

/** Explicit desired visibility of the specified routes, never a stale whole list. */
export function writeHiddenRoutes(form, routes, visible) {
  if (!Array.isArray(routes) || typeof visible !== 'boolean' || !routes.every(item =>
    typeof item?.provider === 'string' && item.provider !== '' && typeof item.model === 'string' && item.model !== '')) {
    return Promise.reject(new TypeError('Invalid model visibility edit'))
  }
  const owned = routes.map(({ provider, model }) => ({ provider, model }))
  const run = () => commit(form, owned, visible)
  const result = (writes.get(form) ?? Promise.resolve()).then(run)
  const settle = (accepted) => {
    clientTrace('visibility', accepted ? 'accepted' : 'refused', { count: owned.length, enabled: visible })
  }
  // A failed write must not poison the queue or produce an unhandled rejection.
  const tail = result.then(accepted => { settle(accepted); }, () => { settle(false) })
  writes.set(form, tail)
  tail.then(() => { if (writes.get(form) === tail) writes.delete(form) })
  return result
}
