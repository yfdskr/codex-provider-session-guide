import fs from 'node:fs/promises';
import path from 'node:path';

export class CodexBusyError extends Error {
  constructor(readonly pids: number[]) { super(`发现 ${pids.length} 个 Codex 后台仍在线；自动切换将等待它们退出，不会结束进程`); }
}

type ProcFiles = Pick<typeof fs, 'readdir' | 'stat' | 'lstat' | 'readlink' | 'readFile'>;
async function systemLoginProcess(folder: string, procRoot: string, uid: number | undefined, files: ProcFiles): Promise<boolean> {
  if (uid === undefined) return false;
  const fields = (raw: string): Record<string, string> => Object.fromEntries(raw.split('\n').map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon), line.slice(colon + 1).trim()];
  }));
  const ownedBy = (row: Record<string, string>, owner: number): boolean => {
    const ids = row.Uid?.split(/\s+/); return ids?.length === 4 && ids.every(id => id === String(owner));
  };
  try {
    const row = fields(await files.readFile(path.join(folder, 'status'), 'utf8'));
    if (!['sshd', '(sd-pam)'].includes(row.Name) || !ownedBy(row, uid) || !/^[1-9]\d*$/.test(row.PPid)) return false;
    // Non-dumpable login helpers expose root-owned proc links even after dropping UID.
    // A process name alone is never enough to bypass the check.
    const link = await files.lstat(path.join(folder, 'exe'));
    if (!link.isSymbolicLink() || link.uid !== 0) return false;
    const parent = path.join(procRoot, row.PPid);
    const owner = fields(await files.readFile(path.join(parent, 'status'), 'utf8'));
    if (row.Name === 'sshd') return owner.Name === 'sshd' && ownedBy(owner, 0) && (await files.stat(parent)).uid === 0;
    return owner.Name === 'systemd' && ownedBy(owner, uid) && (await files.stat(parent)).uid === uid
      && path.basename(await files.readlink(path.join(parent, 'exe'))) === 'systemd';
  } catch { return false; }
}

/** Conservative: do not inspect command lines or environments, and never kill an owner. */
export async function codexProcesses(procRoot = '/proc', uid = process.getuid?.(), files: ProcFiles = fs): Promise<number[]> {
  if (process.platform !== 'linux') throw new Error('自动进程检查目前只支持 Linux');
  const result: number[] = [];
  for (const name of await files.readdir(procRoot)) {
    if (!/^\d+$/.test(name)) continue;
    const folder = path.join(procRoot, name);
    try {
      if (uid !== undefined && (await files.stat(folder)).uid !== uid) continue;
      let executable: string;
      try { executable = await files.readlink(path.join(folder, 'exe')); }
      catch (error: any) {
        if (['EACCES', 'EPERM'].includes(error.code) && await systemLoginProcess(folder, procRoot, uid, files)) continue;
        throw error;
      }
      if (['codex', 'codex.exe'].includes(path.basename(executable).replace(/ \(deleted\)$/, ''))) result.push(Number(name));
    } catch (e: any) {
      if (['EACCES', 'EPERM'].includes(e.code)) throw new Error(`同用户进程 ${name} 无法确认身份，已停止切换。请关闭相关 Codex 窗口；若仍报错，提供此进程编号排查，不要强删锁或结束系统进程`);
      if (!['ENOENT', 'ESRCH', 'EINVAL'].includes(e.code)) throw e;
    }
  }
  return result;
}
