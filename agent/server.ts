import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { defaults, HealthRegistry, validateProviders, validateSettings, withinHours, monitorHour } from '../core/model';
import { probe, probeTools, ProviderProxy } from '../core/network';
import { AccountStore } from '../core/accounts';
import { inspectProvider, prepareSwitch } from '../core/configuration';
import { acquireLock, privateDirectory, readPrivate, writePrivate, withOperation } from '../core/files';
import { createSnapshot } from '../core/snapshot';
import { executePlan } from '../core/switch';
import { codexProcesses } from '../core/processes';
import { SwitchQueue, SwitchQueueOptions } from '../core/switch-queue';
import { AGENT_VERSION, PROTOCOL_VERSION, AgentConfig, AgentState, AgentStatus, Operation } from './protocol';
import { inspectIdeAdapter } from '../core/ide-adapter';

export function validateConfig(value: AgentConfig): AgentConfig {
  if (!value || !Array.isArray(value.providers) || value.providers.length > 100) throw new Error('供应商列表无效或超过 100 个');
  const providers = validateProviders(value.providers);
  if (new Set(providers.map(p => p.id)).size !== providers.length || providers.some(p => ['openai', 'provider_manager'].includes(p.id))) throw new Error('供应商 ID 重复或使用了保留名称');
  if (!Number.isInteger(value.backupHours) || value.backupHours < 1 || value.backupHours > 168) throw new Error('备份间隔应为 1–168 小时');
  if (typeof value.pythonPath !== 'string' || !value.pythonPath || value.pythonPath.length > 4096) throw new Error('Python 路径无效');
  if (value.sqliteHome !== undefined && (typeof value.sqliteHome !== 'string' || value.sqliteHome.length > 4096)) throw new Error('数据库目录无效');
  if (value.codexPath !== undefined && (typeof value.codexPath !== 'string' || !path.isAbsolute(value.codexPath))) throw new Error('Codex 程序路径需要绝对路径');
  return { providers, settings: validateSettings(value.settings), backupHours: value.backupHours, pythonPath: value.pythonPath, sqliteHome: value.sqliteHome, codexPath: value.codexPath };
}

export class AgentServer {
  private state!: AgentState;
  private credentials: Record<string, string> = Object.create(null);
  private operations: Operation[] = [];
  private pending = new Map<string, Promise<Operation>>();
  private serial: Promise<unknown> = Promise.resolve();
  private writes: Promise<void> = Promise.resolve();
  private server?: http.Server;
  private release?: () => Promise<void>;
  private homeRelease?: () => Promise<void>;
  private proxyRelease?: () => Promise<void>;
  private proxy?: ProviderProxy;
  private proxyError = '';
  private monitorTimer?: NodeJS.Timeout;
  private backupTimer?: NodeJS.Timeout;
  private flushTimer?: NodeJS.Timeout;
  private nextCheck = 0;
  private nextBackup = 0;
  private checking = false;
  private backingUp = false;
  private schedulingSwitch = false;
  private stopped = false;
  private probeAbort = new AbortController();
  private health = new HealthRegistry(() => this.state.config.settings);
  private accounts: AccountStore;
  private switches: SwitchQueue;
  private configChecks: Record<string, Awaited<ReturnType<typeof inspectProvider>>> = {};
  readonly instance = randomBytes(16).toString('hex');
  constructor(readonly folder: string, readonly home: string, private backupScript: string, private mode: 'detached' | 'systemd' = 'detached', private switchTool = path.join(os.homedir(), '.local', 'bin', 'codex-provider'), queueOptions: Partial<SwitchQueueOptions> = {}) {
    this.accounts = new AccountStore(folder, home, () => this.state.config.codexPath, message => this.log(message));
    this.switches = new SwitchQueue(folder, { scan: () => codexProcesses(), execute: id => executePlan(folder, id, true), notify: message => this.log(message), ...queueOptions });
  }

