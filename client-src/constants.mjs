/** Dictionary namespace owned by this plugin. */
export const NS = 'model-visibility'
/** Host entry id from cordis.patch.yml; also the settings namespace. */
export const ENTRY = 'model-visibility'
/** Config field persisted by the Host settings document. */
export const FIELD = 'hidden'
/** Settings section id. */
export const SECTION_ID = 'model-visibility'
/**
 * Same-origin route the Host half registers through `connection.fetch`.
 * Resolved against the page base so a reverse-proxy prefix is preserved.
 */
export const API = (() => {
  if (typeof document === 'undefined') return '/api/dsh-model-visibility'
  try {
    return new URL('api/dsh-model-visibility', document.baseURI).pathname
  } catch (_error) {
    return '/api/dsh-model-visibility'
  }
})()
