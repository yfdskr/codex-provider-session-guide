import http, { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { HealthRegistry, MonitorSettings, Provider } from './model';

export type KeyResolver = (id: string) => Promise<string | undefined>;
const retryable = new Set([429, 502, 503, 504]);
export async function probe(provider: Provider, key: string, timeoutSeconds: number, fetcher: typeof fetch = fetch, externalSignal?: AbortSignal): Promise<{ ok: boolean; status?: number; reason: string }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const response = await fetcher(`${provider.baseUrl}/responses`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: provider.model, stream: true, store: false, input: [{ role: 'user', content: 'Reply with OK.' }] }), signal: controller.signal, redirect: 'error'
    });
    if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, reason: `HTTP ${response.status}` }; }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); return { ok: false, status: response.status, reason: '接口没有返回 Responses 流式内容' }; }
    let total = 0, tail = '', completed = false, hasText = false, failed = false;
    for await (const bytes of response.body!) {
      total += bytes.byteLength;
      if (total > 1024 * 1024) throw new Error('检测响应过大');
      tail += Buffer.from(bytes).toString('utf8');
      let newline: number;
      while ((newline = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, newline).trim(); tail = tail.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        try {
          const event = JSON.parse(line.slice(5).trim());
          if (event.type === 'response.output_text.delta' && event.delta) hasText = true;
          if (event.type === 'response.completed') { completed = true; hasText ||= !!event.response?.output?.some((item: any) => item.content?.some((part: any) => part.type === 'output_text' && part.text)); }
          if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) failed = true;
        } catch { /* SSE may include [DONE]. */ }
      }
    }
    return { ok: completed && hasText && !failed, status: response.status, reason: completed && hasText && !failed ? '文字流式检测通过；工具和上下文需另测' : '未收到完整文字回复' };
  } catch {
    return { ok: false, reason: controller.signal.aborted ? '检测超时' : '连接失败，请核对地址、证书和网络' };
  } finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
}

export interface ProxyOptions {
  group: string; token: string; providers: () => Provider[]; settings: () => MonitorSettings;
  health: HealthRegistry; key: KeyResolver; log: (message: string) => void; fetcher?: typeof fetch;
}

