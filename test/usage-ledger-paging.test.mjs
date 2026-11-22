/** Synthetic storage only: contract, cancellation/late completion, scan complexity and profile migration. */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { createUsageLedger, dayKeyOf } from '../lib/usage-ledger.js'
import { routeKey } from '../lib/visibility-identity.js'
import { toUsageCsv } from '../lib/export-csv.js'

const time = new Date(2026, 3, 30, 12).getTime()
const tick = () => new Promise(resolve => setImmediate(resolve))
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mvp-profile-usage-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir
}
const message = (model, step, input, provider = 'relay') => ({ type:'assistant/message', time, data: { turn:0, step,
  message: { source: { kind:'model', provider, model } }, usage: { inputTokens:input, outputTokens:2, cacheReadTokens:1, cacheWriteTokens:3 } } })
const attempt = (step, input) => ({ type:'assistant/attempt', time, data:{ turn:0, step, stream:[{type:'chunk',chunk:{type:'usage',usage:{inputTokens:input,outputTokens:1}}}] } })
function storage(events, { inherited = 0, count = true, limit = Infinity } = {}) {
  let revision = 0
  const bounds = [], calls = { list:0, open:0, read:0, close:0 }
  const trace = []
  const service = {
    async list({ signal }) { calls.list++; assert.ok(signal); return [{ header:{id:'s', createdAt:time}, revision:`r${revision}`,
      ...(count ? {eventCount:events.length} : {}) }] },
    async open(id, access, { signal }) {
      assert.ok(signal); assert.equal(id,'s'); assert.equal(access,'read'); calls.open++
      return { header:{ createdAt:time }, inheritedEventCount:inherited,
        async read(offset,length,{signal}) { assert.ok(signal); calls.read++; bounds.push([offset,length]);
          return {events: events.slice(offset,offset+Math.min(limit,length)).map((item,i) => ({ ...item, seq:offset+i }))} },
        async close() {calls.close++},
      }
    },
  }
  return { service, calls, bounds, trace, changed() {revision++} }
}
function ledger(t, s, options = {}) {
  const home = temp(t)
  const result = createUsageLedger({home, now:()=>time, logger:{warn(){}}, pageSize:3,
    sessionPersistence:s.service, trace:(...args)=>s.trace.push(args), ...options})
  t.after(()=>result.dispose()); return result
}
const same = (tuple, other) => tuple.map((n,i)=>n+other[i])

test('short pages do not signal EOF; append checkpoints span page/fork/settlement replacement/retry boundaries', async t => {
  const events = [
    { type:'request/header', data:{header:{config:{provider:'a/b',model:'c'}}} },
    message('from-parent',0,500), {type:'session/end-seed', data:{inherited:true}}, attempt(1,8),
  ]
  {
    const s = storage(events,{inherited:3,count:false,limit:1}), l = ledger(t,s)
    await l.rescan(); assert.equal(l.read().error,undefined)
    assert.deepEqual(s.bounds.map(([o])=>o),[0,1,2,3,4]); assert.deepEqual(l.read().byModel,{[routeKey('a/b','c')]:[8,1,0,0]})
    s.bounds.length=0
    // Different route & revised values overwrite the prior attempt at the SAME step.
    events.push(message('b/c',1,10,'a'),{type:'llm/retry-started',data:{turn:0,step:1}},message('c',1,7,'a/b'))
    s.changed(); await l.rescan()
    assert.deepEqual(s.bounds.map(([o])=>o),[4,5,6,7]); assert.deepEqual(l.read().ranges.total,[17,4,2,6])
    assert.deepEqual(l.read().byModel,{[routeKey('a','b/c')]:[10,2,1,3],[routeKey('a/b','c')]:[7,2,1,3]})
    const csv = toUsageCsv(l.read())
    assert.match(csv,/range,provider,model,unresolvedRoute,input,output,cacheRead,cacheWrite/)
    assert.match(csv,/,a\/b,c,,7,2,1,3\r\n/); assert.match(csv,/,a,b\/c,,10,2,1,3\r\n/)
    const unread = s.calls.read; await l.rescan(); assert.equal(s.calls.read, unread, 'equal revision touches no event pages')
    await l.rescan({force:true}); assert.deepEqual(l.read().ranges.total,[17,4,2,6]); assert.equal(s.bounds.at(-8)[0],0)
    assert.ok(s.trace.some(([m,step,v])=>m==='usage'&&step==='session.read'&&v.skipped===4&&v.processed===3))
  }
})

