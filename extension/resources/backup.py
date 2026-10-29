"""Consistent session snapshot; credentials and config are intentionally excluded."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from datetime import datetime, timezone


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--home', required=True, type=Path)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--destination', required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    home = args.home.resolve()
    db = args.database.resolve()
    if not db.is_file():
        raise ValueError('State database missing')
    root = args.destination.resolve()
    if root.is_relative_to(home):
        raise ValueError('Backup destination must be outside Codex home')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    work = root / (stamp + '.partial')
    work.mkdir(mode=0o700)
    records = []
    ids = set()
    rollout_files = 0

    def digest(p):
        h = hashlib.sha256()
        with p.open('rb') as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b''):
                h.update(block)
        return h.hexdigest()

    def copy(p):
        if p.is_symlink() or not p.resolve().is_relative_to(home):
            raise ValueError('Session symlinks are not supported')
        target = work / p.relative_to(home)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        before = p.stat()
        shutil.copyfile(p, target)
        target.chmod(0o600)
        after = p.stat()
        if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns) or digest(p) != digest(target):
            raise ValueError('Session changed during snapshot')
        records.append({'path': str(p.relative_to(home)), 'sha256': digest(target)})
        return target

    for scope in ('sessions', 'archived_sessions'):
        base = home / scope
        if base.is_symlink():
            raise ValueError('Session root symlinks are not supported')
        if not base.exists():
            continue
        for p in sorted(base.rglob('*')):
            if p.is_symlink():
                raise ValueError('Session symlinks are not supported')
            if not p.is_file():
                continue
            target = copy(p)
            if p.suffix == '.jsonl':
                with target.open('r', encoding='utf-8') as stream:
                    header = json.loads(stream.readline())
                    if header.get('type') != 'session_meta':
                        raise ValueError('Unknown session format')
                    thread_id = header['payload']['id']
                    # Codex may retain more than one rollout file for a conversation.
                    # Preserve every file, including divergent copies; never merge or delete.
                    rollout_files += 1
                    ids.add(thread_id)
                    for line in stream:
                        if line.strip():
                            json.loads(line)
    if (home / 'session_index.jsonl').exists():
        copy(home / 'session_index.jsonl')
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as original:
        with sqlite3.connect(work / 'state.sqlite') as snapshot:
            original.backup(snapshot)
            if snapshot.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('Database integrity check failed')
            db_ids = {row[0] for row in snapshot.execute('SELECT id FROM threads')}
            if db_ids != ids:
                raise ValueError('Database and session ID sets differ')
    (work / 'state.sqlite').chmod(0o600)
    for entry in records:
        if digest(home / entry['path']) != entry['sha256']:
            raise ValueError('Source changed during database snapshot')
    records.append({'path': 'state.sqlite', 'sha256': digest(work / 'state.sqlite')})
    manifest = {'source': str(home), 'databaseSource': str(db), 'sessions': len(ids), 'rolloutFiles': rollout_files, 'duplicateSessionFiles': rollout_files - len(ids), 'createdUtc': stamp, 'files': records, 'credentialsCopied': False}
    (work / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    for entry in records:
        if digest(work / entry['path']) != entry['sha256']:
            raise ValueError('Snapshot verification failed')
    final = root / stamp
    work.rename(final)
    print(json.dumps({'backup': str(final), 'sessions': len(ids), 'verified': True}))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Do not emit database contents, credentials, or full session text.
        print('Backup incomplete: ' + str(exc), file=sys.stderr)
        sys.exit(1)
