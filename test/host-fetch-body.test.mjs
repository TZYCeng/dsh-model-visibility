import test from 'node:test'
import assert from 'node:assert/strict'
import { registerSupportRoutes } from '../lib/host-http.js'
import { registerCoreRoutes } from '../lib/host-routes.js'

/** Behavioral fixture for the installed dsh-client-connection 0.2.2-rc.5 bridge:
 * buffered GET has no body; a streaming GET attempts a stream-body Request and the
 * Fetch bridge fails with HTTP 400 before the exact route handler is called. */
function bridge(route, method, body) {
  // Exact behavior from the installed connection 0.2.2-rc.5 http-bridge.ts.
  if (route.requestBody === 'streaming' && (method === 'GET' || method === 'HEAD')) {
    try { new Request('http://local/api/test', { method, body: new ReadableStream(), duplex: 'half' }) }
    catch { return Promise.resolve({ status: 400, body: null, handlerCalled: false }) }
  }
  const request = new Request('http://local/api/test', { method, ...(route.requestBody === 'buffered' && body !== undefined ? { body } : {}) })
  return route.fetch(request).then(async response => ({ status: response.status, body: response.body === null ? null : await response.text(), handlerCalled: true }))
}

test('every bodyless GET in the v1.16 exact routes uses buffered mode and reaches its handler', async () => {
  const routes = new Map()
  const register = { fetch: { register: route => { routes.set(route.path.split('/').at(-1), route); return () => {} } } }
  const deps = { connection: register, diagnostics: { snapshot: () => ({ enabled:false }), setEnabled(){}, append(){return true}, clear(){return{} } },
    versions: { read: async () => ({current:'1.16.1'}) }, bulk: { inspect:()=>({rows:[],counts:{}}) } }
  registerSupportRoutes({ effect: fn => fn() }, deps)
  const service = { invalidate(){}, read: async () => ({groups:[],failures:[]}) }
  const overrideStore = { invalidate(){}, read:()=>({overrides:[],revisions:[]}) }
  const usage = { read:()=>({ranges:{}}) }
  const verifier = { snapshot:()=>({phase:'idle'}), cancel:()=>({cancelled:false}), isRunning:()=>false, start:async()=>({}) }
  registerCoreRoutes({ effect: fn => fn() }, { connection:register, service, probe:null, clearFallbackProfiles(){}, overrides:overrideStore,
    learnedService:{ invalidate(){}, meta:()=>({}), assertReadable(){}, getExact:()=>undefined }, imageInput:{refresh(){}}, usageLedger:usage,
    maybeRescan(){}, resetRescan(){}, verifier, settings:{}, configEditor:{}, logger:{warn(){}}, liveList:()=>[], trace:()=>{} })
  for (const name of ['version','diagnostics','bulk-efforts','models','overrides','usage','verify']) {
    const route=routes.get(name); assert.ok(route,name); assert.equal(route.requestBody,'buffered',name)
    const result=await bridge(route,'GET')
    assert.equal(result.status,200,name);assert.equal(result.handlerCalled,true,name)
  }
})

test('the old shared streaming mode reproduces the HTTP 400 for a bodyless GET', async () => {
  const route = { requestBody: 'streaming', async fetch() { return Response.json({ ok: true }) } }
  assert.deepEqual(await bridge(route, 'GET'), { status: 400, body: null, handlerCalled: false })
})

test('a buffered POST body is still consumed exactly once by the JSON control reader',async()=>{
  const route={requestBody:'buffered',async fetch(request){const body=await request.json();return Response.json({action:body.action})}}
  const result=await bridge(route,'POST',JSON.stringify({action:'toggle'}))
  assert.equal(result.status,200);assert.equal(result.body,'{"action":"toggle"}')
})
