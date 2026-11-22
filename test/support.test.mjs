import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import manifest from '../package.json' with { type: 'json' }
import { createDebugTrace, traceData } from '../lib/debug-trace.js'
import { createVersionInfo, compareVersions } from '../lib/version-info.js'
import { registerSupportRoutes, wrapConnection } from '../lib/host-http.js'
import { profileDataFile, storageRoot } from '../lib/profile-store.js'
import { withStoreLock } from '../lib/store-lock.js'
const scratch = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mv-support-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true})); return dir }

test('diagnostics are opt-in, bounded, independently redacted, persisted and removable', t => {
  const dir = scratch(t), journal = createDebugTrace({ dir, limit: 8 })
  journal.trace('model-info','resolve',{ model:'old' }); assert.deepEqual(fs.readdirSync(dir),[])
  const enabled = journal.setEnabled(true), key = enabled.epoch
  assert.equal(journal.append('invalid', []),false)
  const raw = { model:'demo/chat', provider:'relay', status:'received', fields:['input','reasoningEfforts'], credentials:'DO_NOT_STORE', inputBody:{ apiKey:'DO_NOT_STORE' }, prompt:'secret prose', url:'https://never.example', reasoningEffortMappings:{high:'secret-wire'} }
  assert.deepEqual(traceData(raw),{ model:'demo/chat', provider:'relay', status:'received', fields:['input','reasoningEfforts'] })
  assert.deepEqual(traceData({provider:'https://bad.invalid',model:'sk-secret-test',fields:['x/api','OK','sk-secret']}),{fields:['OK']})
  for (let i=0;i<18;i++) journal.trace('directory','resolve',raw)
  assert.equal(journal.append(key,[{module:'ui',step:'reply',data:raw}]),true)
  journal.trace.withRequest('00000000-0000-4000-8000-000000000001', () => journal.trace('catalog','resolved',{ accepted:true }))
  assert.equal(journal.snapshot({detail:true}).events.at(-1).data.requestId,'00000000-0000-4000-8000-000000000001')
  const stop=journal.setEnabled(false); assert.equal(stop.enabled,false); assert.equal(stop.count,8); assert.ok(stop.dropped>0)
  const text=fs.readFileSync(stop.file,'utf8'); assert.equal(text.trimEnd().split('\n').length,8)
  assert.ok(!/DO_NOT_STORE|never\.example|secret-wire|secret prose/.test(text));assert.match(text,/"origin":"client"/)
  assert.equal(journal.append(key,[]),false);const next=journal.setEnabled(true);assert.notEqual(next.epoch,key);assert.equal(journal.append(key,[]),false)
  journal.clear();assert.equal(fs.readFileSync(stop.file,'utf8'),'');journal.dispose();assert.equal(journal.setEnabled(true).enabled,false)
})

