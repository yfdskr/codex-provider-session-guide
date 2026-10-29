import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import TOML from '@iarna/toml';
import { defaults, HealthRegistry, MonitorSettings, Provider, validateProvider, validateSettings } from './model';
import { AgentClient } from '../../agent/client';
import { AGENT_VERSION, AgentConfig, AgentStatus } from '../../agent/protocol';
import { AppServer, Thread, ThreadPage } from './rpc';
import { planMutation } from './session-plan';
import { backup, codexHome, config, database, resolveCodex, withLock, withServer } from './runtime';
import { Dashboard } from './dashboard';
import { listSnapshots, snapshotPath, verifySnapshot } from './backups';
import { inspectIdeAdapter, installIdeAdapter, removeIdeAdapter, IdeAdapterOptions } from '../../core/ide-adapter';

class Item extends vscode.TreeItem {
  children?: Item[];
  provider?: Provider;
  thread?: Thread;
  archived?: boolean;
  constructor(label: string, children?: Item[]) { super(label, children ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None); this.children = children; }
}
class Items implements vscode.TreeDataProvider<Item> {
  private emitter = new vscode.EventEmitter<Item | undefined>();
  onDidChangeTreeData = this.emitter.event;
  constructor(private load: () => Promise<Item[]>) {}
  getTreeItem(item: Item): Item { return item; }
  getChildren(item?: Item): Item[] | Promise<Item[]> { return item?.children ?? (item ? [] : this.load()); }
  refresh(): void { this.emitter.fire(undefined); }
  dispose(): void { this.emitter.dispose(); }
}
function title(t: Thread): string { return (t.name || t.preview || t.id).replace(/[\r\n]/g, ' ').slice(0, 120); }
function note(label: string, command?: string): Item { const item = new Item(label); if (command) item.command = { title: label, command }; return item; }
const sources = ['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown'];
async function listAll(server: AppServer, archived: boolean): Promise<Thread[]> {
  const all: Thread[] = []; const seen = new Set<string>(); let cursor: string | null | undefined;
  do {
    const result: ThreadPage = await server.call('thread/list', { limit: 100, cursor, archived, modelProviders: [], sourceKinds: sources, sortKey: 'updated_at', useStateDbOnly: true });
    all.push(...result.data); cursor = result.nextCursor;
    if (cursor && seen.has(cursor)) throw new Error('对话分页异常，未完成读取');
    if (cursor) seen.add(cursor);
    if (all.length > 100000) throw new Error('对话过多，请缩小范围后检查');
  } while (cursor);
  return all;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Codex Provider Manager');
  const windowState = context.workspaceState ?? context.globalState;
  let settings = validateSettings({ ...defaults, ...context.globalState.get<MonitorSettings>('monitor') });
  let providers = context.globalState.get<Provider[]>('providers', []).map(validateProvider);
  const agentHome = await fs.realpath(codexHome()).catch(() => codexHome());
  const storageRoot = vscode.workspace.getConfiguration('codexProviderManager').get<string>('agentStorageRoot') || path.join(os.homedir(), '.local', 'share', 'codex-provider-manager');
  const client = new AgentClient({ home: agentHome, storageRoot,
    agentScript: context.asAbsolutePath('dist/agent.js'), backupScript: context.asAbsolutePath('resources/backup.py'),
    nodePath: vscode.workspace.getConfiguration('codexProviderManager').get<string>('nodePath') || process.execPath });
  let agentState: AgentStatus | undefined, agentError = '';
  let agentManaged = false, initializing = true;
  try {
    const saved = await client.savedState();
    if (saved) { agentManaged = true; providers = saved.config.providers.map(validateProvider); settings = validateSettings(saved.config.settings); }
  } catch { agentError = '后台保存的配置无法读取，请检查目录权限和格式；不会覆盖原文件。'; }
  let currentProvider = 'openai';
  let configWarning = '';
  async function importConfigured(): Promise<number> {
    const cfg = await config(codexHome());
    currentProvider = cfg.model_provider || 'openai';
    let count = 0;
    for (const [id, raw] of Object.entries(cfg.model_providers ?? {})) {
      const value = raw as any;
      if (!value || (value.wire_api && value.wire_api !== 'responses') || !value.base_url || providers.some(p => p.id === id) || ['openai', 'provider_manager'].includes(id)) continue;
      try {
        providers.push(validateProvider({ id, name: value.name || id, group: '已有 API', baseUrl: value.base_url, model: cfg.model || 'gpt-6.1-sol', priority: count * 10, enabled: true }));
        count++;
      } catch { /* Keep unsupported configuration untouched. */ }
    }
    if (count) await saveProviders();
    configWarning = '';
    return count;
  }
  const health = new HealthRegistry(() => settings);
  let proxy: AgentStatus['proxy'] = null;
  let proxyGroup = '', proxyModel = '', tokenPath = '';
  let monitoring = false;
  let nextCheck = 0, checking = false, search = '';
  let dashboard: Dashboard | undefined;
  let dashboardThreads: (Thread & { archived: boolean })[] = [];
  let sessionsLoaded = false, sessionsError = '', sessionsUpdatedAt = 0;
  let autoBackupEnabled = false, nextBackup = 0;
  let switchCloseTimer: NodeJS.Timeout | undefined;
  let backupHours = context.globalState.get<number>('backupHours', 24);
  const events: { at: number; message: string }[] = [];
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'codexProviderManager.openDashboard';
  const log = (message: string): void => { output.appendLine(`${new Date().toLocaleString()} ${message}`); events.unshift({ at: Date.now(), message }); events.splice(100); refresh(); };
  const key = async (id: string): Promise<string | undefined> => agentManaged ? (agentState?.keyIds.includes(id) ? 'stored-in-agent' : undefined) : context.secrets.get(`provider:${id}`);
  function applyAgent(value: AgentStatus): void {
    agentState = value; agentManaged = true; agentError = '';
    providers = value.config.providers; settings = value.config.settings; backupHours = value.config.backupHours;
    proxy = value.proxy; proxyGroup = proxy?.group || ''; proxyModel = proxy?.model || ''; tokenPath = client.proxyTokenPath;
    monitoring = value.monitoring; nextCheck = value.nextCheck; checking = value.checking;
    autoBackupEnabled = value.autoBackup; nextBackup = value.nextBackup;
    health.states.clear(); health.history.clear();
    for (const [id, state] of Object.entries(value.health)) health.states.set(id, state);
    for (const [id, history] of Object.entries(value.history)) health.history.set(id, history);
  }
  async function localConfig(): Promise<AgentConfig> {
    const cfg = await config(codexHome());
    return { providers, settings, backupHours, pythonPath: vscode.workspace.getConfiguration('codexProviderManager').get<string>('pythonPath') || 'python3', sqliteHome: process.env.CODEX_SQLITE_HOME || cfg.sqlite_home, codexPath: await resolveCodex().catch(() => undefined) };
  }
  async function ensureAgent(): Promise<void> {
    if (await fs.realpath(codexHome()).catch(() => codexHome()) !== agentHome) throw new Error('Codex 目录已经改变，请重新加载窗口后操作');
    if (agentError && !agentState && !agentManaged) throw new Error(agentError);
    const seed = await localConfig();
    let value = await client.ensureStarted();
    if (value.revision === 0 || seed.codexPath && value.config.codexPath !== seed.codexPath) { await client.action('configure', { revision: value.revision, config: value.revision === 0 ? seed : { ...value.config, codexPath: seed.codexPath } }); value = await client.status(); }
    // Keep SecretStorage originals for rollback. Import only missing API keys, never official credentials.
    for (const p of value.config.providers) if (!value.keyIds.includes(p.id)) {
      const original = await context.secrets.get(`provider:${p.id}`);
      if (original) await client.action('setKey', { id: p.id, key: original });
    }
    applyAgent(await client.status());
  }
  async function syncAgent(): Promise<void> {
    if (await fs.realpath(codexHome()).catch(() => codexHome()) !== agentHome) {
      agentError = 'Codex 目录已经改变，请重新加载窗口后操作'; agentState = undefined; proxy = null; monitoring = autoBackupEnabled = false; return;
    }
    try {
      const value = await client.statusIfRunning();
      if (value) applyAgent(value);
      else { agentState = undefined; proxy = null; monitoring = false; autoBackupEnabled = false; nextCheck = nextBackup = 0; }
      try { const cfg = await config(codexHome()); currentProvider = cfg.model_provider || 'openai'; configWarning = ''; } catch { configWarning = '现有配置读取失败，请检查配置路径和格式'; }
    } catch (e) { agentError = (e as Error).message; agentState = undefined; proxy = null; monitoring = false; autoBackupEnabled = false; }
  }
  async function saveProviders(expectedRevision = agentState?.revision): Promise<void> {
    const draft = providers;
    if (!initializing) {
      await ensureAgent();
      try { await client.action('configure', { revision: expectedRevision ?? agentState!.revision, config: { ...agentState!.config, providers: draft } }); }
      finally { await syncAgent(); }
    }
    await context.globalState.update('providers', providers);
    if (!initializing) refresh();
  }
  async function saveMonitor(next: MonitorSettings, expectedRevision = agentState?.revision): Promise<void> {
    await ensureAgent();
    try { await client.action('configure', { revision: expectedRevision ?? agentState!.revision, config: { ...agentState!.config, settings: next } }); }
    finally { await syncAgent(); }
    await context.globalState.update('monitor', settings); refresh();
  }
  const providerView = new Items(async () => {
    const official = note('官方账号 · OpenAI', 'codexProviderManager.officialInfo');
    official.description = currentProvider === 'openai' ? '当前配置使用 · 账号见管理中心' : '内置入口 · 可保存多个账号';
    official.iconPath = new vscode.ThemeIcon('account');
    official.tooltip = '官方账号通过 Codex 登录，不作为第三方 API 加入代理组。仅在你选择保存、登录或切换官方账号时处理本机登录文件；不据此判断真实请求是否有效。';
    const roots = [official, note('打开可视化管理中心', 'codexProviderManager.openDashboard')];
    if (configWarning) roots.push(note(configWarning));
    if (!providers.length) return [...roots, note('点击 ＋ 添加 API 供应商', 'codexProviderManager.addProvider'), note('从现有配置导入（不读取 Key）', 'codexProviderManager.importProviders')];
    return [...roots, ...[...new Set(providers.map(p => p.group))].map(group => {
      const groupItem = new Item(group, providers.filter(p => p.group === group).sort((a, b) => a.priority - b.priority).map(p => {
      const item = new Item(p.name); item.provider = p; item.contextValue = 'provider';
      const state = health.states.get(p.id);
      item.description = `${currentProvider === p.id ? '当前配置使用 · ' : ''}${proxy?.activeProvider === p.id ? '代理使用中 · ' : ''}${p.enabled ? `优先级 ${p.priority}` : '已暂停'} · ${state?.ok === undefined ? '未检测' : state.ok ? '可用' : state.reason}`;
      item.tooltip = `${p.baseUrl}\n模型：${p.model}\n仅支持 Responses\n分组：${p.group}`;
      item.iconPath = new vscode.ThemeIcon(proxy?.activeProvider === p.id ? 'pass-filled' : state?.ok === false ? 'warning' : 'server');
      return item;
      }));
      groupItem.collapsibleState = vscode.TreeItemCollapsibleState.Expanded;
      return groupItem;
    })];
  });
  const sessionView = new Items(async () => {
    if (agentState?.switchJob && ['waiting','running'].includes(agentState.switchJob.phase)) return [note('正在安排账号切换，完成后再读取对话目录')];
    try {
      return await withServer(async server => {
        const roots: Item[] = [];
        for (const archived of [false, true]) {
          const threads = (await listAll(server, archived)).filter(t => !search || `${title(t)} ${t.cwd} ${t.id}`.toLowerCase().includes(search.toLowerCase()));
          const projects = new Map<string, Item[]>();
          for (const t of threads) {
            const item = new Item(title(t)); item.thread = t; item.archived = archived; item.contextValue = archived ? 'archivedSession' : 'activeSession';
            item.description = t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleString() : '';
            item.iconPath = new vscode.ThemeIcon(archived ? 'archive' : 'comment-discussion');
            item.command = { title: '查看对话信息', command: 'codexProviderManager.sessionDetails', arguments: [item] };
            const group = t.cwd || '未分配项目'; if (!projects.has(group)) projects.set(group, []); projects.get(group)!.push(item);
          }
          roots.push(new Item(`${archived ? '已归档' : '进行中'} · ${threads.length}${search ? '（已筛选）' : ''}`, [...projects.entries()].map(([cwd, children]) => { const item = new Item(path.basename(cwd) || cwd, children); item.tooltip = cwd; item.description = `${children.length} 条`; return item; })));
        }
        return roots;
      });
    } catch (error) { return [note(`读取失败：${(error as Error).message}`), note('配置路径或查看使用说明', 'codexProviderManager.openGuide')]; }
  });
  const monitorView = new Items(async () => [
    note(`${vscode.env.remoteName || '本机'} · ${os.hostname()}`), note(`会话目录：${codexHome()}`),
    note(proxy ? `代理运行：127.0.0.1:${proxy.port} · ${proxyGroup}` : '代理已停止', proxy ? 'codexProviderManager.stopProxy' : 'codexProviderManager.startProxy'),
    note(monitoring ? '暂停监控' : '开启监控（可能产生少量费用）', 'codexProviderManager.toggleMonitor'),
    note(`检测间隔 ${settings.intervalSeconds} 秒 · 超时 ${settings.timeoutSeconds} 秒`, 'codexProviderManager.monitorSettings'),
    note(`连续失败 ${settings.failureThreshold} 次 · 恢复等待 ${settings.cooldownSeconds} 秒`, 'codexProviderManager.monitorSettings'),
    note(`时段 ${settings.startHour}:00–${settings.endHour}:00 · ${settings.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone}`, 'codexProviderManager.monitorSettings'),
    note(`下次检测：${nextCheck ? new Date(nextCheck).toLocaleString() : '未安排'}`),
    note('备份全部对话', 'codexProviderManager.backup'), note('代理接入配置（不自动修改 Codex）', 'codexProviderManager.proxyConfig'),
    note('使用说明与排错', 'codexProviderManager.openGuide'), note(agentState ? '独立后台运行；关闭窗口后继续' : '后台未启动，不会自动发起 API 请求', 'codexProviderManager.agentStatus')
  ]);
  function refresh(): void {
    providerView.refresh(); monitorView.refresh();
    status.text = `$(server) Codex · ${proxy ? proxy.activeProvider || '代理待请求' : '管理'}`;
    status.tooltip = `${os.hostname()}\n${codexHome()}\n${agentState ? '独立后台运行，关闭窗口后继续' : '后台未启动；不会自动改变 Codex 配置'}`;
    void dashboard?.update();
  }
  context.subscriptions.push(output, status, providerView, sessionView, monitorView,
    vscode.window.createTreeView('codexProviderManager.providers', { treeDataProvider: providerView }),
    vscode.window.createTreeView('codexProviderManager.sessions', { treeDataProvider: sessionView, canSelectMany: true }),
    vscode.window.createTreeView('codexProviderManager.monitor', { treeDataProvider: monitorView }),
    );
  let polling = false, disposed = false;
  const poll = setInterval(() => {
    if (polling || !vscode.workspace.isTrusted) return;
    polling = true;
    void syncAgent().then(() => { if (!disposed) refresh(); }).catch(() => undefined).finally(() => { polling = false; });
  }, 2500);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  cleanup = async () => { disposed = true; clearInterval(poll); /* Independent background intentionally survives deactivation. */ };
  try {
    if (!agentManaged) await importConfigured();
    else { const cfg = await config(codexHome()); currentProvider = cfg.model_provider || 'openai'; }
  } catch { configWarning = '现有配置读取失败，请检查配置路径和格式'; }
  initializing = false;
  await syncAgent();
  status.show(); refresh();

  function register(name: string, handler: (...args: any[]) => Promise<unknown>): void {
    handlers.set(name, handler);
    context.subscriptions.push(vscode.commands.registerCommand(`codexProviderManager.${name}`, async (...args: any[]) => {
      if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('请先信任工作区，再使用管理功能。'); return; }
      if (await fs.realpath(codexHome()).catch(() => codexHome()) !== agentHome) { void vscode.window.showErrorMessage('Codex 目录已经改变，请重新加载窗口后操作'); return; }
      try { await handler(...args); } catch (error) { void vscode.window.showErrorMessage((error as Error).message); }
    }));
  }
  async function selectProvider(item?: Item): Promise<Provider | undefined> {
    if (item?.provider) return providers.find(p => p.id === item.provider!.id);
    const selected = await vscode.window.showQuickPick(providers.map(p => ({ label: p.name, description: `${p.group} · ${p.model}`, p })), { title: '选择供应商' }); return selected?.p;
  }
  async function input(prompt: string, value = ''): Promise<string> {
    const result = await vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true }); if (result === undefined) throw new Error('操作已取消'); return result.trim();
  }
  async function edit(item?: Item): Promise<void> {
    if (proxy) throw new Error('请先停止代理，再修改供应商组及地址');
    const revision = agentState?.revision;
    const old = item ? await selectProvider(item) : undefined;
    const draft: Provider = {
      id: old?.id || randomBytes(6).toString('hex'),
      name: await input('供应商名称', old?.name), group: await input('分组名称：同组 API 可自动切换', old?.group || '默认组'),
      baseUrl: await input('Responses 基础地址，例如 https://服务商/v1', old?.baseUrl),
      model: await input('模型 ID；自动切换要求同组成员使用相同模型 ID', old?.model || 'gpt-6.1-sol'),
      priority: Number(await input('优先级 0–999：数字小的优先', String(old?.priority ?? providers.length * 10))), enabled: old?.enabled ?? true
    };
    const enabled = await vscode.window.showQuickPick(['启用', '暂停'], { title: '是否参与检测与请求转发' });
    if (!enabled) return; draft.enabled = enabled === '启用';
    const p = validateProvider(draft); providers = [...providers.filter(v => v.id !== p.id), p]; health.states.delete(p.id); await saveProviders(revision);
    if (!old) await setKey({ provider: p } as Item);
  }
  async function setKey(item?: Item): Promise<void> {
    const p = await selectProvider(item); if (!p) return;
    const value = await vscode.window.showInputBox({ prompt: `${p.name} 的 API Key；保存在本机受限后台目录，保留 SecretStorage 副本供回退；不读取官方登录凭证`, password: true, ignoreFocusOut: true });
    if (value === undefined) return; if (!value.trim()) throw new Error('Key 不能为空');
    await ensureAgent(); await client.action('setKey', { id: p.id, key: value.trim() });
    await syncAgent();
    if (!agentState?.keyIds.includes(p.id)) throw new Error('后台未确认保存 Key，原副本已保留');
    await context.secrets.store(`provider:${p.id}`, value.trim()); health.states.delete(p.id); log(`${p.name} 的 Key 已更新（不记录内容）。`);
  }
  async function runProbe(p: Provider): Promise<void> {
    await ensureAgent(); await client.action('probe', { id: p.id }); await syncAgent(); refresh();
  }
  register('addProvider', () => edit()); register('editProvider', edit); register('setKey', setKey);
  register('removeProvider', async item => {
    const revision = agentState?.revision;
    const p = await selectProvider(item); if (!p) return;
    if (proxy) throw new Error('请先停止代理，再移除供应商');
    if (await vscode.window.showWarningMessage(`移除 ${p.name} 及本扩展保存的 Key？不修改 Codex 配置。`, { modal: true }, '移除') !== '移除') return;
    providers = providers.filter(v => v.id !== p.id); await saveProviders(revision); await context.secrets.delete(`provider:${p.id}`);
  });
  register('importProviders', async () => {
    if (proxy) throw new Error('请先停止代理，再导入新的供应商');
    const count = await importConfigured();
    void vscode.window.showInformationMessage(`已导入 ${count} 个供应商。请分别设置 Key；没有读取配置中的密钥或执行其中的认证命令。`);
  });
  register('officialInfo', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: '# 官方账号\n\n点击“新增官方账号”，为账号取名，再到官方授权页面输入面板显示的一次性验证码。每个账号独立保存；登录新账号不会切换当前 Codex。\n\n“保存当前官方账号”仅在你明确确认后读取本机文件登录。钥匙串登录暂不支持。账号文件与密码一样需要保密，不会发送给中转站。\n\n在目标账号卡片点击“切换到此账号”，确认任务结束后，扩展会自动暂停计划并关闭当前窗口；后台等待 Codex 退出后备份、切换和核对全部对话。其他窗口仍在线时等待，不会强杀进程。显示“上次应用”不代表正在运行的窗口已换账号；有效性需在重新打开的官方 Codex 中确认。\n' });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  register('testProvider', async item => {
    const p = await selectProvider(item); if (!p) return;
    if (await vscode.window.showInformationMessage(`向 ${p.name} 发送虚构短句进行文字流式检测，可能产生少量费用。`, { modal: true }, '开始检测') !== '开始检测') return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `检测 ${p.name}` }, () => runProbe(p)); output.show(true);
  });
  register('checkProviderConfig', async item => {
    const p = await selectProvider(item); if (!p) return;
    await ensureAgent(); const result = await client.action<{ ok: boolean; errors: string[]; warnings: string[] }>('checkConfig', { id: p.id });
    await syncAgent(); refresh(); return `${result.ok ? '配置检查通过' : '配置需要修改'}：${[...result.errors, ...result.warnings].join('；')}`;
  });
  register('testProviderTools', async item => {
    const p = await selectProvider(item); if (!p) return;
    if (await vscode.window.showInformationMessage(`向 ${p.name} 发送虚构工具格式测试，可能产生费用。不运行任何工具；通过仅表示返回格式符合要求。`, { modal: true }, '测试工具格式') !== '测试工具格式') return;
    await ensureAgent(); const result = await client.action<{ reason: string }>('probeTools', { id: p.id }); await syncAgent(); refresh(); return result.reason;
  });
  register('addOfficialAccount', async () => {
    const name = await input('账号名称，例如 工作账号；不要填写密码');
    await ensureAgent(); await client.action('accountCreate', { name }); await syncAgent(); refresh();
    return '账号条目已建立，请在对应卡片点击“登录”。当前账号没有改变。';
  });
  register('saveCurrentOfficialAccount', async () => {
    if (await vscode.window.showWarningMessage('保存当前官方账号的文件登录到本机受限目录？登录文件等同密码，不会上传或发送给 API 供应商。仅支持文件登录；保存过程不改变当前登录。', { modal: true }, '保存当前账号') !== '保存当前账号') return;
    const name = await input('给当前官方账号起一个名称');
    await ensureAgent(); await client.action('accountImport', { name }); await syncAgent(); refresh(); return '已保存当前账号的副本。';
  });
  register('useProvider', async item => {
    const revision = agentState?.revision;
    const p = await selectProvider(item); if (!p) return;
    providers = providers.map(v => v.group === p.group ? { ...v, priority: v.id === p.id ? 0 : Math.min(v.priority + 1, 999) } : v);
    await saveProviders(revision); log(`优先供应商：${p.name}。只影响本扩展代理的后续请求。`);
  });
  register('refresh', async () => { if (!proxy) await importConfigured(); refresh(); sessionView.refresh(); });
  register('searchSessions', async () => { const value = await vscode.window.showInputBox({ prompt: '按标题、项目路径或 ID 搜索；留空显示全部', value: search }); if (value !== undefined) { search = value; sessionView.refresh(); } });
  register('sessionDetails', async (item: Item) => {
    if (!item?.thread) return;
    const t = item.thread;
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# ${title(t)}\n\n- ID：${t.id}\n- 项目：${t.cwd || ''}\n- 状态：${item.archived ? '已归档' : '进行中'}\n\n在官方 Codex 的历史列表中找到此对话；归档对话先取消归档。预览版不调用未公开的跳转命令。\n` });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  async function mutate(action: 'archive' | 'unarchive' | 'delete', item?: Item, selection?: Item[]): Promise<void> {
    const chosen = selection?.length ? selection : item ? [item] : [];
    const selected = [...new Map(chosen.filter(i => i.thread).map(i => [i.thread!.id, i])).values()];
    if (!selected.length) throw new Error('请在对话目录中选中对话，再右键操作');
    if (proxy) throw new Error('请先停止代理并结束 Codex 任务，再操作对话');
    const verb = { archive: '归档', unarchive: '取消归档', delete: '删除' }[action];
    const plan = await withServer(async server => {
      const all = [...await listAll(server, false), ...await listAll(server, true)];
      const plan = planMutation(selected.map(i => i.thread!.id), all, action !== 'unarchive');
      for (const t of plan.affected) {
        const read: { thread: Thread } = await server.call('thread/read', { threadId: t.id, includeTurns: false });
        if (read.thread.status?.type === 'active') throw new Error('有对话正在运行，请先结束任务');
      }
      return plan;
    });
    const preview = plan.affected;
    const answer = await vscode.window.showWarningMessage(`${verb} ${selected.length} 条选中对话，已知影响范围共 ${preview.length} 条（可能含子会话）。\n${preview.map(title).slice(0, 12).join('\n')}\n\n请先停止这台机器上所有相关 Codex 任务。操作前完整备份；删除后旧备份仍保留副本。独立管理进程无法保证发现其他窗口的全部活动任务。`, { modal: true }, '任务已停止，备份并继续');
    if (answer !== '任务已停止，备份并继续') return;
    await withLock(async () => {
      const snapshot = await backup(context); log(`操作前备份：${snapshot.backup}`);
      let done = 0;
      try {
        await withServer(async server => { for (const id of plan.roots) { await server.call(`thread/${action}`, { threadId: id }); done++; } });
        const remaining = await withServer(s => listAll(s, action === 'archive'));
        const ids = new Set(remaining.map(t => t.id));
        const expected = action === 'delete' ? [] : (action === 'archive' ? preview : selected.map(i => i.thread!)).map(t => t.id);
        if (expected.some(id => !ids.has(id))) throw new Error('操作后状态与预期不符');
        if (action === 'delete') {
          const archived = await withServer(s => listAll(s, true));
          const allIds = new Set([...remaining, ...archived].map(t => t.id));
          if (preview.some(t => allIds.has(t.id))) throw new Error('仍有对话未删除');
        }
        void vscode.window.showInformationMessage(`${verb}已完成；备份：${snapshot.backup}`);
      } catch (error) { throw new Error(`${verb}未全部确认成功，已收到 ${done} 个成功响应。保留备份 ${snapshot.backup}，先刷新再排查，不要直接重试或覆盖恢复。${(error as Error).message}`); }
      finally { sessionView.refresh(); await loadDashboardSessions(); }
    });
  }
  register('archive', (item, selection) => mutate('archive', item, selection));
  register('unarchive', (item, selection) => mutate('unarchive', item, selection));
  register('delete', (item, selection) => mutate('delete', item, selection));
  register('backup', async () => {
    await ensureAgent();
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '后台备份全部对话与数据库' }, () => client.action<{ backup: string; sessions: number }>('backup'));
    await syncAgent(); log(`完整备份：${result.backup}，${result.sessions} 条`); void vscode.window.showInformationMessage(`备份通过：${result.backup}`);
  });
  register('monitorSettings', async () => {
    const revision = agentState?.revision;
    const next: MonitorSettings = { ...settings };
    for (const [field, label] of Object.entries({ intervalSeconds: '检测间隔（秒，30–86400）', timeoutSeconds: '请求无响应超时（秒，5–600）', failureThreshold: '连续失败次数（1–20）', cooldownSeconds: '恢复等待（秒，30–86400）', startHour: '生效开始小时（0–23，按所选时区）', endHour: '生效结束小时（1–24，按所选时区）' })) next[field as Exclude<keyof MonitorSettings, 'timeZone'>] = Number(await input(label, String(next[field as keyof MonitorSettings])));
    next.timeZone = await input('时区，例如 Asia/Shanghai（北京时间）或 UTC', settings.timeZone);
    await saveMonitor(validateSettings(next), revision);
  });
  register('toggleMonitor', async () => {
    const wasMonitoring = monitoring;
    if (!wasMonitoring && !providers.some(p => p.enabled)) throw new Error('请先新增供应商');
    if (!wasMonitoring && await vscode.window.showInformationMessage('周期性向已启用供应商发送虚构短句，可能产生费用。关闭编辑器后后台继续；可随时在这里暂停。', { modal: true }, '开启监控') !== '开启监控') return;
    if (!wasMonitoring) await ensureAgent();
    await client.action('monitor', { enabled: !wasMonitoring }); await syncAgent(); refresh();
  });
  register('startProxy', async () => {
    if (proxy) throw new Error('代理已启动');
    const groups = [...new Set(providers.filter(p => p.enabled).map(p => p.group))];
    if (!groups.length) throw new Error('请先添加并启用至少一个 API 供应商。');
    const group = await vscode.window.showQuickPick(groups, { title: '选择代理供应商组' }); if (!group) return;
    const members = providers.filter(p => p.group === group && p.enabled);
    if (new Set(members.map(p => p.model)).size !== 1) throw new Error('同组需要完全相同的模型 ID');
    if (await vscode.window.showWarningMessage(`对话可能发给本组任意已启用供应商：\n${members.map(p => `${p.name}：${p.baseUrl}`).join('\n')}\n\n代理在独立后台运行，关闭或重载窗口后继续。已经输出或执行结果不确定时不自动重放。`, { modal: true }, '启动代理') !== '启动代理') return;
    await ensureAgent(); await client.action('proxyStart', { group }); await syncAgent(); refresh();
    await vscode.commands.executeCommand('codexProviderManager.proxyConfig');
  });
  register('stopProxy', async () => {
    if (!proxy) return;
    if (await vscode.window.showWarningMessage('停止后台代理会断开经由它进行的请求。确认任务已结束？', { modal: true }, '停止') !== '停止') return;
    await client.action('proxyStop'); await syncAgent(); refresh();
    log('代理已停止；如已接入，请切回原配置。');
  });
  register('proxyConfig', async () => {
    if (!proxy) throw new Error('请先启动分组代理，再生成配置');
    const existing = await config(codexHome());
    const auth = process.platform === 'win32' ? undefined : { command: '/bin/cat', args: [tokenPath] };
    if (!auth) throw new Error('Windows 的独立 CLI 凭证通道尚未验收，请在 Linux / Remote SSH 使用预览版');
    const snippet = TOML.stringify({ model_providers: { provider_manager: { name: 'Codex Provider Manager', base_url: `http://127.0.0.1:${proxy.port}/v1`, wire_api: 'responses', supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, auth } } });
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: `# 代理接入配置\n\n当前原供应商：${existing.model_provider || 'openai'}。原配置未改动。\n\n先在独立终端备份 config.toml 和全部会话。将下面供应商块合并到 ${codexHome()}/config.toml（已有同名块则编辑，不重复添加）：\n\n\`\`\`toml\n${snippet}\`\`\`\n\n在独立终端按操作指南测试：用 codex exec --ephemeral 和 model_provider=\"provider_manager\" 覆盖参数发送虚构内容；不先迁移真实对话。\n\n通过后，停止相关任务，按指南用会话同步工具切到 provider_manager，模型需为 ${proxyModel}。本扩展暂不自动同步和改写现有配置。\n\n关闭或重载窗口不会停止独立后台。后台重启会尝试恢复原端口和令牌；端口被占用时报告错误，不悄悄更换地址。退出 SSH 后能否继续运行，请检查 Linux 用户服务及 Linger 状态。恢复时切回原供应商，不能用旧会话备份覆盖新消息。\n\n此预览版仅提供 /v1/responses，不代理登录、审批、图片生成等辅助服务；若当前客户端依赖这些服务，请继续使用原接口。\n` });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  register('upgradeAgent', async () => {
    if (await vscode.window.showInformationMessage('升级本机后台。请先停止代理，暂停监控和定时备份，完成或取消登录。升级保留配置和对话；用户服务会指向新版程序。', { modal: true }, '升级后台') !== '升级后台') return;
    applyAgent(await client.upgrade()); await ensureAgent(); serviceCache = undefined; refresh(); return '后台已升级到 ' + AGENT_VERSION;
  });
  register('startAgent', async () => { await ensureAgent(); refresh(); void vscode.window.showInformationMessage('本机后台已启动；首次启动不启用计划，重启时继续之前明确开启的计划。'); });
  register('stopAgent', async () => {
    if (!agentState) return;
    if (await vscode.window.showWarningMessage('停止本机后台并暂停定时计划？请先停止代理和监控，等待检测或备份完成。', { modal: true }, '停止后台') !== '停止后台') return;
    await client.action('shutdown');
    await new Promise(resolve => setTimeout(resolve, 250)); await syncAgent(); refresh();
  });
  register('agentStatus', async () => {
    await syncAgent(); const service = await client.serviceInfo();
    const data = { running: !!agentState, error: agentError || undefined, version: agentState?.version, mode: agentState?.mode, pid: agentState?.pid, home: agentHome, storage: client.folder,
      service, proxy: agentState?.proxy, monitoring, autoBackup: autoBackupEnabled, capabilities: agentState?.capabilities };
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(data, null, 2) }), { preview: true });
  });
  register('agentOperation', async () => {
    const id = await input('粘贴错误提示中的后台操作编号');
    const operation = await client.operation(id);
    const { digest, ...visible } = operation;
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(visible, null, 2) }), { preview: true });
  });
  register('installAgentService', async () => {
    if (await vscode.window.showInformationMessage('安装当前用户的 Linux 后台服务，供登录后启动和异常恢复。请先暂停后台计划、停止代理；退出 SSH 后常驻还需要 Linger。', { modal: true }, '安装用户服务') !== '安装用户服务') return;
    await client.installService(); await ensureAgent(); serviceCache = undefined; refresh();
    void vscode.window.showInformationMessage('用户服务已安装。请在后台状态中检查 Linger；未启用时不能保证退出 SSH 后继续运行。');
  });
  register('removeAgentService', async () => {
    if (await vscode.window.showWarningMessage('移除当前用户的后台服务并停止它？配置、Key 和对话不会被删除。请先暂停计划并停止代理。', { modal: true }, '移除用户服务') !== '移除用户服务') return;
    await client.removeService(); serviceCache = undefined; await syncAgent(); refresh();
  });
  async function loadDashboardSessions(): Promise<void> {
    if (agentState?.switchJob && ['waiting','running'].includes(agentState.switchJob.phase)) { sessionsError = '正在安排账号切换，完成后再读取对话目录'; await dashboard?.update(); return; }
    try {
      dashboardThreads = await withServer(async server => [
        ...(await listAll(server, false)).map(t => ({ ...t, archived: false })),
        ...(await listAll(server, true)).map(t => ({ ...t, archived: true }))
      ]);
      sessionsLoaded = true; sessionsError = ''; sessionsUpdatedAt = Date.now();
    } catch (e) { sessionsError = (e as Error).message; }
    await dashboard?.update();
  }
  const switchTool = path.join(os.homedir(), '.local', 'bin', 'codex-provider');
  let serviceCache: { at: number; data: Awaited<ReturnType<AgentClient['serviceInfo']>> } | undefined;
  async function serviceInfo(): Promise<Awaited<ReturnType<AgentClient['serviceInfo']>>> {
    if (!serviceCache || Date.now() - serviceCache.at > 30000) serviceCache = { at: Date.now(), data: await client.serviceInfo() };
    return serviceCache.data;
  }
  async function switchAvailable(): Promise<boolean> { try { await fs.access(switchTool); return process.platform === 'linux'; } catch { return false; } }
  function ideOptions(): IdeAdapterOptions {
    const official = vscode.extensions.getExtension('openai.chatgpt');
    if (!official) throw new Error('此机器尚未找到官方 Codex 扩展');
    return { root: official.extensionPath, home: agentHome, folder: client.folder, source: context.asAbsolutePath('dist/ide-bootstrap.js') };
  }
  async function ideState() {
    try { return await inspectIdeAdapter(ideOptions(), process.pid); }
    catch (e) { return { state: 'unsupported', reason: (e as Error).message }; }
  }
  register('enableSmoothSwitch', async () => {
    const opts = ideOptions();
    if (vscode.workspace.getConfiguration('chatgpt').get<string>('cliExecutable')?.trim()) throw new Error('请先恢复官方默认 Codex 程序，再启用本机兼容模式');
    if (await vscode.window.showWarningMessage('启用本机平滑切换兼容模式？只调整这台机器上官方 Codex 扩展的启动入口，保留原程序和入口备份，不改全局设置或账号。首次启用后需重载窗口；官方扩展升级后需重新检查。可随时恢复启动入口。', { modal: true }, '启用本机兼容模式') !== '启用本机兼容模式') return;
    await ensureAgent(); await installIdeAdapter(opts); refresh();
    void vscode.window.showInformationMessage('启动入口已准备好。等当前任务结束后，点击“重新加载窗口”完成首次启用。');
  });
  register('disableSmoothSwitch', async () => {
    if (await vscode.window.showWarningMessage('恢复官方原始启动入口？账号、配置和对话保留；重载后停用平滑切换，入口备份仍保留。', { modal: true }, '恢复启动入口') !== '恢复启动入口') return;
    await ensureAgent(); await removeIdeAdapter(ideOptions()); refresh();
    void vscode.window.showInformationMessage('原始启动入口已恢复，等当前任务结束后重新加载窗口生效。');
  });
  register('reloadEditor', async () => {
    if (agentState?.switchJob && ['waiting', 'running'].includes(agentState.switchJob.phase)) throw new Error('切换已安排，请查看进度，不要重复重载');
    if (await vscode.window.showWarningMessage('重新加载当前窗口会中断尚未完成的 Codex 任务，请先等任务结束。', { modal: true }, '任务已结束，重新加载') !== '任务已结束，重新加载') return;
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  });
  dashboard = new Dashboard(context, {
    snapshot: async () => {
      const snapshots = await listSnapshots(codexHome()).catch(() => []);
      const keyed = await Promise.all(providers.map(async p => ({ ...p, hasKey: !!await key(p.id), health: health.states.get(p.id), history: health.history.get(p.id) || [], checks: agentState?.checks?.[p.id], configCheck: agentState?.configChecks?.[p.id] })));
      let executable = '', diskGiB: number | undefined;
      try { executable = await resolveCodex(); } catch { /* Shown in diagnostics. */ }
      try { const disk = await fs.statfs(codexHome()); diskGiB = Math.round(disk.bavail * disk.bsize / 2 ** 30); } catch { /* Optional display only. */ }
      return {
        version: context.extension?.packageJSON?.version || AGENT_VERSION, host: os.hostname(), remote: vscode.env.remoteName || '本机', home: codexHome(),
        currentProvider, configWarning, accounts: agentState?.accounts || [], switchJob: agentState?.switchJob, ideAdapter: await ideState(), providers: keyed, settings, monitoring: !!monitoring, nextCheck, checking,
        proxy: proxy ? { port: proxy.port, group: proxyGroup, activeProvider: proxy.activeProvider } : null,
        threads: dashboardThreads.map(t => ({ id: t.id, title: title(t), cwd: t.cwd || '', archived: t.archived, updatedAt: t.updatedAt, parentThreadId: t.parentThreadId })),
        sessionsLoaded, sessionsError, sessionsUpdatedAt, snapshots, events: [...events, ...agentState?.events || []].sort((a, b) => b.at - a.at).slice(0, 100), backupHours, autoBackup: autoBackupEnabled, nextBackup,
        agent: { running: !!agentState, version: agentState?.version, upgradeAvailable: !!agentState && agentState.version !== AGENT_VERSION, revision: agentState?.revision, mode: agentState?.mode, error: agentError || agentState?.proxyError || '', storage: client.folder, service: await serviceInfo(), capabilities: agentState?.capabilities },
        diagnostics: { executable, diskGiB, platform: process.platform, trusted: vscode.workspace.isTrusted, switchAvailable: await switchAvailable(), serverTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      };
    },
    action: async (action, payload) => {
      if (await fs.realpath(codexHome()).catch(() => codexHome()) !== agentHome) throw new Error('Codex 目录已经改变，请重新加载窗口后操作');
      if (action === 'refreshAll') { if (!proxy) await importConfigured(); refresh(); sessionView.refresh(); await loadDashboardSessions(); return; }
      if (action === 'refreshSessions') { await loadDashboardSessions(); return; }
      if (['enableSmoothSwitch', 'disableSmoothSwitch', 'reloadEditor'].includes(action)) return handlers.get(action)!();
      if (action === 'copySessionId') {
        const t = dashboardThreads.find(t => t.id === payload?.id); if (!t) throw new Error('该对话已不存在，请刷新。');
        await vscode.env.clipboard.writeText(t.id); return '对话 ID 已复制。';
      }
      if (action === 'saveProvider') {
        if (proxy) throw new Error('请先停止代理，再编辑供应商。');
        const id = payload?.id || randomBytes(6).toString('hex');
        if (['openai', 'provider_manager'].includes(id)) throw new Error('该 ID 保留给官方账号或本机代理。');
        if (payload?.id && !providers.some(p => p.id === id)) throw new Error('该供应商已不存在，请刷新。');
        const p = validateProvider({ id, name: payload?.name, group: payload?.group, baseUrl: payload?.baseUrl, model: payload?.model, priority: Number(payload?.priority), enabled: payload?.enabled });
        providers = [...providers.filter(v => v.id !== id), p]; health.states.delete(id); health.history.delete(id);
        await saveProviders(payload?.expectedRevision); return '供应商已保存。检测和代理前，请设置 API Key。';
      }
      if (action === 'saveMonitor') {
        const next = validateSettings({ intervalSeconds: Number(payload?.intervalSeconds), timeoutSeconds: Number(payload?.timeoutSeconds), failureThreshold: Number(payload?.failureThreshold), cooldownSeconds: Number(payload?.cooldownSeconds), startHour: Number(payload?.startHour), endHour: Number(payload?.endHour), timeZone: String(payload?.timeZone || '') });
        if (!next.timeZone) throw new Error('请选择时区。');
        await saveMonitor(next, payload?.expectedRevision); return '监控设置已保存。';
      }
      if (action === 'autoBackup') {
        const hours = Number(payload?.hours);
        if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('备份间隔应为 1–168 小时的整数。');
        if (typeof payload?.enabled !== 'boolean') throw new Error('备份开关无效。');
        if (payload.enabled) await ensureAgent();
        else if (!agentState) throw new Error('后台尚未运行，请刷新后检查');
        await client.action('autoBackup', { enabled: payload.enabled, hours });
        await syncAgent(); await context.globalState.update('backupHours', hours);
        refresh(); return payload.enabled ? '定时备份已交给后台；关闭或重载窗口后继续。' : '定时备份已暂停。';
      }
      if (action === 'verifyBackup') { const count = await verifySnapshot(codexHome(), String(payload?.id)); return `校验通过：${count} 个文件与原备份清单一致。`; }
      if (action === 'openBackup') { const folder = await snapshotPath(codexHome(), String(payload?.id)); await vscode.env.clipboard.writeText(folder); return '备份目录已复制，可在服务器文件管理器中打开。'; }
      if (action === 'copyDiagnostics') {
        const data = { extension: context.extension?.packageJSON?.version || AGENT_VERSION, platform: process.platform, remote: vscode.env.remoteName || 'local', trusted: vscode.workspace.isTrusted, codexFound: !!await resolveCodex().catch(() => ''), providers: providers.length, monitoring, proxy: !!proxy, agentRunning: !!agentState, agentVersion: agentState?.version, agentMode: agentState?.mode, service: await serviceInfo(), sessionsLoaded, conversations: dashboardThreads.length, backups: (await listSnapshots(codexHome())).filter(b => !b.partial).length, timeZone: settings.timeZone, switchToolFound: await switchAvailable() };
        await vscode.env.clipboard.writeText(JSON.stringify(data, null, 2)); return '诊断信息已复制，不含密钥、对话标题、路径或主机名。';
      }
      if (action === 'switchCommand') {
        if (!await switchAvailable()) throw new Error('此机器尚未安装 codex-provider 会话同步工具；请先按通用方法完成安装。');
        await ensureAgent();
        const plan = await client.action<{ planId: string; targetName: string; model?: string }>('prepareSwitch', { id: payload?.id, accountId: payload?.accountId });
        await vscode.env.clipboard.writeText(client.switchCommand(plan.planId));
        return `切换命令已复制：${plan.targetName}${plan.model ? ' · ' + plan.model : ''}。计划编号：${plan.planId}。先停止全部 Codex 任务、关闭 Codex 窗口，再到独立 SSH 终端粘贴执行。命令先备份，再同步和核对对话；一天内有效，只执行一次。`;
      }
      if (action === 'switchNow' || action === 'switchLater') {
        const immediate = action === 'switchNow';
        if (!await switchAvailable()) throw new Error('请先安装 codex-provider 会话同步工具，再使用账号切换');
        if (immediate && !(await vscode.commands.getCommands(true)).includes('workbench.action.reloadWindow')) throw new Error('当前编辑器不支持重新加载窗口');
        if (immediate) { const adapter = await ideState(); if (adapter.state !== 'enabled') throw new Error(adapter.reason + '；请在总览完成平滑切换设置'); }
        const name = payload?.accountId ? agentState?.accounts?.find(a => a.id === payload.accountId)?.name : payload?.id === 'openai' ? '当前目录已有的官方登录' : providers.find(p => p.id === payload?.id)?.name;
        if (!name) throw new Error('切换目标不存在，请刷新');
        const confirm = immediate ? '任务已结束，切换并重新加载' : '安排稍后切换';
        const explanation = immediate ? '请先确认 Codex 任务已结束。确认后只重新加载当前窗口，不关闭 VS Code。新 Codex 会等待后台切换完成后再启动。' : '保留当前窗口和任务，暂不改动账号。等所有 Codex 自然退出后，后台才执行切换；你可以继续当前工作。';
        if (await vscode.window.showWarningMessage(`切换到「${name}」？\n\n${explanation}\n\n扩展先暂停计划、检查代理，再备份、切换和核对对话。不结束其他窗口或 CLI；它们仍在线时会等待，可在管理中心取消。等待一小时作废；切换期间不要更新官方扩展或新开其他 Codex。`, { modal: true }, confirm) !== confirm) return;
        await ensureAgent();
        const job = await client.action<{ id: string }>('queueSwitch', { id: payload?.id, accountId: payload?.accountId, tasksStopped: immediate ? true : undefined, mode: immediate ? 'reloadWindow' : 'afterExit', ...(immediate ? { extensionRoot: ideOptions().root, hostPid: process.pid } : {}) });
        if (immediate) await windowState.update('resumeSwitchDashboard', { home: agentHome, jobId: job.id });
        await syncAgent(); refresh();
        if (!immediate) return `稍后切换已保存，编号 ${job.id}。当前窗口和任务保留；所有 Codex 退出后后台自动处理，等待中可取消。`;
        clearTimeout(switchCloseTimer);
        switchCloseTimer = setTimeout(() => { void syncAgent().then(() => {
          if (agentState?.switchJob?.id === job.id && ['waiting','running','success'].includes(agentState.switchJob.phase)) return Promise.resolve(vscode.commands.executeCommand('workbench.action.reloadWindow'));
        }).catch(() => { void vscode.window.showErrorMessage('重新加载窗口未确认；请查看切换状态或取消，不要重复提交。'); }); }, 1000);
        context.subscriptions.push({ dispose: () => clearTimeout(switchCloseTimer) });
        return `切换已保存，编号 ${job.id}。即将重新加载当前窗口；新 Codex 等待切换完成后启动，请核对账号并继续原对话。`;
      }
      if (action === 'switchCancel') {
        const id = String(payload?.id || ''); if (!id || id !== agentState?.switchJob?.id) throw new Error('切换记录已变化，请刷新后取消对应记录');
        await client.action('switchCancel', { id }); clearTimeout(switchCloseTimer); await windowState.update('resumeSwitchDashboard', undefined); await syncAgent(); refresh(); return '已取消切换；监控和定时备份保持暂停。';
      }
      if (action === 'reviewSwitchFailure') {
        const job = agentState?.switchJob;
        if (!job || job.id !== payload?.id || job.phase !== 'unknown') throw new Error('失败记录已变化，请刷新');
        if (await vscode.window.showWarningMessage('请先核对当前账号、对话和保留的备份。确认后只解除新建切换的阻止；旧计划保持停止，不会重跑或覆盖恢复。', { modal: true }, '已核对，允许创建新计划') !== '已核对，允许创建新计划') return;
        await client.action('reviewSwitchFailure', { id: job.id, reviewed: true }); await syncAgent(); refresh(); return '已保存核对记录，请重新选择目标账号；旧计划不会重复执行。';
      }
      if (action === 'accountLogin' || action === 'accountLoginInfo') {
        await ensureAgent();
        if (!agentState?.accounts?.some(a => a.id === payload?.id)) throw new Error('账号不存在，请刷新');
        if (action === 'accountLogin') {
          if (await vscode.window.showInformationMessage('在独立目录登录官方账号，不改变当前账号。请只在官方授权页面输入验证码。', { modal: true }, '开始登录') !== '开始登录') return;
          await client.action('accountLogin', { id: payload.id });
        }
        await syncAgent(); return { login: await client.loginInfo(payload.id) };
      }
      if (action === 'openAccountLogin') {
        const info = await client.loginInfo(String(payload?.id));
        if (!info || info.until <= Date.now()) throw new Error('登录已结束或过期，请重新登录');
        const url = new URL(info.verificationUrl);
        if (url.protocol !== 'https:' || !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) || url.username || url.password || url.port && url.port !== '443') throw new Error('不是受支持的官方登录地址');
        await vscode.env.openExternal(vscode.Uri.parse(url.toString())); return;
      }
      if (['accountRefresh', 'accountCancel', 'accountRemove'].includes(action)) {
        await ensureAgent();
        if (action === 'accountRemove' && await vscode.window.showWarningMessage('移除此处保存的账号副本？当前 Codex 的登录、对话及旧备份保留。', { modal: true }, '移除账号') !== '移除账号') return;
        await client.action(action, { id: payload?.id }); await syncAgent(); refresh(); return '账号记录已更新。';
      }
      const providerActions = new Set(['setKey', 'testProvider', 'testProviderTools', 'checkProviderConfig', 'useProvider', 'removeProvider']);
      if (providerActions.has(action)) {
        const p = providers.find(p => p.id === payload?.id); if (!p) throw new Error('找不到供应商，请刷新。');
        return handlers.get(action)!({ provider: p });
      }
      if (['archive', 'unarchive', 'delete'].includes(action)) {
        if (!Array.isArray(payload?.ids) || !payload.ids.length) throw new Error('请先选中对话。');
        await loadDashboardSessions();
        if (sessionsError) throw new Error(sessionsError);
        const selected = dashboardThreads.filter(t => payload.ids.includes(t.id)).map(t => ({ thread: t, archived: t.archived } as Item));
        if (selected.length !== new Set(payload.ids).size) throw new Error('选中的对话有变化，请刷新后重新选择。');
        if (action === 'archive' && selected.some(t => t.archived) || action === 'unarchive' && selected.some(t => !t.archived)) throw new Error('请分别选择未归档或已归档对话操作。');
        return mutate(action as 'archive' | 'unarchive' | 'delete', undefined, selected);
      }
      if (['importProviders', 'backup', 'toggleMonitor', 'startProxy', 'stopProxy', 'proxyConfig', 'openGuide', 'officialInfo', 'startAgent', 'stopAgent', 'agentStatus', 'agentOperation', 'installAgentService', 'removeAgentService', 'upgradeAgent', 'addOfficialAccount', 'saveCurrentOfficialAccount'].includes(action)) return handlers.get(action)!();
      throw new Error('此操作暂不支持，请刷新管理面板。');
    }
  });
  context.subscriptions.push(dashboard);
  register('openDashboard', async () => { await dashboard!.open(); await loadDashboardSessions(); });

  register('openGuide', async () => { await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(context.asAbsolutePath('README.md'))); });
  const resume = windowState.get<{ home: string; jobId: string }>('resumeSwitchDashboard');
  if (resume?.home === agentHome) {
    await dashboard.open(); await loadDashboardSessions();
    await windowState.update('resumeSwitchDashboard', undefined);
  }
}

let cleanup: (() => Promise<void>) | undefined;
export async function deactivate(): Promise<void> { await cleanup?.(); cleanup = undefined; }
