import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
let server, url;
const now = Date.now();
function fixture() { return {
  version: '0.6.0', host: 'research-server', remote: 'ssh-remote', home: '/home/demo/.codex', ideAdapter: { state: 'enabled', reason: '已启用本机平滑切换' }, currentProvider: 'deeprouter', configWarning: '',
  providers: [
    { id: 'deeprouter', name: 'DeepRouter', group: '日常工作', baseUrl: 'https://www.deeprouterai.com/v1', model: 'gpt-6.1-sol', priority: 0, enabled: true, hasKey: true, health: { ok: true, reason: '文字流式检测通过', checkedAt: now, failures: 0, unavailableUntil: 0 }, history: Array.from({ length: 27 }, (_, i) => ({ at: now - i * 300000, ok: i !== 5 })) },
    { id: 'backup', name: '备用接口', group: '日常工作', baseUrl: 'https://backup.example/v1', model: 'gpt-6.1-sol', priority: 10, enabled: true, hasKey: false, history: [] }
  ],
  settings: { intervalSeconds: 300, timeoutSeconds: 30, failureThreshold: 3, cooldownSeconds: 300, startHour: 0, endHour: 24, timeZone: 'Asia/Shanghai' },
  monitoring: false, nextCheck: 0, checking: false, proxy: null,
  threads: Array.from({ length: 72 }, (_, i) => ({ id: `synthetic-${i}`, title: i === 0 ? '<img src=x onerror="window.__xss=1"> 安全测试' : ['服务器迁移与环境配置', '供应商切换与上下文保留', '零样本实验方案', '训练数据整理', 'VS Code 扩展开发'][i % 5] + ` · ${i + 1}`, cwd: i % 2 ? '/projects/spine_ct_window' : '/projects/codex-manager', archived: i >= 65, updatedAt: now / 1000 - i * 3600 })),
  sessionsLoaded: true, sessionsError: '', sessionsUpdatedAt: now,
  snapshots: [{ id: '20261018T120000.123456Z', created: '20261018T120000.123456Z', sessions: 72, partial: false, sourceMatches: true }],
  events: [{ at: now - 60000, message: 'DeepRouter 的 Key 已更新（不记录内容）。' }, { at: now - 30000, message: '检测 DeepRouter：文字流式检测通过。' }, { at: now, message: '完整备份已通过，72 条对话。' }],
  backupHours: 24, autoBackup: false, nextBackup: 0,
  diagnostics: { executable: '/opt/codex/bin/codex', diskGiB: 395, platform: 'linux', trusted: true, switchAvailable: true, serverTimeZone: 'UTC' }
}; }
test.beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    let file = req.url === '/' ? 'dashboard.html' : req.url.slice(1);
    if (!['dashboard.html', 'dashboard.css', 'dashboard.js'].includes(file)) { res.writeHead(404).end(); return; }
    let data = await fs.readFile(path.join('webview', file), 'utf8');
    if (file.endsWith('html')) data = data.replaceAll('{{CSP}}', "'self'").replaceAll('{{NONCE}}', 'test-nonce').replaceAll('{{CSS}}', '/dashboard.css').replaceAll('{{JS}}', '/dashboard.js');
    res.writeHead(200, { 'Content-Type': file.endsWith('html') ? 'text/html' : file.endsWith('css') ? 'text/css' : 'text/javascript' }); res.end(data);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); url = `http://127.0.0.1:${server.address().port}`;
  await fs.mkdir('artifacts/screenshots', { recursive: true });
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function start(page, data = fixture()) {
  await page.addInitScript(seed => {
    window.__requests = []; window.__seed = seed; window.__saved = {};
    window.acquireVsCodeApi = () => ({ getState: () => ({}), setState: v => { window.__saved = v; }, postMessage: m => {
      window.__requests.push(m);
      setTimeout(() => {
        let error, value;
        if (m.action === 'saveProvider') {
          const p = { ...m.payload, id: m.payload.id || 'new-provider', history: [], hasKey: false };
          seed.providers = [...seed.providers.filter(x => x.id !== p.id), p]; value = '供应商已保存。';
        }
        if (m.action === 'saveMonitor') { seed.settings = { ...m.payload }; value = '监控设置已保存。'; }
        if (m.action === 'verifyBackup') error = '备份文件有变化，校验未通过；请保留原文件并检查磁盘。';
        if (m.action === 'archive') { seed.threads = seed.threads.map(t => m.payload.ids.includes(t.id) ? { ...t, archived: true } : t); }
        if (m.action === 'accountLogin') { seed.accounts[0].pending = true; value = { login: { id: seed.accounts[0].id, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'SYNTHETIC-CODE', until: Date.now() + 600000 } }; }
        if (['switchNow','switchLater'].includes(m.action)) { seed.switchJob = { id: 'synthetic-job', targetName: '工作账号', createdAt: Date.now(), phase: 'waiting', reason: '等待 Codex 退出后自动备份并切换' }; }
        if (m.action === 'switchCancel') seed.switchJob = { ...seed.switchJob, phase: 'cancelled', reason: '已取消，没有执行切换' };
        if (m.action === 'enableSmoothSwitch') seed.ideAdapter = { state: 'reloadRequired', reason: '入口已安装，请重新加载当前窗口' };
        if (m.action === 'reloadEditor') seed.ideAdapter = { state: 'enabled', reason: '已启用本机平滑切换', entry: '.cpm-bootstrap/synthetic.cjs' };
        if (m.action === 'disableSmoothSwitch') seed.ideAdapter = { state: 'disabled', reason: '尚未启用本机平滑切换' };
        if (m.action === 'accountCancel') seed.accounts[0].pending = false;
        if (m.action === 'copySessionId') value = '对话 ID 已复制。';
        window.postMessage({ type: 'state', data: structuredClone(seed) }, '*');
        window.postMessage({ type: 'result', requestId: m.requestId, value, error }, '*');
      }, 10);
    } });
  }, data);
  await page.goto(url); await expect(page.getByRole('heading', { name: '让每一次切换，都有把握' })).toBeVisible();
  await expect(page.locator('#operation')).toBeHidden();
}
async function nav(page, name) { await page.getByRole('navigation').getByRole('button', { name, exact: true }).click(); }
test('五页可视化、窄屏、键盘焦点与无外部资源', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const external = []; page.on('request', r => { if (!r.url().startsWith(url)) external.push(r.url()); });
  await start(page);
  await page.screenshot({ path: 'artifacts/screenshots/overview.png', fullPage: true, animations: 'disabled' });
  for (const [name, file] of [['供应商', 'providers'], ['对话', 'sessions'], ['监控', 'monitor'], ['备份与检查', 'backups']]) {
    await nav(page, name); await page.screenshot({ path: `artifacts/screenshots/${file}.png`, fullPage: true, animations: 'disabled' });
    await expect(page.locator('nav [aria-current="page"]')).toHaveCount(1);
  }
  await page.setViewportSize({ width: 430, height: 900 }); await nav(page, '供应商');
  await page.locator('#main').focus();
  await page.screenshot({ path: 'artifacts/screenshots/mobile.png', fullPage: true, animations: 'disabled' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Tab'); expect(await page.evaluate(() => document.activeElement.tagName)).not.toBe('BODY');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
test('填表新增、修改草稿不被后台刷新覆盖、保存后可见', async ({ page }) => {
  await start(page); await nav(page, '供应商'); await page.getByRole('button', { name: '添加 API', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('自定义供应商');
  await page.getByLabel('API 基础地址').fill('https://relay.example/v1');
  await page.evaluate(() => window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*'));
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('自定义供应商');
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  await expect(page.getByRole('heading', { name: '自定义供应商', exact: true })).toBeVisible();
  const req = await page.evaluate(() => window.__requests.find(r => r.action === 'saveProvider'));
  expect(req.payload.baseUrl).toBe('https://relay.example/v1'); expect(req.payload.enabled).toBe(true);
  expect(JSON.stringify(req)).not.toContain('api_key');
});
test('对话分页、搜索、归档筛选、多选和安全显示标题', async ({ page }) => {
  await start(page); await nav(page, '对话');
  await expect(page.locator('tbody tr')).toHaveCount(30); expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(page.locator('tbody img')).toHaveCount(0);
  await page.getByRole('button', { name: '下一页' }).click(); await expect(page.getByText('第 2 / 3 页')).toBeVisible();
  await page.getByRole('button', { name: '上一页' }).click();
  await page.getByLabel('选择本页对话').check(); await expect(page.getByText('已选择 30 条', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '归档', exact: true }).click();
  await expect(page.locator('#operation')).toBeHidden();
  await page.getByRole('button', { name: '已归档', exact: true }).click();
  await expect(page.getByText('筛选结果 37 条', { exact: false })).toBeVisible();
  await page.getByLabel('搜索对话').fill('synthetic-71'); await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.locator('.thread-title').click(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '复制 ID', exact: true }).click();
  await expect(page.getByRole('button', { name: '关闭', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
});
test('时区表单、错误提示可读、切换向导不直接改配置', async ({ page }) => {
  await start(page); await nav(page, '监控');
  await page.getByLabel('每天开始小时').fill('22'); await page.getByLabel('每天结束小时').fill('8');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const req = await page.evaluate(() => window.__requests.find(r => r.action === 'saveMonitor'));
  expect(req.payload.timeZone).toBe('Asia/Shanghai'); expect(req.payload.startHour).toBe('22');
  await nav(page, '备份与检查'); await page.getByRole('button', { name: '校验完整性' }).click();
  await expect(page.locator('#toast')).toContainText('备份文件有变化'); await expect(page.locator('#toast')).toHaveAttribute('data-error', 'true');
  await nav(page, '供应商'); await page.getByRole('button', { name: '切回官方配置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '切换到 官方账号' })).toBeVisible();
  expect(await page.evaluate(() => window.__requests.some(r => r.action === 'switchNow'))).toBe(false);
});
test('空目录和读取失败均提供下一步', async ({ page }) => {
  const data = fixture(); data.threads = []; data.sessionsLoaded = false; data.sessionsError = '没有找到 Codex 程序';
  await start(page, data); await nav(page, '对话');
  await expect(page.getByRole('alert')).toContainText('请检查运行机器和对话目录');
  await expect(page.getByRole('button', { name: '刷新目录' })).toBeEnabled();
});
test('浅色主题仍可读', async ({ page }) => {
  await start(page);
  await page.evaluate(() => {
    const colors = { '--vscode-editor-background': '#f7f8fc', '--vscode-sideBar-background': '#ffffff', '--vscode-editor-foreground': '#1e2538', '--vscode-descriptionForeground': '#626b7c', '--vscode-widget-border': '#dce1ec', '--vscode-button-background': '#6553ca', '--vscode-button-foreground': '#ffffff', '--vscode-focusBorder': '#7763dc', '--vscode-testing-iconPassed': '#147d57', '--vscode-errorForeground': '#b92d40' };
    for (const [key, value] of Object.entries(colors)) document.documentElement.style.setProperty(key, value);
  });
  await page.screenshot({ path: 'artifacts/screenshots/light.png', fullPage: true, animations: 'disabled' });
  await expect(page.getByRole('heading', { name: '让每一次切换，都有把握' })).toBeVisible();
});

test('后台入口、退出 SSH 的条件和离线原因清楚显示', async ({ page }) => {
  const data = fixture();
  data.agent = { running: true, revision: 7, mode: 'systemd', service: { installed: true, linger: false }, error: '' };
  await start(page, data);
  await expect(page.getByRole('heading', { name: '本机后台', exact: true })).toBeVisible();
  await expect(page.getByText('Linger 未启用', { exact: false })).toBeVisible();
  await nav(page, '监控');
  await page.getByRole('button', { name: '查看后台状态', exact: true }).click();
  expect(await page.evaluate(() => window.__requests.some(r => r.action === 'agentStatus'))).toBe(true);
  await page.evaluate(() => {
    window.__seed.agent = { ...window.__seed.agent, running: false, error: '后台版本不匹配，请停止旧后台后重新启动' };
    window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*');
  });
  await expect(page.getByRole('alert')).toContainText('后台版本不匹配');
  await expect(page.getByRole('button', { name: '启动后台', exact: true })).toBeEnabled();
});

test('编辑供应商时保留最初版本号，其他窗口刷新不能悄悄覆盖', async ({ page }) => {
  const data = fixture(); data.agent = { running: true, revision: 7, mode: 'detached', service: { installed: false, linger: null } };
  await start(page, data); await nav(page, '供应商');
  await page.getByRole('button', { name: '编辑', exact: true }).first().click();
  await page.getByLabel('名称', { exact: true }).fill('正在编辑的供应商');
  await page.evaluate(() => { window.__seed.agent.revision = 8; window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*'); });
  await page.getByRole('button', { name: '保存供应商', exact: true }).click();
  const request = await page.evaluate(() => window.__requests.find(r => r.action === 'saveProvider'));
  expect(request.payload.expectedRevision).toBe(7);
  await nav(page, '监控');
  await page.getByLabel('每天开始小时').focus();
  await page.evaluate(() => { window.__seed.agent.revision = 9; window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*'); });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  const monitorRequest = await page.evaluate(() => window.__requests.find(r => r.action === 'saveMonitor'));
  expect(monitorRequest.payload.expectedRevision).toBe(8);
});

 test('多账号授权码仅临时显示，取消后清除；账号切换携带明确目标', async ({ page }) => {
  const data = fixture(); data.accounts = [{ id: 'mock-account', name: '工作账号', saved: false, pending: false }];
  await start(page, data); await nav(page, '供应商');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.locator('.login-box')).toContainText('SYNTHETIC-CODE');
  await nav(page, '监控'); expect(JSON.stringify(await page.evaluate(() => window.__saved))).not.toContain('SYNTHETIC-CODE');
  await nav(page, '供应商'); await page.locator('.login-box').getByRole('button', { name: '取消登录', exact: true }).click();
  await expect(page.locator('.login-box')).toHaveCount(0);
  await page.evaluate(() => { window.__seed.accounts[0].saved = true; window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*'); });
  await page.locator('article').filter({ has: page.getByRole('heading', { name: '工作账号', exact: true }) }).getByRole('button', { name: '切换到此账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '切换到 工作账号' })).toBeVisible();
  await page.getByRole('button', { name: '切换并重新加载' }).click();
  expect(await page.evaluate(() => window.__requests.find(r => r.action === 'switchNow').payload)).toEqual({ id: 'openai', accountId: 'mock-account' });
});
test('后台升级入口和三种接口检查分开呈现', async ({ page }) => {
  const data = fixture(); data.agent = { running: true, version: '0.3.0', upgradeAvailable: true, service: { installed: true, linger: true } };
  data.providers[0].checks = { text: { ok: true, at: now, reason: '文字通过' }, tools: { ok: false, at: now, reason: '未返回工具调用' } };
  await start(page, data); await page.getByRole('button', { name: '升级后台', exact: true }).click();
  expect(await page.evaluate(() => window.__requests.some(r => r.action === 'upgradeAgent'))).toBe(true);
  await nav(page, '供应商');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'DeepRouter', exact: true }) });
  await expect(card).toContainText('文字通过'); await expect(card).toContainText('未返回工具调用');
  await card.getByRole('button', { name: '检查配置', exact: true }).click();
  expect(await page.evaluate(() => window.__requests.some(r => r.action === 'checkProviderConfig'))).toBe(true);
  expect(await page.evaluate(() => window.__requests.some(r => ['testProvider', 'testProviderTools'].includes(r.action)))).toBe(false);
});

test('自动切换的等待、取消和结果在重连后可见，不要求复制命令或手动找进程', async ({ page }) => {
  const data = fixture(); data.switchJob = { id: 'synthetic-job', targetName: '工作账号', createdAt: Date.now(), phase: 'waiting', reason: '等待 1 个 Codex 后台退出' };
  await start(page, data); await expect(page.locator('.switch-status')).toContainText('等待 1 个 Codex');
  await page.getByRole('button', { name: '取消本次切换' }).click(); await expect(page.locator('.switch-status')).toContainText('切换已取消');
  await page.evaluate(() => { window.__seed.switchJob = { ...window.__seed.switchJob, phase: 'success', reason: '切换完成，继续原对话' }; window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*'); });
  await expect(page.locator('.switch-status')).toContainText('切换完成');
  await nav(page, '供应商'); await expect(page.locator('.switch-status')).toContainText('切换完成');
  expect(await page.getByRole('button', { name: '复制切换命令' }).count()).toBe(0);
});

test('未知失败先核对现场，已核对后允许新建计划，旧失败记录仍显示', async ({ page }) => {
  const data = fixture(); data.switchJob = { id: 'failed-job', targetName: '工作账号', createdAt: Date.now(), phase: 'unknown', reason: '保留备份检查' };
  await start(page, data); await nav(page, '供应商');
  await expect(page.getByRole('button', { name: '已核对失败现场' })).toBeVisible();
  await page.getByRole('button', { name: '切回官方配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换并重新加载', exact: true })).toBeDisabled();
  await page.evaluate(() => { window.__seed.switchJob.reviewedAt = Date.now(); window.postMessage({ type: 'state', data: structuredClone(window.__seed) }, '*'); });
  await expect(page.locator('.switch-status')).toContainText('失败现场已核对');
  await expect(page.getByRole('button', { name: '切换并重新加载', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__requests.some(r => r.action === 'switchNow'))).toBe(false);
});

test('平滑切换首次引导：启用后先重载，未确认启动前不能切换；可以恢复原入口', async ({ page }) => {
  const data = fixture(); data.ideAdapter = { state: 'disabled', reason: '尚未启用本机平滑切换' };
  await start(page, data); await nav(page, '供应商');
  await page.getByRole('button', { name: '切回官方配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '切换并重新加载', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '前往总览设置', exact: true }).click();
  await page.getByRole('button', { name: '启用本机平滑切换', exact: true }).click();
  await expect(page.locator('.smooth-card')).toContainText('等待首次重载');
  await page.getByRole('button', { name: '重新加载窗口', exact: true }).click();
  await expect(page.locator('.smooth-card')).toContainText('已启用');
  await nav(page, '供应商'); await expect(page.getByRole('button', { name: '切换并重新加载', exact: true })).toBeEnabled();
  await nav(page, '总览'); await page.getByRole('button', { name: '恢复官方启动入口', exact: true }).click();
  await expect(page.locator('.smooth-card')).toContainText('尚未启用');
  expect(await page.evaluate(() => window.__requests.some(r => r.action === 'switchNow'))).toBe(false);
});
