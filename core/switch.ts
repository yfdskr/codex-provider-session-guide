import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from '@iarna/toml';
import { readPrivate, writePrivate, privateDirectory, withOperation } from './files';
import { SwitchPlan, readCodexConfig, sha256, installProvider } from './configuration';
import { accountHome, authIdentity, updateAccountIndex } from './accounts';
import { codexProcesses, CodexBusyError } from './processes';
import { findDatabase } from './snapshot';
import { inspectIdeAdapter } from './ide-adapter';

export async function executePlan(folder: string, id: string, tasksStopped: boolean, processes = () => codexProcesses()): Promise<SwitchPlan> {
  if (!tasksStopped) throw new Error('先结束任务、关闭相关 Codex 窗口，在独立 SSH 终端执行带 --tasks-stopped 的命令');
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('切换计划编号无效');
  const planFile = path.join(folder, 'plans', id + '.json');
  let plan: SwitchPlan = JSON.parse(await readPrivate(planFile));
  if (plan.id !== id || plan.state !== 'prepared') throw new Error('此计划已经执行或结果未知；请先检查状态，不重复执行');
  if (Date.now() - plan.createdAt > 24 * 3600000) throw new Error('切换计划已超过一天，请重新准备');
  const launch = JSON.parse(await readPrivate(path.join(folder, 'launch.json')));
  if (launch.home !== plan.home) throw new Error('切换目录不一致');
  const state = JSON.parse(await readPrivate(path.join(folder, 'state.json')));
  if (state.revision !== plan.expectedRevision) throw new Error('准备后管理设置发生变化，请重新准备切换');
  if (state.proxy || state.monitorEnabled || state.backupEnabled) throw new Error('请先停止后台代理并暂停监控、定时备份，再重新准备切换');
  const active = await processes();
  if (active.length) throw new CodexBusyError(active);
  if (typeof plan.tool !== 'string' || !path.isAbsolute(plan.tool)) throw new Error('会话同步工具路径无效');
  return withOperation(plan.home, async () => {
    const active = await processes(); if (active.length) throw new CodexBusyError(active);
    plan = JSON.parse(await readPrivate(planFile));
    if (plan.reloadAdapter) {
      const adapter = await inspectIdeAdapter({ root: plan.reloadAdapter.root, home: plan.home, folder });
      if (adapter.state !== 'enabled' || adapter.entry !== plan.reloadAdapter.entry) throw new Error('平滑切换入口已变化，尚未开始修改；请重新检查适配');
    }
    if (plan.state !== 'prepared') throw new Error('此计划已经执行或结果未知；不会重复执行');
    const latest = JSON.parse(await readPrivate(path.join(folder, 'state.json')));
    if (latest.revision !== plan.expectedRevision || latest.proxy || latest.monitorEnabled || latest.backupEnabled) throw new Error('后台设置发生变化，请重新准备切换');
    if (sha256((await readCodexConfig(plan.home)).raw) !== plan.expectedConfig) throw new Error('准备后 Codex 配置发生变化，请重新准备切换；未修改当前配置');
    if (plan.provider && plan.keyPath) {
      const expectedKey = path.join(folder, 'provider-keys', plan.target + '.key');
      if (plan.keyPath !== expectedKey || sha256(await readPrivate(expectedKey)) !== plan.keyHash) throw new Error('API Key 已改变，请重新准备切换；未修改当前配置');
    }
    const safety = path.join(folder, 'switch-backups', id); await privateDirectory(safety);
    const original = await readCodexConfig(plan.home);
    await writePrivate(path.join(safety, 'config.toml'), original.raw);
    let selectedRaw: string | undefined;
    if (plan.accountId) {
      selectedRaw = await readPrivate(path.join(accountHome(folder, plan.accountId), 'auth.json'));
      if (authIdentity(selectedRaw).identity !== plan.accountIdentity) throw new Error('目标账号缓存已变化，请刷新账号后重新准备');
      try { await writePrivate(path.join(safety, 'auth.json'), await readPrivate(path.join(plan.home, 'auth.json'))); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    }
    plan.safetyBackup = safety; plan.state = 'running'; plan.stage = 'preflight'; plan.mutationStarted = false; await writePrivate(planFile, JSON.stringify(plan));
    try {
      if (plan.provider && plan.keyPath) {
        plan.stage = 'config'; plan.mutationStarted = true; await writePrivate(planFile, JSON.stringify(plan));
        await writePrivate(path.join(plan.home, 'config.toml'), installProvider(original.raw, plan.provider, plan.keyPath));
      }
      const database = await findDatabase(plan.home, state.config.sqliteHome);
      const owner = JSON.parse(await readPrivate(path.join(plan.home, 'provider-manager.operation.lock')));
      const script = path.join(path.dirname(launch.backupScript), 'switch.py');
      const result = await promisify(execFile)(state.config.pythonPath || 'python3', [script, '--home', plan.home, '--database', database, '--tool', plan.tool, '--target', plan.target, '--tasks-stopped', '--lock-nonce', owner.nonce], { timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
      const backupLine = result.stdout.split('\n').find(line => line.startsWith('完整备份已通过：'));
      plan.sessionBackup = backupLine?.slice('完整备份已通过：'.length);
      plan.stage = 'verify'; plan.mutationStarted = true; await writePrivate(planFile, JSON.stringify(plan));
      let current = await readCodexConfig(plan.home);
      if ((current.value.model_provider || 'openai') !== plan.target) throw new Error('切换后供应商与目标不一致');
      if (selectedRaw && plan.accountId) {
        plan.stage = 'account'; await writePrivate(planFile, JSON.stringify(plan));
        // Save refreshes of the previous account only when its stable identity matches.
        await updateAccountIndex(folder, async index => {
          let oldRaw: string | undefined;
          try { oldRaw = await readPrivate(path.join(plan.home, 'auth.json')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
          if (oldRaw) {
            let identity: ReturnType<typeof authIdentity> | undefined;
            try { identity = authIdentity(oldRaw); } catch { /* Unknown old cache remains in the private backup. */ }
            const old = identity && index.accounts.find(a => a.identity === identity!.identity);
            if (old) await writePrivate(path.join(accountHome(folder, old.id), 'auth.json'), oldRaw);
            if (identity?.identity === plan.accountIdentity) selectedRaw = oldRaw;
            // Unregistered previous login is retained in the private safety backup, never discarded.
          }
          await writePrivate(path.join(plan.home, 'auth.json'), selectedRaw!);
          current.value.cli_auth_credentials_store = 'file'; index.lastAppliedId = plan.accountId;
        });
      }
      current.value.model_provider = plan.target;
      plan.stage = 'config'; await writePrivate(planFile, JSON.stringify(plan));
      if (plan.model) current.value.model = plan.model;
      await writePrivate(path.join(plan.home, 'config.toml'), stringify(current.value));
      current = await readCodexConfig(plan.home);
      plan.stage = 'verify';
      if (current.value.model_provider !== plan.target || plan.model && current.value.model !== plan.model) throw new Error('最终配置核对未通过');
      if (selectedRaw && authIdentity(await readPrivate(path.join(plan.home, 'auth.json'))).identity !== plan.accountIdentity) throw new Error('账号文件核对未通过');
      plan.state = 'success'; await writePrivate(planFile, JSON.stringify(plan)); return plan;
    } catch (error: any) {
      const backupLine = typeof error.stdout === 'string' && error.stdout.split('\n').find((line: string) => line.startsWith('完整备份已通过：'));
      if (backupLine) plan.sessionBackup = backupLine.slice('完整备份已通过：'.length);
      const messages: Record<string, string> = { PREFLIGHT_FAILED: '切换前检查失败，尚未同步会话或切换账号', BACKUP_FAILED: '完整备份失败，尚未同步会话或切换账号', ID_SET_MISMATCH: '数据库与记录的对话 ID 不一致，备份停止，尚未切换账号', SOURCE_CHANGED: '备份期间记录发生变化，备份停止，尚未切换账号', INVALID_SESSION_FORMAT: '存在无法识别的记录格式，备份停止，尚未切换账号', UNSAFE_SESSION_LINK: '记录中存在不安全的链接，备份停止，尚未切换账号', SYNC_UNCONFIRMED: '会话同步结果未确认，保留备份检查，不自动重试', VERIFY_FAILED: '切换后对话核对未通过，保留备份检查，不覆盖恢复' };
      const line = typeof error.stdout === 'string' && error.stdout.split('\n').find((v: string) => v.startsWith('CPM_SWITCH_ERROR:'));
      let receipt: any;
      try { receipt = line && JSON.parse(line.slice('CPM_SWITCH_ERROR:'.length)); } catch { /* No reliable receipt: retain unknown. */ }
      const expectedStage: Record<string, string> = { PREFLIGHT_FAILED: 'preflight', BACKUP_FAILED: 'backup', ID_SET_MISMATCH: 'backup', SOURCE_CHANGED: 'backup', INVALID_SESSION_FORMAT: 'backup', UNSAFE_SESSION_LINK: 'backup', SYNC_UNCONFIRMED: 'sync', VERIFY_FAILED: 'verify' };
      const known = receipt && typeof receipt.mutationStarted === 'boolean' && Object.hasOwn(messages, receipt.errorCode) && expectedStage[receipt.errorCode] === receipt.stage && (['sync','verify'].includes(receipt.stage) ? receipt.mutationStarted === true : receipt.mutationStarted === false);
      const unchanged = known && receipt.mutationStarted === false && !plan.mutationStarted;
      if (known) { plan.stage = receipt.stage; plan.errorCode = receipt.errorCode; plan.mutationStarted ||= receipt.mutationStarted; }
      plan.state = unchanged ? 'error' : 'unknown';
      plan.error = unchanged ? messages[receipt.errorCode] : '切换未全部确认，可能已有修改。保留备份，先检查当前配置与会话，不重复运行或覆盖恢复';
      await writePrivate(planFile, JSON.stringify(plan)); throw new Error(plan.error + '。计划编号：' + id + '。配置备份：' + safety + (plan.sessionBackup ? '。会话备份：' + plan.sessionBackup : ''));
    }
  });
}
