/** Isolated development entry point. Not configured into the official IDE. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { startAfterSwitch } from '../core/startup-gate';
import { readPrivate } from '../core/files';

async function main(): Promise<void> {
  if (process.platform !== 'linux') throw new Error('实验启动器目前只验证 Linux');
  const args = process.argv.slice(2);
  if (args.length < 5 || args[0] !== '--state' || args[2] !== '--codex' || args[4] !== '--'
    || !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error('实验启动器参数不正确');
  const folder = await fs.realpath(args[1]);
  const launch = JSON.parse(await readPrivate(path.join(folder, 'launch.json')));
  const executable = await fs.realpath(args[3]);
  const stat = await fs.stat(executable);
  if (path.basename(executable) !== 'codex' || !stat.isFile() || !(stat.mode & 0o111)
    || stat.mode & 0o022 || ![0, process.getuid!()].includes(stat.uid)) throw new Error('Codex 可执行文件无法安全确认');
  const controller = new AbortController();
  let child: ChildProcess | undefined;
  // Preserve initialize bytes with bounded stream backpressure while waiting.
  const input = new PassThrough({ highWaterMark: 64 * 1024 });
  input.on('finish', () => { if (!child) controller.abort(); });
  process.stdin.pipe(input);
  let forwarded: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    forwarded = signal; controller.abort();
    // Only our own spawned child is signalled, never other IDE or CLI owners.
    if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const term = (): void => forward('SIGTERM'), interrupt = (): void => forward('SIGINT');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  let reportedWaiting = false;
  try {
    let result!: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    await startAfterSwitch(folder, launch.home, async () => {
      child = spawn(executable, args.slice(5), { stdio: ['pipe', 'inherit', 'inherit'], env: { ...process.env, CODEX_HOME: launch.home } });
      const own = child;
      let settled = false;
      result = new Promise((resolve, reject) => {
        own.once('error', () => { settled = true; reject(new Error('无法启动 Codex')); });
        own.once('exit', (code, signal) => { settled = true; resolve({ code, signal }); });
      });
      // Install rejection handling immediately; startup visibility may still be pending.
      void result.catch(() => undefined);
      own.stdin!.on('error', () => undefined);
      input.pipe(own.stdin!);
      try {
        const deadline = performance.now() + 5000;
        while (!settled) {
          if (own.pid) {
            try { if (await fs.readlink(`/proc/${own.pid}/exe`) === executable) return; }
            catch (e: any) { if (!['ENOENT', 'ESRCH'].includes(e.code)) throw new Error('无法确认新 Codex 已启动'); }
          }
          if (controller.signal.aborted || performance.now() >= deadline) throw new Error('新 Codex 启动未确认');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        await result;
      } catch (error) {
        // Settle only this child before releasing admission locks. Existing IDEs
        // and unrelated tasks are never targets of this cleanup.
        if (!settled) {
          own.kill('SIGTERM');
          const timer = setTimeout(() => { if (!settled) own.kill('SIGKILL'); }, 2000);
          try { await result.catch(() => undefined); } finally { clearTimeout(timer); }
        }
        throw error;
      }
    }, { signal: controller.signal, onWaiting: () => {
      if (!reportedWaiting) { reportedWaiting = true; process.stderr.write('正在等待本机切换完成，暂未启动 Codex。\n'); }
    } });
    const outcome = await result;
    process.exitCode = outcome.code ?? (outcome.signal === 'SIGINT' ? 130 : 143);
  } catch (error) {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
    }
    if (forwarded) process.exitCode = forwarded === 'SIGINT' ? 130 : 143;
    else throw error;
  } finally {
    process.removeListener('SIGTERM', term); process.removeListener('SIGINT', interrupt);
    process.stdin.unpipe(input); input.destroy(); process.stdin.pause();
  }
}
void main().catch(() => { process.stderr.write('启动未放行：请在管理中心检查切换结果、目录权限或等待中的操作。\n'); process.exitCode = 1; });
