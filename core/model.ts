export interface Provider { id: string; name: string; group: string; baseUrl: string; model: string; priority: number; enabled: boolean }
export interface MonitorSettings { intervalSeconds: number; timeoutSeconds: number; failureThreshold: number; cooldownSeconds: number; startHour: number; endHour: number; timeZone?: string }
export interface Health { failures: number; unavailableUntil: number; checkedAt: number; ok?: boolean; status?: number; reason: string }
export const defaults: MonitorSettings = { intervalSeconds: 300, timeoutSeconds: 30, failureThreshold: 3, cooldownSeconds: 300, startHour: 0, endHour: 24, timeZone: 'Asia/Shanghai' };
export function validateProvider(p: Provider): Provider {
  if (!p || ['id', 'name', 'group', 'model', 'baseUrl'].some(k => typeof (p as any)[k] !== 'string') || typeof p.enabled !== 'boolean') throw new Error('请填写完整的供应商资料。');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(p.id)) throw new Error('供应商 ID 只允许字母、数字、横线和下划线。');
  if (['__proto__', 'constructor', 'prototype'].includes(p.id)) throw new Error('供应商 ID 使用了保留名称。');
  if (!p.name.trim() || !p.group.trim() || !p.model.trim()) throw new Error('名称、分组、模型不能为空。');
  let url: URL;
  try { url = new URL(p.baseUrl.trim()); } catch { throw new Error('API 基础地址格式不正确，例如 https://服务商/v1。'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('基础地址不能包含密钥、查询参数或片段。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('使用 HTTPS；仅本机地址允许 HTTP。');
  if (/\/(responses|completions)\/?$/.test(url.pathname)) throw new Error('填写基础地址，例如 https://服务商/v1，不填 /responses。');
  if (!Number.isInteger(p.priority) || p.priority < 0 || p.priority > 999) throw new Error('优先级应为 0–999 的整数，数字小的优先。');
  if ([p.name, p.group, p.model].some(v => v.length > 256) || p.baseUrl.length > 4096) throw new Error('供应商名称、分组、模型或地址过长。');
  return { id: p.id, name: p.name.trim(), group: p.group.trim(), model: p.model.trim(), baseUrl: url.toString().replace(/\/$/, ''), priority: p.priority, enabled: p.enabled };
}
export function validateProviders(list: Provider[]): Provider[] {
  const providers = list.map(validateProvider);
  if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('供应商 ID 重复。');
  if (new Set(providers.map(p => p.name.toLocaleLowerCase())).size !== providers.length) throw new Error('供应商名称重复，请使用不同名称区分账号或接口。');
  if (providers.some(p => ['openai', 'provider_manager'].includes(p.id))) throw new Error('供应商 ID 使用了保留名称。');
  return providers;
}
export function validateSettings(s: MonitorSettings): MonitorSettings {
  for (const [key, min, max] of [['intervalSeconds', 30, 86400], ['timeoutSeconds', 5, 600], ['failureThreshold', 1, 20], ['cooldownSeconds', 30, 86400], ['startHour', 0, 23], ['endHour', 1, 24]] as const) {
    if (!Number.isInteger(s[key]) || s[key] < min || s[key] > max) throw new Error(`${key} 应为 ${min}–${max} 的整数。`);
  }
  try { new Intl.DateTimeFormat('en', { timeZone: s.timeZone }); } catch { throw new Error('时区无效，例如 Asia/Shanghai 或 UTC。'); }
  return { intervalSeconds: s.intervalSeconds, timeoutSeconds: s.timeoutSeconds, failureThreshold: s.failureThreshold, cooldownSeconds: s.cooldownSeconds, startHour: s.startHour, endHour: s.endHour, timeZone: s.timeZone };
}
export function monitorHour(s: MonitorSettings, date = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: s.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date));
}
export function withinHours(s: MonitorSettings, hour: number): boolean {
  if (s.startHour === s.endHour) return true;
  return s.startHour < s.endHour ? hour >= s.startHour && hour < s.endHour : hour >= s.startHour || hour < s.endHour;
}
export class HealthRegistry {
  readonly states = new Map<string, Health>();
  readonly history = new Map<string, { at: number; ok: boolean }[]>();
  constructor(private settings: () => MonitorSettings, private now = Date.now) {}
  record(id: string, ok: boolean, status?: number, reason = ''): void {
    const old = this.states.get(id);
    const failures = ok ? 0 : (old?.failures ?? 0) + 1;
    const blocked = !ok && (status === 401 || status === 403 || failures >= this.settings().failureThreshold);
    this.states.set(id, { failures, unavailableUntil: blocked ? this.now() + this.settings().cooldownSeconds * 1000 : 0, checkedAt: this.now(), ok, status, reason });
    this.history.set(id, [...(this.history.get(id) ?? []), { at: this.now(), ok }].slice(-40));
  }
  candidates(providers: Provider[], group: string, model?: string): Provider[] {
    return providers.filter(p => p.enabled && p.group === group && (!model || p.model === model) && (this.states.get(p.id)?.unavailableUntil ?? 0) <= this.now()).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  }
}
