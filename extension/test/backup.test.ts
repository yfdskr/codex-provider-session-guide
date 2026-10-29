import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpm-backup-')); const home = path.join(root, '.codex'); await mkdir(home);
  for (const [id, scope] of [['a', 'sessions'], ['b', 'archived_sessions']]) {
    await mkdir(path.join(home, scope)); await writeFile(path.join(home, scope, `${id}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'synthetic' } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { message: 'Synthetic' } }) + '\n');
  }
  await writeFile(path.join(home, 'auth.json'), 'SYNTHETIC-DO-NOT-COPY'); await writeFile(path.join(home, 'config.toml'), 'synthetic-secret-config');
  const db = path.join(home, 'state_8.sqlite');
  execFileSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE threads(id TEXT PRIMARY KEY, archived INTEGER)"); c.executemany("INSERT INTO threads VALUES(?,?)",[("a",0),("b",1)]); c.commit()', db]);
  const args = [path.resolve('resources/backup.py'), '--home', home, '--database', db, '--destination', path.join(root, 'backups')];
  return { root, home, db, args };
}
test('完整备份包含普通与归档会话、校验数据库，排除凭证和配置', async () => {
  const f = await fixture();
  try {
    const result = JSON.parse(execFileSync('python3', f.args, { encoding: 'utf8' }));
    assert.equal(result.sessions, 2); assert.equal(result.verified, true);
    const files = await readdir(result.backup); assert(!files.includes('auth.json')); assert(!files.includes('config.toml'));
    const manifest = JSON.parse(await readFile(path.join(result.backup, 'manifest.json'), 'utf8'));
    assert.equal(manifest.credentialsCopied, false); assert.equal(manifest.files.length, 3);
    assert.equal(await readFile(path.join(result.backup, 'archived_sessions/b.jsonl'), 'utf8'), await readFile(path.join(f.home, 'archived_sessions/b.jsonl'), 'utf8'));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('数据库与会话不一致时停止，不产生已完成快照', async () => {
  const f = await fixture();
  try {
    execFileSync('python3', ['-c', 'import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("DELETE FROM threads WHERE id=\'b\'");c.commit()', f.db]);
    assert.throws(() => execFileSync('python3', f.args, { stdio: 'pipe' }));
    assert((await readdir(path.join(f.root, 'backups'))).every(p => p.endsWith('.partial')));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test('符号链接不会将会话目录外文件带入备份', async () => {
  const f = await fixture();
  try { await symlink(path.join(f.home, 'auth.json'), path.join(f.home, 'sessions/secret-link')); assert.throws(() => execFileSync('python3', f.args, { stdio: 'pipe' })); }
  finally { await rm(f.root, { recursive: true, force: true }); }
});

test('同一对话 ID 的不同记录文件全部保留，按唯一 ID 核对数据库，不合并正文', async () => {
  const f=await fixture();
  try {
    const duplicate=path.join(f.home,'sessions','a-retained-copy.jsonl');
    const contents=JSON.stringify({type:'session_meta',payload:{id:'a',model_provider:'synthetic'}})+'\n'+JSON.stringify({type:'event_msg',payload:{message:'Synthetic divergent retained copy'}})+'\n';
    await writeFile(duplicate,contents);
    const result=JSON.parse(execFileSync('python3',f.args,{encoding:'utf8'}));
    assert.equal(result.sessions,2);assert.equal(result.verified,true);
    const manifest=JSON.parse(await readFile(path.join(result.backup,'manifest.json'),'utf8'));
    assert.equal(manifest.rolloutFiles,3);assert.equal(manifest.duplicateSessionFiles,1);
    assert.equal(await readFile(path.join(result.backup,'sessions/a-retained-copy.jsonl'),'utf8'),contents);
    assert.equal(await readFile(path.join(result.backup,'sessions/a.jsonl'),'utf8'),await readFile(path.join(f.home,'sessions/a.jsonl'),'utf8'));
    assert.equal(manifest.files.filter((v:any)=>v.path.endsWith('.jsonl')).length,3);
  } finally {await rm(f.root,{recursive:true,force:true});}
});