test('known eventCount pins a growing log to the exact sampled prefix, and noncontiguous/early EOF never replace totals', async t => {
  const events=[message('one',0,1),message('later',1,10)]; const s=storage(events)
  const base=s.service.open.bind(s.service); let report=1,bad=''
  s.service.list=async()=>[{header:{id:'s'}, revision:`r${report}:${bad}`,eventCount:report}]
  s.service.open=async(...args)=>{const h=await base(...args);const read=h.read.bind(h);h.read=async(...args)=>{
    const page=await read(...args); return bad==='gap' ? {events:page.events.map(ev=>({...ev,seq:ev.seq+1}))} : bad==='short'?{events:[]}:page
  };return h}
  const l=ledger(t,s); await l.rescan(); assert.deepEqual(l.read().ranges.total,[1,2,1,3]); assert.deepEqual(s.bounds,[[0,1]])
  const before=fs.readFileSync(l.file,'utf8'); report=2
  for (const problem of ['gap','short']) {
    bad=problem; await l.rescan(); assert.match(l.read().error,/incomplete/); assert.equal(fs.readFileSync(l.file,'utf8'),before)
    assert.deepEqual(l.read().ranges.total,[1,2,1,3]); assert.equal(s.bounds.at(-1)[0],1)
  }
  bad=''; await l.rescan(); assert.equal(l.read().error,undefined); assert.deepEqual(l.read().ranges.total,[11,4,2,6])
})

for (const stage of ['list','open','read','close']) for (const action of ['dispose','timeout']) {
  test(`${action} bounds an uncooperative ${stage}; no late read/commit, including a handle acquired after abort`, {timeout:4000}, async t => {
    const events=[message('late',0,500)], s=storage(events); const arrived=Promise.withResolvers(), delayed=Promise.withResolvers()
    let seenSignal, closeCalls=0, reads=0
    const stall=async(name,signal,value)=>{if(stage===name){seenSignal=signal;arrived.resolve();await delayed.promise}return value}
    s.service={list:({signal})=>stall('list',signal,[{header:{id:'s'},revision:'1',eventCount:1}]),
      open:(id,access,{signal})=>stall('open',signal,{header:{createdAt:time},inheritedEventCount:0,
        read:(offset,length,{signal})=>{reads++;return stall('read',signal,{events:[{...events[0],seq:0}]})},
        close:()=>{closeCalls++;return stall('close',null,undefined)},})}
    const l=ledger(t,s,{ioTimeoutMs:action==='timeout'?30:2000,scanTimeoutMs:3000});const scan=l.rescan();await arrived.promise
    if(action==='dispose')await l.dispose()
    await scan
    if(stage!=='close')assert.equal(seenSignal.aborted,true)
    assert.equal(l.isScanning(),false);assert.deepEqual(l.read().ranges.total,[0,0,0,0]);assert.equal(fs.existsSync(l.file),false)
    if(action==='timeout')assert.match(l.read().error,/timed out/)
    delayed.resolve();await tick();await tick()
    assert.equal(closeCalls,stage==='list'?0:1);assert.equal(reads, stage==='close'||stage==='read'?1:0)
    assert.deepEqual(l.read().ranges.total,[0,0,0,0]);assert.equal(fs.existsSync(l.file),false)
  })
}

