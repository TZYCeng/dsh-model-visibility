/** Exercise the actual source component offline with only its React host mocked. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { toUsageCsv } from '../lib/export-csv.js'

test('usage toolbar always reserves one status slot and shows the exact same four disjoint CSV buckets in each tooltip', async t=>{
  const React = {createElement:(type,props,...children)=>({type,props,children:children.flat()}),
    useRef:current=>({current}), useEffect:()=>{},
    useCallback:fn=>fn, useMemo:fn=>fn(), useSyncExternalStore:(_,read)=>read(), useState:init=>[init,()=>{}]}
  const previous=Object.getOwnPropertyDescriptor(globalThis,'require')
  Object.defineProperty(globalThis,'require',{configurable:true,value:name=>{assert.equal(name,'react');return React}})
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'require',previous);else delete globalThis.require})
  const {UsageToolbar}=await import('../client-src/usage-view.mjs')
  const bucket=[12345,6789,321,9],ranges=Object.fromEntries(['today','week','month','total'].map(key=>[key,bucket]))
  const translate=(key,data)=>data?key+JSON.stringify(data):key
  const render=(computing,error)=>{
    const usage={getSnapshot:()=>({snapshot:{computing,error,ranges}}),subscribe:()=>()=>{}}
    const root=UsageToolbar({usage,t:translate,features:['usage']})
    const walk=node=>node&&typeof node==='object'?[node,...node.children.flatMap(walk)]:[]
    return walk(root)
  }
  for(const [computing,error] of [[false,null],[true,null],[false,'partial scan']]) {
    const nodes=render(computing,error),statuses=nodes.filter(n=>n.props?.className==='mvp_usageStatus')
    assert.equal(statuses.length,1);assert.equal(statuses[0].props.role,'status');assert.equal(statuses[0].props.tabIndex,error?0:undefined)
    assert.equal(statuses[0].children.length, computing||error?1:0)
    const titles=nodes.filter(n=>n.props?.className?.split(' ').includes('mvp_stat')).map(n=>n.props.title)
    assert.equal(titles.length,4);for(const title of titles)assert.match(title,/usage\.detail\{"input":12345,"output":6789,"cacheRead":321,"cacheWrite":9\}/)
    assert.deepEqual(nodes.filter(n=>n.props?.className==='mvp_statValue').map(n=>n.children[0]),Array(4).fill('19.5K'))
  }
  const csv=toUsageCsv({ranges});for(const key of Object.keys(ranges))assert.ok(csv.includes(`sum,${key},${bucket.join(',')}\r\n`))
})

for (const reason of ['timeout','unmount']) test(`CSV export ${reason} releases the UI and refuses an uncooperative late blob`, async t=>{
  const events=[], started=Promise.withResolvers(), late=Promise.withResolvers();let cleanup,deadline,signal,blobs=0,calls=0
  const React={createElement:(type,props,...children)=>({type,props,children:children.flat()}),
    useRef:current=>({current}),useEffect:e=>{cleanup=e()},useCallback:f=>f,useSyncExternalStore:(_,read)=>read(),
    useState:init=>[init,next=>events.push(next)]}
  const previous=Object.getOwnPropertyDescriptor(globalThis,'require')
  Object.defineProperty(globalThis,'require',{configurable:true,value:name=>{assert.equal(name,'react');return React}})
  t.after(()=>{if(previous)Object.defineProperty(globalThis,'require',previous);else delete globalThis.require})
  const {UsageToolbar}=await import(`../client-src/usage-view.mjs?csv=${reason}`)
  t.mock.method(globalThis,'fetch',async(_,init)=>{
    calls++;signal=init.signal
    return {ok:true,headers:new Headers({'content-type':'text/csv'}),blob:()=>{started.resolve();return late.promise}}
  })
  const original=globalThis.setTimeout
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{
    if(ms===120_000){deadline=fn;return 0}
    return original(fn,ms,...args)
  })
  t.mock.method(URL,'createObjectURL',()=>{blobs++;return 'blob:not-allowed'})
  const root=UsageToolbar({usage:{getSnapshot:()=>({snapshot:null}),subscribe:()=>()=>{}},t:k=>k,features:['usage']})
  const button=root.children.find(n=>n.props.className==='mvp_usageActions').children[0]
  button.props.onClick();button.props.onClick();await started.promise;assert.equal(calls,1)
  if(reason==='timeout')deadline();else cleanup()
  await new Promise(setImmediate);assert.ok(signal.aborted)
  if(reason==='timeout')assert.deepEqual(events,['usage',null,'CSV download timed out',null])
  else assert.deepEqual(events,['usage',null], 'an unmounted toolbar never receives a state update')
  late.resolve(new Blob(['ignored']));await new Promise(setImmediate);assert.equal(blobs,0)
})
