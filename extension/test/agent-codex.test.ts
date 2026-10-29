import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppServer } from '../src/rpc';

test('真实 Codex：两个 App Server 的已加载对话各自独立，不推断能接管官方窗口', { skip: !process.env.CODEX_TEST_PATH }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'cpm-codex-capability-'));
  const previous = process.env.CODEX_SQLITE_HOME;
  process.env.CODEX_SQLITE_HOME = home;
  const first = new AppServer(process.env.CODEX_TEST_PATH!, home), second = new AppServer(process.env.CODEX_TEST_PATH!, home);
  try {
    await fs.writeFile(path.join(home, 'synthetic.key'), 'SYNTHETIC-NOT-A-REAL-KEY', { mode: 0o600 });
    await fs.writeFile(path.join(home, 'config.toml'), `model = "synthetic"\nmodel_provider = "synthetic"\nsqlite_home = ${JSON.stringify(home)}\n[analytics]\nenabled = false\n[model_providers.synthetic]\nname = "Synthetic only"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequest_max_retries = 0\n[model_providers.synthetic.auth]\ncommand = "/bin/cat"\nargs = [${JSON.stringify(path.join(home, 'synthetic.key'))}]\n`);
    await first.start(); await second.start();
    const started: any = await first.call('thread/start', { model: 'synthetic', modelProvider: 'synthetic', cwd: home, approvalPolicy: 'never', sandbox: 'read-only' });
    const own: any = await first.call('thread/loaded/list', {}), other: any = await second.call('thread/loaded/list', {});
    assert(own.data.includes(started.thread.id)); assert(!other.data.includes(started.thread.id));
    // No turn/start, no actual model generation, no connection to the user's IDE server.
  } finally {
    first.stop(); second.stop();
    if (previous === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = previous;
    await new Promise(resolve => setTimeout(resolve, 150)); await fs.rm(home, { recursive: true, force: true });
  }
});
