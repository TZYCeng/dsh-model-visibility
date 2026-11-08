const React = require('react')

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

export { subscribeOf, snapshotOf, useSource, useHidden }
