import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Dashboard } from '../src/dashboard';
import { panels, workspace } from './vscode-mock';
const context = { asAbsolutePath: (file: string) => path.resolve(file) };
test('可视化桥接：限制资源、信任检查、串行操作、错误反馈、不注入状态到 HTML', async () => {
  let release!: () => void, calls = 0;
  const manager = new Dashboard(context as any, { snapshot: async () => ({ title: '<script>bad()</script>' }), action: async (action) => { calls++; if (action === 'slow') await new Promise<void>(resolve => { release = resolve; }); else throw new Error('明确错误'); return '完成'; } });
  await manager.open(); const panel = panels.at(-1);
  try {
    assert.equal(panel.options.enableScripts, true);
    assert(panel.webview.html.includes("connect-src 'none'"));
    assert(!panel.webview.html.includes('<script>bad()'));
    assert(!panel.webview.html.includes('{{NONCE}}'));
    await panel.receive({ action: 'ready', requestId: 1 });
    assert.equal(calls, 0); assert(panel.webview.messages.some((m: any) => m.type === 'state'));
    const slow = panel.receive({ action: 'slow', requestId: 2 });
    await panel.receive({ action: 'another', requestId: 3 });
    assert.equal(calls, 1); assert(panel.webview.messages.find((m: any) => m.requestId === 3).error.includes('上一项'));
    release(); await slow;
    workspace.isTrusted = false; await panel.receive({ action: 'another', requestId: 4 });
    assert.equal(calls, 1); workspace.isTrusted = true;
    await panel.receive({ action: 'bad', requestId: 5 });
    assert.equal(panel.webview.messages.find((m: any) => m.requestId === 5).error, '明确错误');
    await manager.open(); assert.equal(panels.at(-1), panel);
  } finally { workspace.isTrusted = true; manager.dispose(); }
});
