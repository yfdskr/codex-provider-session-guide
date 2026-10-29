import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { privateDirectory } from '../../core/files';
import { IDE_COMPATIBILITY } from '../../core/ide-adapter';

/** Copies only public extension code/manifest; never real Codex user state. */
export async function officialFixture(parent: string): Promise<string> {
  const source = path.dirname(path.dirname(path.dirname(process.env.CODEX_TEST_PATH!)));
  const root = path.join(parent, 'official-copy');
  await privateDirectory(root); await privateDirectory(path.join(root, 'out'));
  await fs.copyFile(path.join(source, 'package.json'), path.join(root, 'package.json'));
  let code = await fs.readFile(path.join(source, 'out/extension.js'), 'utf8');
  const shim = /^module\.exports = require\("\.\.\/\.cpm-bootstrap\/([a-f0-9-]{36})\.cjs"\);\n$/.exec(code);
  if (shim) {
    // A user's enabled adapter is not a pristine fixture. Read only its public
    // native-code copy, never bootstrap records, manager state or login files.
    code = await fs.readFile(path.join(source, 'out', `.cpm-native-${shim[1]}.js`), 'utf8');
    const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
    if (createHash('sha256').update(code).digest('hex') !== IDE_COMPATIBILITY[version]) throw new Error('测试所需的官方原程序副本无法核对');
  }
  await fs.writeFile(path.join(root, 'out/extension.js'), code, { mode: 0o600 });
  return root;
}
