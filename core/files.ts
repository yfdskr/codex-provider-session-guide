import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export async function privateDirectory(folder: string): Promise<void> {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error('后台目录的类型或所有者不正确');
  await fs.chmod(folder, 0o700);
}

export async function readPrivate(file: string): Promise<string> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Error('后台文件权限不安全，请检查所有者及 600 权限');
  return fs.readFile(file, 'utf8');
}

export async function writePrivate(file: string, value: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}-${randomBytes(10).toString('hex')}.tmp`);
  try {
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(tmp, file);
    if (process.platform === 'linux') {
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await fs.unlink(tmp).catch(() => undefined); }
}

async function generation(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return boot + ':' + raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  } catch { return undefined; }
}

export async function acquireLock(file: string): Promise<() => Promise<void>> {
  const owner = { pid: process.pid, generation: await generation(process.pid), nonce: randomBytes(16).toString('hex') };
  for (let attempt = 0; attempt < 2; attempt++) {
    let handle;
    try { handle = await fs.open(file, 'wx', 0o600); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let previous: any;
      try { previous = JSON.parse(await readPrivate(file)); } catch { throw new Error('锁文件无法验证，请先检查旧进程，不要直接删除'); }
      if (!Number.isInteger(previous.pid) || previous.pid <= 0) throw new Error('锁文件缺少有效进程信息');
      let dead = false;
      try { process.kill(previous.pid, 0); } catch (e: any) { if (e.code === 'ESRCH') dead = true; }
      const current = await generation(previous.pid);
      if (!dead && !(previous.generation && current && previous.generation !== current)) throw new Error('此目录有其他管理操作或后台正在运行');
      // Check the exact owner again; concurrent contenders must not remove a new lock.
      const raw = await readPrivate(file);
      if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(previous)) throw new Error('锁所有者已变化，请刷新重试');
      // Rename reclamation is serialized by an independent, non-reclaimed lock.
      let reclaim;
      try { reclaim = await fs.open(file + '.reclaim', 'wx', 0o600); }
      catch { throw new Error('其他进程正在检查旧锁，请稍后重试'); }
      try {
        if (await readPrivate(file) !== raw) throw new Error('锁所有者已变化，请刷新重试');
        await fs.unlink(file);
      } finally { await reclaim.close(); await fs.unlink(file + '.reclaim'); }
      continue;
    }
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
    catch (e) { await handle.close(); await fs.unlink(file).catch(() => undefined); throw e; }
    return async () => {
      await handle.close();
      try { if (JSON.parse(await readPrivate(file)).nonce === owner.nonce) await fs.unlink(file); } catch { /* Keep unverifiable locks. */ }
    };
  }
  throw new Error('未能取得操作锁，请刷新后重试');
}

export async function withOperation<T>(home: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireLock(path.join(home, 'provider-manager.operation.lock'));
  try {
    try {
      const proxyLock = path.join(home, 'provider-manager.proxy.lock');
      await fs.access(proxyLock);
      const clearStale = await acquireLock(proxyLock);
      await clearStale();
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('请先停止此目录的代理，再备份或整理对话；若曾崩溃，请先检查旧进程和锁');
    }
    return await action();
  } finally { await release(); }
}
