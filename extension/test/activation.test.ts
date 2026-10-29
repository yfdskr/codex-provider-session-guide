import { officialFixture } from './ide-fixture';
import { installIdeAdapter, inspectIdeAdapter, loadIdeRecord, writeIdeReceipt } from '../../core/ide-adapter';
import { extensionMap } from './vscode-mock';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { activate, deactivate } from '../src/extension';
import { AgentClient } from '../../agent/client';
import { commandsMap, builtinCommands, views, settingsMap, inputs, picks, messages, workspace, panels, confirmations } from './vscode-mock';
import { privateDirectory, writePrivate, readPrivate } from '../../core/files';
import { AGENT_VERSION, PROTOCOL_VERSION } from '../../agent/protocol';
import { defaults } from '../../core/model';
test('扩展激活与命令接线：默认不开监控、不改配置、不读凭证', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cpm-ui-'));
  const raw = 'model="synthetic"\nmodel_provider="relay"\n[model_providers.relay]\nname="Relay"\nbase_url="https://example.invalid/v1"\nwire_api="responses"\napi_key="SYNTHETIC-NEVER-IMPORT"\n[model_providers.relay.auth]\ncommand="/do-not-run"\n';
  await writeFile(path.join(home, 'config.toml'), raw); settingsMap.set('codexHome', home);
  settingsMap.set('agentStorageRoot', path.join(home, 'extension-state'));
  const state = new Map(), secrets = new Map(); let secretReads = 0;
  const context = {
    globalState: { get: (id: string, value: unknown) => state.get(id) ?? value, update: async (id: string, value: unknown) => { state.set(id, value); } },
    secrets: { get: async (id: string) => { secretReads++; return secrets.get(id); }, store: async (id: string, value: string) => { secrets.set(id, value); }, delete: async (id: string) => secrets.delete(id) },
    subscriptions: [] as any[], globalStorageUri: { fsPath: path.join(home, 'extension-state') }, asAbsolutePath: (s: string) => path.resolve(s)
  };
  try {
    await activate(context as any);
    assert.equal(views.size, 3);
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    assert.deepEqual([...commandsMap.keys()].sort(), manifest.contributes.commands.map((c: any) => c.command).sort());
    const monitor = await views.get('codexProviderManager.monitor').getChildren();
    assert(monitor.some((i: any) => i.label === '代理已停止'));
    assert(monitor.some((i: any) => i.label === '开启监控（可能产生少量费用）'));
    assert.equal(secretReads, 0);
    assert.equal(state.get('providers').length, 1, '启动时识别已有 API');
    const providerRoots = await views.get('codexProviderManager.providers').getChildren();
    assert.equal(providerRoots[0].label, '官方账号 · OpenAI');
    assert(!providerRoots[0].description.includes('当前配置使用'));
    const relay = providerRoots.flatMap((i: any) => i.children || []).find((i: any) => i.provider?.id === 'relay');
    assert(relay.description.includes('当前配置使用'));
    await commandsMap.get('codexProviderManager.importProviders')!();
    assert.equal(state.get('providers').length, 1, '再次导入不重复');
    assert(!JSON.stringify(state.get('providers')).includes('SYNTHETIC-NEVER-IMPORT'));
    assert.equal(secretReads, 0);
    inputs.push('Second', '测试组', 'https://second.invalid/v1', 'synthetic', '10', 'SYNTHETIC-SECRET'); picks.push('启用');
    await commandsMap.get('codexProviderManager.addProvider')!();
    assert.equal(state.get('providers').length, 2); assert.equal(secrets.size, 1);
    assert(!messages.join().includes('SYNTHETIC-SECRET'));
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), raw);
    settingsMap.set('codexPath', '/synthetic-codex-does-not-exist');
    await commandsMap.get('codexProviderManager.openDashboard')!();
    const panel = panels.at(-1);
    await panel.receive({ action: 'ready', requestId: 100 });
    assert(!JSON.stringify(panel.webview.messages).includes('SYNTHETIC-SECRET'));
    assert(!JSON.stringify(panel.webview.messages).includes('SYNTHETIC-NEVER-IMPORT'));
    await panel.receive({ action: 'saveProvider', requestId: 101, payload: { name: 'Visual supplier', group: 'test', baseUrl: 'https://visual.invalid/v1', model: 'synthetic', priority: 20, enabled: true } });
    assert.equal(state.get('providers').length, 3);
    await panel.receive({ action: 'executeCommand', requestId: 102, payload: { command: 'anything' } });
    assert(panel.webview.messages.some((m: any) => m.requestId === 102 && m.error.includes('暂不支持')));
    await panel.receive({ action: 'saveMonitor', requestId: 103, payload: { intervalSeconds: 1 } });
    assert(panel.webview.messages.some((m: any) => m.requestId === 103 && m.error));
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), raw);
    workspace.isTrusted = false;
    await commandsMap.get('codexProviderManager.addProvider')!();
    assert.equal(state.get('providers').length, 3); assert(messages.some(m => m.includes('信任工作区')));
  } finally {
    workspace.isTrusted = true; await deactivate(); for (const item of context.subscriptions) item.dispose();
    const client = new AgentClient({ home, storageRoot: context.globalStorageUri.fsPath, agentScript: path.resolve('dist/agent.js'), backupScript: path.resolve('resources/backup.py'), nodePath: process.execPath });
    if (await client.statusIfRunning()) {
      await client.action('shutdown');
      for (let i = 0; i < 50 && await client.statusIfRunning(); i++) await new Promise(resolve => setTimeout(resolve, 100));
    }
    settingsMap.clear(); await rm(home, { recursive: true, force: true });
  }
});

