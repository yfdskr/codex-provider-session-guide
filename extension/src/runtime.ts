import * as vscode from 'vscode';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import TOML from '@iarna/toml';
import { AppServer } from './rpc';
import { withOperation } from '../../core/files';
import { findDatabase, createSnapshot } from '../../core/snapshot';

export function codexHome(): string {
  return path.resolve(vscode.workspace.getConfiguration('codexProviderManager').get<string>('codexHome') || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}
export async function config(home: string): Promise<any> {
  try { return TOML.parse(await fs.readFile(path.join(home, 'config.toml'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw new Error('无法读取 config.toml，请先检查 TOML 格式'); }
}
export async function resolveCodex(): Promise<string> {
  const configured = vscode.workspace.getConfiguration('codexProviderManager').get<string>('codexPath');
  if (configured) { if (!path.isAbsolute(configured)) throw new Error('codexPath 需要绝对路径'); await fs.access(configured); return configured; }
  const roots: string[] = [];
  const extension = vscode.extensions.getExtension('openai.chatgpt');
  if (extension) roots.push(extension.extensionPath);
  for (const dir of ['.vscode-server/extensions', '.vscode/extensions', '.vscode-server-insiders/extensions']) {
    const base = path.join(os.homedir(), dir);
    try { const names = (await fs.readdir(base)).filter(n => n.startsWith('openai.chatgpt-')).sort().reverse(); roots.push(...names.map(n => path.join(base, n))); } catch { /* Try next host layout. */ }
  }
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch;
  for (const root of roots) for (const file of [`bin/${platform}-${arch}/codex${process.platform === 'win32' ? '.exe' : ''}`, 'bin/codex']) {
    const candidate = path.join(root, file); try { await fs.access(candidate); return candidate; } catch { /* Try next. */ }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, process.platform === 'win32' ? 'codex.exe' : 'codex'); try { await fs.access(candidate); return candidate; } catch { /* Try next. */ }
  }
  throw new Error('没有找到 Codex；安装官方扩展，或在设置中填写 codexPath。');
}
export async function withServer<T>(fn: (server: AppServer) => Promise<T>): Promise<T> {
  const server = new AppServer(await resolveCodex(), codexHome());
  try { await server.start(); return await fn(server); } finally { server.stop(); }
}
export async function database(home: string): Promise<string> {
  const cfg = await config(home);
  return findDatabase(home, process.env.CODEX_SQLITE_HOME || cfg.sqlite_home);
}
export async function backup(context: vscode.ExtensionContext): Promise<{ backup: string; sessions: number }> {
  const home = codexHome(); const cfg = await config(home);
  const python = vscode.workspace.getConfiguration('codexProviderManager').get<string>('pythonPath') || 'python3';
  try {
    return await createSnapshot(home, context.asAbsolutePath('resources/backup.py'), python, process.env.CODEX_SQLITE_HOME || cfg.sqlite_home);
  } catch { throw new Error('完整备份未通过，未执行后续写操作。请检查 Python 3.10+、磁盘空间及数据库/会话是否一致，并停止其他窗口的任务后重试；不完整副本保留为 .partial。'); }
}
export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return withOperation(codexHome(), fn);
}
