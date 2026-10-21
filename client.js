window.__ModuleLoader__.load({
  id: 'dsh-model-visibility',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Dictionary namespace owned by this plugin. */
    const NS = 'model-visibility'
    /** Host entry id from cordis.patch.yml; also the settings namespace. */
    const ENTRY = 'model-visibility'
    /** Config field persisted by the Host settings document. */
    const FIELD = 'hidden'
    /** Composer slot that owns the model selector. */
    const MODEL_SLOT = 'conversation.input.model'
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
        'composer.triggerFallback': '选择模型',
        'composer.loading': '正在加载模型…',
        'composer.empty':
          '所有模型都已隐藏。请到“设置 → 模型显示”中打开至少一个模型。',
        'composer.search': '搜索模型…',
        'composer.noResults': '没有匹配的模型。',
        'composer.menuLabel': '选择模型',
        'composer.selectAria': '选择模型，当前 {model}',
        'composer.switchFailed': '切换模型失败：{message}',
        'effort.default': '默认',
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
        'composer.triggerFallback': 'Select model',
        'composer.loading': 'Loading models…',
        'composer.empty':
          'Every model is hidden. Open at least one in Settings → Model visibility.',
        'composer.search': 'Search models…',
        'composer.noResults': 'No matching models.',
        'composer.menuLabel': 'Select model',
        'composer.selectAria': 'Select model, current {model}',
        'composer.switchFailed': 'Could not switch models: {message}',
        'effort.default': 'Default',
      },
    }

    const CSS = `
.mv_root{position:relative;min-width:0;display:flex;align-items:center}
.mv_trigger{box-sizing:border-box;border-radius:var(--dsw-radius-sm,6px);min-width:0;max-width:min(360px,45cqw);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-family:inherit;font-size:13px;font-weight:400;line-height:20px;display:flex}
.mv_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mv_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}
.mv_trigger:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mv_triggerIcon{display:var(--dsh-composer-model-icon-display,none);flex:none;align-items:center;justify-content:center}
.mv_triggerLabel{display:var(--dsh-composer-model-text-display,block);text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.mv_triggerEffort{display:var(--dsh-composer-model-text-display,block);text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex-shrink:1000;overflow:hidden}
.mv_chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:flex;align-items:center}
.mv_menu{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(260px,calc(100vw - 32px));max-width:min(420px,calc(100vw - 32px));max-height:min(360px,calc(100vh - 96px));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.28));color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);flex-direction:column;padding:4px;display:flex;overflow:hidden}
.mv_scroll{flex-direction:column;gap:2px;min-height:0;display:flex;overflow-y:auto}
.mv_group{flex-direction:column;display:flex}
.mv_groupLabel{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;padding:6px 8px 2px;position:sticky;top:0;background:var(--dsw-alias-bg-layer-2)}
.mv_option{border-radius:var(--dsw-radius-sm,6px);width:100%;min-width:0;color:inherit;text-align:left;cursor:pointer;background:0 0;border:none;outline:none;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;font-family:inherit;font-size:13px;line-height:20px;display:flex}
.mv_option:hover:not(:disabled),.mv_option:focus-visible{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.mv_option:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.mv_optionName{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
.mv_check{flex:none;width:16px;height:16px;color:var(--dsw-alias-brand-primary);display:flex;align-items:center;justify-content:center}
.mv_searchRow{flex:none;border-bottom:.5px solid var(--dsw-alias-border-l1);align-items:center;gap:6px;padding:4px 6px 6px;margin-bottom:4px;display:flex}
.mv_searchInput{flex:1;min-width:0;height:24px;color:var(--dsw-alias-label-primary);background:0 0;border:none;outline:none;font-family:inherit;font-size:13px}
.mv_status{color:var(--dsw-alias-label-tertiary);padding:8px;font-size:12px;line-height:18px}
.mv_error{color:var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));gap:8px;align-items:center;padding:8px;font-size:12px;line-height:18px;display:flex}
.mv_retry{color:inherit;cursor:pointer;background:0 0;border:none;flex:none;padding:0;font-family:inherit;font-size:12px;text-decoration:underline}
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

    function findModel(groups, selection) {
      if (!selection) return undefined
      for (const group of groups || []) {
        if (group.id !== selection.provider) continue
        for (const model of group.models || []) {
          if (model.id === selection.model) return { group, model }
        }
      }
      return undefined
    }

    /** Visible groups, optionally narrowed by a case-insensitive query. */
    function visibleGroups(groups, hidden, query) {
      const q = query ? query.trim().toLowerCase() : ''
      const out = []
      for (const group of groups || []) {
        const models = (group.models || []).filter((model) => {
          if (hidden.has(keyOf(group.id, model.id))) return false
          if (q === '') return true
          return (
            String(model.name || '').toLowerCase().includes(q) ||
            String(model.id || '').toLowerCase().includes(q)
          )
        })
        if (models.length > 0) out.push({ ...group, models })
      }
      return out
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

    const IDLE_STATE = {
      current: null,
      routable: false,
      groups: [],
      failures: [],
      status: 'idle',
      pending: null,
      error: null,
    }
    const IDLE_STORE = {
      subscribe() {
        return () => {}
      },
      getSnapshot() {
        return IDLE_STATE
      },
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

    /* ---------------------------------------------------------- small svg */

    function CheckIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3.5 8.5l3 3 6-7' }),
      )
    }

    function ChevronIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 6.5l4 4 4-4' }),
      )
    }

    function LayersIcon() {
      return h(
        'svg',
        {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M8 2.5l5 2.6-5 2.6-5-2.6 5-2.6z' }),
        h('path', { d: 'M3 8.2l5 2.6 5-2.6' }),
      )
    }

    /* ------------------------------------------------------ composer seat */

    function makeSelect(form) {
      /**
       * The composer's model seat: a trigger showing the current model, and a
       * menu that lists only models the settings page has left visible.
       */
      return function ModelVisibilitySelect(props) {
        const { available, store, load, select, locked, t } = props
        const { hidden } = useHidden(form)
        const state = useSource(store)
        const [open, setOpen] = React.useState(false)
        const [query, setQuery] = React.useState('')
        const [pos, setPos] = React.useState(null)
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const rootRef = React.useRef(null)
        const triggerRef = React.useRef(null)
        const menuRef = React.useRef(null)
        const searchRef = React.useRef(null)

        React.useEffect(() => {
          if (available && typeof load === 'function') load()
          // The catalog is loaded once per seat mount; reopening reloads it.
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [available])

        const close = React.useCallback((restoreFocus) => {
          setOpen(false)
          setQuery('')
          setError(null)
          if (restoreFocus) {
            queueMicrotask(() => {
              if (triggerRef.current) triggerRef.current.focus()
            })
          }
        }, [])

        React.useEffect(() => {
          if (!open) return undefined
          const onPointerDown = (event) => {
            if (rootRef.current && rootRef.current.contains(event.target)) return
            if (menuRef.current && menuRef.current.contains(event.target)) return
            close(false)
          }
          const onKeyDown = (event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            close(true)
          }
          document.addEventListener('mousedown', onPointerDown)
          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        }, [open, close])

        const groups = visibleGroups(state.groups, hidden, '')
        const showSearch = countModels(groups) > 6
        const currentEntry = findModel(state.groups, state.current)
        const reasoning = currentEntry === undefined ? undefined : currentEntry.model.reasoning
        const effort =
          state.current === null
            ? undefined
            : state.current.reasoningEffort === undefined
              ? reasoning === undefined
                ? undefined
                : reasoning.defaultEffort
              : state.current.reasoningEffort
        const effortName =
          reasoning === undefined
            ? undefined
            : Array.isArray(reasoning.efforts)
              ? reasoning.efforts.find((level) => level.id === effort)
              : undefined
        let effortLabel
        if (currentEntry !== undefined) {
          if (reasoning === undefined) effortLabel = state.retainedEffort
          else if (effort === undefined) effortLabel = t('effort.default')
          else effortLabel = effortName !== undefined ? effortName.name : effort
        }
        const currentName =
          currentEntry !== undefined
            ? currentEntry.model.name
            : state.current !== null
              ? state.current.model
              : state.status === 'loading' || state.status === 'idle'
                ? t('composer.loading')
                : t('composer.triggerFallback')

        React.useLayoutEffect(() => {
          if (!open) {
            setPos(null)
            return undefined
          }
          const place = () => {
            const trigger = triggerRef.current
            const menu = menuRef.current
            if (trigger === null) return
            const rect = trigger.getBoundingClientRect()
            const MARGIN = 12
            const width = menu === null ? 280 : menu.offsetWidth
            const height = menu === null ? 220 : menu.offsetHeight
            let left = rect.right - width
            let top = rect.top - 8 - height
            left = Math.min(Math.max(left, MARGIN), window.innerWidth - width - MARGIN)
            top = Math.min(Math.max(top, MARGIN), window.innerHeight - height - MARGIN)
            setPos({ left, top })
          }
          place()
          window.addEventListener('scroll', place, true)
          window.addEventListener('resize', place)
          const menu = menuRef.current
          const observer =
            typeof ResizeObserver !== 'undefined' && menu !== null ? new ResizeObserver(place) : null
          if (observer !== null) observer.observe(menu)
          return () => {
            if (observer !== null) observer.disconnect()
            window.removeEventListener('scroll', place, true)
            window.removeEventListener('resize', place)
          }
        }, [open, state, query, hidden])

        React.useLayoutEffect(() => {
          if (!open) return
          if (showSearch) {
            const input = searchRef.current
            if (input !== null) input.focus()
            return
          }
          const menu = menuRef.current
          if (menu === null) return
          const checked = menu.querySelector('[role="menuitemradio"][aria-checked="true"]')
          const target = checked !== null ? checked : menu.querySelector('[role="menuitemradio"]')
          if (target !== null) target.focus()
        }, [open, showSearch])

        if (!available) return null

        const choose = (group, model) => {
          if (busy) return
          const effortId =
            model.reasoning !== undefined && model.reasoning.defaultEffort !== undefined
              ? model.reasoning.defaultEffort
              : undefined
          const selection = { provider: group.id, model: model.id }
          if (effortId !== undefined) selection.reasoningEffort = effortId
          setBusy(true)
          setError(null)
          Promise.resolve(select(selection)).then(
            (result) => {
              setBusy(false)
              if (result && result.ok === false) {
                const failure = result.error
                const message = failure
                  ? String(failure.code) + ': ' + String(failure.message)
                  : ''
                setError(t('composer.switchFailed', { message }))
                return
              }
              close(true)
            },
            (failure) => {
              setBusy(false)
              setError(
                t('composer.switchFailed', {
                  message: String(failure && failure.message ? failure.message : failure),
                }),
              )
            },
          )
        }

        const filtered = visibleGroups(state.groups, hidden, showSearch ? query : '')
        const rows = []
        for (const group of filtered) {
          const options = group.models.map((model) =>
            h(
              'button',
              {
                key: model.id,
                type: 'button',
                role: 'menuitemradio',
                'aria-checked':
                  state.current !== null &&
                  state.current.provider === group.id &&
                  state.current.model === model.id,
                className: 'mv_option',
                title: model.name,
                disabled: busy,
                onClick: () => choose(group, model),
              },
              h('span', { className: 'mv_optionName' }, model.name),
              h(
                'span',
                { className: 'mv_check' },
                state.current !== null &&
                  state.current.provider === group.id &&
                  state.current.model === model.id
                  ? h(CheckIcon)
                  : null,
              ),
            ),
          )
          rows.push(
            h(
              'div',
              { key: group.id, className: 'mv_group', role: 'group', 'aria-label': providerLabel(group, t) },
              h('div', { className: 'mv_groupLabel' }, providerLabel(group, t)),
              options,
            ),
          )
        }

        const emptyText =
          state.groups.length === 0
            ? t('page.empty')
            : countModels(groups) === 0
              ? t('composer.empty')
              : t('composer.noResults')

        const onMenuKeyDown = (event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          const menu = menuRef.current
          if (menu === null) return
          const nodes = Array.from(menu.querySelectorAll('[role="menuitemradio"]:not(:disabled)'))
          if (nodes.length === 0) return
          event.preventDefault()
          const index = nodes.indexOf(document.activeElement)
          const delta = event.key === 'ArrowDown' ? 1 : -1
          const next = index < 0 ? (delta > 0 ? 0 : nodes.length - 1) : (index + delta + nodes.length) % nodes.length
          nodes[next].focus()
        }

        const menu =
          open && typeof document !== 'undefined'
            ? ReactDOM.createPortal(
                h(
                  'div',
                  {
                    ref: menuRef,
                    className: 'mv_menu',
                    role: 'menu',
                    'aria-label': t('composer.menuLabel'),
                    style: {
                      left: pos === null ? 0 : pos.left,
                      top: pos === null ? 0 : pos.top,
                      visibility: pos === null ? 'hidden' : 'visible',
                    },
                    onKeyDown: onMenuKeyDown,
                  },
                  showSearch
                    ? h(
                        'div',
                        { className: 'mv_searchRow' },
                        h('input', {
                          ref: searchRef,
                          className: 'mv_searchInput',
                          type: 'text',
                          value: query,
                          placeholder: t('composer.search'),
                          'aria-label': t('composer.search'),
                          onChange: (event) => setQuery(event.target.value),
                          onKeyDown: (event) => {
                            if (event.key !== 'Enter') return
                            const first = filtered[0] !== undefined ? filtered[0].models[0] : undefined
                            if (first !== undefined) choose(filtered[0], first)
                          },
                        }),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'mv_scroll' },
                    error !== null ? h('div', { className: 'mv_error', role: 'alert' }, error) : null,
                    state.status === 'loading' && state.groups.length === 0
                      ? h('div', { className: 'mv_status' }, t('composer.loading'))
                      : null,
                    state.error !== null
                      ? h(
                          'div',
                          { className: 'mv_error' },
                          h('span', null, state.error),
                          h(
                            'button',
                            {
                              type: 'button',
                              className: 'mv_retry',
                              onClick: () => {
                                if (typeof load === 'function') load()
                              },
                            },
                            t('page.refresh'),
                          ),
                        )
                      : null,
                    rows.length > 0 ? rows : null,
                    rows.length === 0 && !(state.status === 'loading' && state.groups.length === 0)
                      ? h('div', { className: 'mv_status' }, emptyText)
                      : null,
                  ),
                ),
                document.body,
              )
            : null

        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'mv_root', ref: rootRef },
            h(
              'button',
              {
                ref: triggerRef,
                type: 'button',
                className: 'mv_trigger',
                disabled: locked === true,
                'aria-haspopup': 'menu',
                'aria-expanded': open,
                'aria-label': t('composer.selectAria', { model: currentName }),
                onClick: () => {
                  if (open) {
                    close(true)
                    return
                  }
                  setError(null)
                  setQuery('')
                  setOpen(true)
                  if (typeof load === 'function') load()
                },
              },
              h('span', { className: 'mv_triggerIcon' }, h(LayersIcon)),
              h('span', { className: 'mv_triggerLabel' }, currentName),
              effortLabel !== undefined ? h('span', { className: 'mv_triggerEffort' }, effortLabel) : null,
              h('span', { className: 'mv_chevron' }, h(ChevronIcon)),
            ),
          ),
          menu,
        )
      }
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

    const inject = ['slots', 'locale', 'configForms', 'sessions', 'remote', 'remote.session']

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

      ctx.inject(['slots', 'modelDirectories', 'sessions'], (scope) => {
        const models = scope.modelDirectories
        const sessions = scope.sessions
        const Select = makeSelect(form)

        scope.effect(
          () =>
            scope.slots.inject(MODEL_SLOT, () =>
              scope.slots.register(
                {
                  name: MODEL_SLOT,
                  // Lowest priority wins the single-slot seat, so this occupant
                  // shadows the shipped selector while the plugin is loaded.
                  priority: -1,
                  locale: NS,
                  inject: (sessionId) => {
                    let directory
                    try {
                      directory = models.directoryFor(sessionId)
                    } catch (_error) {
                      directory = undefined
                    }
                    if (directory === undefined) {
                      return {
                        available: false,
                        store: IDLE_STORE,
                        load: () => {},
                        select: () => Promise.resolve(undefined),
                      }
                    }
                    const available =
                      typeof sessions.subagentAddress === 'function'
                        ? sessions.subagentAddress(sessionId) === undefined
                        : true
                    return {
                      available,
                      store: directory.store,
                      load: () => {
                        if (available) directory.load().catch(() => {})
                      },
                      select: (selection) =>
                        available ? directory.select(selection) : Promise.resolve(undefined),
                    }
                  },
                },
                Select,
              ),
            ),
          'model-visibility: composer model seat',
        )
      })
    }

    return { inject, apply }
  },
})

