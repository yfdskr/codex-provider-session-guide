import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startAfterSwitch } from '../../core/startup-gate';
import { acquireLock, privateDirectory, writePrivate, readPrivate } from '../../core/files';
import { SwitchQueue, SwitchJob } from '../../core/switch-queue';
import { SwitchPlan } from '../../core/configuration';
import { AppServer } from '../../core/rpc';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-startup-'));
  const home = path.join(root, 'home'), folder = path.join(root, 'state');
  await privateDirectory(home); await privateDirectory(folder); await privateDirectory(path.join(folder, 'plans'));
  await writePrivate(path.join(folder, 'launch.json'), JSON.stringify({ home }));
  const plan: SwitchPlan = { id: randomUUID(), createdAt: Date.now(), home, target: 'openai', targetName: 'synthetic', state: 'prepared', expectedConfig: 'synthetic' };
  const job: SwitchJob = { id: randomUUID(), planId: plan.id, target: plan.target, targetName: plan.targetName, createdAt: Date.now(), expiresAt: Date.now() + 3600000, phase: 'waiting', reason: 'synthetic' };
  const save = async () => {
    await writePrivate(path.join(folder, 'plans', plan.id + '.json'), JSON.stringify(plan));
    await writePrivate(path.join(folder, 'switch-job.json'), JSON.stringify(job));
  };
  await save(); return { root, home, folder, plan, job, save, clean: () => fs.rm(root, { recursive: true, force: true }) };
}
const gateOptions = { timeoutMs: 2000, intervalMs: 5 };

test('启动等待：后台完成前不读旧配置，完成后仅启动一次；不读取登录或正文', async () => {
  const f = await fixture(); let starts = 0;
  try {
    await writePrivate(path.join(f.home, 'config.toml'), 'old');
    // Invalid credential/session content is intentional: admission must not parse it.
    await writePrivate(path.join(f.home, 'auth.json'), 'not-json-synthetic');
    await fs.mkdir(path.join(f.home, 'sessions')); await fs.writeFile(path.join(f.home, 'sessions', 'a.jsonl'), 'not-json-synthetic');
    let waiting!: () => void; const observed = new Promise<void>(resolve => waiting = resolve);
    const admitted = startAfterSwitch(f.folder, f.home, async () => { starts++; return fs.readFile(path.join(f.home, 'config.toml'), 'utf8'); }, { ...gateOptions, onWaiting: waiting });
    await observed; assert.equal(starts, 0);
    const release = await acquireLock(path.join(f.folder, 'switch-job.lock'));
    try { await writePrivate(path.join(f.home, 'config.toml'), 'new'); f.plan.state = 'success'; f.job.phase = 'success'; await f.save(); }
    finally { await release(); }
    assert.equal(await admitted, 'new'); assert.equal(starts, 1);
  } finally { await f.clean(); }
});

test('启动等待：启动可被进程扫描确认前，后台无法接收新的切换或写入操作', async () => {
  const f = await fixture(); let releaseStart!: () => void, entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => entered = resolve);
  try {
    f.job.phase = 'cancelled'; await f.save();
    const started = startAfterSwitch(f.folder, f.home, async () => { entered(); await new Promise<void>(resolve => releaseStart = resolve); return 42; }, gateOptions);
    await enteredPromise;
    await assert.rejects(acquireLock(path.join(f.folder, 'switch-job.lock')), /其他管理操作/);
    await assert.rejects(acquireLock(path.join(f.home, 'provider-manager.operation.lock')), /其他管理操作/);
    releaseStart(); assert.equal(await started, 42);
    for (const file of [path.join(f.folder, 'switch-job.lock'), path.join(f.home, 'provider-manager.operation.lock')]) {
      const release = await acquireLock(file); await release();
    }
  } finally { releaseStart?.(); await f.clean(); }
});

