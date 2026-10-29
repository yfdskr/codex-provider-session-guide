import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { SwitchQueue } from '../../core/switch-queue';
import { SwitchPlan } from '../../core/configuration';
import { CodexBusyError } from '../../core/processes';
import { privateDirectory, writePrivate, readPrivate } from '../../core/files';
import { AgentClient } from '../../agent/client';
import { AgentServer } from '../../agent/server';
import { defaults } from '../../core/model';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-queue-'));
  await privateDirectory(path.join(root, 'plans'));
  const plan: SwitchPlan = { id: randomUUID(), createdAt: Date.now(), home: path.join(root,'home'), target: 'openai', targetName: 'Synthetic official account', expectedConfig: 'synthetic-hash', state: 'prepared' };
  const savePlan = () => writePrivate(path.join(root,'plans',plan.id+'.json'), JSON.stringify(plan));
  await savePlan(); return { root, plan, savePlan };
}
const idleInterval = 3600000;

test('自动切换先持久保存，Codex 在线时等待，连续确认退出后执行且不重复', async () => {
  const f=await fixture(); let active=[101], calls=0;
  const queue=new SwitchQueue(f.root,{scan:async()=>active,intervalMs:idleInterval,notify:()=>{},execute:async()=>{calls++;f.plan.state='success';await f.savePlan();return {...f.plan,sessionBackup:'/synthetic/backup'};}});
  try {
    await queue.start(); const accepted=await queue.enqueue(f.plan);
    assert.equal(JSON.parse(await readPrivate(path.join(f.root,'switch-job.json'))).id,accepted.id);
    await queue.poll();assert.equal(calls,0);assert.equal(queue.status()?.blockedBy,1);
    active=[];await queue.poll();assert.equal(calls,0);
    await queue.poll();assert.equal(calls,1);assert.equal(queue.status()?.phase,'success');
    assert.equal(queue.status()?.sessionBackup,'/synthetic/backup');await queue.poll();assert.equal(calls,1);
  } finally {await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('等待中可以取消，重复安排被拒绝；取消不执行或自动恢复收费计划', async () => {
  const f=await fixture();let calls=0;
  const queue=new SwitchQueue(f.root,{scan:async()=>[101],execute:async()=>{calls++;return f.plan;},intervalMs:idleInterval,notify:()=>{}});
  try {
    await queue.start();const job=await queue.enqueue(f.plan);
    await assert.rejects(queue.enqueue(f.plan),/已有/);
    await Promise.all([queue.poll(),queue.cancel(job.id)]);await queue.poll();
    assert.equal(calls,0);assert.equal(queue.status()?.phase,'cancelled');assert(!queue.pending());
    assert(queue.status()?.reason.includes('保持暂停'));
  } finally {await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('窗口断开或后台重启后继续等待；开始执行的旧任务按未知处理，绝不重放', async () => {
  const f=await fixture();let calls=0;
  const options={scan:async()=>[101],execute:async()=>{calls++;return f.plan;},intervalMs:idleInterval,notify:()=>{}};
  const first=new SwitchQueue(f.root,options);let second:SwitchQueue|undefined,third:SwitchQueue|undefined;
  try {
    await first.start();await first.enqueue(f.plan);await first.stop();
    second=new SwitchQueue(f.root,options);await second.start();await second.poll();assert.equal(second.status()?.phase,'waiting');
    await second.stop();const saved=JSON.parse(await readPrivate(path.join(f.root,'switch-job.json')));saved.phase='running';await writePrivate(path.join(f.root,'switch-job.json'),JSON.stringify(saved));
    third=new SwitchQueue(f.root,options);await third.start();await third.poll();assert.equal(third.status()?.phase,'unknown');assert.equal(calls,0);
    await assert.rejects(third.enqueue(f.plan),/未知/);
  } finally {await first.stop();await second?.stop();await third?.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('无法检查的进程继续阻止切换，等待超过一小时作废', async () => {
  const f=await fixture();let now=f.plan.createdAt,calls=0;
  const queue=new SwitchQueue(f.root,{scan:async()=>{throw new Error('进程无法确认身份');},execute:async()=>{calls++;return f.plan;},intervalMs:idleInterval,now:()=>now,notify:()=>{}});
  try {
    await queue.start();await queue.enqueue(f.plan);await queue.poll();assert.equal(calls,0);assert.equal(queue.status()?.phase,'waiting');
    assert(queue.status()?.reason.includes('无法确认'));now+=3600001;await queue.poll();assert.equal(queue.status()?.phase,'expired');assert.equal(calls,0);
  } finally {await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('执行前出现新 Codex 时仅在计划完全未开始的情况下继续等待', async () => {
  const f=await fixture();let attempts=0,writes=0;
  const queue=new SwitchQueue(f.root,{scan:async()=>[],execute:async()=>{if(++attempts===1)throw new CodexBusyError([101]);writes++;f.plan.state='success';await f.savePlan();return f.plan;},intervalMs:idleInterval,notify:()=>{}});
  try {
    await queue.start();await queue.enqueue(f.plan);await queue.poll();await queue.poll();
    assert.equal(queue.status()?.phase,'waiting');assert.equal(writes,0);
    await queue.poll();await queue.poll();assert.equal(queue.status()?.phase,'success');assert.equal(writes,1);
  } finally {await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('切换部分失败时保留备份路径并标记未知，不重试或允许新切换覆盖', async () => {
  const f=await fixture();let calls=0;
  const queue=new SwitchQueue(f.root,{scan:async()=>[],execute:async()=>{calls++;f.plan.state='unknown';f.plan.safetyBackup='/synthetic/safety';await f.savePlan();throw new Error('Synthetic partial failure');},intervalMs:idleInterval,notify:()=>{}});
  try {
    await queue.start();await queue.enqueue(f.plan);await queue.poll();await queue.poll();
    assert.equal(queue.status()?.phase,'unknown');assert.equal(queue.status()?.safetyBackup,'/synthetic/safety');
    await queue.poll();assert.equal(calls,1);await assert.rejects(queue.enqueue({...f.plan,state:'prepared'}),/未知/);
  } finally {await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('后台停止与进程检查交错时不新启动切换，等待记录留给下次恢复', async () => {
  const f=await fixture();let calls=0,scans=0,release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),inside=new Promise<void>(resolve=>{entered=resolve;});
  const queue=new SwitchQueue(f.root,{scan:async()=>{if(++scans===2){entered();await gate;}return [];},execute:async()=>{calls++;return f.plan;},intervalMs:idleInterval,notify:()=>{}});
  try {
    await queue.start();await queue.enqueue(f.plan);await queue.poll();const poll=queue.poll();await inside;
    const stopping=queue.stop();release();await Promise.all([poll,stopping]);
    assert.equal(calls,0);assert.equal(queue.status()?.phase,'waiting');
  } finally {release?.();await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('核对未知失败只解除新计划阻止，归档旧状态，不重放旧计划', async () => {
  const f=await fixture();let calls=0;
  const queue=new SwitchQueue(f.root,{scan:async()=>[],execute:async()=>{calls++;f.plan.state='unknown';await f.savePlan();throw new Error('Synthetic partial failure');},intervalMs:idleInterval,notify:()=>{}});
  try {
    await queue.start();const job=await queue.enqueue(f.plan);await queue.poll();await queue.poll();
    await queue.review(job.id);assert(queue.status()?.reviewedAt);assert.equal(queue.status()?.phase,'unknown');assert.equal(calls,1);
    assert.equal(JSON.parse(await readPrivate(path.join(f.root,'plans',f.plan.id+'.json'))).state,'unknown');
    assert.equal(JSON.parse(await readPrivate(path.join(f.root,'switch-reviews',job.id+'.json'))).reviewedAt,undefined);
    await queue.poll();assert.equal(calls,1);
    const replacement={...f.plan,id:randomUUID(),state:'prepared' as const};await queue.enqueue(replacement);assert.equal(queue.status()?.phase,'waiting');
  } finally {await queue.stop();await fs.rm(f.root,{recursive:true,force:true});}
});

test('后台切换需明确确认，自动暂停计划；同一请求不重复安排，等待中禁止其他修改', async () => {
  const f=await fixture();const home=f.plan.home;await privateDirectory(home);
  const client=new AgentClient({home,storageRoot:path.join(f.root,'storage'),agentScript:path.resolve('dist/agent.js'),backupScript:path.resolve('resources/backup.py'),nodePath:process.execPath});
  await privateDirectory(client.folder);await writePrivate(path.join(client.folder,'control.key'),'a'.repeat(64));
  const tool=path.join(f.root,'mock-sync');await fs.writeFile(tool,'synthetic tool not executed');
  const server=new AgentServer(client.folder,home,client.options.backupScript,'detached',tool,{scan:async()=>[101],intervalMs:idleInterval});
  try {
    await server.start();await client.action('configure',{revision:0,config:{providers:[{id:'a',name:'Synthetic',baseUrl:'http://127.0.0.1:1/v1',model:'synthetic',group:'test',priority:0,enabled:true}],settings:defaults,pythonPath:'python3',backupHours:24}});
    await client.action('monitor',{enabled:true});await client.action('autoBackup',{enabled:true,hours:24});
    await assert.rejects(client.action('queueSwitch',{id:'openai'}),/任务已结束/);assert((await client.status()).monitoring);
    const op=randomUUID(),payload={id:'openai',tasksStopped:true};
    const first:any=await client.action('queueSwitch',payload,op),duplicate:any=await client.action('queueSwitch',payload,op);assert.equal(first.id,duplicate.id);
    const state=await client.status();assert.equal(state.switchJob?.phase,'waiting');assert.equal(state.monitoring,false);assert.equal(state.autoBackup,false);
    await assert.rejects(client.action('setKey',{id:'a',key:'SYNTHETIC'}),/取消切换/);
    await assert.rejects(client.action('shutdown'),/取消切换/);
    await client.action('switchCancel',{id:first.id});assert.equal((await client.status()).switchJob?.phase,'cancelled');
    const later:any=await client.action('queueSwitch',{id:'openai',mode:'afterExit'});
    assert.equal((await client.status()).switchJob?.phase,'waiting');await client.action('switchCancel',{id:later.id});
    assert(!JSON.stringify(await client.status()).includes('SYNTHETIC'));
  } finally {await server.stop();await fs.rm(f.root,{recursive:true,force:true});}
});
