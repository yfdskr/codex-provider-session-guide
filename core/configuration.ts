import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse, stringify } from '@iarna/toml';
import { Provider, validateProvider } from './model';
import { privateDirectory, readPrivate, writePrivate } from './files';
import { accountHome, authIdentity, readAccountIndex } from './accounts';

export interface SwitchPlan {
  id: string; createdAt: number; home: string; target: string; model?: string;
  expectedConfig: string; provider?: Provider; keyPath?: string; keyHash?: string;
  accountId?: string; accountIdentity?: string; targetName: string;
  state: 'prepared' | 'running' | 'success' | 'error' | 'unknown';
  error?: string; sessionBackup?: string; safetyBackup?: string;
  tool?: string;
  expectedRevision?: number;
  stage?: 'preflight' | 'backup' | 'sync' | 'account' | 'config' | 'verify';
  mutationStarted?: boolean;
  errorCode?: string;
  reloadAdapter?: { root: string; entry: string };
}
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
export async function readCodexConfig(home: string): Promise<{ raw: string; value: any }> {
  const file = path.join(home, 'config.toml');
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || process.getuid && stat.uid !== process.getuid()) throw new Error('Unsafe config');
    const raw = await fs.readFile(file, 'utf8'); return { raw, value: parse(raw) };
  } catch (e: any) { if (e.code === 'ENOENT') return { raw: '', value: {} }; throw new Error('Codex 配置格式或文件所有者不正确，未修改配置'); }
}
export function managedProvider(provider: Provider, keyPath: string): object {
  return { name: provider.name, base_url: provider.baseUrl, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, auth: { command: '/bin/cat', args: [keyPath] } };
}
export function installProvider(raw: string, provider: Provider, keyPath: string): string {
  const value: any = parse(raw); value.model_providers ||= {};
  value.model_providers[provider.id] = managedProvider(validateProvider(provider), keyPath);
  return stringify(value);
}
export async function inspectProvider(home: string, provider: Provider, hasKey: boolean): Promise<{ ok: boolean; errors: string[]; warnings: string[]; usesExistingAuth: boolean }> {
  const errors: string[] = [], warnings: string[] = [];
  try { validateProvider(provider); } catch (e) { errors.push((e as Error).message); }
  let cfg: any;
  try { cfg = (await readCodexConfig(home)).value; } catch (e) { errors.push((e as Error).message); }
  const existing = cfg?.model_providers?.[provider.id];
  const bearerHeader = existing?.http_headers && Object.entries(existing.http_headers).some(([key, value]) => key.toLowerCase() === 'authorization' && typeof value === 'string' && value.trim());
  const usesExistingAuth = !!(existing && !existing.requires_openai_auth && (!existing.wire_api || existing.wire_api === 'responses') && existing.base_url?.replace(/\/$/, '') === provider.baseUrl && (existing.auth?.command || existing.env_key || bearerHeader || existing.experimental_bearer_token));
  if (!hasKey && !usesExistingAuth) errors.push('尚未设置 API Key，请点击“设置”');
  if (!provider.enabled) warnings.push('此供应商已暂停，不参与组内代理和定时检测');
  if (!hasKey && usesExistingAuth) warnings.push('切换沿用 Codex 中已有的认证；本扩展没有读取其中的密钥，不能据此确认接口可用');
  warnings.push('配置检查不发送模型请求，文字、工具和长上下文需要分别验证');
  return { ok: errors.length === 0, errors, warnings, usesExistingAuth };
}
export async function prepareSwitch(folder: string, home: string, target: string, providers: Provider[], key: (id: string) => string | undefined, accountId?: string): Promise<SwitchPlan> {
  if (!/^[\w-]{1,64}$/.test(target) || target === 'provider_manager') throw new Error('切换目标无效；代理接入请使用单独说明');
  const cfg = await readCodexConfig(home);
  const plan: SwitchPlan = { id: randomUUID(), createdAt: Date.now(), home, target, targetName: target === 'openai' ? '官方账号' : target, expectedConfig: sha256(cfg.raw), state: 'prepared' };
  if (target !== 'openai') {
    const provider = providers.find(p => p.id === target); if (!provider) throw new Error('供应商不存在');
    const credential = key(target), inspection = await inspectProvider(home, provider, !!credential);
    if (!inspection.ok) throw new Error(inspection.errors.join('；'));
    plan.targetName = provider.name; plan.model = provider.model;
    if (credential) {
      await privateDirectory(path.join(folder, 'provider-keys'));
      plan.keyPath = path.join(folder, 'provider-keys', target + '.key'); plan.keyHash = sha256(credential);
      await writePrivate(plan.keyPath, credential); plan.provider = provider;
    }
  }
  if (accountId) {
    if (target !== 'openai') throw new Error('官方账号不能用于第三方 API');
    if (cfg.value.cli_auth_credentials_store && cfg.value.cli_auth_credentials_store !== 'file') throw new Error('当前登录不是文件存储，本版不覆盖它；请先在官方客户端确认登录存储方式');
    const account = (await readAccountIndex(folder)).accounts.find(a => a.id === accountId);
    if (!account?.saved) throw new Error('请先完成这个官方账号的登录或保存');
    const identity = authIdentity(await readPrivate(path.join(accountHome(folder, accountId), 'auth.json')));
    if (identity.identity !== account.identity) throw new Error('账号登录信息已经改变，请先刷新账号状态');
    plan.accountId = accountId; plan.accountIdentity = identity.identity; plan.targetName = account.name;
  }
  await privateDirectory(path.join(folder, 'plans'));
  await writePrivate(path.join(folder, 'plans', plan.id + '.json'), JSON.stringify(plan)); return plan;
}
