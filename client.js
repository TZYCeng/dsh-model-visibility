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
          '关闭的模型不会出现在聊天输入框的模型下拉列表中；这里的改动立即生效，之后仍可随时重新打开。每个模型还单独标注推理支持、思考强度、上下文窗口与多模态能力。',
        'page.summary': '已显示 {visible} / {total} 个模型',
        'page.hiddenSummary': '已关闭 {count} 个',
        'page.loading': '正在加载模型列表…',
        'page.empty': '暂无可用模型。',
        'page.error': '模型列表加载失败：{message}',
        'page.saveFailed': '保存失败，请重试。',
        'page.refresh': '刷新',
        'page.showAll': '全部显示',
        'page.legend':
          '标签说明：推理 = 可调推理等级；思考强度 = 额度档位；上下文 = 输入窗口；多模态 = 可输入图像。悬停标签可看详情。',
        'page.metaFallback':
          '模型能力信息暂不可用：上下文与模态显示为未知，推理档位仍来自官方目录。',
        'page.providerFailures': '部分提供方暂时读不到模型：{names}',
        'group.showAll': '全组显示',
        'group.hideAll': '全组隐藏',
        'group.capabilities': '{reasoning} 支持推理 · {multimodal} 多模态',
        'tag.reasoning': '支持推理',
        'tag.noReasoning': '不支持推理',
        'tag.reasoningUnknown': '推理未知',
        'tag.effort': '思考强度',
        'tag.context': '上下文',
        'tag.unknown': '未知',
        'tag.multimodal': '多模态',
        'tag.textOnly': '纯文本',
        'tag.modalityUnknown': '模态未知',
        'tag.reasoningTitle': '支持推理，可用档位：{levels}',
        'tag.effortTitle': '可用档位：{levels}；默认：{fallback}',
        'tag.effortTitleNoFallback': '可用档位：{levels}',
        'tag.contextTitle': '上下文窗口 {tokens} tokens',
        'tag.modalityTitle': '输入模态：{modalities}',
        'tag.unknownTitle': '适配器没有公布这项信息',
        'tag.infoErrorTitle': '模型能力读取失败：{message}',
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
          'Models turned off here disappear from the chat composer model list. Changes apply immediately and can be turned back on at any time. Each model also shows its reasoning support, effort levels, context window and multimodal capability.',
        'page.summary': 'Showing {visible} of {total} models',
        'page.hiddenSummary': '{count} hidden',
        'page.loading': 'Loading model list…',
        'page.empty': 'No models available.',
        'page.error': 'Could not load the model list: {message}',
        'page.saveFailed': 'Could not save this change. Try again.',
        'page.refresh': 'Refresh',
        'page.showAll': 'Show all',
        'page.legend':
          'Tags: Reasoning = adjustable levels; Effort = published levels; Context = input window; Multimodal = accepts images. Hover a tag for details.',
        'page.metaFallback':
          'Model capability details are unavailable right now: context and modalities show as unknown, while effort levels still come from the shipped catalog.',
        'page.providerFailures': 'Some providers could not be read: {names}',
        'group.showAll': 'Show all',
        'group.hideAll': 'Hide all',
        'group.capabilities': '{reasoning} reasoning · {multimodal} multimodal',
        'tag.reasoning': 'Reasoning',
        'tag.noReasoning': 'No reasoning',
        'tag.reasoningUnknown': 'Reasoning unknown',
        'tag.effort': 'Effort',
        'tag.context': 'Context',
        'tag.unknown': 'unknown',
        'tag.multimodal': 'Multimodal',
        'tag.textOnly': 'Text only',
        'tag.modalityUnknown': 'Modality unknown',
        'tag.reasoningTitle': 'Reasoning supported; levels: {levels}',
        'tag.effortTitle': 'Available levels: {levels}; default: {fallback}',
        'tag.effortTitleNoFallback': 'Available levels: {levels}',
        'tag.contextTitle': 'Context window {tokens} tokens',
        'tag.modalityTitle': 'Input modalities: {modalities}',
        'tag.unknownTitle': 'The adapter does not publish this fact',
        'tag.infoErrorTitle': 'Could not read model capabilities: {message}',
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
.mvp_summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.mvp_actions{flex:none;align-items:center;gap:8px;display:flex}
.mvp_button{box-sizing:border-box;height:28px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);padding:0 10px;font-family:inherit;font-size:12px;line-height:18px}
.mvp_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mvp_button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.mvp_button:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mvp_group{flex:none;flex-direction:column;display:flex}
.mvp_groupHead{justify-content:space-between;align-items:center;gap:12px;padding:14px 0 6px;display:flex}
.mvp_groupTitle{color:var(--dsw-alias-label-primary);align-items:baseline;gap:8px;font-size:14px;font-weight:500;line-height:22px;display:flex}
.mvp_groupCount{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}
.mvp_row{border-bottom:.5px solid var(--dsw-alias-border-l1);justify-content:space-between;align-items:center;gap:16px;padding:10px 0;display:flex}
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
.mvp_tag--muted{color:var(--dsw-alias-label-tertiary);border-color:var(--dsw-alias-border-l1)}
.mvp_groupCap{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:16px}
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

    /**
     * Per-model capability tags. The same model may know only part of its
     * capabilities: an adapter that cannot answer produces `infoError`, and the
     * unknown facts are shown as such instead of being guessed.
     */
    function capabilityTags(model, t) {
      const tags = []
      const reasoning = model.reasoning
      const levels = effortNames(reasoning)
      const errorTitle =
        typeof model.infoError === 'string' && model.infoError !== ''
          ? t('tag.infoErrorTitle', { message: model.infoError })
          : t('tag.unknownTitle')

      if (levels.length > 0) {
        tags.push({
          key: 'reasoning',
          tone: 'accent',
          label: t('tag.reasoning'),
          title: t('tag.reasoningTitle', { levels: levels.join(' / ') }),
        })
        const fallback = defaultEffortName(reasoning)
        tags.push({
          key: 'effort',
          tone: 'neutral',
          label: t('tag.effort') + ' ' + levels.join('/'),
          title:
            fallback === null
              ? t('tag.effortTitleNoFallback', { levels: levels.join(' / ') })
              : t('tag.effortTitle', { levels: levels.join(' / '), fallback }),
        })
      } else if (typeof model.infoError === 'string') {
        tags.push({ key: 'reasoning', tone: 'muted', label: t('tag.reasoningUnknown'), title: errorTitle })
      } else {
        tags.push({ key: 'reasoning', tone: 'muted', label: t('tag.noReasoning'), title: t('tag.unknownTitle') })
      }

      const context = formatContext(model.contextWindow)
      tags.push({
        key: 'context',
        tone: context === null ? 'muted' : 'neutral',
        label: t('tag.context') + ' ' + (context === null ? t('tag.unknown') : context),
        title:
          context === null
            ? errorTitle
            : t('tag.contextTitle', { tokens: Number(model.contextWindow).toLocaleString() }),
      })

      const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : null
      if (modalities === null || modalities.length === 0) {
        tags.push({ key: 'modality', tone: 'muted', label: t('tag.modalityUnknown'), title: errorTitle })
      } else {
        const vision = modalities.includes('image')
        tags.push({
          key: 'modality',
          tone: vision ? 'vision' : 'neutral',
          label: vision ? t('tag.multimodal') : t('tag.textOnly'),
          title: t('tag.modalityTitle', {
            modalities: modalities.map((id) => modalityLabel(id, t)).join(' / '),
          }),
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

        const setGroup = (group, visible) => {
          const next = new Set(hidden)
          for (const model of group.models || []) {
            const key = keyOf(group.id, model.id)
            if (visible) next.delete(key)
            else next.add(key)
          }
          commit(next)
        }

        const rows = []
        for (const group of groups) {
          const models = group.models || []
          const shown = models.filter((model) => !hidden.has(keyOf(group.id, model.id))).length
          const allShown = shown === models.length
          const reasoningCount = models.filter((model) => model.reasoning !== undefined).length
          const multimodalCount = models.filter(
            (model) => Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
          ).length
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
                  h('span', { className: 'mvp_groupCount' }, shown + '/' + models.length),
                  reasoningCount > 0 || multimodalCount > 0
                    ? h(
                        'span',
                        { className: 'mvp_groupCap' },
                        t('group.capabilities', {
                          reasoning: reasoningCount,
                          multimodal: multimodalCount,
                        }),
                      )
                    : null,
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'mvp_button',
                    disabled: disabled,
                    onClick: () => setGroup(group, !allShown),
                  },
                  allShown ? t('group.hideAll') : t('group.showAll'),
                ),
              ),
              models.map((model) => {
                const shownModel = !hidden.has(keyOf(group.id, model.id))
                const tags = capabilityTags(model, t)
                return h(
                  'div',
                  { key: model.id, className: 'mvp_row' },
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
                            className:
                              'mvp_tag' +
                              (tag.tone === 'accent'
                                ? ' mvp_tag--accent'
                                : tag.tone === 'vision'
                                  ? ' mvp_tag--vision'
                                  : tag.tone === 'muted'
                                    ? ' mvp_tag--muted'
                                    : ''),
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
                  (hiddenCount > 0 ? ' · ' + t('page.hiddenSummary', { count: hiddenCount }) : ''),
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
          rows.length === 0 && !loading && state.error === null
            ? h('div', { className: 'mvp_error' }, t('page.empty'))
            : null,
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
