import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
export interface DashboardHost {
  snapshot(): Promise<unknown>;
  action(action: string, payload: any): Promise<unknown>;
}
export class Dashboard implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private busy = false;
  private sending = false;
  private pending = false;
  constructor(private context: vscode.ExtensionContext, private host: DashboardHost) {}
  async open(): Promise<void> {
    if (this.panel) { this.panel.reveal(); await this.update(); return; }
    const panel = vscode.window.createWebviewPanel('codexProviderManager.dashboard', 'Codex 管理中心', vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.file(this.context.asAbsolutePath('webview'))] });
    this.panel = panel;
    panel.iconPath = vscode.Uri.file(this.context.asAbsolutePath('media/manager.svg'));
    const webview = panel.webview;
    const nonce = randomBytes(24).toString('hex');
    const css = webview.asWebviewUri(vscode.Uri.file(this.context.asAbsolutePath('webview/dashboard.css')));
    const js = webview.asWebviewUri(vscode.Uri.file(this.context.asAbsolutePath('webview/dashboard.js')));
    const template = await fs.readFile(this.context.asAbsolutePath('webview/dashboard.html'), 'utf8');
    webview.html = template.replaceAll('{{CSP}}', webview.cspSource).replaceAll('{{NONCE}}', nonce).replaceAll('{{CSS}}', css.toString()).replaceAll('{{JS}}', js.toString());
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
    panel.webview.onDidReceiveMessage(async message => {
      if (!message || typeof message !== 'object' || typeof message.action !== 'string' || typeof message.requestId !== 'number') return;
      if (this.busy) { await webview.postMessage({ type: 'result', requestId: message.requestId, error: '上一项操作仍在处理，请稍候。' }); return; }
      if (!vscode.workspace.isTrusted) { await webview.postMessage({ type: 'result', requestId: message.requestId, error: '请先信任工作区。' }); return; }
      this.busy = true;
      try {
        const value = message.action === 'ready' ? undefined : await this.host.action(message.action, message.payload);
        await this.update();
        await webview.postMessage({ type: 'result', requestId: message.requestId, value });
      } catch (error) { await webview.postMessage({ type: 'result', requestId: message.requestId, error: (error as Error).message }); }
      finally { this.busy = false; }
    });
  }
  async update(): Promise<void> {
    if (!this.panel) return;
    if (this.sending) { this.pending = true; return; }
    this.sending = true;
    try {
      do { this.pending = false; const data = await this.host.snapshot(); await this.panel?.webview.postMessage({ type: 'state', data }); }
      while (this.pending && this.panel);
    } catch { await this.panel?.webview.postMessage({ type: 'notice', error: '状态暂时无法读取，请点击刷新重试。' }); }
    finally { this.sending = false; }
  }
  dispose(): void { this.panel?.dispose(); this.panel = undefined; }
}
