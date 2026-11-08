import { kindOf, sourceOf, isInferredSource, formatContext, effortNames, defaultEffortName, modalityNames, modalityLabel, resolutionOf, manualFieldsOf } from './format.mjs'

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
  return tags
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
  const levels = effortNames(reasoning)
  const reasoningSource = sourceOf(model, 'reasoning')
  const errorTitle =
    typeof model.infoError === 'string' && model.infoError !== ''
      ? t('tag.infoErrorTitle', { message: model.infoError })
      : t('tag.unknownTitle')

  if (levels.length > 0) {
    tags.push({
      key: 'reasoning',
      tone: 'accent',
      label: t('tag.reasoning'),
      title: t('tag.reasoningTitle', {
        levels: levels.join(' / '),
        source: sourceLabel(reasoningSource, t),
      }),
    })
    const fallback = defaultEffortName(reasoning)
    tags.push({
      key: 'effort',
      tone: 'neutral',
      label: t('tag.effort') + ' ' + levels.join('/'),
      title:
        fallback === null
          ? t('tag.effortTitleNoFallback', {
              levels: levels.join(' / '),
              source: sourceLabel(reasoningSource, t),
            })
          : t('tag.effortTitle', {
              levels: levels.join(' / '),
              fallback,
              source: sourceLabel(reasoningSource, t),
            }),
    })
  } else if (model.reasoningSupported === true) {
    tags.push({
      key: 'reasoning',
      tone: 'accent',
      label: t('tag.reasoning'),
      title: t('tag.reasoningCatalogTitle', { source: sourceLabel(reasoningSource, t) }),
      inferred: isInferredSource(reasoningSource),
    })
  } else if (model.reasoningSupported === false) {
    tags.push({
      key: 'reasoning',
      tone: 'muted',
      label: t('tag.noReasoning'),
      title: sourceLabel(reasoningSource, t),
      inferred: isInferredSource(reasoningSource),
    })
  } else {
    tags.push({ key: 'reasoning', tone: 'muted', label: t('tag.reasoningUnknown'), title: errorTitle })
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
    tags.push({
      key: 'modality',
      tone: vision ? 'vision' : 'neutral',
      label: vision ? t('tag.multimodal') : t('tag.textOnly'),
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
  return tags
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
