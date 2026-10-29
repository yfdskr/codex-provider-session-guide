// Real Electron/VS Code lifecycle test. Uses only a cloned public extension,
// temporary homes, synthetic credentials, and a loopback model endpoint.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
const require = createRequire(import.meta.url);
const desktop = process.env.CPM_VSCODE_DESKTOP, codex = process.env.CODEX_TEST_PATH, sync = process.env.CODEX_SYNC_TEST_PATH;
if (!desktop || !codex || !sync) throw new Error('Set CPM_VSCODE_DESKTOP, CODEX_TEST_PATH, CODEX_SYNC_TEST_PATH');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-real-ide-'));
await fs.chmod(root, 0o700);
const shared = path.join(root, 'shared.cjs');
await build({ stdin: { contents: `export {AgentClient} from '../agent/client';export {AgentServer} from '../agent/server';export {executePlan} from '../core/switch';export {defaults} from '../core/model';export {installIdeAdapter,inspectIdeAdapter,removeIdeAdapter} from '../core/ide-adapter';export {privateDirectory,writePrivate,readPrivate} from '../core/files';export {AppServer} from '../core/rpc';`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', outfile: shared, alias: { '@iarna/toml': path.resolve('node_modules/@iarna/toml') } });
const core = require(shared), home = path.join(root, 'codex'), storageRoot = path.join(root, 'state');
const extensions = path.join(root, 'extensions'), official = path.join(extensions, 'openai.chatgpt-copy');
const original = path.dirname(path.dirname(path.dirname(codex)));
await fs.mkdir(extensions); await fs.cp(original, official, { recursive: true, mode: fs.constants.COPYFILE_FICLONE });
const binary = path.join(official, 'bin/linux-x86_64/codex');
const client = new core.AgentClient({ home, storageRoot, nodePath: process.execPath, agentScript: path.resolve('dist/agent.js'), backupScript: path.resolve('resources/backup.py') });
await core.privateDirectory(home); await core.privateDirectory(client.folder);
await core.writePrivate(path.join(client.folder, 'control.key'), randomBytes(32).toString('hex'));
await core.writePrivate(path.join(home, 'config.toml'), 'cli_auth_credentials_store="file"\n[analytics]\nenabled=false\n');
await core.writePrivate(path.join(home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-gui-test-key' }));
await core.writePrivate(path.join(client.folder, 'launch.json'), JSON.stringify({ home, backupScript: path.resolve('resources/backup.py') }));
let generationRequests = 0;
const upstream = createServer((req, res) => {
  req.resume();
  if (req.method !== 'POST' || !/\/responses/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); return; }
  generationRequests++;
  const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const response = { id: 'resp_test', object: 'response', created_at: 1700000000, model: 'synthetic-model', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } }, { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'OK' }, { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response }];
  res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
});
upstream.listen(0, '127.0.0.1'); await new Promise(resolve => upstream.once('listening', resolve));
const scan = async () => {
  const pids = [];
  for (const name of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try { if ((await fs.stat('/proc/' + name)).uid === process.getuid() && await fs.readlink(`/proc/${name}/exe`) === binary) pids.push(Number(name)); }
    catch { /* This scan is scoped to the unique cloned executable only. */ }
  }
  return pids;
};
const backend = new core.AgentServer(client.folder, home, path.resolve('resources/backup.py'), 'detached', sync, {
  scan, intervalMs: 50,
  execute: async id => { await new Promise(resolve => setTimeout(resolve, 8000)); return core.executePlan(client.folder, id, true, scan); }
});
let app;
try {
  await core.writePrivate(path.join(home, 'seed.key'), 'synthetic-seed-only');
  await core.writePrivate(path.join(home, 'config.toml'), `model="synthetic-model"\nmodel_provider="seed"\ncli_auth_credentials_store="file"\n[analytics]\nenabled=false\n[model_providers.seed]\nname="Synthetic local seed"\nbase_url="http://127.0.0.1:${upstream.address().port}/v1"\nwire_api="responses"\nsupports_websockets=false\nrequest_max_retries=0\nstream_max_retries=0\n[model_providers.seed.auth]\ncommand="/bin/cat"\nargs=[${JSON.stringify(path.join(home, 'seed.key'))}]\n`);
  const seedRun = promisify(execFile)(binary, ['exec', '--skip-git-repo-check', '--cd', root, 'Reply OK. Do not call tools.'], { env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, CODEX_SQLITE_HOME: home }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  seedRun.child.stdin?.end(); const seedResult = await seedRun;
  if (!seedResult.stdout.includes('OK')) throw new Error('Synthetic local seed failed');
  const seedReader = new core.AppServer(binary, home, 10000, ['app-server', '--listen', 'stdio://'], true);
  await seedReader.start(); const seeds = await seedReader.call('thread/list', { sourceKinds: ['exec'], modelProviders: [], useStateDbOnly: true }); seedReader.stop();
  if (seeds.data.length !== 1) throw new Error('Expected one durable synthetic conversation');
  await new Promise(resolve => setTimeout(resolve, 250));
  await backend.start();
  const before = await client.status();
  await client.action('configure', { revision: before.revision, config: { providers: [{ id: 'relay', name: 'Synthetic local relay', group: 'test', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'synthetic-model', priority: 0, enabled: true }], settings: core.defaults, backupHours: 24, pythonPath: '/usr/bin/python3', codexPath: binary } });
  await client.action('setKey', { id: 'relay', key: 'synthetic-local-only-key' });
  const opts = { root: official, home, folder: client.folder, source: path.resolve('dist/ide-bootstrap.js') };
  const originalManifest = await fs.readFile(path.join(official, 'package.json'), 'utf8');
  const originalEntry = await fs.readFile(path.join(official, 'out', 'extension.js'), 'utf8');
  const harness = path.join(root, 'harness'); await fs.mkdir(harness);
  await fs.writeFile(path.join(harness, 'package.json'), JSON.stringify({ name: 'reload-harness', publisher: 'cpm-test', version: '0.0.1', engines: { vscode: '^1.95.0' }, activationEvents: ['onStartupFinished'], main: './index.cjs' }));
  await fs.writeFile(path.join(root, 'test-config.json'), JSON.stringify({ shared, home, storageRoot, folder: client.folder, official, binary, source: opts.source, nodePath: process.execPath, stage: -1, threadId: seeds.data[0].id }));
  await fs.writeFile(path.join(harness, 'index.cjs'), String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),vscode=require('vscode');
exports.activate=async function(){
 const root=process.env.CPM_TEST_ROOT,cfg=JSON.parse(await fs.readFile(path.join(root,'test-config.json'),'utf8')),core=require(cfg.shared);
 const client=new core.AgentClient({home:cfg.home,storageRoot:cfg.storageRoot,nodePath:cfg.nodePath,agentScript:'/unused/agent.js',backupScript:'/unused/backup.py'});
 const resultFile=path.join(root,'result.json'),stepsFile=path.join(root,'steps.json');
 const add=async value=>{let rows=[];try{rows=JSON.parse(await fs.readFile(stepsFile,'utf8'));}catch{}rows.push(value);await fs.writeFile(stepsFile,JSON.stringify(rows));};
 const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
 try{
  const official=vscode.extensions.getExtension('openai.chatgpt');check(official,'official extension missing');
  const started=official.activate();void started.catch(()=>{});
  if(cfg.stage===-1){
   await started;check((await core.inspectIdeAdapter({root:cfg.official,home:cfg.home,folder:cfg.folder})).state==='disabled','expected original native startup');
   await core.installIdeAdapter({root:cfg.official,home:cfg.home,folder:cfg.folder,source:cfg.source});
   check((await core.inspectIdeAdapter({root:cfg.official,home:cfg.home,folder:cfg.folder},process.pid)).state==='reloadRequired','setup must require first reload');
   await add({stage:-1,nativeStartup:true,setupInstalled:true});cfg.stage=0;
   await fs.writeFile(path.join(root,'test-config.json'),JSON.stringify(cfg));
   void vscode.commands.executeCommand('workbench.action.reloadWindow').catch(()=>{});return;
  }else if(cfg.stage===0){
   await started;
   check((await core.inspectIdeAdapter({root:cfg.official,home:cfg.home,folder:cfg.folder},process.pid)).state==='enabled','initial adapter receipt missing');
   await add({stage:0,hostPid:process.pid,active:true});
   const job=await client.action('queueSwitch',{id:'relay',mode:'reloadWindow',tasksStopped:true,hostPid:process.pid,extensionRoot:cfg.official});
   cfg.stage=1;cfg.jobId=job.id;cfg.firstHost=process.pid;
   await fs.writeFile(path.join(root,'test-config.json'),JSON.stringify(cfg));
   void vscode.commands.executeCommand('workbench.action.reloadWindow').catch(()=>{});return;
  }else if(cfg.stage===1){
   await new Promise(r=>setTimeout(r,300));
   const pending=await client.status();check(pending.switchJob.id===cfg.jobId,'job changed');
   check(['waiting','running'].includes(pending.switchJob.phase),'test must exercise startup while switch is pending');
   check(!official.isActive,'official extension started before switch completion');
   await add({stage:1,waiting:true,hostPid:process.pid});
   await started;const status=await client.status();check(status.switchJob.phase==='success','switch failed');
   check((await fs.readFile(path.join(cfg.home,'config.toml'),'utf8')).includes('model_provider = "relay"'),'new provider not installed');
   const rpc=new core.AppServer(cfg.binary,cfg.home,10000,['app-server','--listen','stdio://'],true);
   await rpc.start();const read=await rpc.call('thread/read',{threadId:cfg.threadId,includeTurns:false});rpc.stop();check(read.thread.id===cfg.threadId,'thread lost');
   await core.removeIdeAdapter({root:cfg.official,home:cfg.home,folder:cfg.folder});
   await add({stage:1,success:true,hostPid:process.pid,oldHostExited:process.pid!==cfg.firstHost,threadPreserved:true});
   cfg.stage=2;await fs.writeFile(path.join(root,'test-config.json'),JSON.stringify(cfg));
   void vscode.commands.executeCommand('workbench.action.reloadWindow').catch(()=>{});return;
  }else{
   await started;check((await core.inspectIdeAdapter({root:cfg.official,home:cfg.home,folder:cfg.folder})).state==='disabled','native entry not restored');
   await add({stage:2,nativeRestored:true,active:official.isActive});
   await fs.writeFile(resultFile,JSON.stringify({passed:true}));
  }
 }catch(e){await fs.writeFile(resultFile,JSON.stringify({passed:false,error:e.message}));}
};`);
  const fakeHome = path.join(root, 'user'); await fs.mkdir(path.join(fakeHome, '.config'), { recursive: true });
  const data = path.join(root, 'vscode-user'); await fs.mkdir(path.join(data, 'User'), { recursive: true });
  await fs.writeFile(path.join(data, 'User/settings.json'), JSON.stringify({ 'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'security.workspace.trust.enabled': false, 'http.proxy': 'http://127.0.0.1:1', 'http.proxySupport': 'override', 'window.restoreWindows': 'none', 'workbench.startupEditor': 'none', 'chatgpt.openOnStartup': false }));
  const env = { PATH: process.env.PATH, HOME: fakeHome, XDG_CONFIG_HOME: path.join(fakeHome, '.config'), XDG_CACHE_HOME: path.join(fakeHome, '.cache'), LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH || '', LANG: 'C.UTF-8', SHELL: '/bin/bash', CODEX_HOME: home, CODEX_SQLITE_HOME: home, CPM_TEST_ROOT: root, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost' };
  const log = await fs.open(path.join(root, 'vscode.log'), 'w');
  app = spawn(desktop, ['--no-sandbox', '--disable-gpu', '--ozone-platform=headless', '--user-data-dir', data, '--extensions-dir', extensions, '--extensionDevelopmentPath', harness, '--skip-welcome', '--disable-workspace-trust', root], { env, stdio: ['ignore', log.fd, log.fd] });
  await log.close();
  const deadline = Date.now() + 90000;
  let result;
  while (Date.now() < deadline) {
    try { result = JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8')); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const steps = JSON.parse(await fs.readFile(path.join(root, 'steps.json'), 'utf8').catch(() => '[]'));
  if (!result?.passed) throw new Error((result?.error || 'real IDE timed out') + '; test directory: ' + root);
  if (generationRequests !== 1) throw new Error('Expected only the one synthetic local seeding request');
  if (await fs.readFile(path.join(official, 'package.json'), 'utf8') !== originalManifest) throw new Error('restored manifest differs');
  if (await fs.readFile(path.join(official, 'out', 'extension.js'), 'utf8') !== originalEntry) throw new Error('restored native entry differs');
  await fs.mkdir('artifacts/experiments/reload', { recursive: true });
  await fs.writeFile('artifacts/experiments/reload/real-ide.json', JSON.stringify({ passed: true, steps, setupReloads: 1, switchReloads: 1, restoreReloads: 1, manifestUnchanged: true, nativeEntryRestoredExactly: true, externalModelRequests: 0, syntheticLoopbackRequests: generationRequests, realCredentialsUsed: false, source: 'actual cloned official VS Code extension and desktop Electron', directory: root }, null, 2));
  console.log(JSON.stringify({ passed: true, steps: steps.length, report: 'artifacts/experiments/reload/real-ide.json' }));
} finally {
  app?.kill('SIGTERM');
  if (app) await Promise.race([new Promise(resolve => app.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
  await backend.stop(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
}
