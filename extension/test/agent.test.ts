import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn, ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentServer } from '../../agent/server';
import { AgentClient, serviceUnit } from '../../agent/client';
import { AGENT_VERSION, AgentConfig } from '../../agent/protocol';
import { defaults } from '../../core/model';
import { acquireLock, privateDirectory, readPrivate, writePrivate, withOperation } from '../../core/files';

const config = (): AgentConfig => ({ providers: [{ id: 'a', name: 'Synthetic', group: 'test', baseUrl: 'https://example.invalid/v1', model: 'synthetic', priority: 0, enabled: true }], settings: { ...defaults }, backupHours: 24, pythonPath: 'python3' });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-agent-'));
  const home = path.join(root, 'codex'); await privateDirectory(home);
  const client = new AgentClient({ home, storageRoot: path.join(root, 'storage'), agentScript: path.resolve('dist/agent.js'), backupScript: path.resolve('resources/backup.py'), nodePath: process.execPath });
  await privateDirectory(client.folder); await writePrivate(path.join(client.folder, 'control.key'), 'a'.repeat(64));
  const server = new AgentServer(client.folder, home, client.options.backupScript);
  return { root, home, client, server, cleanup: async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}
async function waitStopped(client: AgentClient) {
  for (let i = 0; i < 80; i++) { if (!await client.statusIfRunning()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Test agent did not stop');
}

test('后台认证、来源校验、默认关闭，状态和操作记录不含 Key', async () => {
  const f = await fixture();
  try {
    const port = await f.server.start();
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: 'Bearer ' + 'a'.repeat(64), Origin: 'https://example.invalid' } })).status, 403);
    const first = await f.client.status(); assert.equal(first.monitoring, false); assert.equal(first.autoBackup, false); assert.equal(first.proxy, null);
    await f.client.action('configure', { revision: 0, config: config() });
    await f.client.action('setKey', { id: 'a', key: 'SYNTHETIC-PRIVATE-KEY' });
    const state = await f.client.status(); assert.deepEqual(state.keyIds, ['a']);
    const visible = JSON.stringify(state) + await readPrivate(path.join(f.client.folder, 'operations.json')) + await readPrivate(path.join(f.client.folder, 'state.json'));
    assert(!visible.includes('SYNTHETIC-PRIVATE-KEY'));
    assert.equal((await fs.stat(path.join(f.client.folder, 'credentials.json'))).mode & 0o777, 0o600);
    assert.equal((await fs.stat(f.client.folder)).mode & 0o777, 0o700);
    assert.equal(state.capabilities.existingVSCodeControl, false);
    await assert.rejects(f.client.action('executeCommand', { command: 'anything' }), /不支持/);
  } finally { await f.cleanup(); }
});

test('两个窗口同时提交同一编号只执行一次；陈旧版本不能覆盖新设置', async () => {
  const f = await fixture();
  try {
    await f.server.start(); const id = randomUUID(), payload = { revision: 0, config: config() };
    const results = await Promise.all([f.client.action('configure', payload, id), f.client.action('configure', payload, id)]);
    assert.deepEqual(results, [{ revision: 1 }, { revision: 1 }]);
    assert.equal((await f.client.status()).revision, 1);
    await assert.rejects(f.client.action('configure', { revision: 1, config: config() }, id), /同一操作编号/);
    await assert.rejects(f.client.action('configure', payload), /其他窗口/);
    assert.equal((await f.client.status()).revision, 1);
  } finally { await f.cleanup(); }
});

test('崩溃时未确认的操作保持未知，同编号不自动重放', async () => {
  const f = await fixture();
  try {
    const id = randomUUID(), payload = { revision: 0, config: config() };
    const digest = createHash('sha256').update(JSON.stringify({ action: 'configure', payload })).digest('hex');
    await writePrivate(path.join(f.client.folder, 'operations.json'), JSON.stringify([{ id, action: 'configure', digest, at: Date.now(), state: 'running' }]));
    await f.server.start();
    assert.equal((await f.client.operation(id)).state, 'unknown');
    await assert.rejects(f.client.action('configure', payload, id), /未知/);
    assert.equal((await f.client.status()).revision, 0);
  } finally { await f.cleanup(); }
});