test('启动等待：未知、错误回执不一致、缺失计划、路由错误均阻止启动', async () => {
  const f = await fixture(); let starts = 0;
  const run = () => startAfterSwitch(f.folder, f.home, async () => { starts++; }, gateOptions);
  try {
    f.job.phase = 'unknown'; f.job.reviewedAt = Date.now(); await f.save(); await assert.rejects(run(), /结果未知/);
    f.job.phase = 'success'; await f.save(); await assert.rejects(run(), /与计划不一致/);
    f.job.phase = 'error'; f.plan.state = 'error'; f.plan.mutationStarted = true; await f.save(); await assert.rejects(run(), /与计划不一致/);
    f.plan.mutationStarted = false; await f.save(); await run(); assert.equal(starts, 1);
    await fs.unlink(path.join(f.folder, 'plans', f.plan.id + '.json')); await assert.rejects(run(), /计划无法核对/);
    await writePrivate(path.join(f.folder, 'launch.json'), JSON.stringify({ home: path.join(f.root, 'other') })); await assert.rejects(run(), /目录不一致/);
    assert.equal(starts, 1);
  } finally { await f.clean(); }
});

test('启动等待：超时、取消、损坏记录和不安全链接均不放行', async () => {
  const f = await fixture(); let starts = 0;
  const run = (options: any = {}) => startAfterSwitch(f.folder, f.home, async () => { starts++; }, { ...gateOptions, ...options });
  try {
    f.job.expiresAt = Date.now() - 1; await f.save();
    await assert.rejects(run({ timeoutMs: 35 }), /超时/); // expiry alone must not permit startup
    const controller = new AbortController(); controller.abort(); await assert.rejects(run({ signal: controller.signal }), /已取消/);
    const waitingController = new AbortController();
    await assert.rejects(run({ signal: waitingController.signal, onWaiting: () => waitingController.abort() }), /已取消/);
    await writePrivate(path.join(f.folder, 'switch-job.json'), 'invalid'); await assert.rejects(run(), /无法核对/);
    await fs.unlink(path.join(f.folder, 'switch-job.json'));
    await fs.symlink(path.join(f.folder, 'launch.json'), path.join(f.folder, 'switch-job.json')); await assert.rejects(run(), /无法核对/);
    assert.equal(starts, 0);
  } finally { await f.clean(); }
});

test('启动等待：取消/过期保留原配置；活跃操作锁或启动失败不泄漏自己的锁', async () => {
  const f = await fixture(); let starts = 0;
  try {
    f.job.phase = 'expired'; await f.save();
    const release = await acquireLock(path.join(f.home, 'provider-manager.operation.lock'));
    try { await assert.rejects(startAfterSwitch(f.folder, f.home, async () => { starts++; }, { timeoutMs: 35, intervalMs: 5 }), /超时/); }
    finally { await release(); }
    assert.equal(starts, 0);
    await assert.rejects(startAfterSwitch(f.folder, f.home, async () => { throw new Error('synthetic spawn failure'); }, gateOptions), /synthetic spawn failure/);
    await assert.rejects(fs.access(path.join(f.folder, 'switch-job.lock')));
    await assert.rejects(fs.access(path.join(f.home, 'provider-manager.operation.lock')));
    await fs.unlink(path.join(f.folder, 'switch-job.json'));
    assert.equal(await startAfterSwitch(f.folder, f.home, async () => 9, gateOptions), 9);
  } finally { await f.clean(); }
});

test('启动等待与真实队列互锁：其他窗口在线时等待，完成后允许多个新窗口启动', async () => {
  const f = await fixture(); let active = [123], switches = 0, starts = 0;
  await fs.unlink(path.join(f.folder, 'switch-job.json'));
  const queue = new SwitchQueue(f.folder, { scan: async () => active, intervalMs: 3600000, notify: () => {}, execute: async () => {
    switches++; await new Promise(resolve => setTimeout(resolve, 40));
    f.plan.state = 'success'; await writePrivate(path.join(f.folder, 'plans', f.plan.id + '.json'), JSON.stringify(f.plan)); return f.plan;
  } });
  const controller = new AbortController(); const admitted: Promise<number>[] = [];
  // The production queue's timer retries a contended poll; drive that same
  // behavior explicitly instead of relying on a wall-clock two-second tick.
  const poll = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { await queue.poll(); return; }
      catch (error) {
        if (!/其他管理操作|检查旧锁/.test((error as Error).message)) throw error;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    throw new Error('Queue remained contended');
  };
  try {
    await queue.start(); await queue.enqueue(f.plan);
    let waiting!: () => void; const observed = new Promise<void>(resolve => waiting = resolve);
    for (let i = 0; i < 3; i++) admitted.push(startAfterSwitch(f.folder, f.home, async () => ++starts, { ...gateOptions, signal: controller.signal, onWaiting: waiting }));
    await observed; await poll(); assert.equal(starts, 0); assert.equal(switches, 0);
    active = []; await poll(); await poll();
    assert.deepEqual((await Promise.all(admitted)).sort(), [1, 2, 3]); assert.equal(switches, 1); assert.equal(queue.status()?.phase, 'success');
  } finally { controller.abort(); await Promise.allSettled(admitted); await queue.stop(); await f.clean(); }
});

