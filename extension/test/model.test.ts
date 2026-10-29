import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaults, HealthRegistry, Provider, validateProvider, validateSettings, withinHours } from '../src/model';
const p: Provider = { id: 'a', name: 'A', group: '组', baseUrl: 'https://example.invalid/v1', model: 'test-model', priority: 0, enabled: true };
test('地址验证：拒绝明文外网、内嵌凭证、完整请求路径', () => {
  for (const baseUrl of ['http://example.invalid/v1', 'https://key@example.invalid/v1', 'https://example.invalid/v1?key=x', 'https://example.invalid/v1/responses']) assert.throws(() => validateProvider({ ...p, baseUrl }));
  assert.equal(validateProvider({ ...p, baseUrl: 'http://127.0.0.1:123/v1/' }).baseUrl, 'http://127.0.0.1:123/v1');
});
test('失败阈值、冷却、恢复与优先级', () => {
  let now = 1000; const h = new HealthRegistry(() => ({ ...defaults, failureThreshold: 2, cooldownSeconds: 30 }), () => now);
  const b = { ...p, id: 'b', priority: 10 };
  h.record('a', false, 503); assert.deepEqual(h.candidates([b, p], '组').map(p => p.id), ['a', 'b']);
  h.record('a', false, 503); assert.deepEqual(h.candidates([b, p], '组').map(p => p.id), ['b']);
  now += 30001; assert.equal(h.candidates([b, p], '组')[0].id, 'a');
  h.record('a', true, 200); assert.equal(h.states.get('a')!.failures, 0);
  h.record('a', false, 401); assert.equal(h.candidates([b, p], '组')[0].id, 'b');
});
test('分组、启用状态和模型不会被忽略', () => {
  const h = new HealthRegistry(() => defaults);
  assert.equal(h.candidates([p, { ...p, id: 'off', enabled: false }, { ...p, id: 'wrong', model: 'other' }], '组', 'test-model').length, 1);
  assert.equal(h.candidates([p], '其他组').length, 0);
});
test('监控时间支持全天、白天和跨午夜，拒绝过密间隔', () => {
  assert(withinHours(defaults, 23));
  const day = { ...defaults, startHour: 9, endHour: 23 };
  assert(withinHours(day, 9)); assert(!withinHours(day, 23));
  const night = { ...defaults, startHour: 22, endHour: 6 };
  assert(withinHours(night, 23)); assert(withinHours(night, 5)); assert(!withinHours(night, 12));
  assert.throws(() => validateSettings({ ...defaults, intervalSeconds: 1 }));
});

test('监控时区明确使用北京时间；连接历史有上限', async () => {
  const { monitorHour } = await import('../src/model');
  assert.equal(monitorHour({ ...defaults, timeZone: 'Asia/Shanghai' }, new Date('2026-10-18T16:00:00Z')), 0);
  assert.equal(monitorHour({ ...defaults, timeZone: 'UTC' }, new Date('2026-10-18T16:00:00Z')), 16);
  assert.throws(() => validateSettings({ ...defaults, timeZone: 'not-a-timezone' }));
  const registry = new HealthRegistry(() => defaults);
  for (let i = 0; i < 100; i++) registry.record('p', true);
  assert.equal(registry.history.get('p')?.length, 40);
});
