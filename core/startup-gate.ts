import path from 'node:path';
import { acquireLock, readPrivate } from './files';
import type { SwitchJob } from './switch-queue';
import type { SwitchPlan } from './configuration';

export class StartupBlockedError extends Error {}
export interface StartupGateOptions {
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onWaiting?: (state: 'switch' | 'operation') => void;
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Only reads switch metadata. It never reads authentication or conversation content. */
async function settled(folder: string, home: string): Promise<boolean> {
  let job: SwitchJob;
  try { job = JSON.parse(await readPrivate(path.join(folder, 'switch-job.json'))); }
  catch (e: any) { if (e.code === 'ENOENT') return true; throw new StartupBlockedError('切换记录无法核对，暂不启动 Codex；请打开管理中心检查'); }
  if (!job || !uuid.test(job.id) || !uuid.test(job.planId) || !Number.isFinite(job.createdAt) || !Number.isFinite(job.expiresAt)
    || !['waiting', 'running', 'success', 'error', 'unknown', 'cancelled', 'expired'].includes(job.phase)) {
    throw new StartupBlockedError('切换记录格式不正确，暂不启动 Codex；请保留现场并检查');
  }
  // A timeout or a reviewed failure is not proof that mutation has stopped safely.
  if (job.phase === 'unknown') throw new StartupBlockedError('上次切换结果未知，暂不启动 Codex；请在管理中心核对，不自动重试');
  if (job.phase === 'waiting' || job.phase === 'running') return false;
  let plan: SwitchPlan;
  try { plan = JSON.parse(await readPrivate(path.join(folder, 'plans', job.planId + '.json'))); }
  catch { throw new StartupBlockedError('切换计划无法核对，暂不启动 Codex；请打开管理中心检查'); }
  if (plan.id !== job.planId || plan.home !== home || plan.target !== job.target) throw new StartupBlockedError('切换目录或目标不一致，暂不启动 Codex');
  const safe = job.phase === 'success' ? plan.state === 'success'
    : job.phase === 'error' ? plan.state === 'prepared' || plan.state === 'error' && plan.mutationStarted === false
    : plan.state === 'prepared';
  if (!safe) throw new StartupBlockedError('切换结果与计划不一致，暂不启动 Codex；请核对实际账号和备份');
  return true;
}

/**
 * Experimental admission boundary for a future machine-specific launcher.
 * The caller must keep both locks until the child is visible to codexProcesses().
 * This does not attach to or terminate an already-running official IDE instance.
 */
export async function startAfterSwitch<T>(folder: string, home: string, start: () => Promise<T>, options: StartupGateOptions = {}): Promise<T> {
  if (!path.isAbsolute(folder) || !path.isAbsolute(home)) throw new StartupBlockedError('启动目录需要绝对路径');
  const timeout = options.timeoutMs ?? 3600000, interval = options.intervalMs ?? 250;
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) throw new StartupBlockedError('启动等待时间无效');
  const deadline = performance.now() + timeout;
  const check = (): void => {
    if (options.signal?.aborted) throw new StartupBlockedError('已取消等待，没有启动 Codex');
    if (performance.now() >= deadline) throw new StartupBlockedError('等待切换超时，没有启动 Codex；请查看管理中心，不自动放行或重试切换');
  };
  const pause = async (): Promise<void> => {
    check();
    await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); options.signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, Math.min(interval, Math.max(1, deadline - performance.now())));
      options.signal?.addEventListener('abort', done, { once: true });
      if (options.signal?.aborted) done();
    });
    check();
  };
  // Verify exact routing before taking locks; this function never creates a home.
  let launch: any;
  try { launch = JSON.parse(await readPrivate(path.join(folder, 'launch.json'))); }
  catch { throw new StartupBlockedError('本机启动信息无法核对，没有启动 Codex'); }
  if (launch.home !== home) throw new StartupBlockedError('启动目标与后台目录不一致，没有启动 Codex');
  for (;;) {
    check();
    // Never compete with a running queue's completion write just to learn that
    // we must wait. Files are atomically replaced; admission still rechecks
    // under the queue lock before spawning.
    if (!await settled(folder, home)) {
      options.onWaiting?.('switch'); await pause(); continue;
    }
    let releaseJob: (() => Promise<void>) | undefined;
    let releaseOperation: (() => Promise<void>) | undefined;
    let waiting: 'switch' | 'operation' = 'operation';
    try {
      // Queue acceptance uses the same lock: a new switch cannot slip between
      // the final check and child startup. A manual switch uses operation.lock.
      try { releaseJob = await acquireLock(path.join(folder, 'switch-job.lock')); }
      catch { /* Stay closed until the lock can be verified and acquired. */ }
      if (releaseJob) {
        if (!await settled(folder, home)) waiting = 'switch';
        else {
          try { releaseOperation = await acquireLock(path.join(home, 'provider-manager.operation.lock')); }
          catch { /* Active, unsafe or unverifiable lock: never bypass it. */ }
          if (releaseOperation) { check(); return await start(); }
        }
      }
    } finally {
      await releaseOperation?.();
      await releaseJob?.();
    }
    options.onWaiting?.(waiting);
    await pause();
  }
}
