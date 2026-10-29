import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, accountHome, authIdentity } from '../../core/accounts';
import { AgentClient } from '../../agent/client';
import { AgentServer } from '../../agent/server';
import { defaults } from '../../core/model';
import { privateDirectory, readPrivate, writePrivate } from '../../core/files';

export const syntheticAuth = (id: string, refresh = 'SYNTHETIC-REFRESH') => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: id, id_token: 'synthetic.' + Buffer.from(JSON.stringify({ sub: 'sub-' + id, email: id + '@example.invalid' })).toString('base64url') + '.synthetic', access_token: 'SYNTHETIC-ACCESS', refresh_token: refresh } });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-accounts-'));
  const home = path.join(root, 'main'), folder = path.join(root, 'storage');
  await privateDirectory(home); await privateDirectory(folder);
  await writePrivate(path.join(home, 'config.toml'), 'cli_auth_credentials_store="file"\n');
  await writePrivate(path.join(home, 'auth.json'), syntheticAuth('original'));
  const exe = path.join(root, 'mock-codex');
  await fs.writeFile(exe, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const home = process.env.CODEX_HOME;
let timer;
function send(v) { process.stdout.write(JSON.stringify(v)+'\\n'); }
readline.createInterface({input:process.stdin}).on('line', line=>{
 const m=JSON.parse(line); if(!m.id) return;
 let result={};
 if(m.method==='account/login/start') {
  result={type:'chatgptDeviceCode',loginId:'mock-login',verificationUrl:fs.existsSync(path.join(home,'bad-url'))?'https://evil.invalid/':'https://auth.openai.com/codex/device',userCode:'SYNTHETIC-ONE-TIME-CODE'};
  timer=setTimeout(()=>{fs.writeFileSync(path.join(home,'auth.json'),${JSON.stringify(syntheticAuth('new-account'))},{mode:0o600});send({method:'account/login/completed',params:{loginId:'mock-login',success:true}});},500);
 }
 if(m.method==='account/login/cancel') clearTimeout(timer);
 if(m.method==='account/read') result={account:fs.existsSync(path.join(home,'auth.json'))?{type:'chatgpt',email:'mock@example.invalid',planType:'test-plan'}:null};
 send({id:m.id,result});
});
`, { mode: 0o700 });
  return { root, home, folder, exe };
}

test('账号登录独立保存，验证码只在内存，导入不改变当前登录', async () => {
  const f = await fixture(); const events: string[] = [];
  const store = new AccountStore(f.folder, f.home, () => f.exe, s => events.push(s));
  const original = await readPrivate(path.join(f.home, 'auth.json'));
  try {
    const id = await store.create('工作账号');
    await assert.rejects(store.create('工作账号'), /重复/);
    await store.startLogin(id);
    assert.equal(store.info(id)?.userCode, 'SYNTHETIC-ONE-TIME-CODE'); assert(store.hasPending());
    for (let i = 0; i < 60 && !store.summaries()[0].saved; i++) await new Promise(r => setTimeout(r, 30));
    assert(store.summaries()[0].saved); assert(!store.hasPending()); assert.equal(store.info(id), undefined);
    assert.equal(await readPrivate(path.join(f.home, 'auth.json')), original);
    assert(!JSON.stringify(store.summaries()).includes('SYNTHETIC-'));
    assert(!events.join().includes('SYNTHETIC-'));
    const imported = await store.importCurrent('原账号'); assert.notEqual(imported, id);
    assert.equal(await readPrivate(path.join(accountHome(f.folder, imported), 'auth.json')), original);
    assert.equal(await readPrivate(path.join(f.home, 'auth.json')), original);
    await assert.rejects(store.importCurrent('重复账号'), /已经保存/);
    for (const account of store.summaries()) {
      const files = await fs.readdir(accountHome(f.folder, account.id));
      assert(!files.includes('sessions')); assert(!files.some(n => n.endsWith('.sqlite')));
    }
    await store.startLogin(id); await store.cancel(id); assert(!store.info(id));
    await store.remove(id); assert.equal(store.summaries().length, 1);
    await assert.rejects(fs.access(accountHome(f.folder, id)));
    assert.equal(await readPrivate(path.join(f.home, 'auth.json')), original);
  } finally { store.stop(); await new Promise(r => setTimeout(r, 50)); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('账号文件未知、钥匙串及非法目录失败时保留当前登录', async () => {
  const f = await fixture(); const store = new AccountStore(f.folder, f.home, () => f.exe, () => {});
  try {
    assert.throws(() => accountHome(f.folder, '../main'), /编号/);
    assert.throws(() => authIdentity('{"tokens":{}}'), /格式/);
    await writePrivate(path.join(f.home, 'config.toml'), 'cli_auth_credentials_store="keyring"\n');
    await assert.rejects(store.importCurrent('钥匙串'), /钥匙串/);
    assert.equal(store.summaries().length, 0);
    assert.equal(await readPrivate(path.join(f.home, 'auth.json')), syntheticAuth('original'));
  } finally { store.stop(); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('拒绝非官方授权地址，不暴露验证码或更改主账号', async () => {
  const f = await fixture(); const store = new AccountStore(f.folder, f.home, () => f.exe, () => {});
  try {
    const id = await store.create('地址检查'); await writePrivate(path.join(accountHome(f.folder, id), 'bad-url'), 'synthetic');
    await assert.rejects(store.startLogin(id), /未能开始/);
    assert(!store.hasPending()); assert.equal(store.info(id), undefined);
    assert.equal(await readPrivate(path.join(f.home, 'auth.json')), syntheticAuth('original'));
  } finally { store.stop(); await new Promise(r => setTimeout(r, 50)); await fs.rm(f.root, { recursive: true, force: true }); }
});

test('后台账号操作不把授权码、令牌写到状态、日志或操作账本', async () => {
  const f = await fixture();
  const client = new AgentClient({ home: f.home, storageRoot: f.folder, agentScript: path.resolve('dist/agent.js'), backupScript: path.resolve('resources/backup.py'), nodePath: process.execPath });
  await privateDirectory(client.folder); await writePrivate(path.join(client.folder, 'control.key'), 'a'.repeat(64));
  const server = new AgentServer(client.folder, f.home, client.options.backupScript);
  try {
    await server.start(); await client.action('configure', { revision: 0, config: { providers: [], settings: defaults, pythonPath: 'python3', backupHours: 24, codexPath: f.exe } });
    const { id } = await client.action<{id:string}>('accountCreate', {name:'工作'});
    await client.action('accountLogin', { id }); assert.equal((await client.loginInfo(id))?.userCode, 'SYNTHETIC-ONE-TIME-CODE');
    const visible = JSON.stringify(await client.status()) + await readPrivate(path.join(client.folder, 'operations.json')) + await readPrivate(path.join(client.folder, 'state.json'));
    assert(!visible.includes('SYNTHETIC-ONE-TIME-CODE')); assert(!visible.includes('SYNTHETIC-REFRESH')); assert(!visible.includes('SYNTHETIC-ACCESS'));
    await assert.rejects(client.action('shutdown'), /登录/);
    await client.action('accountCancel', { id }); assert.equal(await client.loginInfo(id), null);
    assert.equal(await readPrivate(path.join(f.home, 'auth.json')), syntheticAuth('original'));
  } finally { await server.stop(); await new Promise(r=>setTimeout(r,50)); await fs.rm(f.root, { recursive: true, force: true }); }
});
