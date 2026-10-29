import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { backupRoot, listSnapshots, verifySnapshot } from '../src/backups';
test('备份目录：隔离不同 Codex Home，损坏、越界与软链接不能通过校验', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-verify-')); const home = path.join(root, '.codex');
  const id = '20261018T120000.123456Z', folder = path.join(backupRoot(home), id);
  await fs.mkdir(folder, { recursive: true }); await fs.writeFile(path.join(folder, 'state.sqlite'), 'synthetic');
  const file = { path: 'state.sqlite', sha256: createHash('sha256').update('synthetic').digest('hex') };
  const manifest = { source: home, createdUtc: id, sessions: 0, files: [file] };
  const save = async () => fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest));
  try {
    await save(); assert.equal((await listSnapshots(home)).length, 1);
    assert.equal((await listSnapshots(path.join(root, 'different-home'))).length, 0);
    assert.equal(await verifySnapshot(home, id), 1);
    await fs.writeFile(path.join(folder, 'state.sqlite'), 'changed');
    await assert.rejects(verifySnapshot(home, id), /有变化/);
    manifest.files[0].path = '../outside'; await save();
    await assert.rejects(verifySnapshot(home, id), /越界/);
    manifest.files[0] = file; file.path = 'state.sqlite'; await save();
    await fs.unlink(path.join(folder, 'state.sqlite')); await fs.writeFile(path.join(root, 'secret'), 'synthetic');
    await fs.symlink(path.join(root, 'secret'), path.join(folder, 'state.sqlite'));
    await assert.rejects(verifySnapshot(home, id), /越界/);
    await fs.mkdir(path.join(backupRoot(home), id + '.partial'));
    assert((await listSnapshots(home)).some(s => s.partial));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
