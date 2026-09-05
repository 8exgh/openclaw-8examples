import contextlib
import io
import os
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
from backup import backup


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.relay = self.root / 'relay'
        (self.relay / 'data').mkdir(parents=True)
        (self.relay / 'secrets').mkdir()
        (self.relay / '.env').write_text('SESSION_ENCRYPTION_KEY=test-only\n')
        (self.relay / 'config.local.json').write_text('{"openclaw1":"test-only"}')
        (self.relay / 'secrets/AuthKey.p8').write_text('fake-key-for-backup-test')
        self.database = sqlite3.connect(self.relay / 'data/glasses.sqlite')
        self.addCleanup(self.database.close)
        self.database.execute('PRAGMA journal_mode=WAL')
        self.database.execute('CREATE TABLE events (summary TEXT)')
        self.database.execute('INSERT INTO events VALUES (?)', ('committed WAL entry',))
        self.database.commit()
        self.destination = self.root / 'backups'

    def snapshot(self):
        with contextlib.redirect_stdout(io.StringIO()):
            return backup(self.relay, self.destination)

    def test_live_wal_restores_with_configuration_keys_and_private_permissions(self):
        self.assertGreater((self.relay / 'data/glasses.sqlite-wal').stat().st_size, 0)
        archive = self.snapshot()
        with tarfile.open(archive) as check:
            for name in ['.env', 'config.local.json', 'secrets/AuthKey.p8']:
                self.assertEqual(check.extractfile(name).read(), (self.relay / name).read_bytes())
            restored = self.root / 'restored.sqlite'
            restored.write_bytes(check.extractfile('data/glasses.sqlite').read())
            with sqlite3.connect(restored) as database:
                self.assertEqual(database.execute('SELECT summary FROM events').fetchone(), ('committed WAL entry',))
            self.assertFalse(any(p.endswith(('-wal', '-shm')) for p in check.getnames()))
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.destination.stat().st_mode & 0o777, 0o700)

    def test_retention_only_removes_own_expired_archives_after_success(self):
        self.destination.mkdir()
        old = self.destination / 'glasses-20000101T000000000000Z.tar.gz'
        old.write_text('expired')
        os.utime(old, (0, 0))
        unrelated = self.destination / 'unrelated.tar.gz'
        unrelated.write_text('preserve')
        saved = self.snapshot()
        self.assertFalse(old.exists())
        self.assertTrue(unrelated.exists())
        (self.relay / '.env').unlink()
        with self.assertRaises(RuntimeError):
            self.snapshot()
        self.assertTrue(saved.exists())
