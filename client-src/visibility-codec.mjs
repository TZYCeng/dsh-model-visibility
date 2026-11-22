/**
 * Stored hidden[] is also read by old composer clients. A legacy `a/b/c`
 * hides EVERY provider/model split. Never infer a split from a (possibly
 * partial) catalog. Keep that conservative baseline and add exact exceptions.
 *
 * For a newly hidden ambiguous route keep the legacy key as an old-reader
 * shadow, plus a `hide` tag. A group with hide tags is an explicit subset;
 * a legacy group without hide tags is still a blanket with optional `show`
 * exceptions. Old readers may hide extra colliding routes, never expose one
 * we hide. Old readers deleting a shadow explicitly show the group. Tags
 * without a shadow are inert. Untouched/unknown preferences pass through.
 *
 * Tags contain no literal slash and cannot be any legacy provider/model key.
 * JSON handles arbitrary IDs (including lone surrogates); escape only the
 * percent sign and slash, in that order, to make the tag's namespace disjoint.
 */
const PREFIX = 'mv2:'
const tag = (kind, provider, model) => PREFIX + kind + ':' + JSON.stringify([provider, model]).replaceAll('%', '%25').replaceAll('/', '%2F')
const legacyKey = (provider, model) => provider + '/' + model
const ambiguous = (provider, model) => provider.includes('/') || model.includes('/')
const id = (text) => typeof text === 'string' && text.length > 0

/** Injective route identity. Preserve every already-unambiguous legacy key. */
export function routeKey(provider, model) {
  return ambiguous(provider, model) ? tag('hide', provider, model) : legacyKey(provider, model)
}

function parseTag(text) {
  if (typeof text !== 'string' || !text.startsWith(PREFIX) || text.includes('/')) return null
  const split = text.indexOf(':', PREFIX.length)
  const kind = text.slice(PREFIX.length, split)
  if (kind !== 'hide' && kind !== 'show') return null
  try {
    const pair = JSON.parse(text.slice(split + 1).replaceAll('%2F', '/').replaceAll('%25', '%'))
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(id)) return null
    const [provider, model] = pair
    if (!ambiguous(provider, model) || tag(kind, provider, model) !== text) return null
    return { kind, provider, model, legacy: legacyKey(provider, model) }
  } catch { return null }
}

/** Exact route fields for usage exports; old multi-slash totals stay unassigned. */
export function routeFields(key) {
  if (typeof key !== 'string') return null
  const slash = key.indexOf('/')
  if (slash > 0 && slash < key.length - 1 && slash === key.lastIndexOf('/')) return [key.slice(0, slash), key.slice(slash + 1)]
  const parsed = parseTag(key)
  return parsed?.kind === 'hide' ? [parsed.provider, parsed.model] : null
}

// Per-legacy-group tag index, updated along with the raw strings. A raw key
// with no tag always retains the full historical behavior, even if a model
// disappears from the catalog and comes back under another provider split.
function preferences(list) {
  const raw = new Set(Array.isArray(list) ? list : [])
  const groups = new Map()
  for (const text of raw) {
    const parsed = parseTag(text)
    if (!parsed) continue
    let metadata = groups.get(parsed.legacy)
    if (!metadata) groups.set(parsed.legacy, metadata = { hide: new Set(), show: new Set() })
    metadata[parsed.kind].add(text)
  }

  const hasRoute = (provider, model) => {
    const legacy = legacyKey(provider, model)
    if (!raw.has(legacy)) return false
    const meta = groups.get(legacy)
    if (!meta) return true
    return meta.hide.size ? meta.hide.has(tag('hide', provider, model)) : !meta.show.has(tag('show', provider, model))
  }

  const setRoute = (provider, model, visible) => {
    if (hasRoute(provider, model) === !visible) return false
    const legacy = legacyKey(provider, model)
    if (!ambiguous(provider, model)) {
      if (visible) raw.delete(legacy)
      else raw.add(legacy)
      return true
    }
    let meta = groups.get(legacy)
    if (!meta) groups.set(legacy, meta = { hide: new Set(), show: new Set() })
    const hidden = tag('hide', provider, model)
    const shown = tag('show', provider, model)
    if (!raw.has(legacy)) {
      // An old reader removed the shadow but retained unknown tags. A later
      // explicit hide must not resurrect other routes from that old edit.
      for (const keys of [meta.hide, meta.show]) { for (const key of keys) raw.delete(key); keys.clear() }
      raw.add(legacy); raw.add(hidden); meta.hide.add(hidden)
    } else if (meta.hide.size) {
      if (!visible) { raw.add(hidden); meta.hide.add(hidden) }
      else {
        raw.delete(hidden); meta.hide.delete(hidden)
        if (!meta.hide.size) {
          raw.delete(legacy)
          for (const key of meta.show) raw.delete(key)
          groups.delete(legacy)
        }
      }
    } else if (visible) {
      // Do not split or replace a blanket based on currently listed models.
      raw.add(shown); meta.show.add(shown)
      // Once *every possible* nonempty split was explicitly shown, the old
      // blanket can be removed too. Counting separators does not guess IDs.
      let splits = 0
      for (let i = 1; i < legacy.length - 1; i++) if (legacy[i] === '/') splits++
      if (meta.show.size === splits) {
        raw.delete(legacy)
        for (const key of meta.show) raw.delete(key)
        groups.delete(legacy)
      }
    } else { raw.delete(shown); meta.show.delete(shown) }
    return true
  }
  return { raw, hasRoute, setRoute }
}

/** Read-only facade for filters using canonical keys, plus a direct hot-path check. */
export function hiddenIndex(list) {
  const { raw, hasRoute } = preferences(list)
  return { hasRoute, has(key) {
    if (typeof key !== 'string') return false
    if (key.includes('/')) return raw.has(key)
    const parsed = parseTag(key)
    return parsed?.kind === 'hide' && hasRoute(parsed.provider, parsed.model)
  } }
}

/** Pure route-level edit. Keep the input array reference if nothing changed. */
export function editHiddenRoutes(list, routes, visible) {
  const prefs = preferences(list)
  let changed = false
  for (const { provider, model } of routes) if (prefs.setRoute(provider, model, visible)) changed = true
  return changed ? [...prefs.raw] : list
}
