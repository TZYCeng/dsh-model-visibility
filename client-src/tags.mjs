import { kindOf, sourceOf, sourceLabel, isInferredSource, formatContext, effortNames, defaultEffortName, modalityNames, modalityLabel, resolutionOf, manualFieldsOf } from './format.mjs'

// Evidence belongs to a field, never to a whole row: a context alias is not proof of a ladder.
function withEvidence(tag, model, field, t) {
  const fact = model.fieldEvidence?.[field]
  const alias = fact?.alias === true || (field === 'referenceReasoning' && model.referenceReasoningAlias === true)
  if (!fact && !alias) return tag
  const details = [tag.title, fact?.catalog, fact?.lookupId ? t('tag.lookupId', { id: fact.lookupId }) : null, alias ? t(fact?.source === 'provider' ? 'tag.relayAliasTitle' : 'tag.aliasReferenceTitle') : null]
  return { ...tag, evidenceField: field, label: tag.label + (alias ? ' · ' + t('tag.aliasReference') : ''), title: details.filter(Boolean).join(' · '),
    inferred: Boolean(tag.inferred || alias || isInferredSource(fact?.source)) }
}

function manualTag(model, t) {
  return manualFieldsOf(model).length === 0
    ? null
    : {
        key: 'manual',
        tone: 'accent',
        label: t('tag.manual'),
        title: t('tag.manualTitle'),
      }
}

/** Tags for image / video / embedding / rerank / audio / moderation models. */
function generationTags(model, t) {
  const kind = kindOf(model)
  const kindSource = sourceOf(model, 'kind')
  const kindLabel = t('tag.kind.' + kind) === 'tag.kind.' + kind ? t('tag.kind.unknown') : t('tag.kind.' + kind)
  const titleKey = kind === 'image' ? 'tag.kindImageTitle' : kind === 'video' ? 'tag.kindVideoTitle' : 'tag.kindTitle'
  const tags = [
    {
      key: 'kind',
      tone: 'kind-' + kind,
      label: kindLabel,
      title: t(titleKey, { kind: kindLabel, source: sourceLabel(kindSource, t) }),
      inferred: isInferredSource(kindSource),
    },
  ]
  const resolution = resolutionOf(model)
  if (resolution !== null && (kind === 'image' || kind === 'video')) {
    tags.push({
      key: 'resolution',
      tone: 'neutral',
      label: resolution,
      title: t('tag.resolutionTitle', { value: resolution }),
    })
  }
  // Image editing capability is the one input fact worth showing on a
  // generation row; it never turns into the chat "multimodal" tag.
  if (kind === 'image' && Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) {
    tags.push({
      key: 'image-input',
      tone: 'neutral',
      label: t('tag.imageInput'),
      title: t('tag.imageInputTitle'),
    })
  }
  const manual = manualTag(model, t)
  if (manual !== null) tags.push(manual)
  return tags.map((tag) => tag.key === 'kind' || tag.key === 'image-input' ? withEvidence(tag, model, tag.key === 'kind' ? 'kind' : 'modalities', t) : tag)
}

/**
 * Per-model capability tags. The same model may know only part of its
 * capabilities: an adapter that cannot answer produces `infoError`, and the
 * unknown facts are shown as such instead of being guessed. Each tag knows
 * whether its value is a declaration (solid border) or a completion from the
 * built-in catalog / name heuristics (dashed border).
 */
