import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
test('切换失败流程：必须确认停任务、备份先行、部分失败保留副本且不自动覆盖', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-switch-failure-')); const home = path.join(root, '.codex');
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
  const log = path.join(home, 'sessions/a.jsonl'), db = path.join(home, 'state_9.sqlite');
  await fs.writeFile(log, JSON.stringify({ type: 'session_meta', payload: { id: 'a', model_provider: 'source' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { message: 'Synthetic original' } }) + '\n');
  execFileSync('python3', ['-c', 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE threads(id TEXT PRIMARY KEY)");c.execute("INSERT INTO threads VALUES(\'a\')");c.commit()', db]);
  const tool = path.join(root, 'fake-sync');
  await fs.writeFile(tool, `#!/usr/bin/python3\nimport json,sys\nfrom pathlib import Path\nif sys.argv[1]=='status':\n print(json.dumps({'ok':True,'outcome':'completed','result':{'rolloutScanComplete':True,'configuredProviders':['openai','source'],'currentProvider':'source','stateDbLocation':{'path':${JSON.stringify(db)}}}}))\nelse:\n Path(${JSON.stringify(path.join(home, 'partial-marker'))}).write_text('changed')\n print(json.dumps({'ok':False,'outcome':'partial'}))\n sys.exit(1)\n`, { mode: 0o700 });
  const args = [path.resolve('resources/switch.py'), '--home', home, '--database', db, '--tool', tool, '--target', 'openai'];
  try {
    assert.throws(() => execFileSync('python3', args, { stdio: 'pipe' }));
    await assert.rejects(fs.access(path.join(home, 'provider-manager.operation.lock')));
    let stderr = '';
    try { execFileSync('python3', [...args, '--tasks-stopped'], { stdio: 'pipe' }); } catch (e: any) { stderr = e.stderr.toString(); }
    assert(stderr.includes('可能已有部分修改'));
    assert.equal(await fs.readFile(path.join(home, 'partial-marker'), 'utf8'), 'changed');
    const backups = await fs.readdir(path.join(root, '.codex-provider-manager-backups'));
    assert.equal(backups.length, 1); assert(!backups[0].endsWith('.partial'));
    assert.equal(await fs.readFile(path.join(root, '.codex-provider-manager-backups', backups[0], 'sessions/a.jsonl'), 'utf8'), await fs.readFile(log, 'utf8'));
    await assert.rejects(fs.access(path.join(home, 'provider-manager.operation.lock')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