export async function probeTools(provider: Provider, key: string, timeoutSeconds: number, fetcher: typeof fetch = fetch, externalSignal?: AbortSignal): Promise<{ ok: boolean; status?: number; reason: string }> {
  const controller = new AbortController(), abort = () => controller.abort();
  externalSignal?.addEventListener('abort', abort, { once: true });
  if (externalSignal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeoutSeconds * 1000);
  try {
    const response = await fetcher(`${provider.baseUrl}/responses`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, redirect: 'error', signal: controller.signal,
      body: JSON.stringify({ model: provider.model, stream: true, store: false, input: 'Call cpm_connection_check once with value OK. This is a synthetic interface test.', tools: [{ type: 'function', name: 'cpm_connection_check', description: 'Return a synthetic value; the client will not execute this function.', strict: true, parameters: { type: 'object', properties: { value: { type: 'string', enum: ['OK'] } }, required: ['value'], additionalProperties: false } }], tool_choice: { type: 'function', name: 'cpm_connection_check' }, parallel_tool_calls: false }) });
    if (!response.ok) { await response.body?.cancel(); return { ok: false, status: response.status, reason: `工具接口返回 HTTP ${response.status}，文字可用性需分别判断` }; }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel(); return { ok: false, status: response.status, reason: '工具测试未返回 Responses 流' }; }
    let size = 0, tail = '', complete = false, failed = false;
    const calls = new Map<string, any>();
    for await (const bytes of response.body!) {
      size += bytes.byteLength; if (size > 1024 * 1024) throw new Error('Response too large');
      tail += Buffer.from(bytes).toString('utf8'); let newline: number;
      while ((newline = tail.indexOf('\n')) >= 0) {
        const line = tail.slice(0, newline).trim(); tail = tail.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        let event: any; try { event = JSON.parse(line.slice(5)); } catch { continue; }
        if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') calls.set(event.item.call_id || event.item.id || 'single', event.item);
        if (event.type === 'response.completed') { complete = true; for (const item of event.response?.output || []) if (item.type === 'function_call') calls.set(item.call_id || item.id || 'single', item); }
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) failed = true;
      }
    }
    const values = [...calls.values()]; let valid = false;
    try { const args = JSON.parse(values[0]?.arguments); valid = values.length === 1 && values[0].name === 'cpm_connection_check' && args.value === 'OK' && Object.keys(args).length === 1; } catch { /* No valid function call. */ }
    const ok = complete && !failed && valid;
    return { ok, status: response.status, reason: ok ? '工具调用格式检测通过；未执行工具，真实工具和长上下文需另测' : '未收到预期的完整工具调用；文字通过不代表工具可用' };
  } catch { return { ok: false, reason: controller.signal.aborted ? '工具测试超时' : '工具测试连接失败，未执行任何工具' }; }
  finally { clearTimeout(timer); externalSignal?.removeEventListener('abort', abort); }
}
function authenticated(value: string | undefined, token: string): boolean {
  const received = Buffer.from(value ?? ''); const expected = Buffer.from(`Bearer ${token}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}
export class ProviderProxy {
  private server?: http.Server;
  private accepting = true;
  private requests = 0;
  private readonly controllers = new Set<AbortController>();
  port = 0;
  activeProvider = '';
  constructor(private options: ProxyOptions) {}
  async start(port = 0): Promise<number> {
    if (this.server) throw new Error('代理已启动');
    this.accepting = true;
    const server = http.createServer((req, res) => {
      if (!this.accepting) { this.reply(res, 503, '代理正在准备切换，暂不接受新请求'); req.resume(); return; }
      this.requests++; let finished = false;
      const done = () => { if (!finished) { finished = true; this.requests--; } };
      res.once('finish', done); res.once('close', done);
      void this.handle(req, res);
    });
    server.requestTimeout = 60000;
    this.server = server;
    try { server.listen(port, '127.0.0.1'); await once(server, 'listening'); }
    catch (error) { this.server = undefined; throw error; }
    this.port = (server.address() as import('node:net').AddressInfo).port;
    return this.port;
  }
  async stop(): Promise<void> {
    const server = this.server; this.server = undefined; this.port = 0;
    for (const controller of this.controllers) controller.abort();
    if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  async stopIfIdle(): Promise<void> {
    if (this.requests || this.controllers.size) throw new Error('代理仍有请求正在处理，请等当前请求结束再切换；没有中断请求');
    this.accepting = false; await this.stop();
  }
  private reply(res: ServerResponse, status: number, message: string): void {
    if (res.destroyed || res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'provider_manager_error' } }));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const o = this.options;
    if (!authenticated(req.headers.authorization, o.token)) { this.reply(res, 401, '需要本机代理令牌'); req.resume(); return; }
    if (req.method !== 'POST' || req.url !== '/v1/responses') { this.reply(res, 404, '首版只提供 POST /v1/responses'); req.resume(); return; }
    if (req.headers.origin) { this.reply(res, 403, '不接受浏览器跨域请求'); req.resume(); return; }
    const controller = new AbortController(); this.controllers.add(controller);
    res.on('close', () => controller.abort());
    let timer: NodeJS.Timeout | undefined;
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) { this.reply(res, 413, '请求超过预览版 8 MiB 限制'); req.resume(); return; } chunks.push(chunk); }
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { this.reply(res, 400, '请求不是 JSON'); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.model !== 'string' || payload.stream !== true || !payload.input) { this.reply(res, 400, '需要 model、input 和 stream: true'); return; }
      if (payload.previous_response_id || payload.background === true) { this.reply(res, 409, '预览版需要完整历史输入，不支持 previous_response_id 或后台请求'); return; }
      const candidates = o.health.candidates(o.providers(), o.group, payload.model);
      if (!candidates.length) { this.reply(res, 503, '没有可用的同模型供应商，请查看监控面板'); return; }
      timer = setTimeout(() => controller.abort(), o.settings().timeoutSeconds * 1000);
      for (const provider of candidates) {
        if (controller.signal.aborted) break;
        const key = await o.key(provider.id);
        if (!key) { o.health.record(provider.id, false, 401, '尚未设置 Key'); continue; }
        let upstream: Response;
        try {
          upstream = await (o.fetcher ?? fetch)(`${provider.baseUrl}/responses`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, Accept: 'text/event-stream' },
            body: JSON.stringify(payload), redirect: 'error', signal: controller.signal
          });
        } catch {
          o.health.record(provider.id, false, undefined, '连接中断或超时，执行情况不确定');
          o.log(`请求中断：${provider.name}；未自动重放。`);
          this.reply(res, 502, '连接中断或超时，执行情况不确定；未自动重放，请检查任务结果'); return;
        }
        if (!upstream.ok) {
          await upstream.body?.cancel();
          o.health.record(provider.id, false, upstream.status, `HTTP ${upstream.status}`);
          if (retryable.has(upstream.status) || [401, 403].includes(upstream.status)) { o.log(`${provider.name} 返回 HTTP ${upstream.status}，检查备用供应商。`); continue; }
          this.reply(res, upstream.status, `供应商返回 HTTP ${upstream.status}；请检查请求或接口兼容性`); return;
        }
        if (!upstream.headers.get('content-type')?.includes('text/event-stream')) { await upstream.body?.cancel(); this.reply(res, 502, '上游未返回 Responses 流式内容；未重放'); return; }
        o.health.record(provider.id, true, upstream.status, '已连接，任务结果由 Codex 判断');
        if (this.activeProvider !== provider.id) { this.activeProvider = provider.id; o.log(`当前请求使用：${provider.name}（${o.group}）。`); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        // Once any stream is accepted, never replay it against another provider.
        try { for await (const chunk of upstream.body!) { timer?.refresh(); if (!res.write(Buffer.from(chunk))) await once(res, 'drain', { signal: controller.signal }); } res.end(); }
        catch { o.health.record(provider.id, false, undefined, '回复流中断'); res.destroy(); o.log('回复流中断；未自动重放，检查是否已有工具执行。'); }
        return;
      }
      this.reply(res, 503, '本组供应商均不可用；查看监控状态后重试');
    } catch { this.reply(res, 502, '代理处理失败；请求未自动重放'); }
    finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
}
