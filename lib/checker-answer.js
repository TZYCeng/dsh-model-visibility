/** Checker response extraction and capability projection. */
import { lookupPublicMatch, publicEvidence, publicFactToCapability } from './public-catalog.js'
import { MAX_CHECKER_REPLY_CHARS, parseCheckerJson, validateReplyShape } from './checker-contract.js'

/**
 * Extract a JSON value from a possibly fenced or chatty checker reply.
 *
 * Both `{…}` and `[…]` are accepted: the contract asks for an array, and a
 * model that answers `[]` ("I know none of these") used to fall through to
 * "contained no JSON" because only braces were searched.
 * @param text - raw assistant text.
 * @returns the parsed object/array, or undefined when nothing parseable remains.
 */
export function extractJsonBlock(text) {
  if (typeof text !== 'string') return undefined
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidates = []
  if (fenced !== null) candidates.push(fenced[1])
  candidates.push(text)
  for (const candidate of candidates) {
    // Prefer the outermost balanced span of whichever bracket opens first.
    const spans = [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
    ]
      .map(({ open, close }) => {
        const start = candidate.indexOf(open)
        const end = candidate.lastIndexOf(close)
        return start === -1 || end <= start ? undefined : { start, end }
      })
      .filter(Boolean)
      .sort((left, right) => left.start - right.start)
    for (const span of spans) {
      try {
        const parsed = JSON.parse(candidate.slice(span.start, span.end + 1))
        if (parsed !== null && typeof parsed === 'object') return parsed
      } catch (_error) {
        // Try the next span, then the next candidate.
      }
    }
  }
  return undefined
}

/** Parse a complete final JSON value, optionally inside a single whole-reply fence. */
export function exactCheckerJson(text) {
  if (typeof text !== 'string' || text.length > MAX_CHECKER_REPLY_CHARS) return undefined
  const trimmed = text.trim()
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  return parseCheckerJson(fenced?.[1] ?? trimmed)
}

/**
 * Validate one checker answer against the identifiers of its batch.
 *
 * Only plain facts survive: modalities are filtered through the host's
 * modality list, kinds through `MODEL_KINDS`, numbers guarded, and every
 * entry stays attached to an id the batch actually asked about.
 *
 * Public catalog facts are *merged in*, not just named: the discovered public
 * row provides a base and the checker overrides it field by field. Before this
 * the catalogs were downloaded, parsed and then thrown away except for an
 * `origins` label — which is why the sweep looked like "the public catalogs
 * returned no model data" even though the endpoints answered fine.
 * @param parsed - the checker's parsed JSON, or canonical rows with `validated: true`.
 * @param ids - the batch ids verbatim.
 * @param publicFacts - the merged public catalog (variant id -> fact).
 * @returns array of `{ id, fact, origins }`; `fact` is null when neither the
 *   public catalogs nor the checker declared anything for that model.
 */
export function parseCheckerAnswer(parsed, ids, publicFacts, { fuzzy = false, validated = false } = {}) {
  const source = validated ? parsed : validateReplyShape(parsed, ids).validRows
  const out = []
  for (const raw of source) {
    const { id } = raw
    const match = lookupPublicMatch(publicFacts, id, { fuzzy })
    // Keep the historic checker snapshot projection, but retain *independent*
    // exact public evidence. The display and write-back can then use the same
    // precedence without attributing the checker's values to a catalog.
    const fromPublic = publicFactToCapability(match?.fact)
    const exact = publicEvidence(match, id, publicFacts, fromPublic)
    const fact = { id, ...(exact ? { ...fromPublic, publicFacts: exact, publicLookupId: id } : {}) }
    const writeFact = {}
    /** Fields the checker itself supplied (as opposed to the catalog). */
    let checkerContributed = false
    for (const field of ['kind', 'input', 'output', 'contextWindow', 'maxTokens', 'reasoning']) {
      if (raw[field] == null) continue
      fact[field === 'kind' ? 'type' : field] = raw[field]
      if (['input', 'contextWindow', 'maxTokens'].includes(field)) writeFact[field] = raw[field]
      checkerContributed = true
    }
    if (raw.reasoningEfforts?.length) {
      // A retained, nonempty ladder is itself a positive reasoning declaration.
      fact.reasoning = true
      fact.reasoningEfforts = raw.reasoningEfforts.map(id => ({ id }))
      delete fact.defaultEffort
      delete fact.reasoningCatalog // the new top-level ladder is the checker's, not the catalog's
      if (raw.defaultEffort != null) fact.defaultEffort = raw.defaultEffort
      checkerContributed = true
    }
    // `origins` names the layers that actually contributed a field. Before this
    // "checker" was pushed unconditionally, so a model the checker skipped but a
    // catalog knew looked like a checker answer.
    const origins = []
    const useAlias = match && !match.exact && !checkerContributed && Object.keys(fromPublic).length > 0
    if (useAlias) Object.assign(fact, fromPublic, { publicLookupId: match.fact.id })
    // Only candidates independently confirmed for this exact ID in this run.
    // Exact public values outrank checker suggestions, but can still lose to
    // live route/official/manual evidence at write time.
    if (exact) Object.assign(writeFact, fromPublic)
    if (Object.keys(fromPublic).length > 0 && (match?.exact || useAlias)) origins.push('public')
    if (checkerContributed) origins.push('checker')
    const declared =
      fact.type !== undefined || fact.input !== undefined || fact.output !== undefined ||
      fact.contextWindow !== undefined || fact.maxTokens !== undefined ||
      fact.reasoning !== undefined || fact.reasoningEfforts !== undefined
    if (Array.isArray(raw.evidence)) fact.evidence = raw.evidence
    if (fact.reasoning === false) { delete fact.reasoningEfforts; delete fact.defaultEffort }
    if (declared) out.push({ id, fact, origins, writeFact: Object.keys(writeFact).length > 0 ? writeFact : null,
      ...(useAlias ? { publicAlias: true } : {}) })
    else out.push({ id, fact: null, origins })
  }
  return out
}
