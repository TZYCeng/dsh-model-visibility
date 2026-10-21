/**
 * Host half of the model-visibility plugin.
 *
 * Its only Host-side job is to own the `model-visibility` settings namespace:
 * `hidden` is a volatile Config field, so the Host settings document persists
 * the browser's choices and `settings.describe` projects them back to the
 * Client. The generated configuration page is disabled because the plugin's
 * own settings section is the editing surface.
 *
 * Each entry is an opaque `provider/model` key; the Client never parses it.
 *
 * @module index.js
 */
import z from '@deepseek-ai/schemastery'

/** Model keys the composer must stop offering, in the order they were hidden. */
export const Config = z.object({
  hidden: z.array(z.string()).default([]).volatile(),
})

/**
 * Disable the generated configuration page for this entry.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }))
  })
}
