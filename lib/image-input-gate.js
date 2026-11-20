/**
 * Request-side image-input gate for relay adapters.
 *
 * The settings page can prove that a relay model accepts images (relay
 * listing, built-in catalog, vendor correction), but the `llm-pi-ai` adapter
 * builds an internal model object from the route configuration. For a relay
 * that leaves `input` empty, that object falls back to the provider's
 * `defaultInput` (`["text"]`), so both the session admission check and the
 * adapter's own serializer reject an image that the relay really accepts.
 *
 * This module patches only the adapter method that materializes that model
 * object (`modelOf`), which is used by `resolveModel`, `stream` and
 * `imageRequestTarget` alike. The patch is read-only: it never writes settings,
 * never changes a route, and returns the original object untouched when the
 * capability merge says the model is text-only. It is scoped to the pi-ai
 * adapter shape, so built-in adapters and the DeepSeek Messages adapter keep
 * their own declarations.
 *
 * @module lib/image-input-gate
 */

import { isPiAiRouteAdapter } from './provider-write.js'

/**
 * Patch every registered pi-ai adapter so image-capable relay models advertise
 * `image` to the admission check and to the request serializer.
 *
 * @param llm - the Host `ctx.llm` service (a traceable service proxy is fine).
 * @param options - `{ allow(provider, model, name, snapshotRoute), warn(error) }`.
 * @returns `{ refresh, dispose }`; call `refresh` after adapters change.
 */
export function installImageInputGate(llm, options = {}) {
  const allow = typeof options.allow === 'function' ? options.allow : () => false
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  /** adapter -> { active, descriptor, wrapper } */
  const patched = new Map()
  let disposed = false

  const shouldAddImage = (adapter, snapshot, provider, model, resolved) => {
    try {
      // Prepared calls may still be holding a previous collection. Never ask
      // today's settings/probe about a model materialized from that collection.
      if (llm.adapters.get(provider)?.adapter !== adapter || adapter.current() !== snapshot) return false
      const profile = adapter.profileOf(snapshot, provider)
      if (snapshot?.profiles?.get?.(provider) !== profile || profile === undefined ||
          resolved.provider !== provider || resolved.id !== model ||
          !Array.isArray(resolved.input) || !resolved.input.includes('text')) return false
      return allow(provider, model, resolved.name, { adapter, snapshot, profile, resolved }) === true
    } catch (error) {
      warn(error)
      return false
    }
  }

  const patchAdapter = (adapter) => {
    try {
      if (patched.has(adapter) || !isPiAiRouteAdapter(adapter)) return
      const original = adapter.modelOf
      const descriptor = Object.getOwnPropertyDescriptor(adapter, 'modelOf')
      const record = { active: true, descriptor, wrapper: null }
      const wrapper = function modelOf(snapshot, provider, model, ...rest) {
        const resolved = original.call(this, snapshot, provider, model, ...rest)
        if (!record.active || resolved === null || typeof resolved !== 'object') return resolved
        if (Array.isArray(resolved.input) && resolved.input.includes('image')) return resolved
        if (!shouldAddImage(this, snapshot, provider, model, resolved)) return resolved
        return { ...resolved, input: [...resolved.input, 'image'] }
      }
      Object.defineProperty(adapter, 'modelOf', {
        value: wrapper,
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? false,
        writable: descriptor?.writable ?? true,
      })
      record.wrapper = wrapper
      patched.set(adapter, record)
    } catch (error) {
      warn(error)
    }
  }

  const release = (adapter, record) => {
    record.active = false
    patched.delete(adapter)
    try {
      if (Object.getOwnPropertyDescriptor(adapter, 'modelOf')?.value !== record.wrapper) return
      if (record.descriptor === undefined) delete adapter.modelOf
      else Object.defineProperty(adapter, 'modelOf', record.descriptor)
    } catch (error) {
      // The wrapper is inactive even if the property no longer permits edits.
      warn(error)
    }
  }

  /** Re-scan the registry; registrations are replaced on route/config changes. */
  const refresh = () => {
    if (disposed) return
    let adapters
    try {
      adapters = llm?.adapters
    } catch (_error) {
      return
    }
    if (!(adapters instanceof Map)) return
    const registered = new Set([...adapters.values()].map((registration) => registration?.adapter))
    for (const [adapter, record] of patched) {
      if (!registered.has(adapter)) release(adapter, record)
    }
    for (const adapter of registered) patchAdapter(adapter)
  }

  refresh()

  return {
    refresh,
    dispose() {
      disposed = true
      for (const [adapter, record] of patched) release(adapter, record)
    },
  }
}
