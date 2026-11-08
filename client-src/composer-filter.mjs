import { keyOf } from './format.mjs'
import { FIELD } from './constants.mjs'

function hiddenListOf(snapshot) {
  const value = snapshot && snapshot.value
  return value && Array.isArray(value[FIELD]) ? value[FIELD] : []
}

/**
 * Rewrite one directory store in place so its snapshots omit hidden models.
 *
 * The shipped composer seat may capture the directory store before this plugin
 * applies, so replacing the store object would never reach it; rewriting
 * getSnapshot/subscribe on the captured object does. The session's active
 * model stays listed even while hidden, because the shipped trigger
 * resolves its label from this same catalog.
 */
export function patchDirectoryStore(store, form) {
  const readBase = store.getSnapshot.bind(store)
  const subscribeBase = store.subscribe.bind(store)
  const originalGet = store.getSnapshot
  const originalSubscribe = store.subscribe
  const listeners = new Set()
  let snapshot = null
  let lastBase
  let lastSignature

  const build = (baseSnapshot) => {
    const hidden = new Set(hiddenListOf(form.getSnapshot()))
    const activeSelection = baseSnapshot.current
    const groups = []
    for (const group of baseSnapshot.groups || []) {
      const all = group.models || []
      const models = []
      for (const model of all) {
        const key = keyOf(group.id, model.id)
        const active =
          activeSelection !== null &&
          activeSelection !== undefined &&
          activeSelection.provider === group.id &&
          activeSelection.model === model.id
        if (!hidden.has(key) || active) models.push(model)
      }
      if (models.length === 0) continue
      groups.push(models.length === all.length ? group : { ...group, models })
    }
    return { ...baseSnapshot, groups }
  }

  const current = () => {
    const baseSnapshot = readBase()
    const signature = hiddenListOf(form.getSnapshot()).join('\u0000')
    if (snapshot !== null && baseSnapshot === lastBase && signature === lastSignature) {
      return snapshot
    }
    lastBase = baseSnapshot
    lastSignature = signature
    snapshot = build(baseSnapshot)
    return snapshot
  }

  const emit = () => {
    const previous = snapshot
    const next = current()
    if (previous === next) return
    for (const listener of Array.from(listeners)) listener()
  }

  Object.defineProperties(store, {
    __modelVisibilityPatched: { value: true, configurable: true },
    getSnapshot: { value: current, configurable: true, writable: true },
    subscribe: {
      value(listener) {
        listeners.add(listener)
        const stop = subscribeBase(listener)
        return () => {
          listeners.delete(listener)
          stop()
        }
      },
      configurable: true,
      writable: true,
    },
  })

  return {
    emit,
    restore() {
      Object.defineProperties(store, {
        getSnapshot: { value: originalGet, configurable: true, writable: true },
        subscribe: { value: originalSubscribe, configurable: true, writable: true },
      })
      delete store.__modelVisibilityPatched
      listeners.clear()
    },
  }
}

/**
 * Patch every model directory — the ones already live when the plugin
 * applies and every directory resolved later — so the shipped seat keeps
 * owning the trigger, the Model / Effort rows, and third-party menu
 * enhancements such as the reasoning-effort slider.
 */
export function installComposerFilter(scope, form) {
  const models = scope.modelDirectories
  const original = models.directoryFor
  if (typeof original !== 'function') return
  const records = new Set()

  const ensure = (directory) => {
    if (directory === undefined || directory === null) return directory
    const store = directory.store
    if (store === undefined || store === null || store.__modelVisibilityPatched === true) {
      return directory
    }
    try {
      records.add(patchDirectoryStore(store, form))
    } catch (_error) {
      // Fail open: an unwritable store simply keeps showing every model.
    }
    return directory
  }

  scope.effect(() => {
    const live = models.live && models.live.directories ? models.live.directories.values : null
    if (live instanceof Set) for (const directory of live) ensure(directory)

    const stopForm = form.subscribe(() => {
      for (const record of records) record.emit()
    })

    const wrapper = function directoryFor(sessionId) {
      return ensure(original.call(this, sessionId))
    }
    Object.defineProperty(models, 'directoryFor', {
      value: wrapper,
      configurable: true,
      writable: true,
    })

    return () => {
      stopForm()
      for (const record of records) record.restore()
      records.clear()
      if (Object.getOwnPropertyDescriptor(models, 'directoryFor')?.value === wrapper) {
        delete models.directoryFor
      }
    }
  }, 'model-visibility: filtered model directory')
}

/* ----------------------------------------------------- settings page */
