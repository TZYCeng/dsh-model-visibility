window.__ModuleLoader__.load({
  id: 'dsh-model-visibility',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'model-visibility'
    /** Host entry id from cordis.patch.yml; also the settings namespace. */
    const ENTRY = 'model-visibility'
    /** Config field persisted by the Host settings document. */
    const FIELD = 'hidden'
    /** Settings section id. */
    const SECTION_ID = 'model-visibility'
    /**
     * Same-origin route the Host half registers through `connection.fetch`.
     * Resolved against the page base so a reverse-proxy prefix is preserved.
     */
    const API = (() => {
      try {
        return new URL('api/dsh-model-visibility', document.baseURI).pathname
      } catch (_error) {
        return '/api/dsh-model-visibility'
      }
    })()

    const DICT = {
      zh: {
        'nav': '模型显示',
        'page.title': '模型显示',
        'page.description':
          '关闭的模型不会出现在聊天输入框的模型下拉列表中；这里的改动立即生效，之后仍可随时重新打开。每个模型标注真实能力：适配器声明优先，其次读中转站的模型列表，再用内置目录补全；生图、生视频等生成类模型单独标记。',
        'page.summary': '已显示 {visible} / {total} 个模型',
        'page.hiddenSummary': '已关闭 {count} 个',
        'page.kindSummary': '{count} 个生图/生视频模型',
        'page.loading': '正在加载模型列表…',
        'page.empty': '暂无可用模型。',
        'page.filterEmpty': '当前筛选下没有模型。',
        'page.error': '模型列表加载失败：{message}',
        'page.saveFailed': '保存失败，请重试。',
        'page.refresh': '刷新',
        'page.showAll': '全部显示',
        'page.legend':
          '标签说明：推理 = 可调推理等级；上下文 = 输入窗口；多模态 = 可输入图像。实线标签来自适配器或中转站，虚线标签来自内置目录或模型名推断。生图 / 生视频 / 嵌入等模型只标类型，不显示思考强度与文本标签。',
        'page.metaFallback':
          '模型能力信息暂不可用：上下文与模态显示为未知，推理档位仍来自官方目录。',
        'page.providerFailures': '部分提供方暂时读不到模型：{names}',
        'page.probeSummary': '中转站探测：{ok} 个已读取模型列表，{caps} 个公布了能力字段',
        'page.probeSummaryNone': '中转站探测：暂无可读取的路由配置',
        'page.catalogNote': '内置目录：pi-ai {version} 快照（{date}），共 {models} 个模型',
        'page.filterLabel': '筛选',
        'page.filter.all': '全部',
        'page.filter.chat': '对话',
        'page.filter.image': '生图',
        'page.filter.video': '生视频',
        'page.filter.other': '其它',
        'group.showAll': '全组显示',
        'group.hideAll': '全组隐藏',
        'group.showFiltered': '显示筛选结果',
        'group.hideFiltered': '隐藏筛选结果',
        'group.capabilities': '{chat} 对话 · {image} 生图 · {video} 生视频 · {other} 其它',
        'group.probeOk': '中转站 {models} 个模型 · {caps} 个带能力字段',
        'group.probeNoCaps': '中转站 {models} 个模型 · 未公布能力字段',
        'group.probeFailed': '中转站读取失败',
        'group.probeSkipped': '未探测中转站',
        'tag.reasoning': '支持推理',
        'tag.noReasoning': '不支持推理',
        'tag.reasoningUnknown': '推理未知',
        'tag.effort': '思考强度',
        'tag.context': '上下文',
        'tag.unknown': '未知',
        'tag.multimodal': '多模态',
        'tag.textOnly': '纯文本',
        'tag.modalityUnknown': '模态未知',
        'tag.kind.image': '生图',
        'tag.kind.video': '生视频',
        'tag.kind.embedding': '嵌入',
        'tag.kind.rerank': '重排',
        'tag.kind.audio': '音频',
        'tag.kind.classifier': '审核',
        'tag.kind.translation': '翻译',
        'tag.kind.unknown': '模型',
        'tag.kindTitle': '模型类型：{kind}；类型来源：{source}',
        'tag.kindImageTitle': '图像生成模型（输出图像）；类型来源：{source}',
        'tag.kindVideoTitle': '视频生成模型（输出视频）；类型来源：{source}',
        'tag.resolution': '分辨率',
        'tag.resolutionTitle': '模型名标注了 {value} 输出档位',
        'tag.imageInput': '可改图',
        'tag.imageInputTitle': '支持图像输入（图生图 / 参考图）',
        'tag.reasoningTitle': '支持推理，可用档位：{levels}（来源：{source}）',
        'tag.reasoningCatalogTitle': '支持推理；适配器未公布档位，此结论来自{source}',
        'tag.effortTitle': '可用档位：{levels}；默认：{fallback}（来源：{source}）',
        'tag.effortTitleNoFallback': '可用档位：{levels}（来源：{source}）',
        'tag.contextTitle': '上下文窗口 {tokens} tokens；来源：{source}',
        'tag.modalityTitle': '输入模态：{modalities}；来源：{source}',
        'tag.outputTitle': '输出模态：{modalities}；来源：{source}',
        'tag.unknownTitle': '适配器与中转站都没有公布这项信息',
        'tag.infoErrorTitle': '模型能力读取失败：{message}',
        'source.config': '适配器配置',
        'source.adapter': '适配器',
        'source.provider': '中转站模型列表',
        'source.catalog': '内置模型目录',
        'source.inferred': '模型名推断',
        'source.unknown': '未知',
        'modality.text': '文本',
        'modality.image': '图像',
        'modality.audio': '音频',
        'modality.video': '视频',
        'modality.file': '文件',
        'provider.account': 'DeepSeek 账号',
      },
      en: {
        'nav': 'Model visibility',
        'page.title': 'Model visibility',
        'page.description':
          'Models turned off here disappear from the chat composer model list. Changes apply immediately and can be turned back on at any time. Every model shows its real capabilities: adapter declarations first, then the relay model list, then a built-in catalog; image, video and other generation models are labelled separately.',
        'page.summary': 'Showing {visible} of {total} models',
        'page.hiddenSummary': '{count} hidden',
        'page.kindSummary': '{count} image/video models',
        'page.loading': 'Loading model list…',
        'page.empty': 'No models available.',
        'page.filterEmpty': 'No models match this filter.',
        'page.error': 'Could not load the model list: {message}',
        'page.saveFailed': 'Could not save this change. Try again.',
        'page.refresh': 'Refresh',
        'page.showAll': 'Show all',
        'page.legend':
          'Tags: Reasoning = adjustable levels; Context = input window; Multimodal = accepts images. Solid tags come from the adapter or the relay; dashed tags come from the built-in catalog or the model name. Image, video, embedding and other generation models show only their kind, never effort or text tags.',
        'page.metaFallback':
          'Model capability details are unavailable right now: context and modalities show as unknown, while effort levels still come from the shipped catalog.',
        'page.providerFailures': 'Some providers could not be read: {names}',
        'page.probeSummary': 'Relay probe: {ok} model lists read, {caps} published capability fields',
        'page.probeSummaryNone': 'Relay probe: no readable route configuration',
        'page.catalogNote': 'Built-in catalog: pi-ai {version} snapshot ({date}), {models} models',
        'page.filterLabel': 'Filter',
        'page.filter.all': 'All',
        'page.filter.chat': 'Chat',
        'page.filter.image': 'Image',
        'page.filter.video': 'Video',
        'page.filter.other': 'Other',
        'group.showAll': 'Show all',
        'group.hideAll': 'Hide all',
        'group.showFiltered': 'Show filtered',
        'group.hideFiltered': 'Hide filtered',
        'group.capabilities': '{chat} chat · {image} image · {video} video · {other} other',
        'group.probeOk': 'relay: {models} models · {caps} with capability fields',
        'group.probeNoCaps': 'relay: {models} models · no capability fields',
        'group.probeFailed': 'relay read failed',
        'group.probeSkipped': 'relay not probed',
        'tag.reasoning': 'Reasoning',
        'tag.noReasoning': 'No reasoning',
        'tag.reasoningUnknown': 'Reasoning unknown',
        'tag.effort': 'Effort',
        'tag.context': 'Context',
        'tag.unknown': 'unknown',
        'tag.multimodal': 'Multimodal',
        'tag.textOnly': 'Text only',
        'tag.modalityUnknown': 'Modality unknown',
        'tag.kind.image': 'Image',
        'tag.kind.video': 'Video',
        'tag.kind.embedding': 'Embedding',
        'tag.kind.rerank': 'Rerank',
        'tag.kind.audio': 'Audio',
        'tag.kind.classifier': 'Moderation',
        'tag.kind.translation': 'Translation',
        'tag.kind.unknown': 'Model',
        'tag.kindTitle': 'Model kind: {kind}; kind source: {source}',
        'tag.kindImageTitle': 'Image generation model (outputs images); kind source: {source}',
        'tag.kindVideoTitle': 'Video generation model (outputs video); kind source: {source}',
        'tag.resolution': 'Resolution',
        'tag.resolutionTitle': 'The model name advertises a {value} output tier',
        'tag.imageInput': 'Image edit',
        'tag.imageInputTitle': 'Accepts image input (image-to-image / reference images)',
        'tag.reasoningTitle': 'Reasoning supported; levels: {levels} (source: {source})',
        'tag.reasoningCatalogTitle': 'Reasoning supported; the adapter publishes no levels, so this comes from {source}',
        'tag.effortTitle': 'Available levels: {levels}; default: {fallback} (source: {source})',
        'tag.effortTitleNoFallback': 'Available levels: {levels} (source: {source})',
        'tag.contextTitle': 'Context window {tokens} tokens; source: {source}',
        'tag.modalityTitle': 'Input modalities: {modalities}; source: {source}',
        'tag.outputTitle': 'Output modalities: {modalities}; source: {source}',
        'tag.unknownTitle': 'Neither the adapter nor the relay publishes this fact',
        'tag.infoErrorTitle': 'Could not read model capabilities: {message}',
        'source.config': 'adapter configuration',
        'source.adapter': 'adapter',
        'source.provider': 'relay model list',
        'source.catalog': 'built-in model catalog',
        'source.inferred': 'model name inference',
        'source.unknown': 'unknown',
        'modality.text': 'text',
        'modality.image': 'image',
        'modality.audio': 'audio',
        'modality.video': 'video',
        'modality.file': 'file',
        'provider.account': 'DeepSeek Account',
      },
    }

    const CSS = `
.mvp_page{box-sizing:border-box;width:100%;height:100%;min-height:0;flex-direction:column;display:flex;overflow-y:auto;padding-bottom:24px}
.mvp_head{flex:none;flex-direction:column;gap:6px;padding:4px 0 14px;display:flex}
.mvp_title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:500;line-height:24px}
.mvp_desc{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:18px}
.mvp_toolbar{border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;display:flex}
.mvp_summary{color:var(--dsw-alias-label-secondary);flex:1;min-width:0;font-size:12px;line-height:18px}
.mvp_actions{flex:none;align-items:center;gap:8px;display:flex}
.mvp_button{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 10px;font-family:inherit;font-size:12px;line-height:18px}
.mvp_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mvp_group{flex:none;flex-direction:column;display:flex}
.mvp_groupHead{justify-content:space-between;align-items:center;gap:12px;padding:14px 0 6px;display:flex}
.mvp_groupTitle{color:var(--dsw-alias-label-primary);align-items:baseline;row-gap:2px;gap:8px;font-size:14px;font-weight:500;line-height:22px;display:flex;flex-wrap:wrap}
.mvp_groupCount{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.mvp_row{border-bottom:.5px solid var(--dsw-alias-border-l1);justify-content:space-between;align-items:center;gap:16px;padding:10px 0;display:flex}
.mvp_row--gen{background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 4%, transparent)}
.mvp_rowText{flex-direction:column;gap:2px;min-width:0;display:flex}
.mvp_rowTitle{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.mvp_rowMeta{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;overflow:hidden}
.mvp_error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;padding:6px 0}
.mvp_switch{position:relative;flex:none;box-sizing:border-box;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background-color .15s ease}
.mvp_switch[aria-checked="true"]{background:var(--dsw-alias-bg-base)}
.mvp_switch:disabled{opacity:.45;cursor:default}
.mvp_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mvp_thumb{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .15s ease,background-color .15s ease}
.mvp_switch[aria-checked="true"] .mvp_thumb{background:var(--dsw-alias-label-primary);transform:translateX(16px)}
.mvp_tags{flex-wrap:wrap;align-items:center;gap:4px;margin-top:4px;display:flex}
.mvp_tag{box-sizing:border-box;max-width:100%;height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:4px;align-items:center;padding:0 6px;font-size:11px;line-height:16px;display:inline-flex;overflow:hidden;text-overflow:ellipsis}
.mvp_tag--accent{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent)}
.mvp_tag--vision{color:var(--dsw-alias-state-business-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 45%, transparent)}
.mvp_tag--kind{color:var(--dsw-alias-brand-primary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);font-weight:500}
.mvp_tag--inferred{border-style:dashed}
.mvp_tag--muted{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l1)}
.mvp_groupCap{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:16px}
.mvp_groupProbe{color:var(--dsw-alias-label-tertiary);border:.5px dashed var(--dsw-alias-border-l2);border-radius:4px;max-width:100%;white-space:nowrap;text-overflow:ellipsis;padding:0 5px;font-size:10px;line-height:15px;overflow:hidden}
.mvp_filters{align-items:center;gap:6px;padding:8px 0 2px;display:flex;flex-wrap:wrap}
.mvp_filterLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.mvp_filter{box-sizing:border-box;height:24px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 9px;font-family:inherit;font-size:11px;line-height:18px}
.mvp_filter:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_filter[aria-pressed="true"]{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);background:transparent;background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.mvp_filter:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_note{color:var(--dsw-alias-label-tertiary);flex:none;padding:6px 0 0;font-size:10px;line-height:15px}
.mvp_legend{color:var(--dsw-alias-label-tertiary);flex:none;padding:8px 0 2px;font-size:11px;line-height:16px}
.mvp_fallback{color:var(--dsw-alias-label-secondary);background:transparent;background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent);border-radius:var(--dsw-radius-sm,6px);padding:6px 8px;font-size:11px;line-height:16px;margin-top:8px}
`

    /* ---------------------------------------------------------------- data */

    /** Opaque key; never parsed back, so ids containing "/" stay unambiguous. */
    function keyOf(provider, model) {
      return provider + '/' + model
    }

    function hiddenSetOf(snapshot) {
      const value = snapshot && snapshot.value
      const list = value && Array.isArray(value[FIELD]) ? value[FIELD] : []
      return new Set(list)
    }

    function providerLabel(group, t) {
      return group.id === 'deepseek-account' ? t('provider.account') : group.name
    }

    function countModels(groups) {
      let total = 0
      for (const group of groups || []) total += (group.models || []).length
      return total
    }

    /** Human context size: 1048576 → "1M", 128000 → "128K". */
    function formatContext(tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return null
      if (tokens >= 1_000_000) return Math.round(tokens / 100_000) / 10 + 'M'
      if (tokens >= 1_000) return Math.round(tokens / 100) / 10 + 'K'
      return String(tokens)
    }

    /** Effort display names in catalog order. */
    function effortNames(reasoning) {
      const efforts = reasoning && Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const names = []
      for (const effort of efforts) {
        if (effort === null || typeof effort !== 'object') continue
        const label = effort.name || effort.id
        if (typeof label === 'string' && label !== '') names.push(label)
      }
      return names
    }

    /** Display name of the default effort, or null when none is published. */
    function defaultEffortName(reasoning) {
      if (!reasoning || typeof reasoning.defaultEffort !== 'string') return null
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const found = efforts.find((effort) => effort !== null && effort.id === reasoning.defaultEffort)
      return found && typeof found.name === 'string' && found.name !== ''
        ? found.name
        : reasoning.defaultEffort
    }

    /** Localized name of one input modality. */
    function modalityLabel(id, t) {
      const key = 'modality.' + id
      const label = t(key)
      return label === key ? id : label
    }

    /** Localized provenance label ("adapter", "relay model list", …). */
    function sourceLabel(source, t) {
      const key = 'source.' + (source || 'unknown')
      const label = t(key)
      return label === key ? t('source.unknown') : label
    }

    /** Per-field provenance recorded by the Host. */
    function sourceOf(model, field) {
      const sources = model && model.sources
      return sources && typeof sources[field] === 'string' ? sources[field] : 'unknown'
    }

    /** Catalog and name heuristics are completed values, not declarations. */
    function isInferredSource(source) {
      return source === 'catalog' || source === 'inferred'
    }

    /** Kind with a safe fallback for records from an older Host. */
    function kindOf(model) {
      return model && typeof model.kind === 'string' && model.kind !== '' ? model.kind : 'chat'
    }

    /** Filter bucket: chat / image / video / other. */
    function bucketOf(kind) {
      if (kind === 'image') return 'image'
      if (kind === 'video') return 'video'
      if (kind === 'chat') return 'chat'
      return 'other'
    }

    function isGenerationKind(kind) {
      return kind === 'image' || kind === 'video' || kind === 'audio'
    }

    /** Resolution tier advertised in the model id ("-4k", "2K"). */
    function resolutionOf(model) {
      const text = String((model && model.id) || '')
      const match = /(?:^|[-_/])(4k|2k|8k|uhd|hd)(?:$|[-_/])/i.exec(text)
      return match === null ? null : match[1].toUpperCase()
    }

    /** "文本 / 图像" for one modality array. */
    function modalityNames(modalities, t) {
      return (Array.isArray(modalities) ? modalities : []).map((id) => modalityLabel(id, t)).join(' / ')
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
          tone: 'kind',
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
      return tags
    }

    function subscribeOf(source) {
      return (fn) => source.subscribe(fn)
    }

    function snapshotOf(source) {
      return () => source.getSnapshot()
    }

    function useSource(source) {
      const subscribe = React.useCallback(subscribeOf(source), [source])
      const getSnapshot = React.useCallback(snapshotOf(source), [source])
      return React.useSyncExternalStore(subscribe, getSnapshot)
    }

    function useHidden(form) {
      const snapshot = useSource(form)
      const hidden = React.useMemo(() => hiddenSetOf(snapshot), [snapshot])
      return { hidden, snapshot }
    }

    /** Host-generation catalog, shared by the settings page. */
    function createCatalog(ctx) {
      const listeners = new Set()
      let state = {
        status: 'idle',
        groups: [],
        failures: [],
        providers: [],
        catalog: null,
        error: null,
        detailsError: null,
        source: null,
        generatedAt: 0,
      }
      let inflight = null

      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }

      /** Message of a failed Remote envelope. */
      const failureMessage = (response) => {
        const failure = response && response.error
        return failure
          ? String(failure.code) + ': ' + String(failure.message)
          : 'unknown error'
      }

      /**
       * Read the enriched catalog from the Host half. It carries the same
       * groups as `session.modelCatalog` plus context windows and modalities.
       */
      const fetchHostCatalog = async (fresh) => {
        const response = await fetch(API + '/models' + (fresh ? '?fresh=1' : ''), {
          method: 'GET',
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'error',
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        const body = await response.json()
        const value = body && body.ok === true ? body.value : null
        if (value === null || !Array.isArray(value.groups)) {
          throw new Error('malformed capability catalog')
        }
        return value
      }

      /** Read the shipped catalog; the fallback when the route is unavailable. */
      const fetchOfficialCatalog = async () => {
        const response = await ctx.remote.session.modelCatalog()
        if (!response || response.ok !== true) throw new Error(failureMessage(response))
        const value = response.value || {}
        return {
          groups: Array.isArray(value.groups) ? value.groups : [],
          failures: Array.isArray(value.failures) ? value.failures : [],
          generatedAt: 0,
        }
      }

      const load = (options) => {
        if (inflight !== null) return inflight
        if (state.status !== 'ready') {
          publish({ ...state, status: 'loading', error: null })
        }
        const fresh = options !== null && typeof options === 'object' && options.fresh === true
        inflight = (async () => {
          try {
            const value = await fetchHostCatalog(fresh)
            publish({
              status: 'ready',
              groups: Array.isArray(value.groups) ? value.groups : [],
              failures: Array.isArray(value.failures) ? value.failures : [],
              providers: Array.isArray(value.providers) ? value.providers : [],
              catalog: value.catalog && typeof value.catalog === 'object' ? value.catalog : null,
              error: null,
              detailsError: null,
              source: 'host',
              generatedAt: Number.isFinite(value.generatedAt) ? value.generatedAt : 0,
            })
            return
          } catch (detailError) {
            const detail = String(detailError && detailError.message ? detailError.message : detailError)
            try {
              const value = await fetchOfficialCatalog()
              publish({
                status: 'ready',
                groups: value.groups,
                failures: value.failures,
                providers: [],
                catalog: null,
                error: null,
                detailsError: detail,
                source: 'catalog',
                generatedAt: value.generatedAt,
              })
            } catch (error) {
              publish({
                ...state,
                status: 'error',
                error: String(error && error.message ? error.message : error),
              })
            }
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      return {
        subscribe(fn) {
          listeners.add(fn)
          return () => {
            listeners.delete(fn)
          }
        },
        getSnapshot() {
          return state
        },
        load,
        refresh() {
          return load({ fresh: true })
        },
      }
    }

    /* ------------------------------------------------------ composer filter */

    /** Hidden model keys as the plain array the Host stores. */
    function hiddenListOf(snapshot) {
      const value = snapshot && snapshot.value
      return value && Array.isArray(value[FIELD]) ? value[FIELD] : []
    }

    /**
     * Rewrite one directory store in place so its snapshots omit hidden models.
     *
     * The shipped composer seat may capture the directory store before this plugin
     * applies, so replacing the store object would never reach it; rewriting
     * getSnapshot/subscribe on the captured object does. The session's active
     * model stays listed even while hidden, because the shipped trigger
     * resolves its label from this same catalog.
     */
    function patchDirectoryStore(store, form) {
      const readBase = store.getSnapshot.bind(store)
      const subscribeBase = store.subscribe.bind(store)
      const originalGet = store.getSnapshot
      const originalSubscribe = store.subscribe
      const listeners = new Set()
      let snapshot = null
      let lastBase
      let lastSignature

      const build = (baseSnapshot) => {
        const hidden = new Set(hiddenListOf(form.getSnapshot()))
        const activeSelection = baseSnapshot.current
        const groups = []
        for (const group of baseSnapshot.groups || []) {
          const all = group.models || []
          const models = []
          for (const model of all) {
            const key = keyOf(group.id, model.id)
            const active =
              activeSelection !== null &&
              activeSelection !== undefined &&
              activeSelection.provider === group.id &&
              activeSelection.model === model.id
            if (!hidden.has(key) || active) models.push(model)
          }
          if (models.length === 0) continue
          groups.push(models.length === all.length ? group : { ...group, models })
        }
        return { ...baseSnapshot, groups }
      }

      const current = () => {
        const baseSnapshot = readBase()
        const signature = hiddenListOf(form.getSnapshot()).join('\u0000')
        if (snapshot !== null && baseSnapshot === lastBase && signature === lastSignature) {
          return snapshot
        }
        lastBase = baseSnapshot
        lastSignature = signature
        snapshot = build(baseSnapshot)
        return snapshot
      }

      const emit = () => {
        const previous = snapshot
        const next = current()
        if (previous === next) return
        for (const listener of Array.from(listeners)) listener()
      }

      Object.defineProperties(store, {
        __modelVisibilityPatched: { value: true, configurable: true },
        getSnapshot: { value: current, configurable: true, writable: true },
        subscribe: {
          value(listener) {
            listeners.add(listener)
            const stop = subscribeBase(listener)
            return () => {
              listeners.delete(listener)
              stop()
            }
          },
          configurable: true,
          writable: true,
        },
      })

      return {
        emit,
        restore() {
          Object.defineProperties(store, {
            getSnapshot: { value: originalGet, configurable: true, writable: true },
            subscribe: { value: originalSubscribe, configurable: true, writable: true },
          })
          delete store.__modelVisibilityPatched
          listeners.clear()
        },
      }
    }

    /**
     * Patch every model directory — the ones already live when the plugin
     * applies and every directory resolved later — so the shipped seat keeps
     * owning the trigger, the Model / Effort rows, and third-party menu
     * enhancements such as the reasoning-effort slider.
     */
    function installComposerFilter(scope, form) {
      const models = scope.modelDirectories
      const original = models.directoryFor
      if (typeof original !== 'function') return
      const records = new Set()

      const ensure = (directory) => {
        if (directory === undefined || directory === null) return directory
        const store = directory.store
        if (store === undefined || store === null || store.__modelVisibilityPatched === true) {
          return directory
        }
        try {
          records.add(patchDirectoryStore(store, form))
        } catch (_error) {
          // Fail open: an unwritable store simply keeps showing every model.
        }
        return directory
      }

      scope.effect(() => {
        const live = models.live && models.live.directories ? models.live.directories.values : null
        if (live instanceof Set) for (const directory of live) ensure(directory)

        const stopForm = form.subscribe(() => {
          for (const record of records) record.emit()
        })

        const wrapper = function directoryFor(sessionId) {
          return ensure(original.call(this, sessionId))
        }
        Object.defineProperty(models, 'directoryFor', {
          value: wrapper,
          configurable: true,
          writable: true,
        })

        return () => {
          stopForm()
          for (const record of records) record.restore()
          records.clear()
          if (Object.getOwnPropertyDescriptor(models, 'directoryFor')?.value === wrapper) {
            delete models.directoryFor
          }
        }
      }, 'model-visibility: filtered model directory')
    }

    /* ----------------------------------------------------- settings page */

    /** Count models per filter bucket for one group. */
    function countKinds(models) {
      const counts = { chat: 0, image: 0, video: 0, other: 0 }
      for (const model of models || []) counts[bucketOf(kindOf(model))] += 1
      return counts
    }

    /** Compact label + tooltip for one provider probe diagnostic. */
    function probeOf(state, group, t) {
      const list = Array.isArray(state.providers) ? state.providers : []
      const diagnostic = list.find((item) => item && item.id === group.id)
      if (diagnostic === undefined) return null
      const details = [
        diagnostic.host ? 'host: ' + diagnostic.host : null,
        diagnostic.status ? 'status: ' + diagnostic.status : null,
        diagnostic.message ? 'message: ' + diagnostic.message : null,
        diagnostic.pricing && diagnostic.pricing !== 'skipped' ? 'pricing: ' + diagnostic.pricing : null,
      ]
        .filter(Boolean)
        .join('\n')
      if (diagnostic.status === 'ok') {
        return {
          label:
            Number(diagnostic.capabilities) > 0
              ? t('group.probeOk', {
                  models: diagnostic.models ?? 0,
                  caps: diagnostic.capabilities,
                })
              : t('group.probeNoCaps', { models: diagnostic.models ?? 0 }),
          title: details,
        }
      }
      if (diagnostic.status === 'failed' || diagnostic.status === 'unauthorized') {
        return { label: t('group.probeFailed'), title: details }
      }
      return { label: t('group.probeSkipped'), title: details }
    }

    /** Class list for one capability tag. */
    function tagClassOf(tag) {
      const tone =
        tag.tone === 'accent'
          ? ' mvp_tag--accent'
          : tag.tone === 'vision'
            ? ' mvp_tag--vision'
            : tag.tone === 'kind'
              ? ' mvp_tag--kind'
              : tag.tone === 'muted'
                ? ' mvp_tag--muted'
                : ''
      return 'mvp_tag' + tone + (tag.inferred === true ? ' mvp_tag--inferred' : '')
    }

    function makeSection(form, catalog) {
      return function ModelVisibilitySection({ t }) {
        const { hidden, snapshot } = useHidden(form)
        const state = useSource(catalog)
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState(null)

        React.useEffect(() => {
          catalog.load()
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        const writable = snapshot.writable !== false
        const groups = state.groups
        const total = countModels(groups)
        const hiddenCount = groups.reduce(
          (count, group) =>
            count +
            (group.models || []).filter((model) => hidden.has(keyOf(group.id, model.id))).length,
          0,
        )
        const allKinds = countKinds(groups.flatMap((group) => group.models || []))
        const generationCount = allKinds.image + allKinds.video
        const [filter, setFilter] = React.useState('all')
        const filteredGroups = []
        for (const group of groups) {
          const models = (group.models || []).filter(
            (model) => filter === 'all' || bucketOf(kindOf(model)) === filter,
          )
          if (models.length > 0) filteredGroups.push({ ...group, models })
        }
        const disabled = busy || !writable

        const commit = (next) => {
          if (disabled) return
          setBusy(true)
          setError(null)
          Promise.resolve(form.set(FIELD, Array.from(next))).then(
            (accepted) => {
              if (accepted === false) setError(t('page.saveFailed'))
            },
            () => {
              setError(t('page.saveFailed'))
            },
          ).finally(() => {
            setBusy(false)
          })
        }

        const toggleModel = (group, model) => {
          const next = new Set(hidden)
          const key = keyOf(group.id, model.id)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          commit(next)
        }

        const setGroup = (group, subset, visible) => {
          const next = new Set(hidden)
          for (const model of subset) {
            const key = keyOf(group.id, model.id)
            if (visible) next.delete(key)
            else next.add(key)
          }
          commit(next)
        }

        const rows = []
        for (const group of filteredGroups) {
          const allGroupModels =
            (groups.find((candidate) => candidate.id === group.id) || group).models || []
          const models = group.models || []
          const shown = allGroupModels.filter(
            (model) => !hidden.has(keyOf(group.id, model.id)),
          ).length
          const allShown = models.every((model) => !hidden.has(keyOf(group.id, model.id)))
          const kinds = countKinds(allGroupModels)
          const kindParts = []
          if (kinds.chat > 0) kindParts.push(t('page.filter.chat') + ' ' + kinds.chat)
          if (kinds.image > 0) kindParts.push(t('page.filter.image') + ' ' + kinds.image)
          if (kinds.video > 0) kindParts.push(t('page.filter.video') + ' ' + kinds.video)
          if (kinds.other > 0) kindParts.push(t('page.filter.other') + ' ' + kinds.other)
          const probe = probeOf(state, group, t)
          rows.push(
            h(
              'div',
              { key: group.id, className: 'mvp_group' },
              h(
                'div',
                { className: 'mvp_groupHead' },
                h(
                  'div',
                  { className: 'mvp_groupTitle' },
                  h('span', null, providerLabel(group, t)),
                  h('span', { className: 'mvp_groupCount' }, shown + '/' + allGroupModels.length),
                  kindParts.length > 0
                    ? h('span', { className: 'mvp_groupCap' }, kindParts.join(' · '))
                    : null,
                  probe !== null
                    ? h('span', { className: 'mvp_groupProbe', title: probe.title || undefined }, probe.label)
                    : null,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mvp_button',
                    disabled: disabled,
                    onClick: () => setGroup(group, models, !allShown),
                  },
                  allShown
                    ? filter === 'all'
                      ? t('group.hideAll')
                      : t('group.hideFiltered')
                    : filter === 'all'
                      ? t('group.showAll')
                      : t('group.showFiltered'),
                ),
              ),
              models.map((model) => {
                const shownModel = !hidden.has(keyOf(group.id, model.id))
                const tags = capabilityTags(model, t)
                const generation = isGenerationKind(kindOf(model))
                return h(
                  'div',
                  {
                    key: model.id,
                    className: 'mvp_row' + (generation ? ' mvp_row--gen' : ''),
                  },
                  h(
                    'div',
                    { className: 'mvp_rowText' },
                    h('div', { className: 'mvp_rowTitle' }, model.name),
                    model.id === model.name
                      ? null
                      : h('div', { className: 'mvp_rowMeta' }, model.id),
                    h(
                      'div',
                      { className: 'mvp_tags' },
                      tags.map((tag) =>
                        h(
                          'span',
                          {
                            key: tag.key,
                            className: tagClassOf(tag),
                            title: tag.title || undefined,
                          },
                          tag.label,
                        ),
                      ),
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'switch',
                      className: 'mvp_switch',
                      'aria-checked': shownModel,
                      'aria-label': model.name,
                      disabled: disabled,
                      onClick: () => toggleModel(group, model),
                    },
                    h('span', { className: 'mvp_thumb' }),
                  ),
                )
              }),
            ),
          )
        }

        const loading = state.status === 'loading' || state.status === 'idle'
        const providerList = Array.isArray(state.providers) ? state.providers : []
        const probeOk = providerList.filter((provider) => provider && provider.status === 'ok').length
        const probeCaps = providerList.reduce(
          (count, provider) => count + (Number(provider && provider.capabilities) || 0),
          0,
        )
        const probeNote =
          state.source === 'host'
            ? providerList.length > 0
              ? t('page.probeSummary', { ok: probeOk, caps: probeCaps })
              : t('page.probeSummaryNone')
            : null
        const catalogMeta = state.catalog && typeof state.catalog === 'object' ? state.catalog : null
        const catalogDate =
          catalogMeta && typeof catalogMeta.generatedAt === 'string'
            ? catalogMeta.generatedAt.slice(0, 10)
            : null
        const catalogNote =
          catalogMeta !== null
            ? t('page.catalogNote', {
                version: catalogMeta.piAiVersion || '?',
                date: catalogDate || '?',
                models: catalogMeta.models ?? 0,
              })
            : null
        const filterOptions = [
          ['all', t('page.filter.all'), total],
          ['chat', t('page.filter.chat'), allKinds.chat],
          ['image', t('page.filter.image'), allKinds.image],
          ['video', t('page.filter.video'), allKinds.video],
          ['other', t('page.filter.other'), allKinds.other],
        ]

        return h(
          'div',
          { className: 'mvp_page' },
          h(
            'div',
            { className: 'mvp_head' },
            h('h2', { className: 'mvp_title' }, t('page.title')),
            h('p', { className: 'mvp_desc' }, t('page.description')),
          ),
          h(
            'div',
            { className: 'mvp_toolbar' },
            h(
              'div',
              { className: 'mvp_summary' },
              total === 0
                ? loading
                  ? t('page.loading')
                  : t('page.empty')
                : t('page.summary', { visible: total - hiddenCount, total }) +
                  (hiddenCount > 0 ? ' · ' + t('page.hiddenSummary', { count: hiddenCount }) : '') +
                  (generationCount > 0 ? ' · ' + t('page.kindSummary', { count: generationCount }) : ''),
            ),
            h(
              'div',
              { className: 'mvp_actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button',
                  disabled: disabled || hiddenCount === 0,
                  onClick: () => commit(new Set()),
                },
                t('page.showAll'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'mvp_button',
                  disabled: busy,
                  onClick: () => catalog.refresh(),
                },
                t('page.refresh'),
              ),
            ),
          ),
          h(
            'div',
            { className: 'mvp_filters' },
            h('span', { className: 'mvp_filterLabel' }, t('page.filterLabel')),
            filterOptions.map(([value, label, count]) =>
              h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'mvp_filter',
                  'aria-pressed': filter === value,
                  onClick: () => setFilter(value),
                },
                label + ' ' + count,
              ),
            ),
          ),
          h('div', { className: 'mvp_legend' }, t('page.legend')),
          state.detailsError !== null && state.source === 'catalog'
            ? h('div', { className: 'mvp_fallback' }, t('page.metaFallback'))
            : null,
          state.failures.length > 0
            ? h(
                'div',
                {
                  className: 'mvp_fallback',
                  title: state.failures
                    .map((failure) => (failure.name || failure.id) + ': ' + failure.message)
                    .join('\n'),
                },
                t('page.providerFailures', {
                  names: state.failures
                    .map((failure) => failure.name || failure.id)
                    .join(' · '),
                }),
              )
            : null,
          error !== null ? h('div', { className: 'mvp_error', role: 'alert' }, error) : null,
          state.error !== null
            ? h('div', { className: 'mvp_error', role: 'alert' }, t('page.error', { message: state.error }))
            : null,
          rows.length > 0 ? rows : null,
          total > 0 && filter !== 'all' && rows.length === 0
            ? h('div', { className: 'mvp_note' }, t('page.filterEmpty'))
            : null,
          rows.length === 0 && !loading && state.error === null && total === 0
            ? h('div', { className: 'mvp_error' }, t('page.empty'))
            : null,
          probeNote !== null ? h('div', { className: 'mvp_note' }, probeNote) : null,
          catalogNote !== null ? h('div', { className: 'mvp_note' }, catalogNote) : null,
        )
      }
    }

    /* --------------------------------------------------------------- plugin */

    const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICT), 'model-visibility: dictionaries')

      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-model-visibility'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'model-visibility: styles')

      const form = ctx.configForms.get(ENTRY)
      const catalog = createCatalog(ctx)

      ctx.effect(() => {
        const disposers = []
        disposers.push(
          ctx.on('connection/reset', () => {
            catalog.refresh()
          }),
        )
        if (ctx.remote !== undefined && typeof ctx.remote.$on === 'function') {
          // A route change can alter capabilities (an adapter may report a new
          // effort ladder), so that read bypasses the Host-side cache.
          disposers.push(
            ctx.remote.$on('llm/adapters-updated', () => {
              catalog.refresh()
            }),
          )
          // Settings and credential writes can also change what the registry
          // knows, but hiding a model writes settings too — a normal read lets
          // the Host cache absorb that write instead of re-probing every model.
          for (const event of [
            'settings/document-updated',
            'credentials/record-updated',
            'credentials/reference-updated',
          ]) {
            disposers.push(
              ctx.remote.$on(event, () => {
                catalog.load()
              }),
            )
          }
        }
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch (_error) {
              // A source may already be gone during teardown.
            }
          }
        }
      }, 'model-visibility: catalog refresh')

      const Section = makeSection(form, catalog)
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: SECTION_ID,
                order: 12,
                locale: NS,
                label: () => ctx.locale.bind(NS)('nav'),
              },
              Section,
            ),
          ),
        'model-visibility: settings section',
      )

      ctx.inject(['modelDirectories'], (scope) => {
        installComposerFilter(scope, form)
      })
    }

    return { inject, apply }
  },
})
