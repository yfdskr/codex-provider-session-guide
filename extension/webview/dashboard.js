(() => {
'use strict';
const vscode = acquireVsCodeApi();
const saved = vscode.getState() || {};
const tabs = { overview: ['◈', '总览'], providers: ['⇄', '供应商'], sessions: ['☷', '对话'], monitor: ['◷', '监控'], backups: ['▣', '备份与检查'] };
let tab = Object.hasOwn(tabs, saved.tab) ? saved.tab : 'overview';
let state, busy = false, sequence = 0, page = 0, scope = 'active', query = '', project = '', sort = 'newest';
let providerDraft, monitorDraft, monitorRenderedRevision, switchTarget, switchAccount, loginInfo, selected = new Set(), currentDetail;
const pending = new Map();
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const btn = (label, action, id = '', cls = '', disabled = false) => `<button type="button" data-action="${esc(action)}" data-id="${esc(id)}" class="${cls}" ${disabled ? 'disabled' : ''}>${esc(label)}</button>`;
const date = seconds => seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: state?.settings?.timeZone || 'Asia/Shanghai', hour12: false }) : '—';
const time = ms => ms ? date(ms / 1000) : '未安排';
const currentName = () => state.currentProvider === 'openai' ? '官方账号' : state.providers.find(p => p.id === state.currentProvider)?.name || state.currentProvider;
function toast(message, error = false) {
  if (!message) return;
  const t = $('toast'); t.replaceChildren(document.createTextNode(message)); t.dataset.error = String(error); t.hidden = false;
  const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label', '关闭提示'); close.addEventListener('click', () => { t.hidden = true; }); t.append(close);
}
async function request(action, payload, label = '正在处理，请稍候…') {
  if (busy) return;
  busy = true; $('operation').hidden = false; $('operation').textContent = label;
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  const requestId = ++sequence;
  const result = new Promise(resolve => {
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ error: '长时间未收到结果。操作可能仍在执行，请先刷新检查，避免重复提交。' }); }, 360000);
    pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
  });
  vscode.postMessage({ action, payload, requestId });
  const reply = await result; busy = false; $('operation').hidden = true;
  if (reply.error) toast(reply.error, true);
  else if (typeof reply.value === 'string') toast(reply.value);
  render(); document.querySelectorAll('dialog button').forEach(b => { b.disabled = false; }); return reply;
}
function navigate(next) { if (!Object.hasOwn(tabs, next)) return; tab = next; vscode.setState({ tab }); render(); document.querySelector('#main')?.focus(); }
function heading(title, sub, actions = '') { return `<header class="topbar"><div><div class="eyebrow">CODEX PROVIDER MANAGER</div><h1>${title}</h1></div><div class="actions">${actions}</div></header><p class="subtitle">${sub}</p>`; }
function history(p) {
  const rows = p.history || [];
  return `<div class="history" aria-label="最近 ${rows.length} 次检测和请求连接状态，${rows.filter(x => x.ok).length} 次正常">${rows.length ? rows.map(x => `<span class="${x.ok ? '' : 'bad'}" title="${esc(time(x.at))} · ${x.ok ? '正常' : '失败'}"></span>`).join('') : Array.from({ length: 24 }, () => '<span class="none"></span>').join('')}</div>`;
}
function healthBadge(p) { return `<span class="badge ${p.health?.ok === true ? 'ok' : p.health?.ok === false ? 'bad' : ''}"><span class="dot ${p.health?.ok === true ? 'ok' : p.health?.ok === false ? 'bad' : ''}"></span>${!p.enabled ? '已暂停' : p.health?.ok === true ? '最近连接正常' : p.health?.ok === false ? '需要检查' : '尚未检测'}</span>`; }
function officialCard() { return `<article class="card"><div class="card-head"><h3>官方账号 · OpenAI</h3><span class="badge ${state.currentProvider === 'openai' ? 'current' : ''}">${state.currentProvider === 'openai' ? '当前配置' : '内置入口'}</span></div><p>可保存多个官方账号。新增和登录不会切换正在使用的账号。</p><div class="actions">${btn('新增官方账号', 'addOfficialAccount', '', 'primary')}${btn('保存当前官方账号', 'saveCurrentOfficialAccount')}${btn('切回官方配置', 'switchWizard', 'openai')}${btn('账号说明', 'officialInfo')}</div><p class="caption">仅明确选择保存、登录或切换时处理本机登录文件；账号不加入第三方 API 代理组。</p></article>`; }
function accountCard(a) {
  return `<article class="card"><div class="card-head"><h3>${esc(a.name)}</h3><span class="badge ${a.saved ? 'ok' : ''}">${a.pending ? '等待授权' : a.saved ? '已保存登录' : '尚未登录'}</span></div><dl class="kv"><dt>账号</dt><dd>${esc(a.email || '尚未读取')}</dd><dt>套餐</dt><dd>${esc(a.plan || '未读取')}</dd><dt>最近检查</dt><dd>${esc(time(a.checkedAt))}</dd></dl>${a.lastApplied ? '<p class="caption">上次应用的账号；正在运行的窗口需重新打开确认。</p>' : ''}<div class="actions">${a.pending ? btn('查看验证码', 'accountLoginInfo', a.id) + btn('取消登录', 'accountCancel', a.id) : btn(a.saved ? '重新登录' : '登录', 'accountLogin', a.id)}${btn('刷新账号', 'accountRefresh', a.id, '', a.pending || !a.saved)}${btn('切换到此账号', 'accountSwitch', a.id, 'primary', !a.saved || a.pending)}${btn('移除账号', 'accountRemove', a.id, 'danger', a.lastApplied)}</div><p class="caption">已保存不代表令牌仍然有效；请在官方 Codex 中验证。</p></article>`;
}
function loginCard() {
  if (!loginInfo) return '';
  return `<section class="panel login-box"><h2>完成官方账号登录</h2><ol><li>点击“打开官方授权页面”。</li><li>登录你要保存的账号，输入下面的一次性验证码。</li><li>完成后点击“刷新”，对应账号应显示“已保存登录”。</li></ol><p>一次性验证码：<strong><code>${esc(loginInfo.userCode)}</code></strong></p><p class="caption">授权地址：${esc(loginInfo.verificationUrl)} · 本次显示有效至 ${esc(time(loginInfo.until))}。不要把验证码发给别人。</p><div class="actions">${btn('打开官方授权页面', 'openAccountLogin', loginInfo.id, 'primary')}${btn('刷新', 'refreshAll')}${btn('取消登录', 'accountCancel', loginInfo.id)}</div></section>`;
}
function checkLabel(label, result) { return `<div><strong>${label}</strong> · ${result ? result.ok ? '通过' : '未通过' : '未测试'}${result ? `<br><small>${esc(result.reason)} · ${esc(time(result.at))}</small>` : ''}</div>`; }
function providerCard(p) { return `<article class="card"><div class="card-head"><div class="identity"><div class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</div><div><h3>${esc(p.name)}</h3><small>${esc(p.group)} · 优先级 ${p.priority}</small></div></div>${state.currentProvider === p.id ? '<span class="badge current">当前配置</span>' : healthBadge(p)}</div><dl class="kv"><dt>地址</dt><dd>${esc(p.baseUrl)}</dd><dt>模型</dt><dd><code>${esc(p.model)}</code></dd><dt>API Key</dt><dd>${p.hasKey ? '<span class="good">已保存</span>' : '尚未设置'} · ${btn('设置', 'setKey', p.id, 'quiet')}</dd></dl><div class="notice"><strong>配置检查</strong> · ${p.configCheck ? p.configCheck.ok ? '通过' : '需要修改' : '未检查'}${p.configCheck ? `<p>${esc([...p.configCheck.errors, ...p.configCheck.warnings].join('；'))}</p>` : ''}${checkLabel('文字流式', p.checks?.text)}${checkLabel('工具格式', p.checks?.tools)}</div>${history(p)}<div class="actions">${btn('检查配置', 'checkProviderConfig', p.id)}${btn('检测连接', 'testProvider', p.id)}${btn('测试工具格式', 'testProviderTools', p.id)}${btn('设为组内首选', 'useProvider', p.id)}${btn('编辑', 'editProvider', p.id)}${btn('切换到此 API', 'switchWizard', p.id)}${btn('移除', 'removeProvider', p.id, 'danger')}</div><p class="caption">配置检查免费且不发请求；文字与工具测试需确认，可能收费。通过不代表长对话和所有工具均兼容。</p></article>`; }
function backgroundCard() {
  const a = state.agent || {}, service = a.service || {};
  const running = !!a.running;
  const lifecycle = a.mode === 'systemd' ? 'Linux 用户服务' : running ? '独立后台进程' : '尚未启动';
  return `<section class="panel"><div class="card-head"><div><h2>本机后台</h2><p class="muted">${esc(lifecycle)} · ${running ? '关闭或重载窗口后继续运行' : '首次打开不会自动启动监控或发送 API 请求'}</p></div><span class="badge ${running ? 'ok' : ''}">${running ? '运行中' : '未连接'}</span></div>${a.upgradeAvailable ? `<div class="notice warning">扩展已更新，后台仍为 ${esc(a.version)}。暂停计划、停止代理后点击“升级后台”。</div>` : ''}${a.error ? `<div class="notice error" role="alert">${esc(a.error)}</div>` : ''}<div class="actions">${btn(running ? '停止后台' : '启动后台', running ? 'stopAgent' : 'startAgent', '', 'primary')}${a.upgradeAvailable ? btn('升级后台', 'upgradeAgent', '', 'primary') : ''}${btn('查看后台状态', 'agentStatus')}${btn('查询操作编号', 'agentOperation')}${state.diagnostics.platform === 'linux' ? btn(service.installed ? '移除用户服务' : '安装用户服务', service.installed ? 'removeAgentService' : 'installAgentService') : ''}</div><p class="caption">后台负责代理、监控和定时备份。${state.diagnostics.platform === 'linux' ? `退出 SSH 后继续运行需要用户服务和 Linger；当前：${service.installed ? '服务已安装' : '服务未安装'}，${service.linger === true ? 'Linger 已启用' : service.linger === false ? 'Linger 未启用' : 'Linger 状态待检查'}。` : '当前只验收 Linux，其他系统的后台安装仍待验证。'} 查看状态可找到日志目录；停止后台前先停止代理并暂停监控。</p></section>`;
}
function overview() {
  const counts = { active: state.threads.filter(t => !t.archived).length, archived: state.threads.filter(t => t.archived).length };
  const snapshots = state.snapshots.filter(b => !b.partial);
  const hasKey = state.providers.some(p => p.hasKey);
  return heading('让每一次切换，都有把握', '供应商、对话与备份，在一个地方管理。', btn('刷新', 'refreshAll') + btn('使用说明', 'openGuide')) +
  `<section class="hero"><div><div class="eyebrow">YOUR CODEX WORKSPACE</div><h2>当前配置：${esc(currentName())}</h2><p>${esc(state.host)} · ${state.remote === '本机' ? '本机运行' : '在远程服务器运行'}<br>新任务默认使用这里的配置。<br>已打开任务的实际接口：暂无法确认，请在对应 Codex 窗口核对。</p><div class="actions">${btn('管理供应商', 'nav', 'providers', 'primary')}${btn('查看全部对话', 'nav', 'sessions')}</div></div><div class="hero-orbit" aria-hidden="true"><div class="orb">API</div><div class="orb center">⇄</div><div class="orb">Codex</div></div></section>` +
  backgroundCard() + smoothCard() + switchStatus() + `<div class="stats"><div class="stat"><small>API 供应商</small><strong>${state.providers.length}</strong><small>${state.providers.filter(p => p.enabled).length} 个已启用</small></div><div class="stat"><small>未归档对话</small><strong>${state.sessionsLoaded ? counts.active : '—'}</strong><small>${counts.archived} 条已归档</small></div><div class="stat"><small>完整备份</small><strong>${snapshots.length}</strong><small>${state.autoBackup ? `每 ${state.backupHours} 小时自动备份` : '可开启定时备份'}</small></div><div class="stat"><small>连接监控</small><strong>${state.monitoring ? '运行中' : '已暂停'}</strong><small>${state.proxy ? '代理正在运行' : '代理尚未启动'}</small></div></div>` +
  `<div class="grid"><section class="panel"><h2>从这里开始</h2><p class="subtitle">已有配置会自动识别，你可以从尚未完成的一步继续。</p><div class="steps">${[
    [state.providers.length > 0, '确认供应商', '核对官方账号与已有 API，新增 API 可以直接填表。', 'providers'],
    [hasKey, '添加 Key 并测试', '用于本扩展检测和转发；不会读取旧配置里的 Key。', 'providers'],
    [snapshots.length > 0, '保存一份完整备份', '包括普通对话、归档对话与数据库。', 'backups'],
    [state.proxy !== null, '按需开启自动切换', '同组 API 共用一个模型，接入前先用测试对话验证。', 'monitor']
  ].map(([done, name, hint, next], i) => `<div class="step ${done ? 'done' : ''}"><div class="step-number">${done ? '✓' : i + 1}</div><div><h3>${name}</h3><p>${hint}</p>${btn('前往设置', 'nav', next, 'quiet')}</div></div>`).join('')}</div></section><section class="panel"><h2>最近发生的事</h2><p class="subtitle">后台保留最近操作记录，不保存对话内容和密钥。</p>${eventsMarkup(8)}<div class="notice">代理、监控和定时备份在独立后台运行；关闭窗口后继续。</div></section></div>`;
}
function eventsMarkup(count = 20) { return state.events.length ? `<ul class="timeline">${state.events.slice(0, count).map(e => `<li><time>${esc(time(e.at))}</time><span>${esc(e.message)}</span></li>`).join('')}</ul>` : '<div class="empty"><h3>还没有操作记录</h3><p>配置、检测和备份的结果会出现在这里。</p></div>'; }
function providerForm() {
  const p = providerDraft;
  return `<section class="panel"><div class="section-title"><h2>${p.id ? '编辑供应商' : '添加 API 供应商'}</h2>${btn('收起', 'cancelProvider', '', 'quiet')}</div><form id="providerForm"><div class="form-grid"><label>名称<input name="name" placeholder="例如 DeepRouter" value="${esc(p.name)}" required maxlength="100"></label><label>自动切换分组<input name="group" placeholder="例如 日常工作" value="${esc(p.group)}" required maxlength="100"></label><label class="full">API 基础地址<input name="baseUrl" type="url" placeholder="https://www.deeprouterai.com/v1" value="${esc(p.baseUrl)}" required maxlength="2048"><small>填写到 /v1，不要加 /responses，也不要填 Key。</small></label><label>模型 ID<input name="model" value="${esc(p.model)}" required maxlength="150"><small>同组自动切换时，模型 ID 需一致。</small></label><label>优先级<input name="priority" type="number" value="${p.priority}" min="0" max="999" required><small>数字越小，越优先使用。</small></label><label class="check full"><input name="enabled" type="checkbox" ${p.enabled ? 'checked' : ''}>参与检测与组内请求</label></div><p class="caption">这里只支持 Responses 接口。只有 Chat Completions 的服务不能直接使用。保存后，再通过隐藏输入框设置 Key。</p><div class="form-footer">${btn('取消', 'cancelProvider')}<button class="primary" type="submit">保存供应商</button></div></form></section>`;
}
function switchStatus() {
  const j = state.switchJob; if (!j) return '';
  const labels = { waiting: '等待 Codex 退出', running: '正在备份并切换', success: '切换完成', error: '切换未开始', unknown: j.reviewedAt ? '失败现场已核对' : '切换结果需检查', cancelled: '切换已取消', expired: '等待已过期' };
  return `<section class="panel switch-status" role="status"><div class="card-head"><h2>${esc(labels[j.phase] || j.phase)}</h2><span class="badge ${j.phase === 'success' ? 'ok' : ['error','unknown'].includes(j.phase) ? 'bad' : ''}">${esc(j.targetName)}</span></div><p>${esc(j.reason)}</p><p class="caption">切换编号：${esc(j.id)} · ${esc(time(j.createdAt))}${j.sessionBackup ? '<br>会话备份：' + esc(j.sessionBackup) : ''}${j.safetyBackup ? '<br>配置备份：' + esc(j.safetyBackup) : ''}</p><div class="actions">${j.phase === 'waiting' ? btn('取消本次切换', 'switchCancel', j.id) : ''}${j.phase === 'unknown' && !j.reviewedAt ? btn('已核对失败现场', 'reviewSwitchFailure', j.id) : ''}${btn('刷新状态', 'refreshAll')}</div></section>`;
}
function smoothCard() {
  const a = state.ideAdapter || { state: 'unsupported', reason: '暂时无法读取启动入口状态' };
  const enabled = a.state === 'enabled', prepared = a.state === 'reloadRequired';
  const pending = ['waiting','running'].includes(state.switchJob?.phase);
  return `<section class="panel smooth-card"><div class="card-head"><h2>平滑切换</h2><span class="badge ${enabled ? 'ok' : ''}">${enabled ? '已启用' : prepared ? (pending ? '等待切换完成' : '等待首次重载') : '尚未启用'}</span></div><p>切换账号或 API 后，只重新加载当前窗口，无需关闭 VS Code。</p><p class="caption">${esc(a.reason)}<br>本机兼容模式调整官方扩展启动入口，保留原程序及入口备份；官方扩展升级后需重新检查。</p><div class="actions">${!enabled && !prepared ? btn('启用本机平滑切换', 'enableSmoothSwitch', '', 'primary', pending || a.state === 'unsupported') : ''}${prepared || enabled || a.state === 'disabled' ? btn('重新加载窗口', 'reloadEditor', '', 'primary', pending) : ''}${enabled || prepared || a.entry ? btn('恢复官方启动入口', 'disableSmoothSwitch', '', '', pending) : ''}</div></section>`;
}
function switchWizard() {
  if (!switchTarget) return '';
  const name = switchAccount ? state.accounts?.find(a => a.id === switchAccount)?.name || '官方账号' : switchTarget === 'openai' ? '官方账号' : state.providers.find(p => p.id === switchTarget)?.name || switchTarget;
  const active = ['waiting', 'running'].includes(state.switchJob?.phase);
  const ready = state.ideAdapter?.state === 'enabled';
  return `<section class="panel switch-box"><div class="section-title"><h2>切换到 ${esc(name)}</h2>${btn('收起', 'cancelSwitch', '', 'quiet')}</div><ol><li>等当前 Codex 任务结束，点击“切换并重新加载”。</li><li>当前窗口重载，新 Codex 等后台完成备份、切换和对话检查后再启动。</li><li>在管理中心确认成功，再继续原对话。</li></ol><p class="caption">不关闭 VS Code，不结束其他窗口或 CLI。其他 Codex 仍在线时会等待，可在管理中心取消；等待一小时作废。切换期间不要更新官方扩展或新开其他 Codex。无法确认其他窗口的任务状态，所以切换前仍需确认当前任务已结束。</p>${!ready ? '<div class="notice">首次使用请在总览启用“本机平滑切换”，然后重新加载窗口。</div>'+btn('前往总览设置', 'nav', 'overview') : ''}${!state.diagnostics.switchAvailable ? '<div class="notice error">尚未安装会话同步工具，请先按操作指南安装。</div>' : ''}<div class="actions">${btn('切换并重新加载', 'switchNow', switchTarget, 'primary', !ready || !state.diagnostics.switchAvailable || active || state.switchJob?.phase === 'unknown' && !state.switchJob?.reviewedAt)}${btn('安排稍后切换', 'switchLater', switchTarget, '', !state.diagnostics.switchAvailable || active || state.switchJob?.phase === 'unknown' && !state.switchJob?.reviewedAt)}${btn('打开操作说明', 'openGuide')}</div></section>`;
}
function providers() { return heading('供应商，清楚可控', '官方账号一直保留。API 按组管理，同组成员可作为彼此的备用。', btn('从配置导入', 'importProviders') + btn('添加 API', 'newProvider', '', 'primary')) +
  `<div class="notice">“设为组内首选”调整代理的请求顺序；“切换到此账号/API”自动安排整个 Codex 的切换。添加 API 不会立即改变现有 Codex 配置。</div>` +
  backgroundCard() + smoothCard() + switchStatus() + (providerDraft ? providerForm() : '') + loginCard() + switchWizard() + `<div class="section-title"><h2>你的供应商</h2><small>${state.providers.length + 1 + (state.accounts || []).length} 个入口</small></div><div class="grid provider-grid">${officialCard()}${(state.accounts || []).map(accountCard).join('')}${state.providers.map(providerCard).join('')}</div>`;
}
function filteredThreads() {
  const q = query.trim().toLowerCase();
  return state.threads.filter(t => (scope === 'all' || t.archived === (scope === 'archived')) && (!project || t.cwd === project) && (!q || `${t.title} ${t.cwd} ${t.id}`.toLowerCase().includes(q)))
    .sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'oldest' ? (a.updatedAt || 0) - (b.updatedAt || 0) : (b.updatedAt || 0) - (a.updatedAt || 0));
}
function sessions() {
  const filtered = filteredThreads(), size = 30, pages = Math.max(1, Math.ceil(filtered.length / size)); page = Math.min(page, pages - 1);
  const rows = filtered.slice(page * size, page * size + size), chosen = state.threads.filter(t => selected.has(t.id));
  return heading('对话目录', '快速找到记录，再决定保留、归档或删除。归档后仍可恢复继续。', btn('刷新目录', 'refreshSessions')) +
  (state.sessionsError ? `<div class="notice error" role="alert">读取失败：${esc(state.sessionsError)}。${state.sessionsLoaded ? '下方为上次成功读取的结果。' : '请检查运行机器和对话目录。'}</div>` : '') +
  `<div class="toolbar"><input id="sessionSearch" aria-label="搜索对话" type="search" placeholder="搜索标题、项目或对话 ID" value="${esc(query)}"><div class="filters" aria-label="归档筛选">${[['active', '未归档'], ['archived', '已归档'], ['all', '全部']].map(([s, n]) => `<button data-action="scope" data-id="${s}" aria-pressed="${scope === s}">${n}</button>`).join('')}</div></div><div class="toolbar"><select id="projectFilter" aria-label="按项目筛选"><option value="">全部项目</option>${[...new Set(state.threads.map(t => t.cwd))].sort().map(p => `<option value="${esc(p)}" ${project === p ? 'selected' : ''}>${esc(p || '无项目')}</option>`).join('')}</select><select id="sortFilter" aria-label="排序">${[['newest', '最近更新在前'], ['oldest', '最早更新在前'], ['title', '按标题排序']].map(([v, n]) => `<option value="${v}" ${sort === v ? 'selected' : ''}>${n}</option>`).join('')}</select></div>` +
  `<div class="toolbar"><small>已选择 ${selected.size} 条 · 筛选结果 ${filtered.length} 条</small>${btn('归档', 'archive', '', '', !chosen.length || chosen.some(t => t.archived))}${btn('取消归档', 'unarchive', '', '', !chosen.length || chosen.some(t => !t.archived))}${btn('删除', 'delete', '', 'danger', !chosen.length)}${selected.size ? btn('清空选择', 'clearSelection', '', 'quiet') : ''}</div>` +
  (!state.sessionsLoaded && !state.sessionsError ? '<div class="empty"><h3>正在读取对话目录</h3><p>如果等待过久，点击“刷新目录”重试。</p></div>' : !rows.length ? `<div class="empty"><h3>${state.sessionsLoaded && !state.threads.length ? '这个目录还没有对话' : '没有找到符合条件的对话'}</h3><p>试试清空搜索、切到“全部”，或检查是否连接到正确的机器。</p>${btn('清除筛选', 'clearFilters')}</div>` :
  `<div class="table-wrap"><table><thead><tr><th><input id="selectPage" type="checkbox" aria-label="选择本页对话" ${rows.every(t => selected.has(t.id)) ? 'checked' : ''}></th><th>对话 / 项目</th><th>状态</th><th>最近更新</th></tr></thead><tbody>${rows.map(t => `<tr class="${selected.has(t.id) ? 'selected' : ''}"><td><input type="checkbox" data-thread="${esc(t.id)}" aria-label="选择 ${esc(t.title)}" ${selected.has(t.id) ? 'checked' : ''}></td><td class="title"><button class="thread-title" data-action="threadDetail" data-id="${esc(t.id)}" title="${esc(t.title)}">${esc(t.title)}</button><span class="project" title="${esc(t.cwd)}">${esc(t.cwd || '无项目')}${t.parentThreadId ? ' · 子会话' : ''}</span></td><td><span class="badge">${t.archived ? '已归档' : '未归档'}</span></td><td>${esc(date(t.updatedAt))}</td></tr>`).join('')}</tbody></table></div><div class="pagination"><span>第 ${page + 1} / ${pages} 页 · 每页 ${size} 条</span><div class="actions">${btn('上一页', 'prevPage', '', '', page === 0)}${btn('下一页', 'nextPage', '', '', page + 1 >= pages)}</div></div>`) +
  `<p class="caption">最近读取：${esc(time(state.sessionsUpdatedAt))} · 时间按 ${esc(state.settings.timeZone || state.diagnostics.serverTimeZone)} 显示。点击标题可查看信息；继续对话请到官方 Codex 历史列表。</p><div class="notice">归档、恢复与删除前，会展示影响范围并完整备份。请先停止相关 Codex 任务；删除不会清除旧备份中的副本。</div>`;
}
function monitor() {
  if (!monitorDraft) monitorRenderedRevision = state.agent?.revision;
  const s = monitorDraft || state.settings;
  const field = (name, label, min, max) => `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" value="${s[name]}" required></label>`;
  return heading('按你的节奏，保持连接', '监控只发送测试短句，可能产生少量费用。自动切换仅处理明确可重试的请求。', btn('查看接入说明', 'openGuide')) + backgroundCard() +
  `<div class="grid"><section class="panel"><div class="card-head"><div><h2>连接监控</h2><p class="muted">${state.monitoring ? state.checking ? '正在检测' : '已开启' : '已暂停'} · 下次：${esc(time(state.nextCheck))}</p></div><span class="badge ${state.monitoring ? 'ok' : ''}">${state.monitoring ? '运行中' : '暂停中'}</span></div><form id="monitorForm"><div class="form-grid">${field('intervalSeconds', '检测间隔（秒）', 30, 86400)}${field('timeoutSeconds', '无响应超时（秒）', 5, 600)}${field('failureThreshold', '连续失败几次后避开', 1, 20)}${field('cooldownSeconds', '多久后再尝试（秒）', 30, 86400)}${field('startHour', '每天开始小时', 0, 23)}${field('endHour', '每天结束小时', 1, 24)}<label class="full">使用时区<select name="timeZone">${[...new Set(['Asia/Shanghai', 'UTC', state.diagnostics.serverTimeZone, s.timeZone].filter(Boolean))].map(z => `<option value="${esc(z)}" ${s.timeZone === z ? 'selected' : ''}>${z === 'Asia/Shanghai' ? '北京时间 · Asia/Shanghai' : esc(z)}</option>`).join('')}</select></label></div><p class="caption">0–24 表示全天；22–8 表示晚上 22 点至次日 8 点。时间段限制定时检测，真实请求不受此时段限制。</p><div class="form-footer">${btn(state.monitoring ? '暂停监控' : '开启监控', 'toggleMonitor')}<button class="primary" type="submit">保存设置</button></div></form></section><section class="panel"><div class="card-head"><div><h2>API 组内自动切换</h2><p class="muted">${state.proxy ? '本机代理已启动' : '本机代理尚未启动'}</p></div><span class="badge ${state.proxy ? 'ok' : ''}">${state.proxy ? '运行中' : '未运行'}</span></div>${state.proxy ? `<dl class="kv"><dt>运行分组</dt><dd>${esc(state.proxy.group)}</dd><dt>当前请求</dt><dd>${esc(state.providers.find(p => p.id === state.proxy.activeProvider)?.name || '等待请求')}</dd><dt>监听地址</dt><dd><code>127.0.0.1:${state.proxy.port}</code></dd></dl>` : '<p class="subtitle">将同组 API 接入一个本机地址，首选接口明确拒绝请求时，尝试备用接口。</p>'}<ol><li>在供应商页添加同组、相同模型的 API。</li><li>为组内每个 API 设置 Key，并先检测。</li><li>启动代理，按生成的说明接入和测试。</li></ol><div class="actions">${btn(state.proxy ? '停止代理' : '启动分组代理', state.proxy ? 'stopProxy' : 'startProxy', '', 'primary')}${btn('生成接入配置', 'proxyConfig', '', '', !state.proxy)}</div><div class="notice warning">关闭或重载窗口不会停止后台代理。后台重启尝试保留原端口和令牌；失败时先检查，不会自动重放旧请求。</div><p class="caption">已经开始输出、调用工具，或执行结果不确定时，不会自动重放到另一家。只支持 Responses 流式接口；不转换 Chat Completions。</p></section></div><div class="section-title"><h2>最近连接变化</h2><small>绿色正常 · 红色失败 · 每家最多 40 次</small></div><div class="grid">${state.providers.length ? state.providers.map(p => `<div class="card"><div class="card-head"><h3>${esc(p.name)}</h3>${healthBadge(p)}</div>${history(p)}<small>${esc(p.health?.reason || '暂无记录')} · ${p.health ? esc(time(p.health.checkedAt)) : '可先手动检测'}${p.health?.unavailableUntil > Date.now() ? ` · 等待至 ${esc(time(p.health.unavailableUntil))}` : ''}</small></div>`).join('') : '<div class="empty">添加 API 供应商后，这里会显示连接记录。</div>'}</div>`;
}
function backups() {
  const d = state.diagnostics;
  return heading('记录有备份，操作有依据', '完整备份与原目录分开保存。不自动删除旧副本，也不覆盖备份之后的新消息。', btn('立即完整备份', 'backup', '', 'primary')) +
  `<div class="grid"><section class="panel"><h2>定时备份</h2><p class="subtitle">${state.autoBackup ? `下次备份：${esc(time(state.nextBackup))}` : '按需开启，第一份定时备份将在设置的间隔后保存。'}</p><form id="backupForm"><div class="form-grid"><label>备份间隔（小时）<input name="hours" type="number" min="1" max="168" value="${state.backupHours}" required></label><label class="check"><input name="enabled" type="checkbox" ${state.autoBackup ? 'checked' : ''}>启用定时备份</label></div><div class="form-footer"><button class="primary" type="submit">保存备份计划</button></div></form><p class="caption">关闭或重载窗口后继续；后台重启后安排下一轮，不补跑错过的任务。代理运行时，定时备份会跳过本轮并记入操作记录。旧方案的系统每日备份独立运行。</p></section><section class="panel"><div class="card-head"><h2>运行检查</h2>${btn('复制诊断信息', 'copyDiagnostics', '', 'quiet')}</div><ul class="check-list">${[
    [!!d.executable, 'Codex 程序', d.executable || '未找到，请配置 codexPath'],
    [d.trusted, '工作区', d.trusted ? '已信任' : '请先信任'],
    [state.sessionsLoaded && !state.sessionsError, '对话目录', `${state.threads.length} 条已读取`],
    [d.diskGiB === undefined ? false : d.diskGiB > 5, '可用磁盘', d.diskGiB === undefined ? '暂时无法读取' : `${d.diskGiB} GiB`],
    [d.switchAvailable, '会话同步工具', d.switchAvailable ? '已找到' : '未安装或当前系统暂不支持向导']
  ].map(([ok, name, detail]) => `<li><span class="${ok ? 'good' : 'bad-text'}">${ok ? '✓' : '!'}</span><div><strong>${name}</strong><br><small class="trunc">${esc(detail)}</small></div></li>`).join('')}</ul><p class="caption">诊断复制不含 Key、对话标题、路径或主机名。Python 与数据库的一致性会在实际备份时验证。</p></section></div><div class="section-title"><h2>本扩展保存的备份</h2>${btn('刷新', 'refreshAll', '', 'quiet')}</div>${state.snapshots.length ? `<div class="table-wrap"><table><thead><tr><th>备份时间（UTC）</th><th>对话数</th><th>状态</th><th>操作</th></tr></thead><tbody>${state.snapshots.map(b => `<tr><td><code>${esc(b.id)}</code></td><td>${b.partial ? '—' : esc(b.sessions)}</td><td><span class="badge ${b.partial ? 'bad' : 'ok'}">${b.partial ? '未完成' : '完整快照'}</span></td><td><div class="actions">${btn('校验完整性', 'verifyBackup', b.id, '', b.partial)}${btn('复制目录', 'openBackup', b.id, '', !b.sourceMatches)}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>还没有完整备份</h3><p>先保存一份，再开始对话整理或供应商切换。</p><div class="actions">'+btn('备份全部对话', 'backup', '', 'primary')+'</div></div>'}<div class="notice">归档对话也在备份中。这里不提供一键覆盖恢复；遇到问题先校验副本，再确定要恢复的范围，以免覆盖新消息。</div><div class="section-title"><h2>操作记录</h2><small>后台最近记录及本次窗口</small></div><section class="panel">${eventsMarkup()}</section>`;
}
function render() {
  if (!state) return;
  const content = ({ overview, providers, sessions, monitor, backups })[tab]();
  $('app').innerHTML = `<div class="shell"><aside class="rail"><div class="brand"><span class="mark" aria-hidden="true">⇄</span><div>Codex 管理<small>PROVIDER MANAGER</small></div></div><nav aria-label="主要导航">${Object.entries(tabs).map(([id, [icon, label]]) => `<button type="button" data-action="nav" data-id="${id}" ${tab === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span>${label}</button>`).join('')}</nav><div class="rail-bottom"><div class="connection"><span class="dot ok"></span>管理面板已连接</div>${esc(state.host)}<br>v${esc(state.version)} · ${esc(state.remote)}<br><br><span title="${esc(state.home)}">${esc(state.home)}</span><br><br>${btn('使用说明', 'openGuide', '', 'quiet')}</div></aside><main id="main" tabindex="-1">${state.configWarning ? `<div class="notice error" role="alert">${esc(state.configWarning)}</div>` : ''}${content}</main></div>`;
  if (busy) document.querySelectorAll('button').forEach(b => { b.disabled = true; });
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message?.type === 'state') { state = message.data; if (loginInfo && (loginInfo.until <= Date.now() || !state.accounts?.some(a => a.id === loginInfo.id && a.pending))) loginInfo = undefined; const editing = document.activeElement?.matches('input,select'); if (!editing || busy) render(); }
  if (message?.type === 'result') { pending.get(message.requestId)?.(message); pending.delete(message.requestId); }
  if (message?.type === 'notice') toast(message.error, true);
});
function readForm(form) { const data = Object.fromEntries(new FormData(form)); for (const box of form.querySelectorAll('input[type=checkbox]')) data[box.name] = box.checked; return data; }
document.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const form = event.target, payload = readForm(form);
  if (form.id === 'providerForm') { const reply = await request('saveProvider', { ...payload, id: providerDraft?.id, expectedRevision: providerDraft?.expectedRevision }); if (!reply?.error) { providerDraft = undefined; render(); } }
  if (form.id === 'monitorForm') { const reply = await request('saveMonitor', { ...payload, expectedRevision: monitorDraft?.expectedRevision ?? monitorRenderedRevision }); if (!reply?.error) { monitorDraft = undefined; render(); } }
  if (form.id === 'backupForm') await request('autoBackup', payload);
});
document.addEventListener('input', event => {
  const target = event.target;
  if (target.closest('#providerForm')) providerDraft = { ...providerDraft, ...readForm(target.form) };
  if (target.closest('#monitorForm')) monitorDraft = { ...readForm(target.form), expectedRevision: monitorDraft?.expectedRevision ?? monitorRenderedRevision };
  if (target.id === 'sessionSearch') { query = target.value; page = 0; selected.clear(); const start = target.selectionStart; render(); const input = $('sessionSearch'); input.focus(); try { input.setSelectionRange(start, start); } catch { /* Search inputs may not support selection. */ } }
});
document.addEventListener('change', event => {
  const target = event.target;
  if (target.id === 'projectFilter') { project = target.value; page = 0; selected.clear(); render(); }
  if (target.id === 'sortFilter') { sort = target.value; page = 0; render(); }
  if (target.dataset.thread) { if (target.checked) selected.add(target.dataset.thread); else selected.delete(target.dataset.thread); render(); }
  if (target.id === 'selectPage') { for (const t of filteredThreads().slice(page * 30, page * 30 + 30)) if (target.checked) selected.add(t.id); else selected.delete(t.id); render(); }
});
function detail(id) {
  currentDetail = state.threads.find(t => t.id === id); if (!currentDetail) return;
  document.querySelector('dialog')?.remove();
  const t = currentDetail, dialog = document.createElement('dialog');
  dialog.setAttribute('aria-labelledby', 'detailTitle');
  dialog.innerHTML = `<h2 id="detailTitle">${esc(t.title)}</h2><dl class="kv"><dt>对话 ID</dt><dd><code>${esc(t.id)}</code></dd><dt>项目位置</dt><dd>${esc(t.cwd || '无项目')}</dd><dt>状态</dt><dd>${t.archived ? '已归档' : '未归档'}</dd><dt>最近更新</dt><dd>${esc(date(t.updatedAt))}</dd></dl><p>继续对话时，在官方 Codex 历史列表查找该标题。已归档对话需要先取消归档。</p><div class="actions">${btn('复制 ID', 'copySessionId', t.id)}${btn('关闭', 'closeDetail', '', 'primary')}</div>`;
  document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => { dialog.remove(); document.querySelector(`[data-action="threadDetail"][data-id="${CSS.escape(id)}"]`)?.focus(); });
}
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]'); if (!target || busy) return;
  const action = target.dataset.action, id = target.dataset.id;
  if (action === 'nav') return navigate(id);
  if (action === 'newProvider') { providerDraft = { expectedRevision: state.agent?.revision, name: '', group: '日常工作', baseUrl: '', model: 'gpt-6.1-sol', priority: state.providers.length * 10, enabled: true }; render(); document.querySelector('#providerForm input')?.focus(); return; }
  if (action === 'editProvider') { providerDraft = { ...state.providers.find(p => p.id === id), expectedRevision: state.agent?.revision }; render(); document.querySelector('#providerForm input')?.focus(); return; }
  if (action === 'cancelProvider') { providerDraft = undefined; render(); return; }
  if (action === 'accountSwitch') { switchAccount = id; switchTarget = 'openai'; render(); document.querySelector('.switch-box')?.scrollIntoView({ block: 'center' }); return; }
  if (action === 'switchWizard') { switchAccount = undefined; switchTarget = id; render(); document.querySelector('.switch-box')?.scrollIntoView({ block: 'center' }); return; }
  if (action === 'cancelSwitch') { switchTarget = switchAccount = undefined; render(); return; }
  if (action === 'scope') { scope = id; page = 0; selected.clear(); render(); return; }
  if (action === 'prevPage' || action === 'nextPage') { page += action === 'nextPage' ? 1 : -1; render(); return; }
  if (action === 'clearSelection') { selected.clear(); render(); return; }
  if (action === 'clearFilters') { query = ''; project = ''; scope = 'all'; page = 0; selected.clear(); render(); return; }
  if (action === 'threadDetail') return detail(id);
  if (action === 'closeDetail') { document.querySelector('dialog')?.close(); return; }
  const destructive = ['archive', 'unarchive', 'delete'].includes(action);
  const labels = { backup: '正在完整备份并校验…', verifyBackup: '正在逐一核对备份文件…', refreshSessions: '正在读取对话目录…', refreshAll: '正在刷新配置与对话…', testProvider: '请在 VS Code 提示中确认检测…', archive: '请确认影响范围；正在备份和归档…', unarchive: '请确认影响范围；正在备份和恢复…', delete: '请确认影响范围；正在备份和删除…' };
  const reply = await request(action, destructive ? { ids: [...selected] } : ['switchCommand', 'switchNow', 'switchLater'].includes(action) ? { id, accountId: switchAccount } : { id }, labels[action]);
  if (!reply?.error && reply?.value && Object.hasOwn(reply.value, 'login')) { loginInfo = reply.value.login || undefined; render(); document.querySelector('.login-box')?.scrollIntoView({ block: 'center' }); }
  if (action === 'accountCancel' && !reply?.error) { loginInfo = undefined; render(); }
  if (destructive && !reply?.error) { selected.clear(); render(); }
});
request('ready', null, '正在连接管理服务…');
})();
