import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from '@iarna/toml';
import { privateDirectory, readPrivate, writePrivate } from '../../core/files';
import { inspectProvider, installProvider, prepareSwitch } from '../../core/configuration';
import { validateProviders, defaults, Provider } from '../../core/model';
import { executePlan } from '../../core/switch';
import { codexProcesses } from '../../core/processes';
import { probeTools } from '../../core/network';

const provider: Provider = { id: 'relay', name: '测试 API', group: 'test', model: 'synthetic', baseUrl: 'https://example.invalid/v1', enabled: true, priority: 0 };
test('配置检查不联网，重复名称和错误地址被拒绝，写配置保留其他值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-config-'));
  try {
    await writePrivate(path.join(root, 'config.toml'), 'model="old"\n[features]\ncustom=true\n');
    assert.equal((await inspectProvider(root, provider, false)).ok, false);
    assert.equal((await inspectProvider(root, provider, true)).ok, true);
    assert.throws(() => validateProviders([provider, { ...provider, id: 'second' }]), /名称/);
    assert.throws(() => validateProviders([{ ...provider, baseUrl: 'https://example.invalid/v1/responses' }]), /地址/);
    const value: any = parse(installProvider(await readPrivate(path.join(root, 'config.toml')), provider, '/tmp/synthetic.key'));
    assert.equal(value.features.custom, true); assert.equal(value.model, 'old');
    assert.equal(value.model_providers.relay.requires_openai_auth, false);
    await writePrivate(path.join(root, 'config.toml'), installProvider('', provider, '/tmp/synthetic.key'));
    assert.equal((await inspectProvider(root, provider, false)).usesExistingAuth, true);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});

test('工具格式测试只发送虚构请求，不执行工具；错误与不完整流不通过', async () => {
  const call = { type: 'function_call', call_id: 'synthetic-id', name: 'cpm_connection_check', arguments: '{"value":"OK"}' };
  let requests = 0;
  const fetcher = (events: any[], status = 200) => (async (_url: any, options: any) => {
    requests++; const body = JSON.parse(options.body); assert.equal(body.store, false); assert.equal(body.tool_choice.name, call.name); assert(!options.body.includes('function_call_output'));
    return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { status, headers: {'Content-Type':'text/event-stream'} });
  }) as typeof fetch;
  assert((await probeTools(provider, 'SYNTHETIC', 5, fetcher([{type:'response.completed',response:{output:[call]}}]))).ok);
  assert(!(await probeTools(provider, 'SYNTHETIC', 5, fetcher([{type:'response.output_item.done',item:call}]))).ok);
  assert(!(await probeTools(provider, 'SYNTHETIC', 5, fetcher([{type:'response.completed',response:{output:[{...call,arguments:'{"value":"bad"}'}]}}]))).ok);
  assert(!(await probeTools(provider, 'SYNTHETIC', 5, fetcher([], 400))).ok);
  assert.equal(requests,4);
});

test('进程检查只看同用户的可执行文件，不读取命令行和环境', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-proc-'));
  try {
    for (const [id, exe] of [['101','/opt/bin/codex'],['102','/opt/bin/node'],['103','/opt/bin/codex (deleted)']]) {
      await fs.mkdir(path.join(root,id)); await fs.symlink(exe,path.join(root,id,'exe'));
      await fs.writeFile(path.join(root,id,'environ'),'DO-NOT-READ');
    }
    assert.deepEqual((await codexProcesses(root)).sort(),[101,103]);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});

