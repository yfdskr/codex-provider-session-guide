import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
export interface Snapshot { id: string; created: string; sessions: number; partial: boolean; sourceMatches: boolean }
export function backupRoot(home: string): string { return path.join(path.dirname(home), '.codex-provider-manager-backups'); }
export async function listSnapshots(home: string): Promise<Snapshot[]> {
  let entries;
  try { entries = await fs.readdir(backupRoot(home), { withFileTypes: true }); }
  catch (e: any) { if (e.code === 'ENOENT') return []; throw e; }
  const result: Snapshot[] = [];
  for (const entry of entries.filter(e => e.isDirectory() && /^\d{8}T\d{6}\.\d+Z(?:\.partial)?$/.test(e.name)).sort((a, b) => b.name.localeCompare(a.name))) {
    try {
      const folder = path.join(backupRoot(home), entry.name);
      const file = path.join(folder, 'manifest.json');
      if ((await fs.lstat(file)).isSymbolicLink()) continue;
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      if (path.resolve(manifest.source) !== path.resolve(home)) continue;
      result.push({ id: entry.name, created: manifest.createdUtc, sessions: manifest.sessions, partial: entry.name.endsWith('.partial'), sourceMatches: true });
    } catch { if (entry.name.endsWith('.partial')) result.push({ id: entry.name, created: entry.name, sessions: 0, partial: true, sourceMatches: false }); }
  }
  return result;
}
export async function snapshotPath(home: string, id: string): Promise<string> {
  if (!(await listSnapshots(home)).some(b => b.id === id && b.sourceMatches)) throw new Error('找不到属于当前对话目录的备份。');
  const folder = path.join(backupRoot(home), id);
  if ((await fs.lstat(folder)).isSymbolicLink()) throw new Error('备份目录不能是符号链接。');
  return folder;
}
export async function verifySnapshot(home: string, id: string): Promise<number> {
  const folder = await snapshotPath(home, id);
  if (id.endsWith('.partial')) throw new Error('这是一份未完成的备份，不能用来恢复。');
  const manifest = JSON.parse(await fs.readFile(path.join(folder, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('备份清单为空。');
  const root = await fs.realpath(folder);
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('备份清单格式错误。');
    const file = path.resolve(folder, entry.path);
    const relative = path.relative(folder, file);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || (await fs.lstat(file)).isSymbolicLink()) throw new Error('备份清单包含越界路径。');
    const real = await fs.realpath(file);
    if (!real.startsWith(root + path.sep)) throw new Error('备份文件不在备份目录内。');
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(file)) hash.update(bytes);
    if (hash.digest('hex') !== entry.sha256) throw new Error('备份文件有变化，校验未通过；请保留原文件并检查磁盘。');
  }
  return manifest.files.length;
}
