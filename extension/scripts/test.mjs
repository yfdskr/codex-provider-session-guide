import path from 'node:path';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const tests = readdirSync('test').filter(f => f.endsWith('.test.ts')).map(f => `test/${f}`);
await import('./build-startup.mjs');
await build({ entryPoints: tests, bundle: true, platform: 'node', target: 'node20', format: 'cjs', outdir: '.test-build', alias: { '@iarna/toml': path.resolve('node_modules/@iarna/toml'), vscode: './test/vscode-mock.ts' } });
const result = spawnSync(process.execPath, ['--test', ...tests.map(f => f.replace('test/', '.test-build/').replace('.ts', '.js'))], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
