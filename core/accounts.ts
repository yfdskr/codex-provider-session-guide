import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppServer } from './rpc';
import { privateDirectory, readPrivate, writePrivate, acquireLock } from './files';
import { parse } from '@iarna/toml';

export interface AccountEntry {
  id: string; name: string; createdAt: number; checkedAt?: number;
  email?: string; plan?: string; identity?: string; saved: boolean;
}
export interface AccountSummary extends Omit<AccountEntry, 'identity'> { pending: boolean; lastApplied: boolean }
export interface AccountIndex { accounts: AccountEntry[]; lastAppliedId?: string }
export interface LoginInfo { id: string; verificationUrl: string; userCode: string; until: number }

export function authIdentity(raw: string): { identity: string; email?: string } {
  let data: any, claims: any;
  try {
    data = JSON.parse(raw);
    const token = data.tokens;
    if (!token || ['id_token', 'access_token', 'refresh_token', 'account_id'].some(key => typeof token[key] !== 'string' || !token[key])) throw new Error();
    claims = JSON.parse(Buffer.from(token.id_token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.sub !== 'string' || !claims.sub) throw new Error();
  } catch { throw new Error('官方登录文件格式无法确认，请在独立账号目录重新登录；未复制或覆盖登录信息'); }
  // Claims identify a cached account only; they never authorize model or tool access.
  return { identity: createHash('sha256').update(data.tokens.account_id + '\0' + claims.sub).digest('hex'), email: typeof claims.email === 'string' ? claims.email.slice(0, 256) : undefined };
}
export function accountHome(folder: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('账号编号无效');
  return path.join(folder, 'accounts', id, 'home');
}
export async function readAccountIndex(folder: string): Promise<AccountIndex> {
  let value: any;
  try { value = JSON.parse(await readPrivate(path.join(folder, 'accounts.json'))); }
  catch (e: any) { if (e.code === 'ENOENT') return { accounts: [] }; throw e; }
  if (!Array.isArray(value.accounts) || value.accounts.length > 100) throw new Error('账号目录格式不正确，请保留文件并排查');
  const accounts = value.accounts.map((a: any): AccountEntry => {
    accountHome(folder, a.id);
    if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 100 || typeof a.saved !== 'boolean' || typeof a.createdAt !== 'number') throw new Error('账号记录格式不正确');
    return { id: a.id, name: a.name, createdAt: a.createdAt, checkedAt: a.checkedAt, email: a.email, plan: a.plan, identity: a.identity, saved: a.saved };
  });
  return { accounts, lastAppliedId: value.lastAppliedId };
}
export async function updateAccountIndex<T>(folder: string, fn: (index: AccountIndex) => Promise<T>): Promise<T> {
  const release = await acquireLock(path.join(folder, 'accounts.lock'));
  try { const index = await readAccountIndex(folder); const result = await fn(index); await writePrivate(path.join(folder, 'accounts.json'), JSON.stringify(index)); return result; }
  finally { await release(); }
}