test('扩展关闭后代理仍可用，重新激活连接同一后台；密钥迁移保留原副本', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cpm-ui-persist-'));
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"type":"response.completed"}\n\n'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const raw = 'model_provider="openai"\n'; await writeFile(path.join(home, 'config.toml'), raw);
  const storageRoot = path.join(home, 'extension-state'); settingsMap.set('codexHome', home); settingsMap.set('agentStorageRoot', storageRoot);
  const state = new Map<string, any>([['providers', [{ id: 'synthetic', name: 'Synthetic', group: 'test', model: 'synthetic', baseUrl: `http://127.0.0.1:${(upstream.address() as any).port}/v1`, enabled: true, priority: 0 }]]]);
  const secrets = new Map([['provider:synthetic', 'SYNTHETIC-LEGACY-KEY']]);
  const createContext = () => ({ globalState: { get: (id: string, initial: unknown) => state.get(id) ?? initial, update: async (id: string, value: unknown) => { state.set(id, value); } },
    secrets: { get: async (id: string) => secrets.get(id), store: async (id: string, value: string) => { secrets.set(id, value); }, delete: async (id: string) => secrets.delete(id) },
    subscriptions: [] as any[], globalStorageUri: { fsPath: storageRoot }, asAbsolutePath: (file: string) => path.resolve(file) });
  let context = createContext();
  const client = new AgentClient({ home, storageRoot, agentScript: path.resolve('dist/agent.js'), backupScript: path.resolve('resources/backup.py'), nodePath: process.execPath });
  try {
    await activate(context as any); picks.push('test'); confirmations.push('启动代理');
    await commandsMap.get('codexProviderManager.startProxy')!();
    const first = await client.status(); assert(first.proxy); assert(first.keyIds.includes('synthetic'));
    assert.equal(secrets.get('provider:synthetic'), 'SYNTHETIC-LEGACY-KEY');
    await deactivate(); for (const item of context.subscriptions) item.dispose();
    const response = await fetch(`http://127.0.0.1:${first.proxy.port}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${await readPrivate(client.proxyTokenPath)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'synthetic', stream: true, input: 'synthetic' }) });
    assert.equal(response.status, 200); await response.text();
    context = createContext(); await activate(context as any);
    const second = await client.status(); assert.equal(second.pid, first.pid); assert.equal(second.proxy!.port, first.proxy.port);
    assert.equal(await readFile(path.join(home, 'config.toml'), 'utf8'), raw);
  } finally {
    await deactivate(); for (const item of context.subscriptions) item.dispose();
    if (await client.statusIfRunning()) { await client.action('proxyStop'); await client.action('shutdown'); for (let i = 0; i < 50 && await client.statusIfRunning(); i++) await new Promise(resolve => setTimeout(resolve, 50)); }
    settingsMap.clear(); confirmations.length = 0; picks.length = 0;
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await rm(home, { recursive: true, force: true });
  }
});

test('原生重载切换：后台接收后仅重载一次，拒绝、取消和稍后模式不重载', { skip: !process.env.CODEX_SYNC_TEST_PATH || !process.env.CODEX_TEST_PATH }, async () => {
  const home=await mkdtemp(path.join(os.tmpdir(),'cpm-native-switch-')),storageRoot=path.join(home,'state');
  const client=new AgentClient({home,storageRoot,agentScript:path.resolve('dist/agent.js'),backupScript:path.resolve('resources/backup.py'),nodePath:process.execPath});
  await privateDirectory(client.folder);await writePrivate(path.join(client.folder,'control.key'),'a'.repeat(64));await writePrivate(path.join(home,'config.toml'),'model_provider="openai"\n');
  let job:any,fail=false,queued=0;
  const seed={providers:[],settings:defaults,backupHours:24,pythonPath:'python3',codexPath:'/usr/bin/false'};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/status'){res.end(JSON.stringify({version:AGENT_VERSION,protocol:PROTOCOL_VERSION,home,pid:process.pid,mode:'detached',revision:1,config:seed,keyIds:[],monitoring:false,checking:false,nextCheck:0,autoBackup:false,nextBackup:0,backingUp:false,proxy:null,proxyError:'',health:{},history:{},events:[],accounts:[{id:'synthetic-account',name:'工作账号',saved:true,pending:false}],switchJob:job,capabilities:{history:true,existingVSCodeControl:false}}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const op=JSON.parse(raw);let result:any={};
    if(op.action==='queueSwitch'){
      if(fail){res.end(JSON.stringify({id:op.id,state:'error',error:'Synthetic backend refusal'}));return;}
      queued++;job={id:'synthetic-job',phase:'waiting',target:'openai',targetName:'工作账号',createdAt:Date.now(),reason:'等待退出'};result=job;
    }
    if(op.action==='switchCancel')job={...job,phase:'cancelled'};
    res.end(JSON.stringify({id:op.id,state:'success',result}));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  await writePrivate(path.join(client.folder,'connection.json'),JSON.stringify({port:(server.address() as any).port,home}));
  settingsMap.set('codexHome',home);settingsMap.set('agentStorageRoot',storageRoot);settingsMap.set('codexPath','/usr/bin/false');
  const persisted = new Map<string, any>();
  const context={globalState:{get:(k:string,v:any)=>persisted.get(k) ?? v,update:async(k:string,v:any)=>{persisted.set(k,v);}},secrets:{get:async()=>undefined},subscriptions:[] as any[],asAbsolutePath:(s:string)=>path.resolve(s)};
  const official = await officialFixture(home);
  extensionMap.set('openai.chatgpt', { extensionPath: official });
  const opts = { root: official, home, folder: client.folder, source: path.resolve('dist/ide-bootstrap.js') };
  await installIdeAdapter(opts); const adapted = await inspectIdeAdapter(opts);
  await writeIdeReceipt(await loadIdeRecord(path.join(official, adapted.entry!)), 'active');
  builtinCommands.length=0;
  try {
    await activate(context as any);await commandsMap.get('codexProviderManager.openDashboard')!();const panel=panels.at(-1);
    await panel.receive({action:'switchNow',requestId:201,payload:{id:'openai',accountId:'synthetic-account'}});assert.equal(queued,0,'没有确认时不安排');
    fail=true;confirmations.push('任务已结束，切换并重新加载');await panel.receive({action:'switchNow',requestId:202,payload:{id:'openai',accountId:'synthetic-account'}});
    await new Promise(r=>setTimeout(r,1100));assert.equal(builtinCommands.length,0,'后台拒绝时不关闭窗口');
    fail=false;confirmations.push('安排稍后切换');await panel.receive({action:'switchLater',requestId:203,payload:{id:'openai',accountId:'synthetic-account'}});
    await new Promise(r=>setTimeout(r,1100));assert.equal(builtinCommands.length,0,'稍后模式不关闭窗口');await panel.receive({action:'switchCancel',requestId:204,payload:{id:'synthetic-job'}});
    confirmations.push('任务已结束，切换并重新加载');await panel.receive({action:'switchNow',requestId:205,payload:{id:'openai',accountId:'synthetic-account'}});
    await panel.receive({action:'switchCancel',requestId:206,payload:{id:'synthetic-job'}});await new Promise(r=>setTimeout(r,1100));assert.equal(builtinCommands.length,0,'取消后不再自动关闭');
    confirmations.push('任务已结束，切换并重新加载');await panel.receive({action:'switchNow',requestId:207,payload:{id:'openai',accountId:'synthetic-account'}});
    await new Promise(r=>setTimeout(r,1100));assert.deepEqual(builtinCommands,['workbench.action.reloadWindow']);assert.equal(job.phase,'waiting');
    assert.equal(persisted.get('resumeSwitchDashboard')?.jobId, job.id);
    await deactivate();for(const item of context.subscriptions)item.dispose();context.subscriptions=[];
    const count=panels.length;await activate(context as any);assert(panels.length>count,'重载后自动恢复管理面板');
    assert.equal(persisted.get('resumeSwitchDashboard'),undefined);
  } finally {await deactivate();for(const item of context.subscriptions)item.dispose();settingsMap.clear();confirmations.length=0;builtinCommands.length=0;extensionMap.clear();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await rm(home,{recursive:true,force:true});}
});