  private file(name: string): string { return path.join(this.folder, name); }
  private async read<T>(name: string, initial: T): Promise<T> {
    try { return JSON.parse(await readPrivate(this.file(name))); }
    catch (e: any) { if (e.code === 'ENOENT') return initial; throw e; }
  }
  private persist(): Promise<void> {
    const content = JSON.stringify(this.state);
    const next = this.writes.catch(() => undefined).then(() => writePrivate(this.file('state.json'), content));
    this.writes = next;
    return next;
  }
  private log(message: string): void {
    this.state.events.unshift({ at: Date.now(), message }); this.state.events.splice(100);
    if (!this.flushTimer && !this.stopped) this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.persist().catch(() => undefined);
    }, 100);
  }
  async start(): Promise<number> {
    await privateDirectory(this.folder);
    try {
      this.homeRelease = await acquireLock(path.join(this.home, 'provider-manager.agent.lock'));
      this.release = await acquireLock(this.file('agent.lock'));
      this.state = await this.read<AgentState>('state.json', { revision: 0, config: { providers: [], settings: defaults, backupHours: 24, pythonPath: 'python3' }, monitorEnabled: false, backupEnabled: false, events: [] });
      this.state.config = validateConfig(this.state.config);
      this.state.checks ||= {};
      await this.accounts.reload();
      if (!Number.isInteger(this.state.revision) || !Array.isArray(this.state.events) || typeof this.state.monitorEnabled !== 'boolean' || typeof this.state.backupEnabled !== 'boolean') throw new Error('后台状态格式错误，请保留文件并排查');
      this.credentials = Object.assign(Object.create(null), await this.read('credentials.json', {}));
      for (const [id, key] of Object.entries(this.credentials)) if (!/^[\w-]{1,64}$/.test(id) || typeof key !== 'string' || !key || key.length > 16384) throw new Error('后台凭据格式错误');
      this.operations = await this.read<Operation[]>('operations.json', []);
      if (!Array.isArray(this.operations)) throw new Error('操作记录格式错误');
      for (const op of this.operations) if (op.state === 'running') { op.state = 'unknown'; op.error = '后台曾退出，执行结果未知；请检查实际状态，不要自动重试'; }
      await writePrivate(this.file('operations.json'), JSON.stringify(this.operations));
      const token = await readPrivate(this.file('control.key'));
      if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('后台认证令牌无效');
      try { await readPrivate(this.file('proxy.key')); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; await writePrivate(this.file('proxy.key'), randomBytes(32).toString('hex')); }
      if (this.state.proxy) {
        try { await withOperation(this.home, () => this.startProxy(this.state.proxy!.group, true)); }
        catch { this.proxyError = '上次代理未能恢复，请检查端口、旧进程和供应商；未更换接入地址'; this.log(this.proxyError); }
      }
      this.server = http.createServer((req, res) => { void this.handle(req, res, token); });
      this.server.requestTimeout = 10000; this.server.headersTimeout = 10000;
      this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
      const port = (this.server.address() as import('node:net').AddressInfo).port;
      await writePrivate(this.file('connection.json'), JSON.stringify({ port, pid: process.pid, instance: this.instance, version: AGENT_VERSION, home: this.home }));
      this.log('本机后台已启动；未确认完成的旧操作不会自动重放。');
      await this.persist();
      await this.switches.start();
      // Missed schedules are not replayed after downtime.
      this.armMonitor(); this.armBackup();
      return port;
    } catch (error) { await this.stop(); throw error; }
  }
  status(): AgentStatus {
    return { version: AGENT_VERSION, protocol: PROTOCOL_VERSION, home: this.home, pid: process.pid, mode: this.mode,
      revision: this.state.revision, config: this.state.config, monitoring: this.state.monitorEnabled, checking: this.checking, nextCheck: this.nextCheck,
      autoBackup: this.state.backupEnabled, backingUp: this.backingUp, nextBackup: this.nextBackup,
      proxy: this.proxy && this.state.proxy ? { ...this.state.proxy, port: this.proxy.port, activeProvider: this.proxy.activeProvider } : null,
      proxyError: this.proxyError, keyIds: Object.keys(this.credentials).filter(id => this.state.config.providers.some(p => p.id === id)),
      health: Object.fromEntries(this.health.states), history: Object.fromEntries(this.health.history), events: this.state.events,
      checks: this.state.checks, accounts: this.accounts.summaries(), configChecks: this.configChecks,
      switchJob: this.switches.status(),
      capabilities: { history: true, existingVSCodeControl: false } };
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
    const reply = (status: number, data: unknown) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); } };
    const received = Buffer.from(req.headers.authorization || ''); const expected = Buffer.from(`Bearer ${token}`);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) { req.resume(); reply(401, { error: '需要本机后台认证' }); return; }
    const port = (this.server?.address() as import('node:net').AddressInfo)?.port;
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) { req.resume(); reply(403, { error: '不接受浏览器来源或非本机地址' }); return; }
    if (req.method === 'GET' && req.url === '/v1/status') { try { await this.accounts.reload(); reply(200, this.status()); } catch { reply(500, { error: '账号目录读取失败，请保留文件并排查' }); } return; }
    if (req.method === 'GET' && /^\/v1\/login\/[a-f0-9-]{36}$/.test(req.url || '')) {
      reply(200, this.accounts.info(req.url!.split('/').pop()!) || null); return;
    }
    if (req.method === 'GET' && /^\/v1\/operations\/[\w-]{1,80}$/.test(req.url || '')) {
      const op = this.operations.find(op => op.id === req.url!.split('/').pop()); reply(op ? 200 : 404, op || { error: '找不到操作记录' }); return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/action') { req.resume(); reply(404, { error: '接口不存在' }); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const part of req) { size += part.length; if (size > 256 * 1024) { reply(413, { error: '管理请求过大' }); return; } chunks.push(part); }
      let value: any;
      try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply(400, { error: '管理请求不是 JSON' }); return; }
      if (!value || typeof value.id !== 'string' || !/^[\w-]{1,80}$/.test(value.id) || typeof value.action !== 'string' || value.action.length > 64) { reply(400, { error: '操作编号或操作名称无效' }); return; }
      const op = await this.dispatch(value.id, value.action, value.payload);
      reply(op.state === 'success' ? 200 : op.state === 'running' ? 202 : 409, op);
    } catch { reply(500, { error: '后台处理失败，结果可能未知；请刷新状态并保留操作编号' }); }
  }
  private dispatch(id: string, action: string, payload: any): Promise<Operation> {
    const digest = createHash('sha256').update(JSON.stringify({ action, payload })).digest('hex');
    const known = this.operations.find(o => o.id === id);
    if (known) {
      if (known.digest !== digest) return Promise.resolve({ ...known, state: 'error', result: undefined, error: '同一操作编号不能用于不同请求' });
      return this.pending.get(id) || Promise.resolve(known);
    }
    const op: Operation = { id, action, digest, at: Date.now(), state: 'running' };
    this.operations.push(op);
    const task = this.serial.catch(() => undefined).then(async () => {
      // Do not evict operation IDs: reconnecting clients must never repeat an old write.
      await writePrivate(this.file('operations.json'), JSON.stringify(this.operations));
      try { if (this.stopped) throw new Error('后台正在停止'); const standalone = ['configure', 'backup', 'proxyStart'].includes(action);
        const release = standalone ? undefined : await acquireLock(path.join(this.home, 'provider-manager.operation.lock'));
        try { op.result = await this.action(action, payload); } finally { await release?.(); } op.state = 'success'; }
      catch (error) { op.state = 'error'; op.error = (error as Error).message; }
      await writePrivate(this.file('operations.json'), JSON.stringify(this.operations));
      return op;
    });
    this.pending.set(id, task); this.serial = task;
    void task.finally(() => this.pending.delete(id)).catch(() => undefined);
    return task;
  }
  private async action(action: string, payload: any): Promise<unknown> {
    if (this.switches.pending() && action !== 'switchCancel') throw new Error('已安排自动切换；请先取消切换，再修改设置或停止后台');
    if (action === 'switchCancel') { await this.switches.cancel(String(payload?.id)); return {}; }
    if (action === 'reviewSwitchFailure') {
      if (payload?.reviewed !== true) throw new Error('请先核对当前账号、对话和备份，再确认失败现场');
      await this.switches.review(String(payload?.id)); return {};
    }
    if (action === 'queueSwitch') {
      if (payload?.mode !== 'afterExit' && payload?.tasksStopped !== true) throw new Error('请先确认任务已结束，再开始自动切换；也可选择安排稍后切换');
      if (this.checking || this.backingUp || this.accounts.hasPending()) throw new Error('检测、备份或登录正在进行，请完成后再切换；没有中断它们');
      if (this.switches.status()?.phase === 'unknown' && !this.switches.status()?.reviewedAt) throw new Error('上次切换结果未知，请先核对当前账号、配置与备份，不自动重新安排');
      const reload = payload?.mode === 'reloadWindow';
      const validateReload = async () => {
        if (!reload) return;
        if (typeof payload.extensionRoot !== 'string' || !path.isAbsolute(payload.extensionRoot) || !Number.isInteger(payload.hostPid) || payload.hostPid <= 0) throw new Error('当前窗口启动信息无效');
        const adapter = await inspectIdeAdapter({ root: payload.extensionRoot, home: this.home, folder: this.folder }, payload.hostPid);
        if (adapter.state !== 'enabled') throw new Error(adapter.reason);
        return adapter;
      };
      const adapter = await validateReload();
      this.schedulingSwitch = true;
      try {
      await fs.access(this.switchTool);
      // Validate the selected account/provider before pausing any existing schedules.
      const plan = await prepareSwitch(this.folder, this.home, String(payload?.id), this.state.config.providers, id => this.credentials[id], payload?.accountId);
      if (adapter) plan.reloadAdapter = { root: payload.extensionRoot, entry: adapter.entry! };
      await this.proxy?.stopIfIdle(); this.proxy = undefined;
      await this.proxyRelease?.(); this.proxyRelease = undefined; this.state.proxy = undefined; this.proxyError = '';
      this.state.monitorEnabled = false; this.state.backupEnabled = false; this.state.revision++;
      await this.persist(); this.armMonitor(); this.armBackup();
      plan.tool = this.switchTool; plan.expectedRevision = this.state.revision;
      await writePrivate(path.join(this.folder, 'plans', plan.id + '.json'), JSON.stringify(plan));
      const job = await this.switches.enqueue(plan, async () => { await validateReload(); });
      this.log('已保存自动切换安排；暂停计划，等待 Codex 退出后备份并切换。'); return job;
      } finally { this.schedulingSwitch = false; }
    }
    if (action === 'configure') {
      if (payload?.revision !== this.state.revision) throw new Error('其他窗口已更新设置，请刷新后再保存');
      const cfg = validateConfig(payload.config);
      if (this.proxy) {
        const normalize = (list: AgentConfig['providers']) => JSON.stringify(list.map(p => ({ ...p, priority: 0 })).sort((a, b) => a.id.localeCompare(b.id)));
        if (normalize(cfg.providers) !== normalize(this.state.config.providers)) throw new Error('请先停止代理，再修改供应商地址、分组或成员');
      }
      const release = await acquireLock(path.join(this.home, 'provider-manager.operation.lock'));
      try {
        for (const provider of cfg.providers) {
          const old = this.state.config.providers.find(p => p.id === provider.id);
          if (!old || old.baseUrl !== provider.baseUrl || old.model !== provider.model) { delete this.state.checks![provider.id]; delete this.configChecks[provider.id]; this.health.states.delete(provider.id); this.health.history.delete(provider.id); }
        }
        this.state.config = cfg; this.state.revision++; await this.persist();
        for (const id of Object.keys(this.credentials)) if (!cfg.providers.some(p => p.id === id)) delete this.credentials[id];
        await writePrivate(this.file('credentials.json'), JSON.stringify(this.credentials));
      } finally { await release(); }
      this.armMonitor(); this.armBackup(); return { revision: this.state.revision };
    }
    if (action === 'setKey') {
      const id = String(payload?.id || '');
      if (!this.state.config.providers.some(p => p.id === id) || typeof payload?.key !== 'string' || !payload.key.trim() || payload.key.length > 16384) throw new Error('供应商或 Key 无效');
      const next = { ...this.credentials, [id]: payload.key.trim() };
      await writePrivate(this.file('credentials.json'), JSON.stringify(next)); this.credentials = next;
      this.state.revision++; this.health.states.delete(id); delete this.state.checks![id]; delete this.configChecks[id]; await this.persist(); this.log('供应商 Key 已安全保存，未记录内容。'); return { stored: true, id };
    }
    if (action === 'probe') {
      const provider = this.state.config.providers.find(p => p.id === payload?.id);
      if (!provider) throw new Error('供应商不存在');
      await this.runProbe(provider); return this.health.states.get(provider.id);
    }
    if (action === 'checkConfig') {
      const provider = this.state.config.providers.find(p => p.id === payload?.id); if (!provider) throw new Error('供应商不存在');
      return this.configChecks[provider.id] = await inspectProvider(this.home, provider, !!this.credentials[provider.id]);
    }
    if (action === 'probeTools') {
      const provider = this.state.config.providers.find(p => p.id === payload?.id); if (!provider) throw new Error('供应商不存在');
      const key = this.credentials[provider.id]; if (!key) throw new Error('请先设置 Key，再测试工具调用');
      const result = await probeTools(provider, key, this.state.config.settings.timeoutSeconds, fetch, this.probeAbort.signal);
      (this.state.checks![provider.id] ||= {}).tools = { ...result, at: Date.now() }; await this.persist();
      this.log(`工具格式测试：${result.reason}`); return result;
    }
    if (action === 'accountCreate') return { id: await this.accounts.create(payload?.name) };
    if (action === 'accountImport') return { id: await this.accounts.importCurrent(payload?.name) };
    if (action === 'accountLogin') { await this.accounts.startLogin(String(payload?.id)); return { started: true }; }
    if (action === 'accountRefresh') { await this.accounts.refresh(String(payload?.id)); return {}; }
    if (action === 'accountCancel') { await this.accounts.cancel(String(payload?.id)); return {}; }
    if (action === 'accountRemove') { await this.accounts.remove(String(payload?.id)); return {}; }
    if (action === 'prepareSwitch') {
      if (this.proxy || this.state.monitorEnabled || this.state.backupEnabled || this.checking || this.backingUp || this.accounts.hasPending()) throw new Error('请先停止代理、暂停监控和定时备份，完成或取消账号登录，再准备切换');
      await fs.access(this.switchTool);
      const plan = await prepareSwitch(this.folder, this.home, String(payload?.id), this.state.config.providers, id => this.credentials[id], payload?.accountId);
      plan.tool = this.switchTool; plan.expectedRevision = this.state.revision;
      await writePrivate(path.join(this.folder, 'plans', plan.id + '.json'), JSON.stringify(plan));
      return { planId: plan.id, target: plan.target, targetName: plan.targetName, model: plan.model, accountId: plan.accountId, home: plan.home };
    }
    if (action === 'monitor') {
      if (typeof payload?.enabled !== 'boolean') throw new Error('监控开关无效');
      if (payload.enabled && !this.state.config.providers.some(p => p.enabled)) throw new Error('请先新增并启用供应商');
      this.state.monitorEnabled = payload.enabled; await this.persist(); this.armMonitor();
      this.log(payload.enabled ? '后台监控已开启，关闭编辑器后继续。' : '后台监控已暂停。'); return {};
    }
    if (action === 'autoBackup') {
      if (typeof payload?.enabled !== 'boolean' || !Number.isInteger(payload?.hours) || payload.hours < 1 || payload.hours > 168) throw new Error('备份开关或间隔无效');
      this.state.backupEnabled = payload.enabled; this.state.config.backupHours = payload.hours; this.state.revision++;
      await this.persist(); this.armBackup(); this.log(payload.enabled ? '后台定时备份已开启。' : '后台定时备份已暂停。'); return {};
    }
    if (action === 'backup') return this.performBackup();
    if (action === 'proxyStart') {
      if (this.proxy) throw new Error('代理已启动');
      await withOperation(this.home, async () => { await this.startProxy(String(payload?.group || ''), false); });
      await this.persist(); return { port: this.proxy!.port };
    }
    if (action === 'proxyStop') {
      await this.proxy?.stop(); this.proxy = undefined;
      await this.proxyRelease?.(); this.proxyRelease = undefined;
      this.state.proxy = undefined; this.proxyError = ''; await this.persist(); this.log('后台代理已停止。'); return {};
    }
    if (action === 'shutdown') {
      if (this.proxy || this.checking || this.backingUp) throw new Error('请先停止代理和监控，并等待正在执行的检查或备份完成');
      if (this.accounts.hasPending()) throw new Error('请先完成或取消官方账号登录，再停止后台');
      this.state.monitorEnabled = false; this.state.backupEnabled = false; this.state.proxy = undefined;
      await this.persist(); setTimeout(() => { void this.stop(); }, 100); return { stopping: true };
    }
    throw new Error('不支持此后台操作');
  }
  private async startProxy(group: string, resume: boolean): Promise<void> {
    const members = this.state.config.providers.filter(p => p.enabled && p.group === group);
    const models = [...new Set(members.map(p => p.model))];
    if (!members.length || models.length !== 1) throw new Error('代理组需要至少一家供应商，且模型 ID 完全相同');
    if (members.some(p => !this.credentials[p.id])) throw new Error('请先为组内所有供应商设置 Key');
    const release = await acquireLock(path.join(this.home, 'provider-manager.proxy.lock'));
    const token = await readPrivate(this.file('proxy.key'));
    const candidate = new ProviderProxy({ group, token, providers: () => this.state.config.providers, settings: () => this.state.config.settings, health: this.health, key: async id => this.credentials[id], log: message => this.log(message) });
    try {
      await candidate.start(this.state.proxy?.group === group ? this.state.proxy.port : 0);
      this.proxy = candidate; this.proxyRelease = release; this.proxyError = '';
      this.state.proxy = { group, model: models[0], port: candidate.port };
      this.log(resume ? '代理已在原端口恢复；中断请求未重放。' : '代理已在独立后台启动，未修改 Codex 配置。');
    } catch (e) { await candidate.stop(); await release(); throw e; }
  }
  private async runProbe(provider: AgentConfig['providers'][number]): Promise<void> {
    const key = this.credentials[provider.id];
    const result = key ? await probe(provider, key, this.state.config.settings.timeoutSeconds, fetch, this.probeAbort.signal) : { ok: false, status: 401, reason: '尚未设置 Key' };
    this.health.record(provider.id, result.ok, result.status, result.reason);
    (this.state.checks![provider.id] ||= {}).text = { ...result, at: Date.now() };
    this.log(`检测 ${provider.name}：${result.reason}`);
  }
  private armMonitor(): void {
    clearTimeout(this.monitorTimer); this.monitorTimer = undefined; this.nextCheck = 0;
    if (this.stopped || !this.state.monitorEnabled) return;
    const delay = this.state.config.settings.intervalSeconds * 1000;
    this.nextCheck = Date.now() + delay;
    this.monitorTimer = setTimeout(() => { this.monitorTimer = undefined; void this.tick(); }, delay);
  }
  private async tick(): Promise<void> {
    if (this.checking || this.schedulingSwitch || this.switches.pending()) { this.armMonitor(); return; }
    this.checking = true;
    try {
      const { settings, providers } = this.state.config;
      if (withinHours(settings, monitorHour(settings))) for (const provider of providers) {
        if (this.stopped || !this.state.monitorEnabled) break;
        if (provider.enabled && (this.health.states.get(provider.id)?.unavailableUntil || 0) <= Date.now()) await this.runProbe(provider);
      }
    } catch { this.log('后台监控失败，等待下一次计划检查。'); }
    finally { this.checking = false; this.armMonitor(); }
  }
  private armBackup(): void {
    clearTimeout(this.backupTimer); this.backupTimer = undefined; this.nextBackup = 0;
    if (this.stopped || !this.state.backupEnabled) return;
    const delay = this.state.config.backupHours * 3600000;
    this.nextBackup = Date.now() + delay;
    this.backupTimer = setTimeout(() => { this.backupTimer = undefined; void (async () => {
      if (this.stopped || !this.state.backupEnabled) return;
      if (this.schedulingSwitch || this.switches.pending()) { this.armBackup(); return; }
      try { await this.performBackup(); } catch { this.log('定时备份未通过；请检查代理、操作锁、磁盘和会话一致性。本轮未执行后续写操作。'); }
      this.armBackup();
    })(); }, delay);
  }
  private async performBackup(): Promise<{ backup: string; sessions: number }> {
    if (this.backingUp) throw new Error('后台备份正在执行');
    this.backingUp = true;
    try {
      return await withOperation(this.home, async () => {
        const result = await createSnapshot(this.home, this.backupScript, this.state.config.pythonPath, this.state.config.sqliteHome);
        this.log(`完整备份通过：${result.sessions} 条会话。`); return result;
      });
    } finally { this.backingUp = false; }
  }
  async stop(): Promise<void> {
    if (this.stopped) return; this.stopped = true;
    clearTimeout(this.monitorTimer); clearTimeout(this.backupTimer); clearTimeout(this.flushTimer);
    this.probeAbort.abort();
    this.accounts.stop();
    await this.switches.stop();
    await this.proxy?.stop(); this.proxy = undefined;
    await this.proxyRelease?.(); this.proxyRelease = undefined;
    if (this.server) await new Promise<void>(resolve => { this.server!.close(() => resolve()); this.server!.closeAllConnections(); });
    if (this.state) await this.persist().catch(() => undefined);
    try { if (JSON.parse(await readPrivate(this.file('connection.json'))).instance === this.instance) await fs.unlink(this.file('connection.json')); } catch { /* Another instance owns it or there is no connection file. */ }
    await this.release?.(); this.release = undefined;
    await this.homeRelease?.(); this.homeRelease = undefined;
  }
}
