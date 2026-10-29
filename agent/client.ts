import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { acquireLock, privateDirectory, readPrivate, writePrivate } from '../core/files';
import { AGENT_VERSION, PROTOCOL_VERSION, AgentState, AgentStatus, Operation } from './protocol';
import { LoginInfo } from '../core/accounts';

export interface ClientOptions {
  home: string; storageRoot: string; agentScript: string; backupScript: string; nodePath: string;
  /** Overrides are used by isolated service tests; the extension uses system defaults. */
  serviceDirectory?: string; serviceCommand?: (args: string[]) => Promise<void>;
}
export function serviceUnit(node: string, executable: string, folder: string, searchPath: string): string {
  const quote = (value: string, exec = false): string => {
    if (/[\r\n\0]/.test(value)) throw new Error('服务路径或环境变量包含非法字符');
    const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    return '"' + (exec ? escaped.replaceAll('$', '$$') : escaped) + '"';
  };
  return `[Unit]\nDescription=Codex Provider Manager local agent\n\n[Service]\nType=simple\nExecStart=${quote(node, true)} ${quote(executable, true)} --state ${quote(folder, true)}\nEnvironment=CPM_SYSTEMD=1\nEnvironment=ELECTRON_RUN_AS_NODE=1\nEnvironment=${quote('PATH=' + searchPath)}\nUMask=0077\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=20\n\n[Install]\nWantedBy=default.target\n`;
}
export class AgentClient {
  readonly folder: string;
  readonly unitName: string;
  readonly proxyTokenPath: string;
  constructor(readonly options: ClientOptions) {
    if (!path.isAbsolute(options.home) || !path.isAbsolute(options.storageRoot)) throw new Error('Codex 和后台目录需要绝对路径');
    const id = createHash('sha256').update(options.home).digest('hex').slice(0, 24);
    this.folder = path.join(options.storageRoot, 'agents', id);
    this.proxyTokenPath = path.join(this.folder, 'proxy.key');
    this.unitName = `codex-provider-manager-${id}.service`;
  }
  private serviceDirectory(): string { return this.options.serviceDirectory || path.join(os.homedir(), '.config', 'systemd', 'user'); }
  private async serviceCommand(args: string[]): Promise<void> {
    if (this.options.serviceCommand) return this.options.serviceCommand(args);
    try { await promisify(execFile)('systemctl', ['--user', ...args], { timeout: 10000, maxBuffer: 1024 * 1024 }); }
    catch { throw new Error(`Linux 用户服务操作 ${args[0]} 未确认成功。请检查 systemctl --user 是否可用，并查看后台状态；不要重复安装或删除配置。`); }
  }
  async savedState(): Promise<AgentState | undefined> {
    try { return JSON.parse(await readPrivate(path.join(this.folder, 'state.json'))); }
    catch (e: any) { if (e.code === 'ENOENT') return undefined; throw e; }
  }
  private async request<T>(route: string, body?: unknown, timeout = 3000): Promise<T> {
    const endpoint = JSON.parse(await readPrivate(path.join(this.folder, 'connection.json')));
    if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || endpoint.home !== this.options.home) throw new Error('后台连接信息无效');
    const token = await readPrivate(path.join(this.folder, 'control.key'));
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request({ host: '127.0.0.1', port: endpoint.port, path: route, method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }) } }, res => {
        let size = 0; const chunks: Buffer[] = [];
        res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('后台响应过大')); else chunks.push(chunk); });
        res.on('error', () => reject(new Error('后台响应中断')));
        res.on('end', () => {
          try {
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (res.statusCode === 401 || res.statusCode === 403) throw new Error('后台认证失败，请检查本机目录和连接权限');
            if (result?.error && !result.id) throw new Error(result.error);
            resolve(result);
          } catch (e) { reject(e); }
        });
      });
      req.setTimeout(timeout, () => req.destroy(new Error('后台连接超时')));
      req.on('error', () => reject(new Error('无法连接后台；请刷新状态或启动后台')));
      req.end(data);
    });
  }
  async status(): Promise<AgentStatus> {
    const status = await this.request<AgentStatus>('/v1/status');
    if (status.protocol !== PROTOCOL_VERSION || status.home !== this.options.home) throw new Error('后台协议或目录不匹配；请停止旧后台后重新启动');
    return status;
  }
  async statusIfRunning(): Promise<AgentStatus | undefined> {
    try { return await this.status(); }
    catch (e: any) {
      if (e.code === 'ENOENT' || /无法连接后台/.test(e.message)) return undefined;
      throw e;
    }
  }
  async action<T = unknown>(action: string, payload?: unknown, id = randomUUID()): Promise<T> {
    let result: Operation;
    try { result = await this.request<Operation>('/v1/action', { id, action, payload }, 195000); }
    catch { throw new Error(`后台操作结果未知，编号 ${id}。请刷新实际状态；不要直接重复操作。可用查询操作编号功能核对。`); }
    if (result.state !== 'success') throw new Error(result.error || `后台操作尚未完成，编号 ${id}；请先查询结果`);
    return result.result as T;
  }
  async operation(id: string): Promise<Operation> {
    if (!/^[\w-]{1,80}$/.test(id)) throw new Error('操作编号无效');
    return this.request(`/v1/operations/${id}`);
  }
  async loginInfo(id: string): Promise<LoginInfo | null> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('账号编号无效');
    return this.request(`/v1/login/${id}`);
  }
  switchCommand(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('计划编号无效');
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    return [this.options.nodePath, path.join(this.folder, 'runtime', AGENT_VERSION, 'switch.js'), '--state', this.folder, '--plan', id, '--tasks-stopped'].map(quote).join(' ');
  }
  private async prepare(): Promise<string> {
    try {
      const { stdout } = await promisify(execFile)(this.options.nodePath, ['-p', 'process.versions.node'], { timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      if (Number(stdout.trim().split('.')[0]) < 20 || !/^\d+\.\d+\.\d+$/.test(stdout.trim())) throw new Error('Unsupported runtime');
    } catch { throw new Error('后台需要 Node.js 20 或以上；请检查 nodePath 设置'); }
    await privateDirectory(this.folder);
    const runtime = path.join(this.folder, 'runtime', AGENT_VERSION);
    await privateDirectory(runtime);
    const executable = path.join(runtime, 'agent.js');
    // Never alter the files used by a live service. Same-version runtime must match.
    for (const [source, name] of [[this.options.agentScript, 'agent.js'], [path.join(path.dirname(this.options.agentScript), 'switch.js'), 'switch.js'], [this.options.backupScript, 'backup.py'], [path.join(path.dirname(this.options.backupScript), 'switch.py'), 'switch.py']]) {
      const content = await fs.readFile(source, 'utf8'); const target = path.join(runtime, name);
      try { if (await readPrivate(target) !== content) throw new Error('同版本后台文件已变化，请先升级扩展版本再部署'); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; await writePrivate(target, content); }
    }
    try { await readPrivate(path.join(this.folder, 'control.key')); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; await writePrivate(path.join(this.folder, 'control.key'), randomBytes(32).toString('hex')); }
    await writePrivate(path.join(this.folder, 'launch.json'), JSON.stringify({ home: this.options.home, backupScript: path.join(runtime, 'backup.py') }));
    return executable;
  }
  async ensureStarted(): Promise<AgentStatus> {
    const compatible = (value: AgentStatus): AgentStatus => { if (value.version !== AGENT_VERSION) throw new Error('后台需要升级，请在“本机后台”点击“升级后台”；先暂停计划并停止代理'); return value; };
    const existing = await this.statusIfRunning(); if (existing) return compatible(existing);
    await privateDirectory(this.folder);
    let release;
    try { release = await acquireLock(path.join(this.folder, 'start.lock')); }
    catch {
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const other = await this.statusIfRunning(); if (other) return compatible(other);
      }
      throw new Error('其他窗口正在启动后台；请稍后刷新');
    }
    try {
      const other = await this.statusIfRunning(); if (other) return compatible(other);
      const executable = await this.prepare();
      // If installed, systemd owns lifecycle; never silently compete with it.
      const unit = path.join(this.serviceDirectory(), this.unitName);
      if (await fs.access(unit).then(() => true, () => false)) {
        await this.serviceCommand(['start', this.unitName]);
      } else {
        const log = await fs.open(path.join(this.folder, 'agent.log'), 'a', 0o600);
        try {
          const child = spawn(this.options.nodePath, [executable, '--state', this.folder], { detached: true, stdio: ['ignore', log.fd, log.fd], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('后台无法启动，请检查 Node 路径'))); });
          child.unref();
        } finally { await log.close(); }
      }
      for (let attempt = 0; attempt < 80; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const started = await this.statusIfRunning(); if (started) return compatible(started);
      }
      throw new Error('后台未能就绪；请检查后台日志、旧进程和 Node 路径');
    } finally { await release(); }
  }
  async upgrade(): Promise<AgentStatus> {
    const state = await this.statusIfRunning();
    if (state && (state.switchJob && ['waiting','running'].includes(state.switchJob.phase))) throw new Error('请先取消等待中的账号切换，或等待切换完成，再升级后台');
    if (state && (state.proxy || state.monitoring || state.autoBackup || state.checking || state.backingUp || state.accounts?.some(a => a.pending))) throw new Error('请先暂停监控、定时备份，停止代理，完成或取消登录，再升级后台');
    if (state) { await this.action('shutdown'); for (let i = 0; i < 80 && await this.statusIfRunning(); i++) await new Promise(resolve => setTimeout(resolve, 100)); }
    if (await this.statusIfRunning()) throw new Error('旧后台仍在运行，未替换服务');
    const info = await this.serviceInfo();
    if (info.installed) await this.installService();
    return this.ensureStarted();
  }
  async serviceInfo(): Promise<{ installed: boolean; linger: boolean | null; unit: string }> {
    const installed = await fs.access(path.join(this.serviceDirectory(), this.unitName)).then(() => true, () => false);
    let linger: boolean | null = null;
    if (process.platform === 'linux') try {
      const { stdout } = await promisify(execFile)('loginctl', ['show-user', String(process.getuid!()), '-p', 'Linger', '--value'], { timeout: 3000 });
      linger = stdout.trim() === 'yes';
    } catch { /* Display unknown rather than claiming logout survival. */ }
    return { installed, linger, unit: this.unitName };
  }
  async installService(): Promise<void> {
    if (process.platform !== 'linux') throw new Error('系统后台安装目前只支持 Linux');
    // Check availability before changing files or stopping a detached service.
    await this.serviceCommand(['show', '--property=Version', '--value']);
    const state = await this.statusIfRunning();
    if (state && (state.proxy || state.monitoring || state.autoBackup || state.checking || state.backingUp || state.accounts?.some(a => a.pending))) throw new Error('请先暂停监控和定时备份、停止代理并等待操作完成，再安装系统服务');
    if (state) {
      await this.action('shutdown');
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!await this.statusIfRunning()) break;
      }
      if (await this.statusIfRunning()) throw new Error('旧后台仍在运行，未安装新服务');
    }
    const executable = await this.prepare();
    const directory = this.serviceDirectory(); await fs.mkdir(directory, { recursive: true });
    const unit = serviceUnit(this.options.nodePath, executable, this.folder, process.env.PATH || '/usr/bin:/bin');
    await writePrivate(path.join(directory, this.unitName), unit);
    await this.serviceCommand(['daemon-reload']);
    await this.serviceCommand(['enable', '--now', this.unitName]);
    await this.ensureStarted();
  }
  async removeService(): Promise<void> {
    if (process.platform !== 'linux') throw new Error('当前系统不支持此操作');
    const state = await this.statusIfRunning();
    if (state && (state.proxy || state.monitoring || state.autoBackup || state.checking || state.backingUp || state.accounts?.some(a => a.pending))) throw new Error('请先暂停后台计划、停止代理并等待操作完成');
    await this.serviceCommand(['disable', '--now', this.unitName]);
    await fs.unlink(path.join(this.serviceDirectory(), this.unitName));
    await this.serviceCommand(['daemon-reload']);
  }
}
