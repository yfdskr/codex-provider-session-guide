import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectIdeAdapter, installIdeAdapter, removeIdeAdapter, loadIdeRecord, writeIdeReceipt } from '../../core/ide-adapter';
import { privateDirectory, writePrivate } from '../../core/files';
import { officialFixture } from './ide-fixture';
import { executePlan } from '../../core/switch';
import { randomUUID } from 'node:crypto';

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-ide-adapter-'));
  const root = await officialFixture(base), folder = path.join(base, 'state'), home = path.join(base, 'home');
  await privateDirectory(folder); await privateDirectory(home);
  const options = { root, folder, home, source: path.resolve('dist/ide-bootstrap.js') };
  const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
  return { base, options, raw, clean: () => fs.rm(base, { recursive: true, force: true }) };
}
const enabled = { skip: !process.env.CODEX_TEST_PATH };

test('本机入口：先备份再启用，首次重载回执确认，撤销逐字恢复原 manifest', enabled, async () => {
  const f = await fixture();
  try {
    assert.equal((await inspectIdeAdapter(f.options)).state, 'disabled');
    await installIdeAdapter(f.options);
    assert.equal((await inspectIdeAdapter(f.options, process.pid)).state, 'reloadRequired');
    const installed = await inspectIdeAdapter(f.options), data = await loadIdeRecord(path.join(f.options.root, installed.entry!));
    assert.equal(await fs.readFile(path.join(f.options.folder, 'ide-adapters', data.id, 'package.json'), 'utf8'), f.raw);
    await writeIdeReceipt(data, 'waiting'); assert.equal((await inspectIdeAdapter(f.options, process.pid)).state, 'reloadRequired');
    await writeIdeReceipt(data, 'active'); assert.equal((await inspectIdeAdapter(f.options, process.pid)).state, 'enabled');
    await removeIdeAdapter(f.options); assert.equal(await fs.readFile(path.join(f.options.root, 'package.json'), 'utf8'), f.raw);
    assert.equal((await inspectIdeAdapter(f.options)).state, 'disabled');
  } finally { await f.clean(); }
});

test('本机入口：未知版本、官方代码变化、manifest 变化均不盲目安装或恢复', enabled, async () => {
  const f = await fixture();
  try {
    const value = JSON.parse(f.raw); value.version = 'unknown'; await fs.writeFile(path.join(f.options.root, 'package.json'), JSON.stringify(value));
    await assert.rejects(installIdeAdapter(f.options), /尚未适配/);
    await fs.writeFile(path.join(f.options.root, 'package.json'), f.raw); await installIdeAdapter(f.options);
    const patched = await fs.readFile(path.join(f.options.root, 'package.json'), 'utf8');
    await fs.writeFile(path.join(f.options.root, 'package.json'), patched + ' ');
    await assert.rejects(removeIdeAdapter(f.options), /入口或关联目录/);
    assert.equal(await fs.readFile(path.join(f.options.root, 'package.json'), 'utf8'), patched + ' ');
    await fs.writeFile(path.join(f.options.root, 'out/extension.js'), 'synthetic changed source');
    assert.equal((await inspectIdeAdapter(f.options)).state, 'unsupported');
  } finally { await f.clean(); }
});

test('本机入口：错误目录、旧 PID 回执、更新后的扩展目录和受损备份均拦截', enabled, async () => {
  const f = await fixture();
  try {
    await installIdeAdapter(f.options); const ready = await inspectIdeAdapter(f.options);
    const data = await loadIdeRecord(path.join(f.options.root, ready.entry!));
    assert.equal((await inspectIdeAdapter({ ...f.options, home: f.base })).state, 'unsupported');
    await writeIdeReceipt(data, 'active');
    await writePrivate(path.join(f.options.folder, 'ide-receipts', process.pid + '.json'), JSON.stringify({ ...data, pid: process.pid, stamp: 'old-pid', phase: 'active' }));
    assert.equal((await inspectIdeAdapter(f.options, process.pid)).state, 'reloadRequired');
    await fs.writeFile(path.join(f.base, 'extensions.json'), JSON.stringify([{ identifier: { id: 'openai.chatgpt' }, relativeLocation: 'new-version' }]));
    assert.equal((await inspectIdeAdapter(f.options)).state, 'unsupported');
    await fs.unlink(path.join(f.base, 'extensions.json'));
    await writePrivate(path.join(f.options.folder, 'ide-adapters', data.id, 'extension.js'), 'changed');
    await assert.rejects(removeIdeAdapter(f.options), /备份无法核对/);
  } finally { await f.clean(); }
});

test('本机入口：切换期间禁止改动；升级兼容程序后保留原入口并要求重新重载', enabled, async () => {
  const f = await fixture();
  try {
    await writePrivate(path.join(f.options.folder, 'switch-job.json'), JSON.stringify({ phase: 'waiting' }));
    await assert.rejects(installIdeAdapter(f.options), /切换正在/); await fs.unlink(path.join(f.options.folder, 'switch-job.json'));
    await installIdeAdapter(f.options);
    const old = await inspectIdeAdapter(f.options);
    const updated = path.join(f.base, 'updated.cjs'); await fs.writeFile(updated, (await fs.readFile(f.options.source, 'utf8')) + '\n// synthetic updated bootstrap\n');
    const next = { ...f.options, source: updated };
    assert.equal((await inspectIdeAdapter(next)).state, 'error');
    await installIdeAdapter(next); assert.notEqual((await inspectIdeAdapter(next)).entry, old.entry);
    assert.equal((await inspectIdeAdapter(next, process.pid)).state, 'reloadRequired');
    await removeIdeAdapter(next); assert.equal(await fs.readFile(path.join(f.options.root, 'package.json'), 'utf8'), f.raw);
  } finally { await f.clean(); }
});

test('本机入口：安排后入口被撤销，执行前拒绝且不改动账号、配置或会话', enabled, async () => {
  const f = await fixture();
  try {
    await installIdeAdapter(f.options); const adapter = await inspectIdeAdapter(f.options);
    await writePrivate(path.join(f.options.home, 'config.toml'), 'model_provider="openai"\n');
    await writePrivate(path.join(f.options.folder, 'launch.json'), JSON.stringify({ home: f.options.home, backupScript: path.resolve('resources/backup.py') }));
    await writePrivate(path.join(f.options.folder, 'state.json'), JSON.stringify({ revision: 1, config: { pythonPath: 'python3' }, monitorEnabled: false, backupEnabled: false }));
    await privateDirectory(path.join(f.options.folder, 'plans')); const id = randomUUID();
    await writePrivate(path.join(f.options.folder, 'plans', id + '.json'), JSON.stringify({ id, createdAt: Date.now(), home: f.options.home, target: 'openai', state: 'prepared', expectedRevision: 1, tool: '/bin/true', reloadAdapter: { root: f.options.root, entry: adapter.entry } }));
    await removeIdeAdapter(f.options);
    await assert.rejects(executePlan(f.options.folder, id, true, async () => []), /平滑切换入口已变化/);
    assert.equal(await fs.readFile(path.join(f.options.home, 'config.toml'), 'utf8'), 'model_provider="openai"\n');
    assert.equal(JSON.parse(await fs.readFile(path.join(f.options.folder, 'plans', id + '.json'), 'utf8')).state, 'prepared');
    await assert.rejects(fs.access(path.join(f.options.home, 'auth.json')));
    await assert.rejects(fs.access(path.join(f.options.folder, 'switch-backups')));
  } finally { await f.clean(); }
});
