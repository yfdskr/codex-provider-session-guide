import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function findDatabase(home: string, sqliteHome?: string): Promise<string> {
  const base = path.resolve(home, sqliteHome || home);
  const files = (await fs.readdir(base)).filter(n => /^state(_\d+)?\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)?.[0] ?? 0) - Number(a.match(/\d+/)?.[0] ?? 0));
  if (!files.length) throw new Error('没有找到实际会话数据库，已停止写操作');
  return path.join(base, files[0]);
}

export async function createSnapshot(home: string, script: string, python = 'python3', sqliteHome?: string): Promise<{ backup: string; sessions: number }> {
  try {
    const database = await findDatabase(home, sqliteHome);
    const { stdout } = await promisify(execFile)(python, [script, '--home', home, '--database', database, '--destination', path.join(path.dirname(home), '.codex-provider-manager-backups')], { timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true });
    const result = JSON.parse(stdout);
    if (!result.verified) throw new Error('Unverified snapshot');
    return { backup: result.backup, sessions: result.sessions };
  } catch { throw new Error('完整备份未通过；请检查 Python、磁盘、数据库与会话一致性。未完成副本保留为 .partial'); }
}
