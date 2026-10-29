import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AppServer } from '../src/rpc';
test('管理连接完成握手、处理结果与错误、写操作超时不重试', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cpm-rpc-'));
  const file = path.join(dir, 'mock.cjs');
  await writeFile(file, `const rl=require('node:readline').createInterface({input:process.stdin}); let ready=false; rl.on('line',l=>{ const m=JSON.parse(l); if(m.method==='initialized'){ready=true;return;} if(m.method==='hang')return; if(m.method==='initialize')return console.log(JSON.stringify({id:m.id,result:{}})); if(!ready)return process.exit(2); if(m.method==='bad')return console.log(JSON.stringify({id:m.id,error:{code:-32601,message:'private'}})); console.log(JSON.stringify({id:m.id,result:{echo:m.params}})); });`);
  const server = new AppServer(process.execPath, dir, 1000, [file]);
  try {
    await server.start(); assert.deepEqual(await server.call('echo', { text: 'synthetic' }), { echo: { text: 'synthetic' } });
    await assert.rejects(server.call('bad', {}), /-32601/);
    await assert.rejects(server.call('hang', {}), /超时/);
    assert.deepEqual(await server.call('echo', { n: 2 }), { echo: { n: 2 } });
  } finally { server.stop(); await rm(dir, { recursive: true, force: true }); }
});
test('进程无法启动时明确报错', async () => {
  const server = new AppServer('/missing/codex', os.tmpdir(), 100);
  try { await assert.rejects(server.start(), /无法启动/); } finally { server.stop(); }
});