function capabilityTags(model, t) {
  const kind = kindOf(model)
  if (kind !== 'chat') return generationTags(model, t)

  const tags = []
  const reasoning = model.reasoning
  const reasoningSource = sourceOf(model, 'reasoning')
  const requestReasoning = Object.hasOwn(model, 'requestReasoning') ? model.requestReasoning
    : reasoningSource === 'config' || reasoningSource === 'adapter' ? reasoning : null
  const requestLevels = effortNames(requestReasoning)
  const referenceLevels = model.reasoningSupported === false ? [] : effortNames(reasoning)
  const sameLadder = referenceLevels.length === requestLevels.length
    && referenceLevels.every((level, index) => level === requestLevels[index])
    && reasoning?.defaultEffort === requestReasoning?.defaultEffort
  const errorTitle = typeof model.infoError === 'string' && model.infoError !== ''
    ? t('tag.infoErrorTitle', { message: model.infoError }) : t('tag.unknownTitle')

  if (model.reasoningSupported === false && requestLevels.length === 0) {
    const authoritative = reasoningSource === 'config' || reasoningSource === 'adapter'
    tags.push({ key: 'reasoning', tone: 'muted', label: t(authoritative ? 'tag.noReasoning' : 'tag.noReasoningReference'),
      title: sourceLabel(reasoningSource, t), inferred: !authoritative })
  } else if (model.reasoningSupported === true || requestLevels.length > 0) {
    tags.push({ key: 'reasoning', tone: 'accent', label: t(requestLevels.length > 0 ? 'tag.reasoning' : 'tag.reasoningReference'),
      title: requestLevels.length > 0
        ? t('tag.reasoningTitle', { levels: requestLevels.join(' / '), source: sourceLabel('adapter', t) })
        : t('tag.reasoningCatalogTitle', { source: sourceLabel(reasoningSource, t) }),
      inferred: requestLevels.length === 0 && (isInferredSource(reasoningSource) || reasoningSource === 'manual') })
  } else {
    tags.push({ key: 'reasoning', tone: 'muted', label: t('tag.reasoningUnknown'), title: errorTitle })
  }

  if (requestLevels.length > 0 && model.reasoningSupported === false) {
    tags.push({ key: 'reference-no-reasoning', tone: 'muted', inferred: true,
      label: t('tag.noReasoningReference'), title: t('tag.effortReferenceTitle', { source: sourceLabel(reasoningSource, t) }) })
  }
  if (requestLevels.length > 0) {
    const fallback = defaultEffortName(requestReasoning)
    tags.push({ key: 'effort', tone: 'neutral', label: t('tag.effort') + ' ' + requestLevels.join('/'),
      title: fallback === null
        ? t('tag.effortTitleNoFallback', { levels: requestLevels.join(' / '), source: sourceLabel('adapter', t) })
        : t('tag.effortTitle', { levels: requestLevels.join(' / '), fallback, source: sourceLabel('adapter', t) }) })
  }
  if (model.reasoningWireDisabled === true) {
    tags.push({ key: 'effort-wire-off', tone: 'muted', label: t('tag.effortWireOff'), title: t('tag.effortWireOffTitle') })
  }
  const published = effortNames(model.referenceReasoning)
  const sameLevels = (a, b) => a.length === b.length && a.every((level, index) => level === b[index])
  if (referenceLevels.length > 0 && !sameLadder && !sameLevels(referenceLevels, published)) {
    const ladderSource = model.fieldEvidence?.reasoningEfforts?.source || model.sources?.reasoningEfforts || reasoningSource
    tags.push({ key: 'reference-effort', tone: 'muted', inferred: true,
      label: t(model.reasoningCatalog || ladderSource === 'public' ? 'tag.effortPublicReference' : 'tag.effortReference') + ' ' + referenceLevels.join('/'),
      title: t('tag.effortReferenceTitle', { source: model.reasoningCatalog ?? sourceLabel(ladderSource, t) }) })
  }
  // A trusted directory can advertise a different ladder *alongside* the actual adapter ladder.
  if (published.length && !sameLevels(published, requestLevels)) {
    const fact = model.fieldEvidence?.referenceReasoning
    const raw = model.referenceReasoningSource
    const label = fact?.catalog || (raw && !['public', 'snapshot', 'catalog'].includes(raw) ? raw : sourceLabel(fact?.source || raw || 'snapshot', t))
    tags.push({ key: 'published-effort', tone: 'muted', inferred: true,
      label: t(fact?.source === 'public' || (typeof raw === 'string' && !['snapshot', 'manual'].includes(raw)) ? 'tag.effortPublicReference' : 'tag.effortReference') + ' ' + published.join('/'),
      title: t('tag.effortReferenceTitle', { source: label }) })
  }

  const contextSource = sourceOf(model, 'context')
  const context = formatContext(model.contextWindow)
  tags.push({
    key: 'context',
    tone: context === null ? 'muted' : 'neutral',
    label: t('tag.context') + ' ' + (context === null ? t('tag.unknown') : context),
    title:
      context === null
        ? errorTitle
        : t('tag.contextTitle', {
            tokens: Number(model.contextWindow).toLocaleString(),
            source: sourceLabel(contextSource, t),
          }),
    inferred: context !== null && isInferredSource(contextSource),
  })

  const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : null
  const modalitySource = sourceOf(model, 'modalities')
  if (modalities === null || modalities.length === 0) {
    tags.push({ key: 'modality', tone: 'muted', label: t('tag.modalityUnknown'), title: errorTitle })
  } else {
    const vision = modalities.includes('image')
    const textOnly = modalities.every((modality) => modality === 'text')
    tags.push({
      key: 'modality',
      tone: vision ? 'vision' : 'neutral',
      label: vision ? t('tag.multimodal') : textOnly ? t('tag.textOnly') : modalityNames(modalities, t),
      title: t('tag.modalityTitle', {
        modalities: modalityNames(modalities, t),
        source: sourceLabel(modalitySource, t),
      }),
      inferred: isInferredSource(modalitySource),
    })
  }

  // A vendor-documented correction is the one non-dashed value that is not
  // an adapter declaration; keep it visible so "why is this text-only?"
  // has an answer next to the tag.
  const correction = model.correction
  if (correction !== null && typeof correction === 'object' && typeof correction.code === 'string') {
    const noteKey = 'correction.' + correction.code
    const localized = t(noteKey)
    const note = localized === noteKey
      ? typeof correction.note === 'string' && correction.note !== ''
        ? correction.note
        : correction.code
      : localized
    tags.push({
      key: 'correction',
      tone: 'muted',
      label: t('tag.correction'),
      title: t('tag.correctionTitle', {
        note,
        source: typeof correction.source === 'string' && correction.source !== '' ? correction.source : '—',
      }),
    })
  }
  const manual = manualTag(model, t)
  if (manual !== null) tags.push(manual)
  return tags.map((tag) => {
    const field = { context: 'context', modality: 'modalities', 'reference-no-reasoning': 'reasoning',
      'reference-effort': model.fieldEvidence?.reasoningEfforts ? 'reasoningEfforts' : 'reasoning', 'published-effort': 'referenceReasoning' }[tag.key]
      || (tag.key === 'reasoning' && !requestLevels.length ? 'reasoning' : undefined)
    return field ? withEvidence(tag, model, field, t) : tag
  })
}

function tagClassOf(tag) {
  const tone =
    tag.tone === 'accent'
      ? ' mvp_tag--accent'
      : tag.tone === 'vision'
        ? ' mvp_tag--vision'
        : tag.tone === 'kind'
          ? ' mvp_tag--kind'
          : typeof tag.tone === 'string' && tag.tone.startsWith('kind-')
            ? ' mvp_tag--kind mvp_tag--' + tag.tone
            : tag.tone === 'muted'
              ? ' mvp_tag--muted'
              : ''
  return 'mvp_tag' + tone + (tag.inferred === true ? ' mvp_tag--inferred' : '')
}

export { capabilityTags, tagClassOf }