test('cancelling a caller cannot leak a late first scan into a second one or skip it via a poisoned revision', async t=>{
  const s=storage([message('after',0,2)]), base=s.service.open.bind(s.service)
  const blocked=Promise.withResolvers(), entered=Promise.withResolvers();let first=true
  s.service.open=async(...args)=>{const h=await base(...args); if(first){first=false;h.read=async()=>{entered.resolve();await blocked.promise;return {events:[{...message('before',0,700),seq:0}]}}} return h}
  const l=ledger(t,s), cancel=new AbortController();const old=l.rescan({signal:cancel.signal});await entered.promise;cancel.abort();await old
  assert.match(l.read().error,/cancelled/);await l.rescan();const committed=fs.readFileSync(l.file,'utf8')
  blocked.resolve();await tick();assert.equal(fs.readFileSync(l.file,'utf8'),committed);assert.deepEqual(l.read().byModel,{'relay/after':[2,2,1,3]})
})

test('large synthetic backend loads bounded pages; warm append reads one event, not the entire active transcript', async t=>{
  const events=Array.from({length:2048},(_,step)=>message('same',step,1));const s=storage(events),l=ledger(t,s,{pageSize:32});await l.rescan()
  assert.equal(l.read().error,undefined);assert.equal(s.bounds.length,64);assert.ok(s.bounds.every(([,n])=>n<=32));const before=l.read().ranges.total
  s.bounds.length=0;events.push(message('same',events.length,4));s.changed();await l.rescan();assert.deepEqual(s.bounds,[[2048,1]])
  assert.deepEqual(l.read().ranges.total,same(before,[4,2,1,3]));assert.deepEqual(s.trace.filter(([,step])=>step==='session.read').map(([, ,d])=>[d.count,d.processed,d.skipped]),[[64,2048,0],[1,1,2048]])
})

for(const encoding of ['jsonl','jsonl.zstd'])test(`disk ${encoding} crosses frames/lines/chunks in one streaming fold without reading a session wholesale`, async t=>{
  const home=temp(t);const dir=path.join(home,'sessions','p','s');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,`session.v4.${encoding}`)
  const lines=[{type:'session',version:4,createdAt:time},...Array.from({length:95},(_,i)=>({...message('模型/✓',i,1),seq:i}))].map(x=>JSON.stringify(x)+'\n')
  const raw=Buffer.from(lines.join(''));const frame=lines=>zlib.zstdCompressSync(Buffer.from(lines.join('')),{params:{[zlib.constants.ZSTD_c_checksumFlag]:1}})
  fs.writeFileSync(file,encoding==='jsonl'?raw:Buffer.concat([frame(lines.slice(0,50)),frame(lines.slice(50))]))
  const trace=[];const l=createUsageLedger({home,chunkBytes:31,now:()=>time,trace:(...x)=>trace.push(x)});t.after(()=>l.dispose())
  await l.rescan();assert.equal(l.read().error,undefined);assert.deepEqual(l.read().ranges.total,[95,190,95,285]);
  const stats=trace.find(([,step])=>step==='disk.read')[2];assert.ok(stats.count>10);assert.equal(stats.total,encoding==='jsonl'?0:2);assert.equal(stats.bytes,fs.statSync(file).size)
  const n=trace.length;await l.rescan();assert.equal(trace.slice(n).some(([,step])=>step==='disk.read'),false)
})

test('polling reuses a snapshot projection across reads until bills or the local day change', async t=>{
  const s=storage([message('p',0,1)]);let now=time;const l=ledger(t,s,{now:()=>now});await l.rescan()
  const first=l.read();for(let i=0;i<20;++i) assert.equal(l.read().ranges,first.ranges)
  assert.equal(s.trace.filter(([,step])=>step==='summary.fold').length,1)
  l.notePluginUsage({provider:'p',model:'p',usage:{inputTokens:2,outputTokens:1}})
  const next=l.read();assert.deepEqual(next.ranges.today,[3,3,1,3]);assert.notEqual(next.ranges,first.ranges)
  now+=24*60*60*1000;assert.deepEqual(l.read().ranges.today,[0,0,0,0]);assert.equal(s.trace.filter(([,step])=>step==='summary.fold').length,3)
})

