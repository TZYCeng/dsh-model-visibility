/** Exact API identities and conservative lookup keys for model aliases. */

const REGION_PREFIX = /^(?:global|us|eu|apac|jp|au|ca)\./
const VENDOR_PREFIX = /^(anthropic|openai|google|xai|x-ai|meta|mistralai|moonshotai|minimax|nvidia|qwen|z-ai|zai|zhipu|zhipuai|deepseek|bytedance-seed)\./
const ROUTE_SUFFIX = /(?:(?::|-)(?:fast|free))+$/

/** Exact API identity. A namespace, letter case and request/version suffix are significant. */
export function exactModelIdentity(value) {
  if (typeof value !== 'string') return undefined
  const id = value.trim()
  return id === '' ? undefined : id
}

/** Split structural route prefixes without changing model-name punctuation. */
export function modelIdParts(value) {
  const id = (exactModelIdentity(value) ?? '').toLowerCase().replace(/^~/, '')
  const slash = id.lastIndexOf('/')
  if (slash > 0) return { namespace: id.slice(0, slash), name: id.slice(slash + 1) }
  const dotted = id.replace(REGION_PREFIX, '')
  const vendor = VENDOR_PREFIX.exec(dotted)
  if (vendor === null) return { namespace: '', name: id }
  return { namespace: vendor[1], name: dotted.slice(vendor[0].length) }
}

/** Lowercase model leaf with only terminal fast/free route markers removed. */
export function normalizeModelId(value) {
  const { name } = modelIdParts(value)
  return name.replace(ROUTE_SUFFIX, '') || name
}

/** The lowercased namespace, including every segment of a slash-qualified ID. */
export function modelIdNamespace(value) {
  return modelIdParts(value).namespace
}

/** Retain the legacy array interface without lossy model-family fallback keys. */
export function modelIdVariants(value) {
  const base = normalizeModelId(value)
  return base === '' ? [] : [base]
}

/** Record a spelling of an advertised identity without assigning it a new vendor. */
export function addModelAlias(index, id, spelling = id) {
  if (exactModelIdentity(id) === undefined) return
  const namespace = modelIdNamespace(id)
  const spellingNamespace = modelIdNamespace(spelling)
  if (spellingNamespace && spellingNamespace !== namespace) return
  const key = normalizeModelId(spelling)
  if (!key) return
  let rows = index.get(key)
  if (rows === undefined) index.set(key, rows = new Map())
  rows.set(id, namespace)
}

/** A qualified name prefers its own namespace and cannot borrow another vendor's row. */
export function modelAliasCandidates(index, value, { namespace = modelIdNamespace(value), allowBare = true } = {}) {
  const rows = index.get(normalizeModelId(value))
  if (rows === undefined) return []
  if (!namespace) return [...rows.keys()]
  const sameVendor = [...rows].filter(([, scope]) => scope === namespace).map(([id]) => id)
  if (sameVendor.length > 0) return sameVendor
  // Use an unqualified row only if the caller accepts it and there is no contrary scope.
  return allowBare && ![...rows.values()].some(Boolean) ? [...rows.keys()] : []
}

// Public directory search is advisory. Keep its spelling, alias and modifier
// rules out of exact identities and the provider/learned lookup helpers above.
const PUBLIC_VENDOR_ALIASES = new Map([
  ...'anthropic openai google meta mistralai moonshotai minimax nvidia qwen deepseek bytedance-seed'.split(' ').map(vendor => [vendor, vendor]),
  ['xai', 'xai'], ['x-ai', 'xai'],
  ['z-ai', 'zai'], ['zai', 'zai'], ['zhipu', 'zai'], ['zhipuai', 'zai'],
  ['mistral', 'mistralai'], ['moonshot', 'moonshotai'],
  ['alibaba', 'qwen'], ['alibaba-cloud', 'qwen'],
  ['bytedance', 'bytedance-seed'],
  ['通义千问', 'qwen'], ['通義千問', 'qwen'], ['通義千问', 'qwen'], ['通义千問', 'qwen'], ['千问', 'qwen'], ['千問', 'qwen'],
  ['深度求索', 'deepseek'], ['豆包', 'bytedance-seed'],
  ['智谱清言', 'zai'], ['智譜清言', 'zai'], ['智谱', 'zai'], ['智譜', 'zai'],
  ['月之暗面', 'moonshotai'], ['稀宇科技', 'minimax'],
])

