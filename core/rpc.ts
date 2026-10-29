import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
export interface Thread { id: string; name?: string; preview?: string; cwd?: string; updatedAt?: number; path?: string; status?: { type: string }; forkedFromId?: string; parentThreadId?: string; agentNickname?: string }
export interface ThreadPage { data: Thread[]; nextCursor?: string | null }
export class AppServer {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private listeners = new Set<(method: string, params: any) => void>();
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  constructor(private executable: string, private home: string, private timeoutMs = 30000, private args = ['app-server', '--listen', 'stdio://'], private isolated = false) {}
  onNotification(listener: (method: string, params: any) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async start(): Promise<void> {
    if (this.child) return;
    const env = { ...process.env, CODEX_HOME: this.home };
    if (this.isolated) {
      for (const key of ['CODEX_SQLITE_HOME', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'CODEX_IDENTITY_TOKEN_FILE', 'CODEX_WORKLOAD_IDENTITY_CONTEXT']) delete (env as any)[key];
      (env as any).CODEX_SQLITE_HOME = this.home;
    }
    const child = spawn(this.executable, this.args, { env, stdio: 'pipe', windowsHide: true });
    this.child = child;
    child.stderr.on('data', () => { /* Do not log upstream text or paths containing private data. */ });
    child.stdin.on('error', () => this.fail('Codex 输入通道已关闭'));
    child.on('error', () => this.fail('无法启动 Codex，请检查可执行文件路径'));
    child.on('exit', () => { if (this.child === child) this.child = undefined; this.fail('Codex 管理进程已退出'); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message: any; try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id === undefined) { for (const listener of this.listeners) { try { listener(message.method, message.params); } catch { /* Isolate client handlers. */ } } return; }
      if (message.method && message.id !== undefined) {
        // Management never grants model/tool approval or executes server-requested commands.
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Management client does not execute server requests' } }) + '\n'); return;
      }
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex 接口错误 ${message.error.code ?? ''}；请检查版本是否支持该操作`));
      else pending.resolve(message.result);
    });
    try {
      await this.call('initialize', { clientInfo: { name: 'codex_provider_manager', version: '0.6.0' } });
      child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    } catch (error) { this.stop(); throw error; }
  }
  call<T = any>(method: string, params: object): Promise<T> {
    const child = this.child; if (!child) return Promise.reject(new Error('Codex 管理进程未启动'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex 操作超时；若为写操作请先刷新确认结果，再决定是否重试')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  stop(): void { const child = this.child; this.child = undefined; child?.kill(); this.fail('管理连接已关闭'); }
  private fail(message: string): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(message)); } this.pending.clear(); }
}
