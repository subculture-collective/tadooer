import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("observer", Path(__file__).with_name("observe-soak.py"))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class ObserveSoakTest(unittest.TestCase):
    def scenario(self, *, wrong_revision=False, old_backup=False, corrupt_backup=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            now = datetime.datetime.now(datetime.timezone.utc)
            started = now - datetime.timedelta(minutes=2)
            created = now - datetime.timedelta(minutes=3 if old_backup else 1)
            backup = root / "data/tadooer/backups" / created.strftime("%Y%m%dT%H%M%SZ")
            backup.mkdir(parents=True)
            db = sqlite3.connect(backup / "suite.sqlite")
            db.execute("create table marker (id integer)")
            db.commit()
            db.close()
            (backup / "credential.key").write_text("synthetic-only")
            (backup / "SHA256SUMS").write_text("\n".join(
                hashlib.sha256((backup / name).read_bytes()).hexdigest() + "  ./" + name
                for name in ["suite.sqlite", "credential.key"]))
            if corrupt_backup:
                (backup / "credential.key").write_text("changed")
            report = root / "report.md"
            report.write_text("status: success\ncreated: " + now.isoformat() + "\n")
            ledger = root / "ledger.json"
            digest = "sha256:" + "a" * 64
            ledger.write_text(json.dumps({"candidate": {"version": "0.14.1-calendar", "revision": "a6983dc", "imageDigest": digest}, "startedAt": started.isoformat(), "observations": []}))

            def path(value):
                if str(value) == "/srv/apps/productivity":
                    return root
                if str(value) == "/home/onnwee/.nuc/50-reports/router-restic-backup.md":
                    return report
                return Path(value)

            def run(*args):
                if args[0] == "docker":
                    return json.dumps([{"Config": {"Image": "test@" + digest}, "State": {"Health": {"Status": "healthy"}}, "RestartCount": 0}])
                if args[-1].endswith("/build"):
                    return json.dumps({"revision": "bad" if wrong_revision else "a6983dc", "version": "0.14.1-calendar"})
                return json.dumps({"status": "ok", "migrationCount": 19})

            with patch.object(observer, "Path", side_effect=path), patch.object(observer, "run", side_effect=run), patch.object(observer.subprocess, "run") as record:
                if wrong_revision or corrupt_backup:
                    with self.assertRaises(SystemExit):
                        observer.observe(ledger)
                else:
                    observer.observe(ledger)
                return [(call.args[0][4], call.args[0][5]) for call in record.call_args_list]

    def test_valid_current_window_checks(self):
        self.assertEqual(self.scenario(), [("daily_health", "pass"), ("daily_backup", "pass")])

    def test_revision_drift_records_failure(self):
        self.assertIn(("daily_health", "fail"), self.scenario(wrong_revision=True))

    def test_pre_window_backup_is_not_credited(self):
        self.assertEqual(self.scenario(old_backup=True), [("daily_health", "pass")])

    def test_corrupt_backup_records_failure(self):
        self.assertIn(("daily_backup", "fail"), self.scenario(corrupt_backup=True))


if __name__ == "__main__":
    unittest.main()