const PUBLIC_BRANDS = new Map([
  ['qwen', 'qwen'], ['deepseek', 'deepseek'], ['glm', 'zai'], ['cogview', 'zai'],
  ['doubao', 'bytedance-seed'], ['seedream', 'bytedance-seed'], ['seedance', 'bytedance-seed'],
  ['gpt', 'openai'], ['chatgpt', 'openai'], ['sora', 'openai'], ['dall-e', 'openai'],
  ['claude', 'anthropic'], ['gemini', 'google'], ['gemma', 'google'], ['veo', 'google'],
  ['llama', 'meta'], ['grok', 'xai'], ['kimi', 'moonshotai'],
  ['mistral', 'mistralai'], ['mixtral', 'mistralai'], ['codestral', 'mistralai'],
  ['minimax', 'minimax'], ['hailuo', 'minimax'], ['nemotron', 'nvidia'],
])
const PUBLIC_BRAND_PREFIX = new RegExp(`^(?:${[...PUBLIC_BRANDS.keys()].join('|')})(?=$|[-0-9])`)
const LOCAL_BRANDS = [
  [/^(?:通[义義]-?)?千[问問]/u, 'qwen'], [/^深度求索/u, 'deepseek'], [/^豆包/u, 'doubao'],
  [/^(?:智谱清言|智譜清言|智谱(?:ai)?|智譜(?:ai)?)/u, 'glm'],
  [/^月之暗面/u, 'kimi'], [/^稀宇科技/u, 'minimax'],
]
const CN_DIGITS = '零一二三四五六七八九'
const CN_NUMBERS = `${CN_DIGITS}〇两兩十`
const NUMERAL = `[0-9${CN_NUMBERS}]`
const GENERATION_START = new RegExp(`^${NUMERAL}`)
const SPACED_DECIMAL = new RegExp(`(?<=${NUMERAL})\\s*\\.\\s*(?=${NUMERAL})`, 'gu')
const PUBLIC_SEPARATORS = new RegExp(`(?<!${NUMERAL})\\.|\\.(?!${NUMERAL})|[\\s_:\\p{Dash_Punctuation}()[\\]【】]+`, 'gu')
const LOCAL_GENERATION = new RegExp(`^(qwen|deepseek|doubao|glm|kimi|minimax)(-?)(${NUMERAL}+)(?:[.点點](${NUMERAL}+))?(?=$|[-a-z])`, 'u')
const LOCAL_MODIFIERS = new Map([
  ['预览', 'preview'], ['预览版', 'preview'], ['預覽', 'preview'], ['預覽版', 'preview'],
  ['免费', 'free'], ['免费版', 'free'], ['免費', 'free'], ['免費版', 'free'], ['快速版', 'fast'],
])
const LOCAL_MODIFIER = new RegExp(`-?(${[...LOCAL_MODIFIERS.keys()].join('|')})(?=$|-)`, 'gu')

function publicModelParts(value, foldWidth = true) {
  const identity = exactModelIdentity(value) ?? ''
  const id = (foldWidth ? identity.normalize('NFKC') : identity).toLowerCase().replace(/^~/, '')
  const slash = id.lastIndexOf('/')
  if (slash > 0) return { namespace: id.slice(0, slash).trim(), name: id.slice(slash + 1).trim() }
  const dotted = id.replace(REGION_PREFIX, '')
  const dot = dotted.indexOf('.')
  const vendor = dotted.slice(0, dot)
  if (dot <= 0 || !PUBLIC_VENDOR_ALIASES.has(vendor)) return { namespace: '', name: id }
  const leaf = dotted.slice(dot + 1).trim()
  // `qwen.4-max` and `deepseek.v3.2` are family spellings, not vendor + leaf.
  const family = PUBLIC_BRANDS.has(vendor) || LOCAL_BRANDS.some(([prefix]) => prefix.test(vendor))
  if (family && (GENERATION_START.test(leaf) || (vendor === 'deepseek' && /^[vr]\d/.test(leaf)))) {
    return { namespace: vendor, name: foldWidth ? `${vendor}.${leaf}` : dotted }
  }
  return { namespace: vendor, name: leaf }
}

function generationDigits(value) {
  const text = value.replace(/[〇两兩]/gu, glyph => glyph === '〇' ? '零' : '二')
  const digit = glyph => /[0-9]/.test(glyph) ? glyph : String(CN_DIGITS.indexOf(glyph))
  if (text.includes('十')) {
    const match = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/u.exec(text)
    if (match === null) return undefined
    return `${match[1] ? digit(match[1]) : '1'}${match[2] ? digit(match[2]) : '0'}`
  }
  return [...text].map(digit).join('')
}

