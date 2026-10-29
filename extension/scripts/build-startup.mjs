import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';

// Development artifact only: deliberately excluded from the installed VSIX.
await mkdir('artifacts/experiments/reload', { recursive: true });
await build({ entryPoints: ['../agent/startup-main.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: 'artifacts/experiments/reload/startup.js' });