test('same-profile peer writers that read the same baseline preserve both settlement deltas and distinct sessions', async t=>{
  const home=temp(t), file=path.join(home,'shared-profile.json'), a=storage([message('a',0,5)]), b=storage([message('b',0,6)])
  const open=a.service.open.bind(a.service);a.service.open=(_,access,opt)=>open('s',access,opt);a.service.list=async()=>[{header:{id:'other'},revision:'r0',eventCount:1}]
  const options={home,file,profileScope:'same',now:()=>time,logger:{warn(){}}}
  const one=createUsageLedger({...options,sessionPersistence:a.service}),two=createUsageLedger({...options,sessionPersistence:b.service})
  one.read();two.read();one.notePluginUsage({provider:'check',model:'same',usage:{inputTokens:10,outputTokens:1}})
  two.notePluginUsage({provider:'check',model:'same',usage:{inputTokens:20,outputTokens:2}})
  await one.rescan();await two.rescan();await one.dispose();await two.dispose()
  const again=createUsageLedger({...options,sessionPersistence:b.service});const snap=again.read();assert.equal(snap.error,undefined)
  assert.deepEqual(snap.byModel,{'relay/a':[5,2,1,3],'relay/b':[6,2,1,3],'check/same':[30,3,0,0]});await again.dispose()
})

test('failed reread does not overwrite or quarantine an existing ledger containing unverified history',async t=>{
  const home=temp(t),file=path.join(home,'bad.json');fs.writeFileSync(file,'existing-but-unreadable')
  const l=createUsageLedger({home,file,now:()=>time,logger:{warn(){}}});l.notePluginUsage({provider:'p',model:'q',usage:{inputTokens:1,outputTokens:0}})
  await l.dispose();assert.equal(fs.readFileSync(file,'utf8'),'existing-but-unreadable');assert.deepEqual(l.read().ranges.total,[1,0,0,0]);assert.match(l.read().error,/not replaced/)
})

test('only identifiable legacy session and checker aggregates migrate; old shared ledger remains byte-identical', async t=>{
  const home=temp(t),legacyFile=path.join(home,'shared.json'),day=dayKeyOf(time); const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone
  const files={gone:{from:day,buckets:{[day]:{'p/vanished':[2,0,0,0]}}}},plugin={[day]:{'p/plugin':[8,0,0,0]}}
  const shared=JSON.stringify({version:3,timeZone,source:'service:first',files,plugin});fs.writeFileSync(legacyFile,shared)
  const open=(scope,file=scope)=>createUsageLedger({home,legacyFile,file:path.join(home,file+'.json'),profileScope:scope,now:()=>time,sessionPersistence:{async list(){return []}}})
  const first=open('first');assert.deepEqual(first.read().ranges.total,[2,0,0,0]);assert.match(first.read().error,/not included/);await first.rescan();await first.dispose()
  const second=open('second');assert.deepEqual(second.read().ranges.total,[0,0,0,0]);assert.match(second.read().error,/not included/);
  second.notePluginUsage({provider:'p',model:'plugin',usage:{inputTokens:3,outputTokens:1}});await second.dispose()
  assert.equal(fs.readFileSync(legacyFile,'utf8'),shared);const again=open('second');assert.deepEqual(again.read().ranges.total,[3,1,0,0]);assert.match(again.read().error,/not included/);await again.dispose()
  fs.writeFileSync(legacyFile,JSON.stringify({version:3,timeZone,source:'service:first',pluginScope:'first',files,plugin}));const proved=open('first','witnessed');assert.deepEqual(proved.read().ranges.total,[10,0,0,0]);assert.equal(proved.read().error,undefined);await proved.dispose()
})
