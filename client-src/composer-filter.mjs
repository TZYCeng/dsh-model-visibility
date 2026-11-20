import { keyOf } from './format.mjs'
import { FIELD } from './constants.mjs'

function hiddenListOf(snapshot) {
  const value = snapshot && snapshot.value
  return value && Array.isArray(value[FIELD]) ? value[FIELD] : []
}

/** Patch one method while preserving its previous own/inherited shape. */
function replaceMethod(target, name, wrapper) {
  const original = Object.getOwnPropertyDescriptor(target, name)
  Object.defineProperty(target, name, {
    configurable: original?.configurable ?? true,
    enumerable: original?.enumerable ?? false,
    writable: original && 'writable' in original ? original.writable : true,
    value: wrapper,
  })
  return () => {
    if (Object.getOwnPropertyDescriptor(target, name)?.value !== wrapper) return
    if (original) Object.defineProperty(target, name, original)
    else delete target[name]
  }
}

/**
 * Filter the existing directory store without swapping any subscriptions.
 * Notify through the underlying SnapshotStore so seats already subscribed at
 * attach time (and those still mounted during removal) see the transition.
 */
export function patchDirectoryStore(store, form) {
  const readBase = store.getSnapshot.bind(store)
  const publishBase = typeof store.set === 'function' ? store.set.bind(store) : null
  let active = true
  let snapshot = null
  let lastBase
  let lastSignature

  const build = (baseSnapshot, hiddenList) => {
    const hidden = new Set(hiddenList)
    const selection = baseSnapshot.current
    const groups = []
    let changed = false
    for (const group of baseSnapshot.groups ?? []) {
      const all = group.models ?? []
      const models = all.filter((model) => !hidden.has(keyOf(group.id, model.id)) ||
        (selection?.provider === group.id && selection.model === model.id))
      if (models.length === all.length) groups.push(group)
      else {
        changed = true
        if (models.length > 0) groups.push({ ...group, models })
      }
    }
    return changed ? { ...baseSnapshot, groups } : baseSnapshot
  }

  const current = () => {
    const baseSnapshot = readBase()
    if (!active) return baseSnapshot
    const hidden = hiddenListOf(form.getSnapshot())
    const signature = JSON.stringify(hidden)
    if (baseSnapshot === lastBase && signature === lastSignature) return snapshot
    const next = build(baseSnapshot, hidden)
    // Keep the external-store snapshot stable when a hidden-list edit didn't
    // affect this particular directory (e.g. its current model is retained).
    const sameGroups = baseSnapshot === lastBase && next !== baseSnapshot && snapshot !== baseSnapshot &&
      next.groups.length === snapshot.groups.length && next.groups.every((group, index) => {
        const prior = snapshot.groups[index]
        return group === prior || (group.id === prior.id && group.models.length === prior.models.length &&
          group.models.every((model, modelIndex) => model === prior.models[modelIndex]))
      })
    lastBase = baseSnapshot
    lastSignature = signature
    if (!sameGroups) snapshot = next
    return snapshot
  }

  // Capture the pre-attach snapshot so the initial emit notifies even existing subscribers.
  snapshot = readBase()
  let published = snapshot
  const restoreSnapshot = replaceMethod(store, 'getSnapshot', current)
  const notify = () => { if (publishBase) publishBase({ ...readBase() }) }

  return {
    emit() {
      if (published === current()) return
      notify()
      published = current()
    },
    restore({ notifyReaders = true } = {}) {
      if (!active) return
      const changed = current() !== readBase()
      active = false
      restoreSnapshot()
      if (changed && notifyReaders) notify()
      snapshot = lastBase = lastSignature = null
    },
  }
}

/** Patch live and future directories without retaining closed sessions. */
export function installComposerFilter(scope, form) {
  const models = scope.modelDirectories
  const original = models.directoryFor
  if (typeof original !== 'function') return

  scope.effect(() => {
    const records = new Map()
    const ensure = (directory) => {
      const store = directory?.store
      if (!store || records.has(store)) return directory
      let record
      try {
        record = patchDirectoryStore(store, form)
        let restoreDispose
        const stop = (notifyReaders) => {
          records.delete(store)
          restoreDispose?.()
          record.restore({ notifyReaders })
        }
        const dispose = directory.dispose
        if (typeof dispose !== 'function') throw new Error('Directory has no scope disposer')
        restoreDispose = replaceMethod(directory, 'dispose', function (...args) {
          stop(false)
          return dispose.apply(this, args)
        })
        records.set(store, { emit: record.emit, stop })
        record.emit()
      } catch (_error) {
        // An unwritable store or directory must not break model selection.
        const installed = records.get(store)
        if (installed) installed.stop(false)
        else record?.restore({ notifyReaders: false })
      }
      return directory
    }

    let restoreResolver
    try {
      restoreResolver = replaceMethod(models, 'directoryFor', function (sessionId) {
        return ensure(original.call(this, sessionId))
      })
    } catch (_error) {
      return
    }
    const live = models.live?.directories?.values
    if (live instanceof Set) for (const directory of live) ensure(directory)
    const stopForm = form.subscribe(() => {
      for (const record of records.values()) record.emit()
    })

    return () => {
      restoreResolver()
      stopForm()
      for (const record of records.values()) record.stop(true)
    }
  }, 'model-visibility: filtered model directory')
}
