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

/**
 * True when an adapter is the pi-ai route adapter whose models come from
 * `modelOf(snapshot, provider, model)`.
 * @param adapter - registered adapter instance.
 * @returns whether the adapter has the patched surface.
 */
function isPiAiAdapter(adapter) {
  return (
    adapter !== null &&
    typeof adapter === 'object' &&
    typeof adapter.modelOf === 'function' &&
    typeof adapter.profileOf === 'function' &&
    typeof adapter.current === 'function'
  )
}

/**
 * Patch every registered pi-ai adapter so image-capable relay models advertise
 * `image` to the admission check and to the request serializer.
 *
 * @param llm - the Host `ctx.llm` service (a traceable service proxy is fine).
 * @param options - `{ allow(provider, model), warn(error) }`.
 * @returns `{ refresh, dispose }`; call `refresh` after adapters change.
 */
export function installImageInputGate(llm, options = {}) {
  const allow = typeof options.allow === 'function' ? options.allow : () => false
  const warn = typeof options.warn === 'function' ? options.warn : () => {}
  /** adapter -> { original, wrapper } */
  const patched = new Map()

  const shouldAddImage = (provider, model) => {
    try {
      return allow(provider, model) === true
    } catch (error) {
      warn(error)
      return false
    }
  }

  const patchAdapter = (adapter) => {
    if (!isPiAiAdapter(adapter) || patched.has(adapter)) return
    const original = adapter.modelOf
    const wrapper = function modelOf(snapshot, provider, model) {
      const resolved = original.call(this, snapshot, provider, model)
      if (resolved === null || typeof resolved !== 'object') return resolved
      if (Array.isArray(resolved.input) && resolved.input.includes('image')) return resolved
      if (!shouldAddImage(provider, model)) return resolved
      const input = Array.isArray(resolved.input) ? resolved.input : ['text']
      return { ...resolved, input: [...input, 'image'] }
    }
    try {
      Object.defineProperty(adapter, 'modelOf', {
        value: wrapper,
        configurable: true,
        writable: true,
      })
      patched.set(adapter, { original, wrapper })
    } catch (error) {
      warn(error)
    }
  }

  /** Re-scan the registry; registrations are replaced on route/config changes. */
  const refresh = () => {
    let adapters
    try {
      adapters = llm?.adapters
    } catch (_error) {
      return
    }
    if (!(adapters instanceof Map)) return
    for (const registration of adapters.values()) patchAdapter(registration?.adapter)
  }

  refresh()

  return {
    refresh,
    dispose() {
      for (const [adapter, record] of patched) {
        try {
          if (Object.getOwnPropertyDescriptor(adapter, 'modelOf')?.value === record.wrapper) {
            delete adapter.modelOf
          }
        } catch (_error) {
          // A disposed adapter simply keeps the wrapper; it no longer serves.
        }
      }
      patched.clear()
    },
  }
}