test('操作锁阻止并发，验证旧进程退出后才回收；不跟随凭据符号链接', async () => {
  const f = await fixture();
  try {
    const lock = path.join(f.home, 'test.lock');
    const release = await acquireLock(lock);
    await assert.rejects(acquireLock(lock), /正在运行/); await release();
    const dead = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
    await writePrivate(lock, JSON.stringify({ pid: Number(dead.stdout), nonce: 'old' }));
    const recovered = await acquireLock(lock); await recovered();
    await fs.symlink(path.join(f.client.folder, 'control.key'), path.join(f.client.folder, 'linked.key'));
    await assert.rejects(readPrivate(path.join(f.client.folder, 'linked.key')), /权限不安全/);
  } finally { await f.cleanup(); }
});

test('独立后台跨客户端存活，重启保留代理地址和令牌，不重复上游请求', async () => {
  const f = await fixture(); let requested = 0;
  const upstream = http.createServer((req, res) => {
    requested++; req.resume(); res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"type":"response.output_text.delta","delta":"OK"}\n\ndata: {"type":"response.completed"}\n\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const port = (upstream.address() as any).port;
  const other = new AgentClient(f.client.options);
  try {
    await f.client.ensureStarted();
    const cfg = config(); cfg.providers[0].baseUrl = `http://127.0.0.1:${port}/v1`;
    await f.client.action('configure', { revision: 0, config: cfg });
    await f.client.action('setKey', { id: 'a', key: 'SYNTHETIC-UPSTREAM' });
    await f.client.action('proxyStart', { group: 'test' });
    const first = await other.status(); assert(first.proxy); assert.equal(requested, 0);
    const token = await readPrivate(f.client.proxyTokenPath);
    const response = await fetch(`http://127.0.0.1:${first.proxy.port}/v1/responses`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'synthetic', stream: true, input: 'synthetic' }) });
    assert.equal(response.status, 200); await response.text(); assert.equal(requested, 1);
    // Terminate only the isolated child, never a user's installed backend.
    const exited = new Promise<void>(resolve => { const timer = setInterval(() => {
      try { process.kill(first.pid, 0); } catch { clearInterval(timer); resolve(); }
    }, 50); setTimeout(() => { clearInterval(timer); resolve(); }, 3000).unref(); });
    process.kill(first.pid, 'SIGTERM'); await exited; await waitStopped(other);
    const second = await other.ensureStarted();
    assert(second.proxy); assert.equal(second.proxy.port, first.proxy.port); assert.equal(await readPrivate(other.proxyTokenPath), token);
    assert.notEqual(second.pid, first.pid); assert.equal(requested, 1, '重启没有向模型重放请求');
    await assert.rejects(withOperation(f.home, async () => undefined), /停止.*代理/);
    await other.action('proxyStop'); await other.action('shutdown'); await waitStopped(other);
  } finally {
    const live = await other.statusIfRunning().catch(() => undefined);
    if (live) { await other.action('proxyStop').catch(() => undefined); await other.action('shutdown').catch(() => undefined); await waitStopped(other); }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await f.cleanup();
  }
});

test('后台定时计划可恢复，重启仅安排下一轮；手动停止清除计划', async () => {
  const f = await fixture();
  try {
    await f.server.start(); await f.client.action('configure', { revision: 0, config: config() });
    await f.client.action('monitor', { enabled: true }); await f.client.action('autoBackup', { enabled: true, hours: 2 });
    const before = await f.client.status(); assert(before.nextCheck > Date.now()); assert(before.nextBackup > Date.now());
    await f.server.stop();
    const restarted = new AgentServer(f.client.folder, f.home, f.client.options.backupScript);
    try {
      await restarted.start(); const after = await f.client.status();
      assert(after.monitoring); assert(after.autoBackup); assert(after.nextCheck >= before.nextCheck); assert(after.nextBackup >= before.nextBackup);
      await f.client.action('shutdown'); await waitStopped(f.client);
      const saved = await f.client.savedState(); assert.equal(saved!.monitorEnabled, false); assert.equal(saved!.backupEnabled, false);
    } finally { await restarted.stop(); }
  } finally { await f.cleanup(); }
});

test('后台手动备份使用实际 SQLite 和会话校验，失败不产生完整副本', async () => {
  const f = await fixture();
  try {
    await f.server.start(); await f.client.action('configure', { revision: 0, config: config() });
    await promisify(execFile)('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE threads (id TEXT PRIMARY KEY)"); c.commit()', path.join(f.home, 'state_1.sqlite')]);
    const result = await f.client.action<{ backup: string; sessions: number }>('backup');
    assert.equal(result.sessions, 0); assert((await fs.stat(path.join(result.backup, 'manifest.json'))).isFile());
    await promisify(execFile)('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO threads VALUES (?)", ("missing",)); c.commit()', path.join(f.home, 'state_1.sqlite')]);
    await assert.rejects(f.client.action('backup'), /完整备份未通过/);
    const entries = await fs.readdir(path.dirname(result.backup));
    assert.equal(entries.filter(n => !n.endsWith('.partial')).length, 1);
  } finally { await f.cleanup(); }
});