function publicSpelling(value) {
  let label = value
    // A space inside a numeral, unit, or dimension is typography, not a delimiter.
    .replace(SPACED_DECIMAL, '.')
    .replace(/(?<![a-z0-9.])(\d+(?:\.\d+)?)\s+([bmtkp])(?=$|[^\p{L}\d])/gu, '$1$2')
    .replace(/(?<![a-z0-9.])(\d+)\s*[x×]\s*(\d+)(?![a-z0-9.])/gu, '$1x$2')
    .replace(PUBLIC_SEPARATORS, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(LOCAL_MODIFIER, (_, word) => `-${LOCAL_MODIFIERS.get(word)}`)
    .replace(/^-/, '')
  for (const [prefix, replacement] of LOCAL_BRANDS) {
    const match = prefix.exec(label)
    if (match === null) continue
    const rest = label.slice(match[0].length)
    // Translate a known model brand, not Chinese text that happens to start
    // with its name. An unknown CJK continuation remains literal.
    if (!rest || /^[-a-z]/.test(rest) || GENERATION_START.test(rest)) {
      label = /^[a-z]/.test(rest) ? `${replacement}-${rest}` : replacement + rest
    }
    break
  }
  return label
    .replace(LOCAL_GENERATION, (raw, brand, delimiter, major, minor) => {
      const generation = generationDigits(major)
      if (generation === undefined || minor?.includes('十')) return raw
      return `${brand}${delimiter}${generation}${minor === undefined ? '' : `.${generationDigits(minor)}`}`
    })
    // Qwen commonly joins the brand and its generation; its editions do not
    // change meaning when adjacent (e.g. 千问四max / Qwen 4 Max / Qwen4-max).
    .replace(/^qwen-?(\d+(?:\.\d+)*)(?=$|[-a-z])/u, 'qwen$1')
    .replace(/^(qwen\d+(?:\.\d+)*)(max|plus|turbo|flash|coder|vl|omni)(?=$|-)/u, '$1-$2')
    .replace(/^(gpt|claude|gemini|gemma|glm|llama|grok|doubao|kimi)(?=\d)/u, '$1-')
}

/**
 * Public search scope: canonicalize only known vendor aliases. An explicit
 * namespace wins even if the leaf looks like another brand; unknown scopes
 * (including nested scopes) remain intact. Bare names may imply a known
 * vendor from the leading model brand, or return '' if unbranded.
 */
export function publicModelSearchVendor(value) {
  const { namespace, name } = publicModelParts(value)
  if (namespace) return PUBLIC_VENDOR_ALIASES.get(namespace) ?? namespace
  const brand = PUBLIC_BRAND_PREFIX.exec(publicSpelling(name))?.[0]
  return PUBLIC_BRANDS.get(brand) ?? ''
}

const DATE_MODIFIER = /-v?(20\d{2})([.-]?)(\d{2})\2(\d{2})$/u
const PREVIEW_DATE = /-(?:\d{2})-(?:\d{2})$/u
const PUBLIC_MODIFIER = /-(?:preview|free|fast|(?:f|u)?hd|\d+(?:\.\d+)?[bmt](?:-a\d+(?:\.\d+)?b)?|\d+[kp]|\d+x\d+)$/u
const MODIFIER_WORD = /^(?:preview|free|fast|(?:f|u)?hd|v?\d+(?:\.\d+)?(?:[bmtkp]|x\d+)?)$/u

function validSearchDate(year, month, day) {
  const date = new Date(Date.UTC(+year, +month - 1, +day))
  return date.getUTCMonth() === +month - 1 && date.getUTCDate() === +day
}

function removePublicModifier(key) {
  const date = DATE_MODIFIER.exec(key)
  if (date !== null && validSearchDate(date[1], date[3], date[4])) return key.slice(0, date.index)
  const shortDate = PREVIEW_DATE.exec(key)
  if (shortDate !== null) {
    const beforeDate = key.slice(0, shortDate.index)
    const [, month, day] = shortDate[0].split('-')
    // A release channel can make MM-DD a date; plain numeric suffixes such as
    // model-05-06 may instead be the version and must not be removed.
    if (beforeDate.endsWith('-preview') && validSearchDate(2000, month, day)) return beforeDate
  }
  return key.replace(PUBLIC_MODIFIER, '')
}

/**
 * Advisory public directory keys, never API identities. `strict` is the
 * lowercased leaf with all modifiers retained (full IDs are matched separately).
 * `spelling` folds Unicode width and typography plus explicit brand aliases.
 * `stripped` removes recognized terminal modifiers from right to left; it
 * never drops a plain generation, edition, or general version token. Compare
 * leaf keys within the caller's vendor/ambiguity policy, not across vendors
 * simply because the leaf matches. Missing strict/spelling keys are undefined.
 */
export function publicModelSearchKeyTiers(value) {
  const strict = publicModelParts(value, false).name || undefined
  const spelling = publicSpelling(publicModelParts(value).name) || undefined
  const stripped = []
  let key = spelling
  // Keep indexing work bounded for malformed data with hundreds of suffixes.
  while (key !== undefined && stripped.length < 8) {
    const next = removePublicModifier(key)
    if (next === key || !/\p{L}/u.test(next) || PUBLIC_BRANDS.has(next) || next.split('-').every(word => MODIFIER_WORD.test(word))) break
    stripped.push(next)
    key = next
  }
  return { strict, spelling, stripped }
}

/** Deduplicated public search leaf keys, strongest to weakest. */
export function publicModelSearchKeys(value) {
  const { strict, spelling, stripped } = publicModelSearchKeyTiers(value)
  return [...new Set([strict, spelling, ...stripped].filter(Boolean))]
}
