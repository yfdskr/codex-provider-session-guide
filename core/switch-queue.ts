import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireLock, privateDirectory, readPrivate, writePrivate } from './files';
import { SwitchPlan } from './configuration';
import { CodexBusyError } from './processes';

export interface SwitchJob {
  id: string; planId: string; target: string; targetName: string; createdAt: number; expiresAt: number;
  phase: 'waiting' | 'running' | 'success' | 'error' | 'unknown' | 'cancelled' | 'expired';
  reason: string; blockedBy?: number; finishedAt?: number; sessionBackup?: string; safetyBackup?: string;
  reviewedAt?: number;
}
export interface SwitchQueueOptions {
  scan(): Promise<number[]>;
  execute(planId: string): Promise<SwitchPlan>;
  notify(message: string): void;
  intervalMs?: number;
  now?: () => number;
}
export const switchPending = (job?: SwitchJob): boolean => !!job && ['waiting', 'running'].includes(job.phase);

/** Persists acceptance before any UI closes. It never terminates another process. */
export class SwitchQueue {
  private job?: SwitchJob;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private ticking = false;
  private idleSamples = 0;
  private executing?: Promise<void>;
  private polling?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(readonly folder: string, private options: SwitchQueueOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  status(): SwitchJob | undefined { return this.job && { ...this.job }; }
  pending(): boolean { return switchPending(this.job); }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.catch(() => undefined).then(async () => {
      const release = await acquireLock(path.join(this.folder, 'switch-job.lock'));
      try { return await fn(); } finally { await release(); }
    });
    this.serial = task; return task;
  }
  private async save(): Promise<void> { await writePrivate(path.join(this.folder, 'switch-job.json'), JSON.stringify(this.job)); }
  async start(): Promise<void> {
    await this.locked(async () => {
      try { this.job = JSON.parse(await readPrivate(path.join(this.folder, 'switch-job.json'))); }
      catch (e: any) { if (e.code !== 'ENOENT') throw e; }
      if (this.job) {
        if (!/^[a-f0-9-]{36}$/.test(this.job.id) || !/^[a-f0-9-]{36}$/.test(this.job.planId) || !['waiting','running','success','error','unknown','cancelled','expired'].includes(this.job.phase) || !Number.isFinite(this.job.expiresAt)) throw new Error('自动切换记录格式错误，请保留文件并检查');
        if (this.job.phase === 'running') {
          this.job.phase = 'unknown'; this.job.reason = '后台曾在切换期间退出；保留备份，核对实际账号和对话，不自动重试'; this.job.finishedAt = this.now(); await this.save();
        }
      }
    });
    this.arm();
  }
  async enqueue(plan: SwitchPlan, validate?: () => Promise<void>): Promise<SwitchJob> {
    return this.locked(async () => {
      if (this.stopped || this.pending()) throw new Error('已有待处理的切换，请先查看或取消');
      if (this.job?.phase === 'unknown' && !this.job.reviewedAt) throw new Error('上次切换结果未知，请先检查，不自动重试');
      if (plan.state !== 'prepared') throw new Error('切换计划不是待执行状态');
      await validate?.();
      this.idleSamples = 0;
      this.job = { id: randomUUID(), planId: plan.id, target: plan.target, targetName: plan.targetName, createdAt: this.now(), expiresAt: Math.min(this.now() + 3600000, plan.createdAt + 86400000), phase: 'waiting', reason: '已保存切换安排；等待 Codex 退出后自动备份并切换' };
      await this.save(); this.arm(); return { ...this.job };
    });
  }
  async cancel(id: string): Promise<void> {
    await this.locked(async () => {
      if (this.job?.id !== id) throw new Error('切换记录已变化，请刷新');
      if (this.job.phase !== 'waiting') throw new Error('切换已开始或已结束，不能取消；请查看结果');
      this.job.phase = 'cancelled'; this.job.reason = '已取消，没有执行账号或会话切换；监控与备份计划保持暂停'; this.job.finishedAt = this.now();
      await this.save(); clearTimeout(this.timer); this.timer = undefined;
    });
  }
  async review(id: string): Promise<void> {
    await this.locked(async () => {
      if (this.job?.id !== id || this.job.phase !== 'unknown' || this.job.reviewedAt) throw new Error('失败记录已变化，请刷新后核对');
      const archive = path.join(this.folder, 'switch-reviews'); await privateDirectory(archive);
      await writePrivate(path.join(archive, this.job.id + '.json'), JSON.stringify(this.job));
      this.job.reviewedAt = this.now(); this.job.reason = '失败现场已核对，旧计划保持停止；可以重新选择账号创建新计划，不重放或覆盖恢复'; await this.save();
    });
  }
  private arm(): void {
    clearTimeout(this.timer); this.timer = undefined;
    if (!this.stopped && this.job?.phase === 'waiting') this.timer = setTimeout(() => {
      this.timer = undefined; void this.poll().catch(() => { this.options.notify('自动切换状态暂时无法更新；不会强制结束进程，请查看结果'); }).finally(() => this.arm());
    }, this.options.intervalMs ?? 2000);
  }
  poll(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.polling) return this.polling;
    const task = this.tick(); this.polling = task;
    void task.finally(() => { if (this.polling === task) this.polling = undefined; }).catch(() => undefined);
    return task;
  }
  private async tick(): Promise<void> {
    if (this.stopped || this.ticking) return; this.ticking = true;
    let launch: SwitchJob | undefined;
    try {
      await this.locked(async () => {
        const job = this.job; if (this.stopped || !job || job.phase !== 'waiting') return;
        const previous = JSON.stringify(job);
        if (this.now() >= job.expiresAt) { job.phase = 'expired'; job.reason = '等待已超过一小时或计划过期，没有执行切换；重新选择账号即可'; job.finishedAt = this.now(); }
        else {
          try {
            const active = await this.options.scan(); if (this.stopped) return; job.blockedBy = active.length;
            if (active.length) { this.idleSamples = 0; job.reason = `等待 ${active.length} 个 Codex 后台退出；窗口开着时后台可能常驻，这不代表任务正在执行。可取消本次切换`; }
            else if (++this.idleSamples < 2) job.reason = 'Codex 已退出，正在再次确认后开始备份';
            else { job.phase = 'running'; job.reason = '正在备份、切换和核对对话，请稍候；完成前不要重新打开 Codex'; launch = { ...job }; }
          } catch (e) { this.idleSamples = 0; job.reason = (e as Error).message; job.blockedBy = undefined; }
        }
        if (JSON.stringify(job) !== previous) await this.save();
      });
      if (launch) {
        const job = launch;
        this.executing = (async () => {
          let phase: SwitchJob['phase'] = 'success', reason = '切换完成。请核对 Codex 账号并继续原对话';
          let result: SwitchPlan | undefined;
          try { result = await this.options.execute(job.planId); }
          catch (e) {
            let plan: SwitchPlan | undefined;
            try { plan = JSON.parse(await readPrivate(path.join(this.folder, 'plans', job.planId + '.json'))); } catch { /* Keep unknown rather than retry. */ }
            if (e instanceof CodexBusyError && plan?.state === 'prepared') { phase = 'waiting'; reason = '有新的 Codex 后台启动，继续等待；尚未开始切换'; this.idleSamples = 0; }
            else { phase = plan?.state === 'prepared' || plan?.state === 'error' && plan.mutationStarted === false ? 'error' : 'unknown'; reason = phase === 'error' ? plan?.error || '未开始切换：' + (e as Error).message : '切换未全部确认；保留备份并检查实际账号和对话，不自动重试'; result = plan; }
          }
          await this.locked(async () => {
            if (this.job?.id !== job.id) throw new Error('切换记录编号不一致');
            Object.assign(this.job, { phase, reason, blockedBy: undefined, finishedAt: phase === 'waiting' ? undefined : this.now(), sessionBackup: result?.sessionBackup, safetyBackup: result?.safetyBackup });
            await this.save(); this.options.notify(reason);
          });
        })();
        await this.executing;
      }
    } catch (error) {
      // If acceptance could not be durably recorded, never start or silently retry it.
      if (this.job?.phase === 'running') {
        this.job.phase = 'unknown'; this.job.reason = '切换状态保存未确认；先核对实际状态，不自动重试'; this.job.finishedAt = this.now();
        await this.save().catch(() => undefined);
      }
      throw error;
    } finally { this.executing = undefined; this.ticking = false; }
  }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); this.timer = undefined; await this.polling; }
}
