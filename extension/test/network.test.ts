import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { ProviderProxy, probe } from '../src/network';
import { defaults, HealthRegistry, Provider } from '../src/model';
const complete = 'data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed","response":{}}\n\n';
const p = (id: string, baseUrl: string): Provider => ({ id, name: id, group: 'group', model: 'synthetic-model', baseUrl, priority: id === 'a' ? 0 : 10, enabled: true });
async function upstream(handler: http.RequestListener) {
  const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { url: `http://127.0.0.1:${(server.address() as any).port}/v1`, stop: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
async function proxy(providers: Provider[], fetcher?: typeof fetch) {
  const health = new HealthRegistry(() => defaults);
  const logs: string[] = [];
  const router = new ProviderProxy({ providers: () => providers, group: 'group', token: 'local-token', settings: () => defaults, health, key: async id => `${id}-secret`, log: m => logs.push(m), fetcher });
  await router.start();
  return { router, health, logs, request: (extra = {}, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${router.port}/v1/responses`, { method: 'POST', headers: { Authorization: 'Bearer local-token', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ model: 'synthetic-model', input: [{ role: 'user', content: 'Synthetic' }], stream: true, ...extra }) }) };
}
test('503 时切到备用供应商，密钥独立且不转发本机令牌', async () => {
  let first = 0, second = 0;
  const a = await upstream((req, res) => { first++; assert.equal(req.headers.authorization, 'Bearer a-secret'); res.writeHead(503).end('private upstream error'); });
  const b = await upstream((req, res) => { second++; assert.equal(req.headers.authorization, 'Bearer b-secret'); assert.equal(req.url, '/v1/responses'); res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(complete); });
  const r = await proxy([p('a', a.url), p('b', b.url)]);
  try { const res = await r.request(); assert.equal(res.status, 200); assert.equal(await res.text(), complete); assert.equal(first, 1); assert.equal(second, 1); assert.equal(r.router.activeProvider, 'b'); assert(!r.logs.join().includes('secret')); }
  finally { await r.router.stop(); await a.stop(); await b.stop(); }
});
test('未认证、跨域和后端引用请求不会到达供应商', async () => {
  let calls = 0; const s = await upstream((req, res) => { calls++; res.end(); }); const r = await proxy([p('a', s.url)]);
  try {
    assert.equal((await r.request({}, { Authorization: '' })).status, 401);
    assert.equal((await r.request({}, { Origin: 'https://malicious.invalid' })).status, 403);
    assert.equal((await r.request({ previous_response_id: 'remote-id' })).status, 409);
    assert.equal((await r.request({ background: true })).status, 409);
    assert.equal(calls, 0);
  } finally { await r.router.stop(); await s.stop(); }
});
test('400 不切换到其他供应商、不暴露上游错误正文', async () => {
  const calls: string[] = []; const fetcher = (async (url: any) => { calls.push(url); return new Response('SECRET-UPSTREAM', { status: 400 }); }) as typeof fetch;
  const r = await proxy([p('a', 'https://a.invalid/v1'), p('b', 'https://b.invalid/v1')], fetcher);
  try { const res = await r.request(); assert.equal(res.status, 400); assert(!((await res.text()).includes('SECRET-UPSTREAM'))); assert.equal(calls.length, 1); }
  finally { await r.router.stop(); }
});
test('网络执行结果不确定时不会向备用供应商重放', async () => {
  let calls = 0; const fetcher = (async () => { calls++; throw new Error('private connection text'); }) as typeof fetch;
  const r = await proxy([p('a', 'https://a.invalid/v1'), p('b', 'https://b.invalid/v1')], fetcher);
  try { const res = await r.request(); assert.equal(res.status, 502); assert((await res.text()).includes('未自动重放')); assert.equal(calls, 1); }
  finally { await r.router.stop(); }
});
test('已开始的流中断不会自动重放工具调用', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: {"type":"response.output_item.added","item":{"type":"function_call"}}\n\n')); setTimeout(() => controller.error(new Error('stream gone')), 25); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const r = await proxy([p('a', 'https://a.invalid/v1'), p('b', 'https://b.invalid/v1')], fetcher);
  try { const res = await r.request(); await assert.rejects(res.text()); assert.equal(calls, 1); }
  finally { await r.router.stop(); }
});
test('401 供应商进入等待，备用供应商可用', async () => {
  const calls: string[] = []; const fetcher = (async (url: any) => { calls.push(url); return String(url).includes('a.invalid') ? new Response('', { status: 401 }) : new Response(complete, { headers: { 'Content-Type': 'text/event-stream' } }); }) as typeof fetch;
  const r = await proxy([p('a', 'https://a.invalid/v1'), p('b', 'https://b.invalid/v1')], fetcher);
  try { await (await r.request()).text(); await (await r.request()).text(); assert.equal(calls.filter(x => x.includes('a.invalid')).length, 1); assert.equal(calls.length, 3); }
  finally { await r.router.stop(); }
});
test('探测要求 Responses 流完整完成，HTTP 200 不直接算通过', async () => {
  const fetcher = (body: string) => (async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
  assert.equal((await probe(p('a', 'https://a.invalid'), 'private', 5, fetcher(complete))).ok, true);
  assert.equal((await probe(p('a', 'https://a.invalid'), 'private', 5, fetcher('data: {"type":"response.failed"}\n\n'))).ok, false);
  assert.equal((await probe(p('a', 'https://a.invalid'), 'private', 5, fetcher('data: {"type":"response.output_text.delta","delta":"OK"}\n\n'))).ok, false);
});

test('自动切换不能中断正在处理的代理请求；请求完成后才关闭代理', async () => {
  let accepted!:()=>void,finish!:()=>void;
  const started=new Promise<void>(resolve=>{accepted=resolve;});
  const s=await upstream((req,res)=>{req.resume();res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"type":"response.output_text.delta","delta":"OK"}\n\n');finish=()=>res.end('data: {"type":"response.completed"}\n\n');accepted();});
  const r=await proxy([p('a',s.url)]);
  try {
    const pending=r.request();await started;const response=await pending;
    await assert.rejects(r.router.stopIfIdle(),/没有中断请求/);assert(r.router.port>0);
    finish();assert((await response.text()).includes('response.completed'));
    await new Promise(resolve=>setTimeout(resolve,10));await r.router.stopIfIdle();assert.equal(r.router.port,0);
  } finally {await r.router.stop();await s.stop();}
});
