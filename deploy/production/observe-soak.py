#!/usr/bin/env python3
"""Collect current release health and backup evidence; never infer user journeys."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys


def utc(value):
    return datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))


def run(*args):
    return subprocess.check_output(args, text=True, timeout=30).strip()


def observe(ledger_path):
    os.umask(0o077)
    ledger_path = Path(ledger_path).resolve(strict=True)
    with Path(str(ledger_path) + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ledger = json.loads(ledger_path.read_text())
        started = utc(ledger["startedAt"])
        now = datetime.datetime.now(datetime.timezone.utc)
        if now < started:
            raise RuntimeError("Soak has not started")
        day = (now - started).days
        window = started + datetime.timedelta(days=day)
        root = Path("/srv/apps/productivity")
        evidence_dir = ledger_path.parent / (ledger_path.stem + "-evidence")
        evidence_dir.mkdir(mode=0o700, exist_ok=True)
        evidence = {"at": now.isoformat(), "day": day + 1, "candidate": ledger["candidate"]}
        observations = []

        def record(kind, status, note):
            # Preserve failures. A later healthy check never erases a failed observation.
            if not any(o["kind"] == kind and o["status"] == status and utc(o["at"]) >= window
                       for o in ledger["observations"]):
                observations.append({"kind": kind, "status": status, "at": now.isoformat(), "note": note})

        try:
            build = json.loads(run("curl", "-fsS", "--max-time", "15", "https://tadooer.subcult.tv/api/build"))
            ready = json.loads(run("curl", "-fsS", "--max-time", "15", "https://tadooer.subcult.tv/api/ready"))
            container = json.loads(run("docker", "inspect", "tadooer-suite-1"))[0]
            expected = ledger["candidate"]
            if build["revision"] != expected["revision"] or build["version"] != expected["version"]:
                raise RuntimeError("Public candidate changed")
            if not container["Config"]["Image"].endswith("@" + expected["imageDigest"]):
                raise RuntimeError("Runtime digest changed")
            if ready["status"] != "ok" or ready["migrationCount"] != 19:
                raise RuntimeError("Readiness or migrations failed")
            if container["State"]["Health"]["Status"] != "healthy" or container["RestartCount"] != 0:
                raise RuntimeError("Container unhealthy or unexpected restart")
            evidence["health"] = {"build": build, "ready": ready, "container": "healthy", "unexpectedRestarts": 0}
            record("daily_health", "pass", "Public build/readiness, pinned image, migration 19 and container health verified; evidence " + evidence_dir.name)
        except Exception as error:
            evidence["healthError"] = str(error)
            record("daily_health", "fail", "Release health check failed; inspect " + evidence_dir.name)

        try:
            backup_running = run("systemctl", "show", "nuc-router-restic-backup.service", "--property=ActiveState", "--value") in {"active", "activating"}
            if backup_running:
                evidence["backupPending"] = "Scheduled backup is still running; partial files are not inspected"
            else:
                backups = sorted(p for p in (root / "data/tadooer/backups").iterdir() if p.is_dir())
                backup = backups[-1]
                created = datetime.datetime.strptime(backup.name, "%Y%m%dT%H%M%SZ").replace(tzinfo=datetime.timezone.utc)
                if (now - created).total_seconds() > 36 * 3600:
                    raise RuntimeError("Last backup is older than 36 hours")
                if created >= window:
                    hashes = {}
                    for line in (backup / "SHA256SUMS").read_text().splitlines():
                        digest, name = line.split(maxsplit=1)
                        file = (backup / name.strip().removeprefix("*")).resolve()
                        if file.parent != backup.resolve():
                            raise RuntimeError("Invalid backup manifest path")
                        if hashlib.sha256(file.read_bytes()).hexdigest() != digest:
                            raise RuntimeError("Backup checksum mismatch")
                        hashes[file.name] = digest
                    if not {"suite.sqlite", "credential.key"} <= hashes.keys():
                        raise RuntimeError("Backup lacks paired database/key")
                    db = sqlite3.connect(f"file:{backup}/suite.sqlite?mode=ro", uri=True)
                    try:
                        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok" or db.execute("PRAGMA foreign_key_check").fetchall():
                            raise RuntimeError("Backup database check failed")
                    finally:
                        db.close()
                    report = Path("/home/onnwee/.nuc/50-reports/router-restic-backup.md").read_text()
                    report_fields = dict(line.split(": ", 1) for line in report.splitlines() if ": " in line)
                    if report_fields.get("status") != "success" or utc(report_fields["created"]) < created:
                        evidence["backupPending"] = "Waiting for successful encrypted Restic backup report for this backup"
                    else:
                        evidence["backup"] = {"path": str(backup), "sha256": hashes, "resticReportAt": report_fields["created"]}
                        record("daily_backup", "pass", "Current-window paired backup checksums and SQLite integrity verified; encrypted Restic backup/check report succeeded. Evidence " + evidence_dir.name)
                else:
                    evidence["backupPending"] = "No new backup in the current soak window yet"
        except Exception as error:
            evidence["backupError"] = str(error)
            record("daily_backup", "fail", "Backup verification failed; inspect " + evidence_dir.name)

        stamp = now.strftime("%Y%m%dT%H%M%S%fZ")
        evidence_path = evidence_dir / (stamp + ".json")
        with evidence_path.open("x") as output:
            json.dump(evidence, output, indent=2)
            output.write("\n")
        for observation in observations:
            subprocess.run(["node", str(Path(__file__).with_name("phase12-soak.mjs")), "record", str(ledger_path),
                            observation["kind"], observation["status"], observation["at"], observation["note"]], check=True, timeout=30)
        print(json.dumps({"evidence": str(evidence_path), "recorded": observations}))
        if "healthError" in evidence or "backupError" in evidence:
            raise SystemExit(1)


if __name__ == "__main__":
    observe(sys.argv[1])
