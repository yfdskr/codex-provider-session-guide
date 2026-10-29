"""Run from independent SSH after closing Codex windows. Never restore over newer data."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


def call(tool, home, *args):
    proc = subprocess.run([str(tool), *args, '--json', '--codex-home', str(home)], capture_output=True, text=True, timeout=300)
    try:
        envelope = json.loads(proc.stdout)
    except ValueError:
        raise ValueError('同步工具未返回完整结果。保留当前数据与备份，先检查再继续。')
    if proc.returncode or not envelope.get('ok') or envelope.get('outcome') not in ('completed', 'noop'):
        raise ValueError('同步工具未确认全部完成。可能已有部分修改；请检查状态，不要直接重试或覆盖恢复。')
    return envelope['result']


def ready(status):
    if not status.get('rolloutScanComplete') or status.get('pendingRecovery') or status.get('operationInProgress') or (status.get('skipSummary') or {}).get('total', 0):
        raise ValueError('会话扫描未完成、存在跳过项或待处理恢复。停止任务并先检查同步工具状态。')


def body(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        meta = json.loads(stream.readline())
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return meta['payload']['id'], h.hexdigest()


def switch(args, progress=None):
    progress = progress if progress is not None else {}
    progress.update(stage='preflight', mutationStarted=False, errorCode='PREFLIGHT_FAILED')
    home = args.home.resolve()
    tool = args.tool.resolve()
    database = args.database.resolve()
    if not args.tasks_stopped:
        raise ValueError('先关闭使用此对话目录的 Codex 窗口，再在独立 SSH 中添加 --tasks-stopped 执行。')
    if (home / 'provider-manager.proxy.lock').exists():
        raise ValueError('代理仍在运行或留有锁文件，请先核查并停止代理。')
    lock = home / 'provider-manager.operation.lock'
    fd = None
    if getattr(args, 'lock_nonce', None):
        owner = json.loads(lock.read_text())
        if owner.get('nonce') != args.lock_nonce or owner.get('pid') != os.getppid():
            raise ValueError('无法确认外层操作锁，未执行切换。')
    else:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, json.dumps({'pid': os.getpid()}).encode())
    try:
        with (home / 'session-switch.lock').open('a') as session_lock:
            fcntl.flock(session_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            before = call(tool, home, 'status')
            ready(before)
            if args.target not in before.get('configuredProviders', []):
                raise ValueError('目标尚未写入 Codex 配置，请先完成供应商配置。')
            if Path(before['stateDbLocation']['path']).resolve() != database:
                raise ValueError('同步工具与管理面板使用的数据库不同，已停止。')
            progress.update(stage='backup', errorCode='BACKUP_FAILED')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('backup.py')), '--home', str(home), '--database', str(database), '--destination', str(home.parent / '.codex-provider-manager-backups')], capture_output=True, text=True, timeout=300)
            if result.returncode:
                for text, code in [('Database and session ID sets differ', 'ID_SET_MISMATCH'), ('Session changed during snapshot', 'SOURCE_CHANGED'), ('Source changed during database snapshot', 'SOURCE_CHANGED'), ('Unknown session format', 'INVALID_SESSION_FORMAT'), ('Session symlinks are not supported', 'UNSAFE_SESSION_LINK')]:
                    if text in result.stderr:
                        progress['errorCode'] = code
                        break
                raise ValueError('完整备份未通过，没有执行切换。')
            snapshot = json.loads(result.stdout)
            folder = Path(snapshot['backup'])
            print('完整备份已通过：' + str(folder), flush=True)
            progress.update(stage='sync', mutationStarted=True, errorCode='SYNC_UNCONFIRMED')
            call(tool, home, 'switch', args.target, '--keep-root-model', '--keep', '10')
            progress.update(stage='verify', errorCode='VERIFY_FAILED')
            after = call(tool, home, 'status')
            ready(after)
            if after.get('currentProvider') != args.target:
                raise ValueError('供应商状态与目标不一致。保留备份，先检查。')
            for category in ('rolloutCounts', 'sqliteCounts'):
                if any(provider != args.target and count for counts in after.get(category, {}).values() for provider, count in counts.items()):
                    raise ValueError('仍有会话未同步到目标供应商。')
            def ids(db):
                with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as conn:
                    return {row[0] for row in conn.execute('SELECT id FROM threads')}
            if ids(folder / 'state.sqlite') != ids(database):
                raise ValueError('切换前后会话 ID 不一致。')
            manifest = json.loads((folder / 'manifest.json').read_text())
            count = 0
            for item in manifest['files']:
                relative = Path(item['path'])
                if relative.parts[0] in ('sessions', 'archived_sessions') and relative.suffix == '.jsonl':
                    if body(folder / relative) != body(home / relative):
                        raise ValueError('会话 ID 或正文校验不一致。')
                    count += 1
            print(f'切换成功：{args.target}；已核对 {count} 个记录文件，ID 与正文一致。现在可重新打开 VS Code。')
    finally:
        if fd is not None:
            os.close(fd)
            lock.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', type=Path, required=True)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--tool', type=Path, required=True)
    parser.add_argument('--target', required=True)
    parser.add_argument('--tasks-stopped', action='store_true')
    parser.add_argument('--lock-nonce')
    progress = {'stage': 'preflight', 'mutationStarted': False, 'errorCode': 'PREFLIGHT_FAILED'}
    try:
        switch(parser.parse_args(), progress)
    except Exception as error:
        print('CPM_SWITCH_ERROR:' + json.dumps(progress), flush=True)
        print('未确认切换成功：' + str(error) + '\n如已开始同步，请保留上方备份，勿用旧副本覆盖新消息。', file=sys.stderr)
        sys.exit(1)