export class AccountStore {
  private index: AccountIndex = { accounts: [] };
  private pending = new Map<string, { server: AppServer; loginId: string; info: LoginInfo; timer: NodeJS.Timeout }>();
  private opening = new Set<string>();
  constructor(readonly folder: string, readonly mainHome: string, private executable: () => string | undefined, private notify: (message: string) => void) {}
  async reload(): Promise<void> { this.index = await readAccountIndex(this.folder); }
  summaries(): AccountSummary[] { return this.index.accounts.map(({ identity, ...a }) => ({ ...a, pending: this.pending.has(a.id) || this.opening.has(a.id), lastApplied: this.index.lastAppliedId === a.id })); }
  info(id: string): LoginInfo | undefined { return this.pending.get(id)?.info; }
  hasPending(): boolean { return !!(this.pending.size || this.opening.size); }
  private code(): string { const exe = this.executable(); if (!exe || !path.isAbsolute(exe)) throw new Error('请先在扩展设置中确认 Codex 程序路径，然后刷新管理中心'); return exe; }
  private async config(home: string): Promise<void> {
    await privateDirectory(home);
    await writePrivate(path.join(home, 'config.toml'), 'model_provider = "openai"\ncli_auth_credentials_store = "file"\n[analytics]\nenabled = false\n');
  }
  async create(name: string): Promise<string> {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) throw new Error('请输入 1–100 字的账号名称');
    const id = randomUUID();
    await updateAccountIndex(this.folder, async index => {
      if (index.accounts.length >= 100 || index.accounts.some(a => a.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase())) throw new Error('账号名称重复或数量超过限制');
      await this.config(accountHome(this.folder, id));
      index.accounts.push({ id, name: name.trim(), createdAt: Date.now(), saved: false });
    });
    await this.reload(); return id;
  }
  async importCurrent(name: string): Promise<string> {
    await this.reload();
    let cfg: any = {};
    try { cfg = parse(await fs.readFile(path.join(this.mainHome, 'config.toml'), 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw new Error('当前配置无法读取，未保存账号'); }
    if (cfg.cli_auth_credentials_store && cfg.cli_auth_credentials_store !== 'file') throw new Error('当前登录使用钥匙串或其他存储方式，本版无法确认文件对应的账号；请新增官方账号并独立登录');
    let raw: string;
    try { raw = await readPrivate(path.join(this.mainHome, 'auth.json')); } catch { throw new Error('没有可安全读取的文件登录；请新增官方账号并登录，不要把登录文件贴到聊天里'); }
    const identity = authIdentity(raw);
    if (this.index.accounts.some(a => a.identity === identity.identity)) throw new Error('这个官方账号已经保存，请使用已有条目');
    const id = await this.create(name);
    await writePrivate(path.join(accountHome(this.folder, id), 'auth.json'), raw);
    await updateAccountIndex(this.folder, async index => { Object.assign(index.accounts.find(a => a.id === id)!, identity, { saved: true, checkedAt: Date.now() }); });
    await this.reload(); this.notify('已保存当前官方账号的文件登录，未改变当前账号。'); return id;
  }
  async startLogin(id: string): Promise<void> {
    await this.reload(); if (!this.index.accounts.some(a => a.id === id)) throw new Error('账号不存在');
    if (this.pending.has(id) || this.opening.has(id)) throw new Error('此账号正在等待登录，请完成或取消后重试');
    const home = accountHome(this.folder, id), server = new AppServer(this.code(), home, 30000, undefined, true);
    this.opening.add(id);
    let completion: any;
    server.onNotification((method, params) => {
      if (method === 'account/login/completed') {
        completion = params;
        if (this.pending.has(id)) void this.complete(id, params).catch(() => this.notify('官方账号登录结果无法确认，请刷新账号状态。'));
      }
    });
    try {
      await server.start();
      const result: any = await server.call('account/login/start', { type: 'chatgptDeviceCode' });
      const url = new URL(result.verificationUrl);
      if (result.type !== 'chatgptDeviceCode' || url.username || url.password || (url.port && url.port !== '443') || url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || typeof result.userCode !== 'string' || result.userCode.length > 128 || typeof result.loginId !== 'string') throw new Error('Invalid device login response');
      const info: LoginInfo = { id, verificationUrl: url.toString(), userCode: result.userCode, until: Date.now() + 10 * 60000 };
      const timer = setTimeout(() => { void this.cancel(id).catch(() => undefined); }, 10 * 60000);
      this.pending.set(id, { server, loginId: result.loginId, info, timer });
      if (completion) await this.complete(id, completion);
      this.notify('官方账号登录已开始，请在授权页面完成操作；不会切换当前账号。');
    } catch { server.stop(); throw new Error('官方设备登录未能开始；请检查 Codex 版本、网络和账号的设备登录权限。没有改动当前账号。'); }
    finally { this.opening.delete(id); }
  }
  private async complete(id: string, result: any): Promise<void> {
    const pending = this.pending.get(id); if (!pending || result.loginId !== pending.loginId) return;
    try {
      if (!result.success) { this.notify('官方账号登录未完成，可以取消后重新登录。'); return; }
      await this.refresh(id, pending.server);
      this.notify('官方账号登录信息已保存；尚未切换当前账号。');
    } finally { clearTimeout(pending.timer); this.pending.delete(id); pending.server.stop(); }
  }
  async refresh(id: string, existing?: AppServer): Promise<void> {
    await this.reload(); if (!this.index.accounts.some(a => a.id === id)) throw new Error('账号不存在');
    if (this.pending.has(id) && !existing) throw new Error('此账号仍在等待登录，请先完成授权');
    const home = accountHome(this.folder, id), server = existing || new AppServer(this.code(), home, 30000, undefined, true);
    try {
      if (!existing) await server.start();
      const response: any = await server.call('account/read', { refreshToken: false });
      if (response.account?.type !== 'chatgpt') throw new Error('没有已保存的官方登录，请重新登录');
      const identity = authIdentity(await readPrivate(path.join(home, 'auth.json')));
      await updateAccountIndex(this.folder, async index => {
        Object.assign(index.accounts.find(a => a.id === id)!, identity, { email: typeof response.account.email === 'string' ? response.account.email.slice(0, 256) : identity.email, plan: typeof response.account.planType === 'string' ? response.account.planType.slice(0, 64) : undefined, saved: true, checkedAt: Date.now() });
      });
      await this.reload();
    } finally { if (!existing) server.stop(); }
  }
  async cancel(id: string): Promise<void> {
    const pending = this.pending.get(id); if (!pending) return;
    try { await pending.server.call('account/login/cancel', { loginId: pending.loginId }); }
    finally { clearTimeout(pending.timer); pending.server.stop(); this.pending.delete(id); }
  }
  async remove(id: string): Promise<void> {
    await this.cancel(id);
    await updateAccountIndex(this.folder, async index => {
      if (index.lastAppliedId === id) throw new Error('这是上次应用的账号，请先切换到其他账号，再移除保存条目');
      if (!index.accounts.some(a => a.id === id)) throw new Error('账号不存在');
      // Keep metadata until profile removal succeeds. No main-home login is modified.
      const home = accountHome(this.folder, id);
      if ((await fs.lstat(home)).isSymbolicLink()) throw new Error('账号目录不能是符号链接');
      await fs.rm(path.dirname(home), { recursive: true }); index.accounts = index.accounts.filter(a => a.id !== id);
    });
    await this.reload();
  }
  stop(): void { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.server.stop(); } this.pending.clear(); }
}
