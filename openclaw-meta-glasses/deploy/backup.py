#!/usr/bin/env python3
"""Snapshot the relay's live SQLite database and matching private configuration."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tarfile
import tempfile
import time
from datetime import datetime, timezone


def backup(relay, destination, retention_days=14):
    os.umask(0o077)
    relay, destination = Path(relay).resolve(), Path(destination).resolve()
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    destination.chmod(0o700)
    with (destination / '.backup.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        required = [relay / '.env', relay / 'config.local.json', relay / 'data/glasses.sqlite']
        for source in required:
            if not source.is_file() or source.is_symlink():
                raise RuntimeError(f'Missing or unsupported backup source: {source.name}')
        configuration = {source.name: source.read_bytes() for source in required[:2]}
        with tempfile.TemporaryDirectory(prefix='.snapshot-', dir=destination) as staging:
            snapshot = Path(staging)
            for name, content in configuration.items():
                (snapshot / name).write_bytes(content)
            (snapshot / 'data').mkdir()
            source = sqlite3.connect(required[2].as_uri() + '?mode=ro', uri=True, timeout=30)
            target = sqlite3.connect(snapshot / 'data/glasses.sqlite')
            try:
                source.backup(target)
                if target.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                    raise RuntimeError('Backup database failed its integrity check')
            finally:
                target.close()
                source.close()
            for folder in ['secrets', 'data']:
                directory = relay / folder
                if not directory.exists():
                    continue
                if directory.is_symlink():
                    raise RuntimeError(f'Unsupported symlink: {folder}')
                for item in directory.rglob('*'):
                    if item.is_symlink():
                        raise RuntimeError('Backup source contains a symlink')
                    relative = item.relative_to(relay)
                    if folder == 'data' and item.name in ['glasses.sqlite', 'glasses.sqlite-wal', 'glasses.sqlite-shm']:
                        continue
                    if item.is_file():
                        copied = snapshot / relative
                        copied.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(item, copied)
            if any((relay / name).read_bytes() != content for name, content in configuration.items()):
                raise RuntimeError('Configuration changed during backup; rerun')
            manifest = {str(p.relative_to(snapshot)): hashlib.sha256(p.read_bytes()).hexdigest()
                        for p in snapshot.rglob('*') if p.is_file()}
            timestamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            (snapshot / 'manifest.json').write_text(json.dumps({
                'createdAt': timestamp, 'sha256': manifest, 'sqliteIntegrity': 'ok'
            }, indent=2) + '\n')
            archive = destination / f'glasses-{timestamp}.tar.gz'
            pending = archive.with_suffix('.partial')
            try:
                with tarfile.open(pending, 'w:gz') as output:
                    for item in sorted(snapshot.iterdir()):
                        output.add(item, arcname=item.name)
                # Read back every archived file and verify its checksum before rotation.
                with tarfile.open(pending, 'r:gz') as check:
                    for name, checksum in manifest.items():
                        if hashlib.sha256(check.extractfile(name).read()).hexdigest() != checksum:
                            raise RuntimeError('Archive checksum verification failed')
                with pending.open('rb') as handle:
                    os.fsync(handle.fileno())
                pending.replace(archive)
            finally:
                pending.unlink(missing_ok=True)
        cutoff = time.time() - retention_days * 86400
        for previous in destination.glob('glasses-*.tar.gz'):
            if re.fullmatch(r'glasses-\d{8}T\d{12}Z\.tar\.gz', previous.name) and previous != archive and previous.stat().st_mtime < cutoff:
                previous.unlink()
        print(f'Verified relay backup: {archive.name} ({archive.stat().st_size} bytes)')
        return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--relay', type=Path, default=Path('/home/openclaw/managed-openclaw/openclaw-meta-glasses'))
    parser.add_argument('--destination', type=Path, default=Path('/home/openclaw/openclaw-backups/meta-glasses'))
    args = parser.parse_args()
    backup(args.relay, args.destination)
