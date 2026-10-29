import path from 'node:path';
import { executePlan } from '../core/switch';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 5 || args[0] !== '--state' || !path.isAbsolute(args[1]) || args[2] !== '--plan' || args[4] !== '--tasks-stopped') throw new Error('命令格式不正确，请重新复制管理面板生成的完整命令');
  const result = await executePlan(args[1], args[3], true);
  process.stdout.write(`切换成功：${result.targetName}。当前全部会话已核对；重新打开 VS Code，恢复原对话验证上下文。\n`);
}
void main().catch(error => { process.stderr.write((error as Error).message + '\n'); process.exitCode = 1; });
