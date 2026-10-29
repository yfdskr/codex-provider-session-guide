import path from 'node:path';
import { readPrivate } from '../core/files';
import { AgentServer } from './server';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--state' || !path.isAbsolute(args[1])) throw new Error('Usage: node agent.js --state /absolute/private/directory');
  const folder = args[1];
  const launch = JSON.parse(await readPrivate(path.join(folder, 'launch.json')));
  if (!path.isAbsolute(launch.home) || !path.isAbsolute(launch.backupScript)) throw new Error('Invalid launch configuration');
  const server = new AgentServer(folder, launch.home, launch.backupScript, process.env.CPM_SYSTEMD === '1' ? 'systemd' : 'detached');
  process.once('SIGTERM', () => { void server.stop().finally(() => { process.exitCode = 0; }); });
  process.once('SIGINT', () => { void server.stop().finally(() => { process.exitCode = 0; }); });
  await server.start();
}
void main().catch(() => { process.stderr.write('本机后台启动失败；请检查目录权限、操作锁及后台版本。\n'); process.exitCode = 1; });