test('实验启动器：真实 Codex 只在完成后握手，退出无额外输出且不使用真实认证', { skip: !process.env.CODEX_TEST_PATH, timeout: 20000 }, async () => {
  const f = await fixture();
  const args = [path.resolve('artifacts/experiments/reload/startup.js'), '--state', f.folder, '--codex', process.env.CODEX_TEST_PATH!, '--', 'app-server', '--listen', 'stdio://'];
  const server = new AppServer(process.execPath, f.home, 10000, args, true);
  try {
    await writePrivate(path.join(f.home, 'config.toml'), 'cli_auth_credentials_store="file"\n[analytics]\nenabled=false\n');
    let initialized = false; const pending = server.start().then(() => { initialized = true; });
    await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(initialized, false);
    const release = await acquireLock(path.join(f.folder, 'switch-job.lock'));
    try {
      await writePrivate(path.join(f.home, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'synthetic-startup-test-key' }));
      f.plan.state = 'success'; f.job.phase = 'success'; await f.save();
    } finally { await release(); }
    await pending; const account = await server.call('account/read', { refreshToken: false });
    assert.equal(account.account?.type, 'apiKey');
    const threads = await server.call('thread/list', { limit: 10 }); assert.deepEqual(threads.data, []);
    assert.equal(JSON.parse(await readPrivate(path.join(f.folder, 'switch-job.json'))).phase, 'success');
  } finally { server.stop(); await new Promise(resolve => setTimeout(resolve, 250)); await f.clean(); }
});

test('实验启动器：等待期间接收退出信号，保持未切换且没有创建数据库', { timeout: 10000 }, async () => {
  const f = await fixture();
  const binary = path.join(f.root, 'codex'); await fs.copyFile('/usr/bin/false', binary); await fs.chmod(binary, 0o700);
  try {
    const child = spawn(process.execPath, [path.resolve('artifacts/experiments/reload/startup.js'), '--state', f.folder, '--codex', binary, '--', '--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const completed = once(child, 'exit'); let stdout = ''; child.stdout.on('data', b => stdout += b.toString());
    await once(child.stderr, 'data'); child.kill('SIGTERM');
    const [code] = await completed; assert.equal(code, 143); assert.equal(stdout, '');
    assert.equal(JSON.parse(await readPrivate(path.join(f.folder, 'switch-job.json'))).phase, 'waiting');
    assert.deepEqual(await fs.readdir(f.home), []);
  } finally { await f.clean(); }
});

test('实验启动器：窗口输入通道已关闭时取消等待，不遗留启动进程', { timeout: 10000 }, async () => {
  const f = await fixture();
  const binary = path.join(f.root, 'codex'); await fs.copyFile('/usr/bin/false', binary); await fs.chmod(binary, 0o700);
  try {
    const child = spawn(process.execPath, [path.resolve('artifacts/experiments/reload/startup.js'), '--state', f.folder, '--codex', binary, '--'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const completed = once(child, 'exit'); let stdout = ''; child.stdout.on('data', b => stdout += b.toString());
    child.stdin.end(); const [code] = await completed;
    assert.equal(code, 1); assert.equal(stdout, '');
    assert.equal(JSON.parse(await readPrivate(path.join(f.folder, 'switch-job.json'))).phase, 'waiting');
    assert.deepEqual(await fs.readdir(f.home), []);
  } finally { await f.clean(); }
});