test('version status is local by default; a bounded anonymous lookup is shared and cached',async()=>{
  let calls=0,now=0
  const info=createVersionInfo({now:()=>now,fetch:async(url,init)=>{calls++;assert.equal(new URL(url).origin,'https://registry.npmjs.org');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');return Response.json({name:manifest.name,version:'99.0.0'})}})
  assert.equal((await info.read()).current,manifest.version);assert.equal(calls,0)
  const [a,b]=await Promise.all([info.read({check:true}),info.read({check:true})]);assert.deepEqual(a,b);assert.equal(a.comparison,-1);assert.equal(calls,1)
  now+=1000;await info.read({check:true});assert.equal(calls,1);info.dispose()
  assert.equal(compareVersions('1.2.3-rc.10','1.2.3-rc.2'),1);assert.equal(compareVersions('1.2.3','1.2.3-beta'),1)
  assert.equal(compareVersions('1.2.3+build','1.2.3'),0);assert.equal(compareVersions('1.2.3-01','1.2.3'),null)
})

test('version failure never fabricates latest and a stale success remains marked',async()=>{
  let now=0, broken=false
  const v=createVersionInfo({now:()=>now,fetch:async()=>broken?Response.json({name:'wrong',version:'8.8.8'}):Response.json({name:manifest.name,version:'2.0.0'})})
  assert.equal((await v.read({check:true})).latest,'2.0.0');now+=7*3600000;broken=true;const stale=await v.read({check:true});assert.equal(stale.error,'unavailable');assert.equal(stale.latest,'2.0.0');v.dispose()
  const offline=createVersionInfo({timeoutMs:20,fetch:async()=>new Promise(()=>{})});const r=await offline.read({check:true});assert.equal(r.latest,null);assert.equal(r.error,'unavailable');offline.dispose()
})

test('support routes require explicit one-use scope tokens; preview/read do not dispatch writes',async t=>{
  const routes=new Map(), received=[];const journal=createDebugTrace({dir:scratch(t)});t.after(()=>journal.dispose())
  const connection={fetch:{register:r=>{routes.set(r.path.split('/').at(-1),r);return ()=>{}}}}
  const bulk={inspect:()=>({enabled:false,rows:[],counts:{}}),preview:()=>({ticket:'t',rows:[{status:'pending'}],counts:{pending:1,skipped:0}}),enable:({ticket})=>{if(ticket!=='t')throw Object.assign(Error(),{code:'bulk-efforts/stale'});received.push(ticket);return {enabled:true}},disable:()=>({enabled:false})}
  registerSupportRoutes({effect:f=>f()},{connection:wrapConnection(connection,journal.trace),diagnostics:journal,versions:createVersionInfo(),bulk})
  const req=(key,body)=>{const route=routes.get(key);const request=new Request('http://local/'+key,body?{method:'POST',body:JSON.stringify(body)}:{});
    // Mirrors dsh-client-connection 0.2.2-rc.5's node:http bridge: streaming routes
    // construct a ReadableStream body, which is invalid for GET/HEAD; buffered routes
    // construct an ordinary empty request. This is the HTTP 400 regression fixture.
    if(route.requestBody==='streaming' && ['GET','HEAD'].includes(request.method)) return Promise.resolve(new Response(null,{status:400}));
    return route.fetch(request)}
  assert.equal((await req('diagnostics',{action:'toggle',enabled:'false'})).status,400)
  const key=(await (await req('diagnostics',{action:'toggle',enabled:true})).json()).value.epoch
  assert.equal((await req('diagnostics',{action:'append',epoch:key,events:[]})).status,200)
  assert.equal((await (await req('bulk-efforts',{action:'preview'})).json()).value.eligible,1)
  assert.equal((await req('bulk-efforts',{action:'enable'})).status,400);assert.equal((await req('bulk-efforts',{action:'enable',ticket:'stale'})).status,409)
  assert.deepEqual(received,[]);const accepted=await req('bulk-efforts',{action:'enable',ticket:'t'});assert.equal(accepted.status,200);assert.ok(accepted.headers.get('x-mv-request-id'));assert.deepEqual(received,['t'])
  const before=journal.snapshot().count;await req('diagnostics');assert.equal(journal.snapshot().count,before)
  const stopped = (await (await req('diagnostics',{action:'toggle',enabled:false,detail:true})).json()).value
  assert.equal(stopped.enabled,false);assert.ok(stopped.events.some(e=>e.step==='recording.off'));assert.ok(stopped.events.some(e=>e.step==='response.sent'))
})

test('profile migration creates independent copies, never overwrites legacy; lock covers the read/merge/write', t=>{
  const root=scratch(t), home=path.join(root,'home');const previous=process.env.DSH_HOME;process.env.DSH_HOME=home
  try {
    const options={home,profile:path.join(root,'profile-A')};const b={home,profile:path.join(root,'profile-B')};const src=storageRoot(home,options.profile).legacy
    fs.mkdirSync(src,{recursive:true});fs.writeFileSync(path.join(src,'hidden.json'),'["old-model"]')
    const aFile=profileDataFile('hidden.json',options), bFile=profileDataFile('hidden.json',b);assert.notEqual(aFile,bFile)
    assert.equal(fs.readFileSync(aFile,'utf8'),'["old-model"]');fs.writeFileSync(aFile,'[]');assert.equal(fs.readFileSync(bFile,'utf8'),'["old-model"]');assert.equal(fs.readFileSync(path.join(src,'hidden.json'),'utf8'),'["old-model"]')
    assert.equal(profileDataFile('hidden.json',options),aFile);assert.equal(fs.readFileSync(aFile,'utf8'),'[]');assert.throws(()=>profileDataFile('../secrets',options))
    withStoreLock(aFile,()=>assert.throws(()=>withStoreLock(aFile,()=>{}),{code:'STORE_BUSY'}));assert.doesNotThrow(()=>withStoreLock(aFile,()=>{}))
  } finally {process.env.DSH_HOME=previous}
})