test('强制崩溃后的检测结果可查询为未知，不重发已接受的上游请求', async () => {
  const f = await fixture(); let requested = 0;
  let accept!: () => void; const accepted = new Promise<void>(resolve => { accept = resolve; });
  const upstream = http.createServer((req, _res) => { requested++; req.resume(); accept(); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  try {
    await f.client.ensureStarted();
    const cfg = config(); cfg.providers[0].baseUrl = `http://127.0.0.1:${(upstream.address() as any).port}/v1`;
    await f.client.action('configure', { revision: 0, config: cfg }); await f.client.action('setKey', { id: 'a', key: 'SYNTHETIC' });
    const before = await f.client.status(), id = randomUUID();
    const operation = f.client.action('probe', { id: 'a' }, id).then(() => '', error => error.message as string);
    await accepted; process.kill(before.pid, 'SIGKILL');
    assert((await operation).includes(id));
    const recovered = await f.client.ensureStarted(); assert.notEqual(recovered.pid, before.pid);
    assert.equal((await f.client.operation(id)).state, 'unknown'); assert.equal(requested, 1);
    await assert.rejects(f.client.action('probe', { id: 'a' }, id), /未知/); assert.equal(requested, 1);
  } finally {
    const live = await f.client.statusIfRunning().catch(() => undefined);
    if (live) { await f.client.action('shutdown'); await waitStopped(f.client); }
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); await f.cleanup();
  }
});

test('同一 Codex 目录不能启动第二套后台，即使扩展存储目录不同', async () => {
  const f = await fixture();
  const otherFolder = path.join(f.root, 'other-state'); await privateDirectory(otherFolder);
  await writePrivate(path.join(otherFolder, 'control.key'), 'b'.repeat(64));
  const second = new AgentServer(otherFolder, f.home, f.client.options.backupScript);
  try {
    await f.server.start(); await assert.rejects(second.start(), /正在运行/);
    assert.equal((await f.client.status()).pid, process.pid);
  } finally { await second.stop(); await f.cleanup(); }
});

test('代理原端口被占用时明确报错，不自动换端口或发送请求', async () => {
  const f = await fixture(); let restarted: AgentServer | undefined;
  const blocker = http.createServer();
  try {
    await f.server.start(); await f.client.action('configure', { revision: 0, config: config() }); await f.client.action('setKey', { id: 'a', key: 'SYNTHETIC' });
    await f.client.action('proxyStart', { group: 'test' }); const original = (await f.client.status()).proxy!;
    await f.server.stop(); blocker.listen(original.port, '127.0.0.1'); await once(blocker, 'listening');
    restarted = new AgentServer(f.client.folder, f.home, f.client.options.backupScript); await restarted.start();
    const state = await f.client.status(); assert.equal(state.proxy, null); assert(state.proxyError.includes('未更换'));
    assert.equal((await f.client.savedState())!.proxy!.port, original.port);
  } finally {
    await restarted?.stop(); blocker.closeAllConnections(); await new Promise<void>(resolve => blocker.close(() => resolve())); await f.cleanup();
  }
});

test('Linux 服务安装与移除流程隔离验证，不修改真实用户服务', { skip: process.platform !== 'linux' }, async () => {
  const f = await fixture(); let child: ChildProcess | undefined; const calls: string[][] = [];
  const client = new AgentClient({ ...f.client.options, serviceDirectory: path.join(f.root, 'systemd-user'), serviceCommand: async args => {
    calls.push(args);
    if (args[0] === 'enable' || args[0] === 'start') {
      if (child && child.exitCode === null && child.signalCode === null) return;
      child = spawn(process.execPath, [path.join(client.folder, 'runtime', AGENT_VERSION, 'agent.js'), '--state', client.folder], { stdio: 'ignore', env: { ...process.env, CPM_SYSTEMD: '1' } });
      await once(child, 'spawn');
    }
    if (args[0] === 'disable' && child) { if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } child = undefined; }
  } });
  try {
    await client.installService(); assert.equal((await client.status()).mode, 'systemd');
    const unitPath = path.join(client.options.serviceDirectory!, client.unitName);
    const unit = await readPrivate(unitPath);
    assert(unit.includes('Restart=on-failure')); assert(!unit.includes('SYNTHETIC'));
    await client.removeService(); assert.equal(await client.statusIfRunning(), undefined);
    assert.equal(await fs.access(unitPath).then(() => true, () => false), false);
    assert(calls.some(a => a[0] === 'enable')); assert(calls.some(a => a[0] === 'disable'));
    assert.throws(() => serviceUnit(process.execPath, '/tmp/a\nExecStart=bad', f.root, '/usr/bin'), /非法字符/);
  } finally { if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; } await f.cleanup(); }
});

