import fs from 'node:fs/promises';
import path from 'node:path';
import * as vscode from 'vscode';
import { loadIdeRecord, writeIdeReceipt } from '../core/ide-adapter';
import { startAfterSwitch } from '../core/startup-gate';

let original: any;
const stopped = new AbortController();
async function nativeOwner(root: string): Promise<boolean> {
  const binary = await fs.realpath(path.join(root, 'bin', 'linux-x86_64', 'codex'));
  const children = (await fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
  for (const pid of children) {
    try {
      if (await fs.readlink(`/proc/${pid}/exe`) !== binary) continue;
      // Only inspect exact children using this extension's pinned binary. Never
      // enumerate arbitrary command lines, and never emit arguments or tokens.
      const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean).slice(1);
      if (JSON.stringify(args) === JSON.stringify(['-c', 'features.code_mode_host=true', 'app-server', '--analytics-default-enabled'])) return true;
    } catch (e: any) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw e; }
  }
  return false;
}

export async function activate(context: vscode.ExtensionContext): Promise<unknown> {
  const data = await loadIdeRecord(__filename);
  if (await fs.realpath(context.extensionPath) !== data.root) throw new Error('Codex 启动位置已变化，请恢复本机启动入口');
  if (vscode.workspace.getConfiguration('chatgpt').get<string>('cliExecutable')?.trim()) throw new Error('已配置自定义 Codex 程序，暂不能与本机兼容模式同时使用；请在管理中心恢复启动入口');
  if (process.env.CODEX_HOME && await fs.realpath(process.env.CODEX_HOME) !== await fs.realpath(data.home)) throw new Error('此窗口的 Codex 目录与兼容入口不一致，请在管理中心检查');
  context.subscriptions.push({ dispose: () => stopped.abort() });
  await writeIdeReceipt(data, 'waiting');
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Codex：正在检查本机切换状态', cancellable: false }, () =>
      startAfterSwitch(data.folder, data.home, async () => {
        const current = await loadIdeRecord(__filename);
        if (current.entry !== data.entry) throw new Error('等待期间启动入口已变化，未启动 Codex');
        if (process.env.CODEX_HOME && await fs.realpath(process.env.CODEX_HOME) !== await fs.realpath(data.home)) throw new Error('等待期间 Codex 目录已变化，未启动 Codex');
        // Pin only this host process to the home explicitly selected at setup.
        // The native extension normally exports its discovered home here too.
        process.env.CODEX_HOME = data.home;
        original = require(path.join(data.root, data.originalMain));
        const result = await original.activate(context);
        if (!await nativeOwner(data.root)) throw new Error('未确认官方 Codex 后台启动，平滑切换暂不可用；请检查扩展输出');
        await writeIdeReceipt(data, 'active');
        return result;
      }, { signal: stopped.signal }));
    return result;
  } catch (error) {
    await writeIdeReceipt(data, 'failed').catch(() => undefined);
    throw error;
  }
}
export async function deactivate(): Promise<void> {
  stopped.abort(); await original?.deactivate?.();
}
