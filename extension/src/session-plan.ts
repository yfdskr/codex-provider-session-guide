import { Thread } from './rpc';
export function planMutation(selectedIds: string[], all: Thread[], includeDescendants: boolean): { roots: string[]; affected: Thread[] } {
  const byId = new Map(all.map(t => [t.id, t]));
  const selected = new Set(selectedIds);
  for (const id of selected) if (!byId.has(id)) throw new Error('选中对话已变化，请刷新后重新选择');
  const affected = new Set(selected);
  if (includeDescendants) {
    let changed = true;
    while (changed) { changed = false; for (const t of all) if (t.parentThreadId && affected.has(t.parentThreadId) && !affected.has(t.id)) { affected.add(t.id); changed = true; } }
  }
  const roots = [...selected].filter(id => {
    if (!includeDescendants) return true;
    const seen = new Set<string>([id]); let parent = byId.get(id)?.parentThreadId;
    while (parent && !seen.has(parent)) {
      if (selected.has(parent)) return false;
      seen.add(parent); parent = byId.get(parent)?.parentThreadId;
    }
    return true;
  });
  if (!roots.length && selected.size) throw new Error('对话父子关系异常，请先检查记录');
  return { roots, affected: [...affected].map(id => byId.get(id)!) };
}