async function protectedProcFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-protected-proc-'));
  const uid = process.getuid!();
  const row = async (pid: number, name: string, parent: number, owner: number, exe: string) => {
    await fs.mkdir(path.join(root, String(pid)));
    await fs.writeFile(path.join(root, String(pid), 'status'), `Name:\t${name}\nPPid:\t${parent}\nUid:\t${[owner,owner,owner,owner].join('\t')}\n`);
    await fs.symlink(exe, path.join(root, String(pid), 'exe'));
  };
  await row(10, 'sshd', 1, 0, '/usr/sbin/sshd');
  await row(11, 'sshd', 10, uid, '/usr/sbin/sshd');
  await row(20, 'systemd', 1, uid, '/usr/lib/systemd/systemd');
  await row(21, '(sd-pam)', 20, uid, '/usr/lib/systemd/systemd');
  await row(31, 'codex', 1, uid, '/opt/bin/codex');
  const denied = new Set([11,21]), rootLinks = new Set([11,21]);
  const files = { ...fs,
    stat: (async (p: any, ...args: any[]) => {
      const result = await (fs.stat as any)(p, ...args); if (String(p) === path.join(root, '10')) result.uid = 0; return result;
    }) as typeof fs.stat,
    lstat: (async (p: any, ...args: any[]) => {
      const result = await (fs.lstat as any)(p, ...args); if (rootLinks.has(Number(path.basename(path.dirname(String(p)))))) result.uid = 0; return result;
    }) as typeof fs.lstat,
    readlink: (async (p: any, ...args: any[]) => {
      if (denied.has(Number(path.basename(path.dirname(String(p)))))) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
      return (fs.readlink as any)(p, ...args);
    }) as typeof fs.readlink,
    readFile: (async (p: any, ...args: any[]) => {
      assert(!['cmdline','environ'].includes(path.basename(String(p)))); return (fs.readFile as any)(p, ...args);
    }) as typeof fs.readFile
  };
  return { root, uid, files, denied, rootLinks, row };
}

test('服务器回归：受保护的 sshd、sd-pam 不误拦，同时仍能识别 Codex', async () => {
  const f = await protectedProcFixture();
  try { assert.deepEqual(await codexProcesses(f.root, f.uid, f.files), [31]); }
  finally { await fs.rm(f.root, { recursive:true,force:true }); }
});

test('进程名字不能绕过检查：缺少系统父进程或 root 所属链接时仍阻止切换', async () => {
  const f = await protectedProcFixture();
  try {
    f.rootLinks.delete(11);
    await assert.rejects(codexProcesses(f.root, f.uid, f.files), /进程 11 无法确认身份/);
    f.rootLinks.add(11);
    await fs.writeFile(path.join(f.root,'10','status'), `Name:\tother\nPPid:\t1\nUid:\t0\t0\t0\t0\n`);
    await assert.rejects(codexProcesses(f.root, f.uid, f.files), /进程 11 无法确认身份/);
  } finally { await fs.rm(f.root, { recursive:true,force:true }); }
});

