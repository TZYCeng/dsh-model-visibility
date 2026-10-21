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

    const DICT = {
      zh: {
        'nav': '模型显示',
        'page.title': '模型显示',
        'page.description':
          '关闭的模型不会出现在聊天输入框的模型下拉列表中；这里的改动立即生效，之后仍可随时重新打开。',
        'page.summary': '已显示 {visible} / {total} 个模型',
        'page.hiddenSummary': '已关闭 {count} 个',
        'page.loading': '正在加载模型列表…',
        'page.empty': '暂无可用模型。',
        'page.error': '模型列表加载失败：{message}',
        'page.saveFailed': '保存失败，请重试。',
        'page.refresh': '刷新',
        'page.showAll': '全部显示',
        'group.showAll': '全组显示',
        'group.hideAll': '全组隐藏',
        'provider.account': 'DeepSeek 账号',
      },
      en: {
        'nav': 'Model visibility',
        'page.title': 'Model visibility',
        'page.description':
          'Models turned off here disappear from the chat composer model list. Changes apply immediately and can be turned back on at any time.',
        'page.summary': 'Showing {visible} of {total} models',
        'page.hiddenSummary': '{count} hidden',
        'page.loading': 'Loading model list…',
        'page.empty': 'No models available.',
        'page.error': 'Could not load the model list: {message}',
        'page.saveFailed': 'Could not save this change. Try again.',
        'page.refresh': 'Refresh',
        'page.showAll': 'Show all',
        'group.showAll': 'Show all',
        'group.hideAll': 'Hide all',
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
      let state = { status: 'idle', groups: [], failures: [], error: null }
      let inflight = null

      const publish = (next) => {
        state = next
        for (const listener of listeners) listener()
      }

      const load = () => {
        if (inflight !== null) return inflight
        if (state.status !== 'ready') {
          publish({ ...state, status: 'loading', error: null })
        }
        inflight = Promise.resolve()
          .then(() => ctx.remote.session.modelCatalog())
          .then((response) => {
            if (!response || response.ok !== true) {
              const failure = response && response.error
              const message = failure
                ? String(failure.code) + ': ' + String(failure.message)
                : 'unknown error'
              publish({ ...state, status: 'error', error: message })
              return
            }
            const value = response.value || {}
            publish({
              status: 'ready',
              groups: Array.isArray(value.groups) ? value.groups : [],
              failures: Array.isArray(value.failures) ? value.failures : [],
              error: null,
            })
          })
          .catch((error) => {
            publish({
              ...state,
              status: 'error',
              error: String(error && error.message ? error.message : error),
            })
          })
          .finally(() => {
            inflight = null
          })
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
          return load()
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
                  onClick: () => catalog.load(),
                },
                t('page.refresh'),
              ),
            ),
          ),
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
          disposers.push(
            ctx.remote.$on('llm/adapters-updated', () => {
              catalog.refresh()
            }),
          )
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
