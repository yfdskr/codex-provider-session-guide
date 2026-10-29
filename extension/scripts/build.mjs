import path from 'node:path';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('artifacts', { recursive: true });
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/extension.js', external: ['vscode'], alias: { '@iarna/toml': path.resolve('node_modules/@iarna/toml') }, sourcemap: false });
await build({ entryPoints: ['../agent/main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/agent.js', alias: { '@iarna/toml': path.resolve('node_modules/@iarna/toml') }, sourcemap: false });
await build({ entryPoints: ['../agent/switch-main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/switch.js', alias: { '@iarna/toml': path.resolve('node_modules/@iarna/toml') } });
await build({ entryPoints: ['../agent/ide-bootstrap.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'dist/ide-bootstrap.js', external: ['vscode'] });
