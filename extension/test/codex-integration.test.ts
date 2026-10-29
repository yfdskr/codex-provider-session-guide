import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServer, ThreadPage } from '../src/rpc';
import { ProviderProxy } from '../src/network';
import { defaults, HealthRegistry, Provider } from '../src/model';
import { AccountStore, accountHome } from '../../core/accounts';
import { privateDirectory, writePrivate, readPrivate } from '../../core/files';
import { prepareSwitch } from '../../core/configuration';
import { executePlan } from '../../core/switch';
import { SwitchQueue } from '../../core/switch-queue';
const execute = promisify(execFile);
test('真实 Codex：代理认证与故障切换 → 列表 → 完整备份 → 归档 → 恢复 → 删除', { skip: !process.env.CODEX_TEST_PATH, timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cpm-real-codex-'));
  const home = path.join(root, '.codex'); await mkdir(home);
  const message = { id: 'msg_test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
  const response = { id: 'resp_test', object: 'response', created_at: 1700000000, model: 'synthetic', status: 'completed', output: [message], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  let refused = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* Ignore synthetic request body. */ }
    if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}'); return; }
    if (req.url?.startsWith('/unavailable/')) { refused++; res.writeHead(503).end(); return; }
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'OK' },
      { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: 'OK' },
      { type: 'response.output_item.done', output_index: 0, item: message },
      { type: 'response.completed', response }
    ];
    res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as any).port;
  const providers: Provider[] = ['a', 'b'].map((id, priority) => ({ id, name: id, priority, enabled: true, group: 'test', model: 'synthetic', baseUrl: `http://127.0.0.1:${port}${id === 'a' ? '/unavailable' : ''}/v1` }));
  const proxy = new ProviderProxy({ group: 'test', token: 'synthetic-local-token', providers: () => providers, settings: () => defaults, health: new HealthRegistry(() => defaults), key: async () => 'synthetic-upstream-key', log: () => undefined });
  await proxy.start();
  const tokenFile = path.join(root, 'synthetic.key'); await writeFile(tokenFile, 'synthetic-local-token', { mode: 0o600 });
  await writeFile(path.join(home, 'config.toml'), `model = "synthetic"\nmodel_provider = "synthetic"\n[analytics]\nenabled = false\n[model_providers.synthetic]\nname = "Local test only"\nbase_url = "http://127.0.0.1:${proxy.port}/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[model_providers.synthetic.auth]\ncommand = "/bin/cat"\nargs = [${JSON.stringify(tokenFile)}]\n`);
  const codex = process.env.CODEX_TEST_PATH!;
  let rpc: AppServer | undefined;
  try {
    const invocation = execute(codex, ['exec', '--skip-git-repo-check', '--cd', root, 'Reply OK. Do not call tools.'], { env: { ...process.env, CODEX_HOME: home }, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    invocation.child.stdin?.end();
    const result = await invocation;
    assert(result.stdout.includes('OK'));
    assert.equal(refused, 1); assert.equal(proxy.activeProvider, 'b');
    rpc = new AppServer(codex, home); await rpc.start();
    const query = (archived: boolean) => rpc!.call<ThreadPage>('thread/list', { archived, modelProviders: [], sourceKinds: ['exec', 'cli', 'vscode', 'appServer'], useStateDbOnly: true });
    const active = await query(false); assert.equal(active.data.length, 1);
    const id = active.data[0].id;
    const db = (await readdir(home)).find(p => /^state_\d+\.sqlite$/.test(p))!;
    const snapshot = await execute('python3', [path.resolve('resources/backup.py'), '--home', home, '--database', path.join(home, db), '--destination', path.join(root, 'snapshots')]);
    assert.equal(JSON.parse(snapshot.stdout).verified, true);
    await rpc.call('thread/archive', { threadId: id });
    assert((await query(true)).data.some(t => t.id === id)); assert(!(await query(false)).data.some(t => t.id === id));
    if (process.env.CODEX_SYNC_TEST_PATH) {
      const archivedFile=(await query(true)).data.find(t=>t.id===id)?.path;
      assert(archivedFile);
      await writeFile(path.join(path.dirname(archivedFile),'rollout-2000-01-01T00-00-00-'+id+'.jsonl'),(await readFile(archivedFile,'utf8'))+JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'SYNTHETIC retained divergent copy'}})+'\n');
      rpc.stop(); rpc = undefined;
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = path.join(root, 'isolated-manager'); await privateDirectory(state);
      const api: Provider = { id: 'synthetic', name: 'Synthetic only', group: 'test', model: 'synthetic', baseUrl: `http://127.0.0.1:${proxy.port}/v1`, priority: 0, enabled: true };
      await writePrivate(path.join(state, 'state.json'), JSON.stringify({ revision: 1, config: { providers: [api], pythonPath: 'python3', sqliteHome: home }, monitorEnabled: false, backupEnabled: false }));
      await writePrivate(path.join(state, 'launch.json'), JSON.stringify({ home, backupScript: path.resolve('resources/backup.py') }));
      const auth = (account: string, refresh: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { account_id: account, id_token: 'synthetic.' + Buffer.from(JSON.stringify({ sub: account })).toString('base64url') + '.synthetic', access_token: 'SYNTHETIC-ACCESS', refresh_token: refresh } });
      const accounts = new AccountStore(state, home, () => undefined, () => {});
      await writePrivate(path.join(home, 'auth.json'), auth('a', 'SYNTHETIC-A-OLD'));
      const a = await accounts.importCurrent('A');
      await writePrivate(path.join(home, 'auth.json'), auth('b', 'SYNTHETIC-B-OLD'));
      const b = await accounts.importCurrent('B');
      await writePrivate(path.join(home, 'auth.json'), auth('a', 'SYNTHETIC-A-LATEST'));
      const apply = async (target: string, accountId?: string) => {
        const plan = await prepareSwitch(state, home, target, [api], () => 'synthetic-local-token', accountId);
        plan.expectedRevision = 1; plan.tool = process.env.CODEX_SYNC_TEST_PATH;
        await writePrivate(path.join(state, 'plans', plan.id + '.json'), JSON.stringify(plan));
        // Isolated test only: no user process discovery or termination.
        const queue = new SwitchQueue(state, { scan: async () => [], execute: id => executePlan(state, id, true, async () => []), notify: () => {}, intervalMs: 3600000 });
        try { await queue.start(); await queue.enqueue(plan); await queue.poll(); await queue.poll(); assert.equal(queue.status()?.phase, 'success'); }
        finally { await queue.stop(); }
        const result = JSON.parse(await readPrivate(path.join(state, 'plans', plan.id + '.json')));
        assert.equal(result.state, 'success'); assert(result.sessionBackup);
        await assert.rejects(executePlan(state, plan.id, true, async () => []), /已经执行/);
      };
      await apply('openai', b);
      assert.equal(await readPrivate(path.join(accountHome(state, a), 'auth.json')), auth('a', 'SYNTHETIC-A-LATEST'));
      await apply('synthetic');
      const extra = execute(codex, ['exec', '--skip-git-repo-check', '--cd', root, 'Reply OK. Synthetic second conversation.'], { env: { ...process.env, CODEX_HOME: home }, timeout: 30000 });
      extra.child.stdin?.end(); assert((await extra).stdout.includes('OK'));
      await writePrivate(path.join(home, 'auth.json'), auth('b', 'SYNTHETIC-B-LATEST'));
      await apply('openai', a);
      assert.equal(await readPrivate(path.join(home, 'auth.json')), auth('a', 'SYNTHETIC-A-LATEST'));
      assert.equal(await readPrivate(path.join(accountHome(state, b), 'auth.json')), auth('b', 'SYNTHETIC-B-LATEST'));
      await apply('synthetic');
      rpc = new AppServer(codex, home); await rpc.start();
      assert((await query(true)).data.some(t => t.id === id));
      assert.equal((await query(false)).data.length, 1, 'API 期间新增对话保留');
    }
    await rpc.call('thread/unarchive', { threadId: id });
    assert((await query(false)).data.some(t => t.id === id));
    await rpc.call('thread/delete', { threadId: id });
    assert(!(await query(false)).data.some(t => t.id === id)); assert(!(await query(true)).data.some(t => t.id === id));
  } finally {
    rpc?.stop(); await proxy.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
