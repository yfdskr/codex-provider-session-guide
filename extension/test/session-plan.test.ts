import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMutation } from '../src/session-plan';
const all = [{ id: 'root' }, { id: 'child', parentThreadId: 'root' }, { id: 'grandchild', parentThreadId: 'child' }, { id: 'fork', forkedFromId: 'root' }];
test('批量归档或删除选中父子对话时不重复操作子会话，独立分叉不连带删除', () => {
  const result = planMutation(['root', 'child', 'grandchild'], all, true);
  assert.deepEqual(result.roots, ['root']); assert.deepEqual(result.affected.map(t => t.id).sort(), ['child', 'grandchild', 'root']);
});
test('取消归档只处理明确选中的对话', () => {
  const result = planMutation(['root', 'child'], all, false);
  assert.deepEqual(result.roots, ['root', 'child']); assert.equal(result.affected.length, 2);
});
test('旧选择指向已不存在的对话时停止', () => { assert.throws(() => planMutation(['missing'], all, true), /刷新/); });
