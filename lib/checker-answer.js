/** Checker response extraction and capability projection. */
import { normalizeModalities } from './provider-probe.js'
import { MODEL_KINDS } from './capability-catalog.js'
import { lookupPublicFact, publicFactToCapability } from './public-catalog.js'
function nonEmpty(value) { return typeof value === 'string' && value.trim() ? value.trim() : undefined }

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
 * @param parsed - the checker's parsed JSON (object or `{models:[...]}`).
 * @param ids - the batch ids verbatim.
 * @param publicFacts - the merged public catalog (variant id -> fact).
 * @returns array of `{ id, fact, origins }`; `fact` is null when neither the
 *   public catalogs nor the checker declared anything for that model.
 */
export function parseCheckerAnswer(parsed, ids, publicFacts) {
  const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.models) ? parsed.models : Array.isArray(parsed?.results) ? parsed.results : Object.values(parsed ?? {})
  const wanted = new Set(ids.map((id) => id.toLowerCase()))
  const out = []
  for (const raw of source) {
    if (raw === null || typeof raw !== 'object') continue
    const answerId = nonEmpty(raw.id)
    if (answerId === undefined || !wanted.has(answerId.toLowerCase())) continue
    const id = ids.find(value => value.toLowerCase() === answerId.toLowerCase())
    if (out.some(row => row.id === id)) continue
    const publicFact = lookupPublicFact(publicFacts, id)
    // Public row first, checker answers on top: the checker saw this specific
    // route, the catalog only knows the model family.
    const fromPublic = publicFactToCapability(publicFact)
    const fact = { id, ...fromPublic }
    /** Fields the checker itself supplied (as opposed to the catalog). */
    let checkerContributed = false
    if (MODEL_KINDS.includes(raw.kind)) {
      fact.type = raw.kind
      checkerContributed = true
    }
    if (typeof raw.type === 'string' && MODEL_KINDS.includes(raw.type)) {
      fact.type = raw.type
      checkerContributed = true
    }
    const input = normalizeModalities(raw.input ?? raw.inputModalities)
    if (input !== undefined) {
      fact.input = input
      checkerContributed = true
    }
    const output = normalizeModalities(raw.output ?? raw.outputModalities)
    if (output !== undefined) {
      fact.output = output
      checkerContributed = true
    }
    if (Number.isSafeInteger(raw.contextWindow) && raw.contextWindow > 0) {
      fact.contextWindow = raw.contextWindow
      checkerContributed = true
    }
    if (Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0) {
      fact.maxTokens = raw.maxTokens
      checkerContributed = true
    }
    if (typeof raw.reasoning === 'boolean') {
      fact.reasoning = raw.reasoning
      checkerContributed = true
    }
    if (Array.isArray(raw.reasoningEfforts)) {
      const efforts = raw.reasoningEfforts
        .map((effort) => (typeof effort === 'string' ? effort : effort?.id))
        .filter((effort) => typeof effort === 'string' && effort.trim() !== '')
        .map((effort) => ({ id: effort.trim() }))
      if (efforts.length > 0) fact.reasoningEfforts = efforts
      const defaultEffort = nonEmpty(raw.defaultEffort)
      if (defaultEffort !== undefined && efforts.some((effort) => effort.id === defaultEffort)) {
        fact.defaultEffort = defaultEffort
      }
      if (efforts.length > 0) checkerContributed = true
    }
    // `origins` names the layers that actually contributed a field. Before this
    // "checker" was pushed unconditionally, so a model the checker skipped but a
    // catalog knew looked like a checker answer.
    const origins = []
    if (Object.keys(fromPublic).length > 0) origins.push('public')
    if (checkerContributed) origins.push('checker')
    const declared =
      fact.type !== undefined || fact.input !== undefined || fact.output !== undefined ||
      fact.contextWindow !== undefined || fact.maxTokens !== undefined ||
      fact.reasoning !== undefined || fact.reasoningEfforts !== undefined
    if (Array.isArray(raw.evidence)) fact.evidence = raw.evidence
    if (declared) out.push({ id, fact, origins })
    else out.push({ id, fact: null, origins })
  }
  return out
}
