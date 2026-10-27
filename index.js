/**
 * Host half of the model-visibility plugin.
 *
 * Two jobs:
 *
 * 1. Own the `model-visibility` settings namespace: `hidden` is a volatile
 *    Config field, so the Host settings document persists the browser's choices
 *    and `settings.describe` projects them back to the Client. The generated
 *    configuration page is disabled because the plugin's own settings section
 *    is the editing surface.
 * 2. Keep a shadow copy of that list outside the profile patch layer
 *    (`$DSH_HOME/dsh-model-visibility/hidden.json`), because the patch layer is
 *    rebuilt from scratch in several ordinary situations — a profile repair,
 *    a plugin reinstall, or any write whose value equals the inherited default
 *    (the settings writer then deletes the row). Without a shadow copy the row
 *    silently disappears and every model becomes visible again after the next
 *    reload. The schema default is seeded from that file, so a rebuilt patch
 *    layer restores the last known list instead of an empty one.
 *
 * Each entry is an opaque `provider/model` key; the Client never parses it.
 *
 * @module index.js
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import { createModelInfoService } from './lib/model-info.js'

/** Settings namespace this entry owns; also the loader row id. */
const ENTRY = 'model-visibility'
/** Config field carrying the hidden model keys. */
const FIELD = 'hidden'
/** Shadow store location below `$DSH_HOME`. */
const STORE_DIR = 'dsh-model-visibility'
const STORE_FILE = 'hidden.json'
/** Authenticated same-origin route prefix used by the settings page. */
const API = '/api/dsh-model-visibility'

/** Absolute path of the shadow copy. */
function storeFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, STORE_DIR, STORE_FILE)
}

/** Keep only string entries, so a hand-edited file can never break the schema. */
function asKeyList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((key) => typeof key === 'string')
}

/** Read the shadow copy; a missing or unreadable file simply yields an empty list. */
function readStored() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
    return asKeyList(Array.isArray(parsed) ? parsed : parsed?.[FIELD])
  } catch (_error) {
    return []
  }
}

/** Replace the shadow copy atomically; a failure must never break the plugin. */
function writeStored(list) {
  const file = storeFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify({ [FIELD]: list }, null, 2)}\n`)
  fs.renameSync(temp, file)
}

/**
 * Restored default: a rebuilt settings document keeps the last hidden list
 * instead of falling back to "everything visible".
 */
const RESTORED = readStored()

/** Model keys the composer must stop offering, in the order they were hidden. */
export const Config = z.object({
  hidden: z.array(z.string()).default(RESTORED).volatile(),
})

/**
 * Disable the generated configuration page and keep the shadow copy current.
 * @param ctx - plugin context.
 * @param config - resolved plugin config; `hidden` is a stable volatile reference.
 */
export function apply(ctx, config) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }))
  })

  const logger = ctx.logger ?? console

  /** Current hidden keys, read through the stable volatile reference. */
  const liveList = () => {
    const value = config?.[FIELD]
    const current = value !== null && typeof value === 'object' && typeof value.get === 'function'
      ? value.get()
      : value
    return asKeyList(current)
  }

  let written
  const persist = () => {
    const list = liveList()
    const signature = list.join('\u0000')
    if (signature === written) return
    try {
      writeStored(list)
      written = signature
    } catch (error) {
      if (typeof logger.warn === 'function') {
        logger.warn('model-visibility: could not write the shadow copy')
        logger.warn(error)
      }
    }
  }

  ctx.effect(() => {
    const disposers = []
    /**
     * A volatile-only settings write updates the reference in place and emits
     * `loader/volatile-update`; the settings document event covers the same
     * change when the loader reports it differently.
     */
    const onConfigChanged = (paths) => {
      if (Array.isArray(paths) && !paths.some((item) => Array.isArray(item) && item[0] === FIELD)) return
      persist()
    }
    if (typeof ctx.on === 'function') {
      disposers.push(
        ctx.on('loader/volatile-update', (paths) => {
          onConfigChanged(paths)
        }),
      )
      disposers.push(
        ctx.on('settings/document-updated', (ns) => {
          if (ns === ENTRY) onConfigChanged()
        }),
      )
    }
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (_error) {
          // A listener may already be gone during teardown.
        }
      }
    }
  }, 'model-visibility: shadow copy')

  ctx.effect(() => {
    persist()
    return () => persist()
  }, 'model-visibility: shadow baseline')

  // The capability catalog is a read-only projection of the live LLM registry.
  // It is served over an authenticated same-origin route because the shipped
  // `session.modelCatalog` projection drops context windows and modalities.
  ctx.inject(['llm', 'connection'], (scope) => {
    const connection = scope.connection
    if (scope.llm === undefined) {
      if (typeof logger.warn === 'function') {
        logger.warn('model-visibility: llm service unavailable; capability route not registered')
      }
      return
    }
    if (connection === undefined || typeof connection.fetch?.register !== 'function') {
      if (typeof logger.warn === 'function') {
        logger.warn('model-visibility: connection.fetch unavailable; capability route not registered')
      }
      return
    }

    const service = createModelInfoService(scope.llm)

    /** Answer with JSON; the route is diagnostics-friendly on purpose. */
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      })

    scope.effect(
      () =>
        connection.fetch.register({
          path: `${API}/models`,
          methods: ['GET'],
          requestBody: 'buffered',
          async fetch(request) {
            let fresh = false
            try {
              fresh = new URL(request.url).searchParams.get('fresh') !== null
            } catch (_error) {
              // A malformed URL simply means "use the cached read".
            }
            try {
              return json({ ok: true, value: await service.read({ fresh }) })
            } catch (error) {
              if (typeof logger.warn === 'function') {
                logger.warn('model-visibility: capability probe failed')
                logger.warn(error)
              }
              return json(
                {
                  ok: false,
                  error: {
                    code: 'model-info/failed',
                    message: error instanceof Error ? error.message : String(error),
                  },
                },
                500,
              )
            }
          },
        }),
      'model-visibility: capability route',
    )

    // A route/credential change invalidates both the probe cache and any page
    // that is already open; the browser mirrors the same two events.
    scope.effect(() => {
      const offs = []
      const invalidate = () => service.invalidate()
      if (typeof scope.on === 'function') {
        offs.push(scope.on('llm/adapters-updated', invalidate))
        offs.push(scope.on('settings/document-updated', invalidate))
      }
      return () => {
        for (const off of offs) {
          try {
            if (typeof off === 'function') off()
          } catch (_error) {
            // The service may already be gone during teardown.
          }
        }
      }
    }, 'model-visibility: capability cache')
  })
}