test('生成的 Linux 用户服务通过系统自带解析器检查', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture();
  try {
    try { await fs.access('/usr/bin/systemd-analyze'); } catch { t.skip('systemd-analyze 不可用'); return; }
    const unit = serviceUnit(process.execPath, path.resolve('dist/agent.js'), f.root, '/usr/bin:/bin');
    const target = path.join(f.root, 'cpm-verify.service'); await fs.writeFile(target, unit);
    await promisify(execFile)('/usr/bin/systemd-analyze', ['--user', 'verify', target], { timeout: 10000 });
  } finally { await f.cleanup(); }
});

test('从保留的 0.3.0 安装包升级后台：先暂停计划，保留 Key 和记录，服务改用新版', { skip: process.platform !== 'linux' }, async t => {
  try { await fs.access(path.resolve('artifacts/codex-provider-manager-0.3.0.vsix')); }
  catch { t.skip('可选的历史 0.3.0 安装包未提供；未验证旧版升级'); return; }
  const f = await fixture(); let child: ChildProcess | undefined;
  const client = new AgentClient({ ...f.client.options, serviceDirectory: path.join(f.root, 'mock-user-service'), serviceCommand: async args => {
    if (args[0] === 'enable' || args[0] === 'start') {
      if (child && child.exitCode === null && child.signalCode === null) return;
      child = spawn(process.execPath, [path.join(client.folder, 'runtime', AGENT_VERSION, 'agent.js'), '--state', client.folder], { stdio: 'ignore', env: { ...process.env, CPM_SYSTEMD: '1' } });
      await once(child, 'spawn');
    }
    if (args[0] === 'disable' && child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
  } });
  try {
    const old = path.join(client.folder, 'runtime', '0.3.0'); await privateDirectory(old);
    await promisify(execFile)('python3', ['-c', 'import zipfile,sys,pathlib;z=zipfile.ZipFile(sys.argv[1]);p=pathlib.Path(sys.argv[2]);[(p/name).write_bytes(z.read("extension/"+rel)) for name,rel in [("agent.js","dist/agent.js"),("backup.py","resources/backup.py"),("switch.py","resources/switch.py")]]', path.resolve('artifacts/codex-provider-manager-0.3.0.vsix'), old]);
    await writePrivate(path.join(client.folder, 'launch.json'), JSON.stringify({ home: f.home, backupScript: path.join(old, 'backup.py') }));
    await writePrivate(path.join(client.folder, 'state.json'), JSON.stringify({ revision: 1, config: config(), monitorEnabled: false, backupEnabled: false, events: [] }));
    await writePrivate(path.join(client.folder, 'credentials.json'), JSON.stringify({ a: 'SYNTHETIC-RETAINED-KEY' }));
    await privateDirectory(client.options.serviceDirectory!); await writePrivate(path.join(client.options.serviceDirectory!, client.unitName), 'old synthetic service');
    child = spawn(process.execPath, [path.join(old, 'agent.js'), '--state', client.folder], { stdio: 'ignore' }); await once(child, 'spawn');
    for (let i = 0; i < 100 && !await client.statusIfRunning(); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal((await client.status()).version, '0.3.0');
    await assert.rejects(client.ensureStarted(), /升级/);
    await client.action('monitor', { enabled: true }); await assert.rejects(client.upgrade(), /暂停监控/);
    await client.action('monitor', { enabled: false });
    const current = await client.upgrade(); assert.equal(current.version, AGENT_VERSION); assert.equal(current.mode, 'systemd'); assert.deepEqual(current.keyIds, ['a']);
    assert((await readPrivate(path.join(client.options.serviceDirectory!, client.unitName))).includes('/runtime/' + AGENT_VERSION + '/agent.js'));
    assert.equal(JSON.parse(await readPrivate(path.join(client.folder, 'credentials.json'))).a, 'SYNTHETIC-RETAINED-KEY');
    await client.removeService(); await waitStopped(client);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; }
    await f.cleanup();
  }
});