test('无法读取 Codex 或未知进程时仍失败关闭，不把权限错误直接忽略', async () => {
  const f = await protectedProcFixture();
  try {
    f.denied.add(31);
    await assert.rejects(codexProcesses(f.root, f.uid, f.files), /进程 31 无法确认身份/);
    await fs.writeFile(path.join(f.root,'31','status'), `Name:\tunknown\nPPid:\t1\nUid:\t${[f.uid,f.uid,f.uid,f.uid].join('\t')}\n`);
    await assert.rejects(codexProcesses(f.root, f.uid, f.files), /进程 31 无法确认身份/);
  } finally { await fs.rm(f.root, { recursive:true,force:true }); }
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-plan-')); const home = path.join(root,'home'), folder = path.join(root,'state');
  await privateDirectory(home); await privateDirectory(folder); await privateDirectory(path.join(home,'sessions'));
  await writePrivate(path.join(home,'config.toml'),'model_provider="source"\nmodel="old"\n');
  await writePrivate(path.join(home,'sessions','a.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'a',model_provider:'source'}})+'\n'+JSON.stringify({type:'event_msg',payload:{message:'Synthetic unchanged body'}})+'\n');
  const db=path.join(home,'state_9.sqlite');
  execFileSync('python3',['-c','import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("CREATE TABLE threads(id TEXT PRIMARY KEY)");c.execute("INSERT INTO threads VALUES (\'a\')");c.commit()',db]);
  await writePrivate(path.join(folder,'state.json'),JSON.stringify({revision:1,config:{providers:[provider],settings:defaults,backupHours:24,pythonPath:'python3'},monitorEnabled:false,backupEnabled:false}));
  await writePrivate(path.join(folder,'launch.json'),JSON.stringify({home,backupScript:path.resolve('resources/backup.py')}));
  const tool=path.join(root,'sync');
  await fs.writeFile(tool,`#!/usr/bin/python3
import json,sys
from pathlib import Path
home=Path(${JSON.stringify(home)})
if sys.argv[1]=='status':
 print(json.dumps({'ok':True,'outcome':'completed','result':{'rolloutScanComplete':True,'configuredProviders':['openai','relay','source'],'currentProvider':'source','stateDbLocation':{'path':${JSON.stringify(db)}}}}))
else:
 (home/'partial-marker').write_text('accepted-once')
 print(json.dumps({'ok':False,'outcome':'partial'}))
 sys.exit(1)
`,{mode:0o700});
  const prepare=async()=>{const plan=await prepareSwitch(folder,home,'relay',[provider],()=> 'SYNTHETIC-KEY');plan.tool=tool;plan.expectedRevision=1;await writePrivate(path.join(folder,'plans',plan.id+'.json'),JSON.stringify(plan));return plan;};
  return {root,home,folder,prepare};
}
test('切换前阻止活动进程、配置和 Key 变更；计划内不保存明文 Key', async () => {
  const f=await fixture();
  try {
    const plan=await f.prepare(); assert(!JSON.stringify(plan).includes('SYNTHETIC-KEY'));
    await assert.rejects(executePlan(f.folder,plan.id,false,async()=>[]),/结束任务/);
    await assert.rejects(executePlan(f.folder,plan.id,true,async()=>[101]),/Codex 后台/);
    await writePrivate(path.join(f.home,'config.toml'),'model_provider="changed"\n');
    await assert.rejects(executePlan(f.folder,plan.id,true,async()=>[]),/配置发生变化/);
    assert.equal(await readPrivate(path.join(f.home,'config.toml')),'model_provider="changed"\n');
    const changed=await f.prepare(); await writePrivate(changed.keyPath!,'DIFFERENT-SYNTHETIC');
    await assert.rejects(executePlan(f.folder,changed.id,true,async()=>[]),/Key 已改变/);
    await assert.rejects(fs.access(path.join(f.home,'partial-marker')));
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});
test('部分切换保留原配置和完整会话备份，重复和并发执行不会重放', async () => {
  const f=await fixture();
  try {
    const plan=await f.prepare(), before=await readPrivate(path.join(f.home,'config.toml'));
    const result=await Promise.allSettled([executePlan(f.folder,plan.id,true,async()=>[]),executePlan(f.folder,plan.id,true,async()=>[])]);
    assert(result.every(r=>r.status==='rejected'));
    const saved=JSON.parse(await readPrivate(path.join(f.folder,'plans',plan.id+'.json')));
    assert.equal(saved.state,'unknown'); assert.equal(await readPrivate(path.join(saved.safetyBackup,'config.toml')),before);
    assert.equal(await fs.readFile(path.join(f.home,'partial-marker'),'utf8'),'accepted-once');
    const snapshots=await fs.readdir(path.join(f.root,'.codex-provider-manager-backups'));assert.equal(snapshots.length,1);
    await assert.rejects(executePlan(f.folder,plan.id,true,async()=>[]),/已经执行|未知/);
    assert.equal((await fs.readdir(path.join(f.root,'.codex-provider-manager-backups'))).length,1);
  } finally { await fs.rm(f.root,{recursive:true,force:true}); }
});

test('备份失败有可靠的未修改回执，官方切换按失败处理而不是笼统未知', async () => {
  const f=await fixture();
  try {
    const original=await readPrivate(path.join(f.home,'config.toml'));
    const helperPlan=await f.prepare();
    const plan=await prepareSwitch(f.folder,f.home,'openai',[],()=>undefined);plan.tool=helperPlan.tool;plan.expectedRevision=1;
    await writePrivate(path.join(f.folder,'plans',plan.id+'.json'),JSON.stringify(plan));
    execFileSync('python3',['-c','import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute("INSERT INTO threads VALUES (\'missing-rollout\')");c.commit()',path.join(f.home,'state_9.sqlite')]);
    await assert.rejects(executePlan(f.folder,plan.id,true,async()=>[]),/数据库与记录的对话 ID 不一致/);
    const failed=JSON.parse(await readPrivate(path.join(f.folder,'plans',plan.id+'.json')));
    assert.equal(failed.state,'error');assert.equal(failed.stage,'backup');assert.equal(failed.mutationStarted,false);assert.equal(failed.errorCode,'ID_SET_MISMATCH');
    assert.equal(await readPrivate(path.join(f.home,'config.toml')),original);
    await assert.rejects(fs.access(path.join(f.home,'partial-marker')));
    await assert.rejects(executePlan(f.folder,plan.id,true,async()=>[]),/已经执行|未知/);
  } finally {await fs.rm(f.root,{recursive:true,force:true});}
});
