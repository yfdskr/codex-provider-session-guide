import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireLock, privateDirectory, readPrivate, writePrivate } from './files';

export const IDE_COMPATIBILITY: Record<string, string> = {
  '26.51007.21434': 'a8069de80c8f8141481d033f94c3a95e1b59f399143cb2554d3f68469dfbe5b8'
};
const shimPattern = /^module\.exports = require\("\.\.\/\.cpm-bootstrap\/([a-f0-9-]{36})\.cjs"\);\n$/;
const shim = (id: string): string => `module.exports = require("../.cpm-bootstrap/${id}.cjs");\n`;
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export interface IdeAdapterOptions {
  root: string; folder: string; home: string; source?: string;
}
export interface IdeAdapterRecord {
  format: 1; root: string; folder: string; home: string; id: string; entry: string;
  version: string; originalMain: string; originalHash: string; bootstrapHash: string;
  manifestHash: string;
  originalMode: number;
}
export interface IdeAdapterStatus {
  state: 'disabled' | 'enabled' | 'reloadRequired' | 'unsupported' | 'error';
  reason: string; version?: string; entry?: string;
}
async function owned(file: string, directory = false): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
    || stat.uid !== process.getuid?.() || stat.mode & (directory ? 0o002 : 0o022)) throw new Error('官方扩展路径权限或类型无法确认');
}
async function manifest(root: string): Promise<{ raw: string; value: any; code: string; shimId?: string }> {
  if (process.platform !== 'linux' || process.arch !== 'x64' || !path.isAbsolute(root)) throw new Error('平滑切换目前只适配 Linux x64 本机扩展');
  await owned(root, true); await owned(path.join(root, 'package.json'));
  const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8'), value = JSON.parse(raw);
  if (value.publisher !== 'openai' || value.name !== 'chatgpt') throw new Error('目标不是官方 Codex 扩展');
  await owned(path.join(root, 'out'), true); await owned(path.join(root, 'out', 'extension.js'));
  const code = await fs.readFile(path.join(root, 'out', 'extension.js'), 'utf8'), shimId = shimPattern.exec(code)?.[1];
  if (value.main !== './out/extension.js' || !IDE_COMPATIBILITY[value.version] || !shimId && digest(code) !== IDE_COMPATIBILITY[value.version]) {
    throw new Error('此官方扩展版本或程序尚未适配，暂不启用平滑切换');
  }
  // A managed extension update replaces the registry target; never keep treating
  // a previous version's still-existing directory as the active official IDE.
  try {
    const registry = JSON.parse(await fs.readFile(path.join(path.dirname(root), 'extensions.json'), 'utf8'));
    const official = registry.filter((row: any) => row.identifier?.id === 'openai.chatgpt');
    if (official.length !== 1 || official[0].relativeLocation !== path.basename(root)) throw new Error('官方扩展已更新或安装位置发生变化，请重新检查适配');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  return { raw, value, code, shimId };
}
async function record(options: IdeAdapterOptions, current: Awaited<ReturnType<typeof manifest>>): Promise<IdeAdapterRecord> {
  const id = current.shimId;
  if (!id) throw new Error('官方扩展入口不是本管理器的兼容入口');
  const data: IdeAdapterRecord = JSON.parse(await readPrivate(path.join(options.root, '.cpm-bootstrap', id + '.json')));
  if (data.format !== 1 || data.id !== id || data.entry !== `.cpm-bootstrap/${id}.cjs` || data.root !== options.root || data.home !== options.home
    || data.folder !== options.folder || data.version !== current.value.version || data.originalMain !== `./out/.cpm-native-${id}.js`
    || data.originalHash !== IDE_COMPATIBILITY[data.version] || data.manifestHash !== digest(current.raw)
    || digest(await readPrivate(path.join(options.root, data.entry))) !== data.bootstrapHash
    || digest(await readPrivate(path.join(options.root, data.originalMain))) !== data.originalHash) throw new Error('兼容入口或关联目录已变化，请先检查或恢复启动入口');
  if (options.source && digest(await fs.readFile(options.source, 'utf8')) !== data.bootstrapHash) throw new Error('启动等待程序需要更新，请重新启用平滑切换');
  return data;
}
export async function processStamp(pid: number): Promise<string> {
  if (!Number.isInteger(pid) || pid <= 0 || (await fs.stat(`/proc/${pid}`)).uid !== process.getuid?.()) throw new Error('窗口进程无法确认');
  const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
  return (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() + ':' + raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
}
export async function writeIdeReceipt(data: IdeAdapterRecord, phase: 'waiting' | 'active' | 'failed'): Promise<void> {
  const dir = path.join(data.folder, 'ide-receipts'); await privateDirectory(dir);
  await writePrivate(path.join(dir, process.pid + '.json'), JSON.stringify({ root: data.root, home: data.home, entry: data.entry, pid: process.pid, stamp: await processStamp(process.pid), phase }));
}
export async function inspectIdeAdapter(options: IdeAdapterOptions, hostPid?: number): Promise<IdeAdapterStatus> {
  try {
    const current = await manifest(options.root);
    if (!current.shimId) return { state: 'disabled', reason: '尚未启用本机平滑切换', version: current.value.version };
    const data = await record({ ...options, source: undefined }, current);
    if (options.source && digest(await fs.readFile(options.source, 'utf8')) !== data.bootstrapHash) return { state: 'error', reason: '启动等待程序需要更新，请重新启用平滑切换', version: data.version, entry: data.entry };
    if (hostPid !== undefined) {
      try {
        const stamp = await processStamp(hostPid);
        const receipt = JSON.parse(await readPrivate(path.join(options.folder, 'ide-receipts', hostPid + '.json')));
        if (receipt.pid !== hostPid || receipt.stamp !== stamp || receipt.entry !== data.entry
          || receipt.root !== data.root || receipt.home !== data.home) throw new Error('No matching receipt');
        if (receipt.phase === 'waiting') return { state: 'reloadRequired', reason: '新 Codex 正在等待后台检查或切换完成；可在管理中心查看或取消等待', version: data.version, entry: data.entry };
        if (receipt.phase !== 'active') throw new Error('No active receipt');
      } catch { return { state: 'reloadRequired', reason: '入口已安装，请先重新加载当前窗口完成启用', version: data.version, entry: data.entry }; }
    }
    return { state: 'enabled', reason: '已启用本机平滑切换', version: data.version, entry: data.entry };
  } catch (e) { return { state: 'unsupported', reason: (e as Error).message }; }
}
async function edit<T>(options: IdeAdapterOptions, fn: () => Promise<T>): Promise<T> {
  const release = await acquireLock(path.join(options.folder, 'switch-job.lock'));
  try {
    try {
      const job = JSON.parse(await readPrivate(path.join(options.folder, 'switch-job.json')));
      if (['waiting', 'running'].includes(job.phase)) throw new Error('切换正在等待或执行，不能改动启动入口');
    } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    return await fn();
  } finally { await release(); }
}
export async function installIdeAdapter(options: IdeAdapterOptions): Promise<void> {
  if (!options.source) throw new Error('缺少启动等待程序');
  await edit(options, async () => {
    const current = await manifest(options.root);
    let original = current.code, originalMode = (await fs.stat(path.join(options.root, 'out', 'extension.js'))).mode & 0o777;
    if (current.shimId) {
      const previous = await record({ ...options, source: undefined }, current);
      original = await readPrivate(path.join(options.folder, 'ide-adapters', previous.id, 'extension.js'));
      originalMode = previous.originalMode;
      if (digest(original) !== previous.originalHash) throw new Error('原入口备份无法核对，未覆盖');
    }
    if (digest(original) !== IDE_COMPATIBILITY[current.value.version]) throw new Error('原程序备份版本不一致');
    const id = randomUUID(), entry = `.cpm-bootstrap/${id}.cjs`;
    const source = await fs.readFile(options.source!, 'utf8');
    const data: IdeAdapterRecord = { format: 1, ...options, id, entry, version: current.value.version, originalMain: `./out/.cpm-native-${id}.js`, originalHash: IDE_COMPATIBILITY[current.value.version], bootstrapHash: digest(source), manifestHash: digest(current.raw), originalMode };
    const backup = path.join(options.folder, 'ide-adapters', id);
    await privateDirectory(backup); await writePrivate(path.join(backup, 'package.json'), current.raw); await writePrivate(path.join(backup, 'extension.js'), original);
    await privateDirectory(path.join(options.root, '.cpm-bootstrap'));
    await writePrivate(path.join(options.root, entry), source);
    await writePrivate(path.join(options.root, '.cpm-bootstrap', id + '.json'), JSON.stringify(data));
    // The native module stays in out/ so its relative imports keep working.
    await writePrivate(path.join(options.root, data.originalMain), original);
    if ((await fs.readFile(path.join(options.root, 'package.json'), 'utf8')) !== current.raw || (await fs.readFile(path.join(options.root, 'out', 'extension.js'), 'utf8')) !== current.code) throw new Error('安装期间官方扩展已变化，没有替换入口');
    await writePrivate(path.join(options.root, 'out', 'extension.js'), shim(id));
  });
}
export async function removeIdeAdapter(options: IdeAdapterOptions): Promise<void> {
  await edit(options, async () => {
    const current = await manifest(options.root);
    if (!current.shimId) return;
    const data = await record({ ...options, source: undefined }, current);
    const original = await readPrivate(path.join(options.folder, 'ide-adapters', data.id, 'extension.js'));
    if (digest(original) !== data.originalHash) throw new Error('原入口备份无法核对，未执行恢复');
    if (!Number.isInteger(data.originalMode) || data.originalMode < 0o400 || data.originalMode > 0o755 || data.originalMode & 0o022) throw new Error('原入口权限无法核对，未执行恢复');
    if ((await fs.readFile(path.join(options.root, 'package.json'), 'utf8')) !== current.raw || (await fs.readFile(path.join(options.root, 'out', 'extension.js'), 'utf8')) !== current.code) throw new Error('官方扩展已变化，没有覆盖恢复');
    await writePrivate(path.join(options.root, 'out', 'extension.js'), original);
    await fs.chmod(path.join(options.root, 'out', 'extension.js'), data.originalMode);
    // Keep boot files and backup for windows still executing the previous entry.
  });
}
export async function loadIdeRecord(entryFile: string): Promise<IdeAdapterRecord> {
  const root = path.dirname(path.dirname(entryFile));
  const data: IdeAdapterRecord = JSON.parse(await readPrivate(entryFile.replace(/\.cjs$/, '.json')));
  if (data.root !== root || path.join(root, data.entry) !== entryFile) throw new Error('启动入口关联错误');
  const current = await manifest(root);
  return record({ root, home: data.home, folder: data.folder }, current);
}
