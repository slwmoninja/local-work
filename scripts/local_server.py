#!/usr/bin/env python3
"""Static file server for LocalWork, plus a same-origin /api/refresh endpoint
that the app's "Refresh job data" button calls to run scripts/refresh-jobs.ps1
in the background. GitHub Pages (or any plain static host) has no equivalent
-- there, app.js's fetch to /api/refresh simply fails, and it falls back to
just pulling whatever snapshot is already published. No separate code path is
needed here for that case.

Usage: python scripts/local_server.py [port]  (invoked by scripts/serve.ps1)
"""
import json
import subprocess
import sys
import threading
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATUS_FILE = ROOT / "data" / "refresh-status.json"
LOG_FILE = ROOT / "data" / "refresh-log.txt"
REFRESH_SCRIPT = ROOT / "scripts" / "refresh-jobs.ps1"

_lock = threading.Lock()
_running = False


def _write_status(status, **extra):
    payload = {"status": status, "updatedAt": datetime.now(timezone.utc).isoformat()}
    payload.update(extra)
    STATUS_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _run_refresh():
    global _running
    started = datetime.now(timezone.utc).isoformat()
    _write_status("running", startedAt=started)
    try:
        with LOG_FILE.open("w", encoding="utf-8") as log:
            proc = subprocess.run(
                ["powershell", "-File", str(REFRESH_SCRIPT)],
                cwd=str(ROOT), stdout=log, stderr=subprocess.STDOUT,
            )
        finished = datetime.now(timezone.utc).isoformat()
        if proc.returncode == 0:
            _write_status("done", startedAt=started, finishedAt=finished)
        else:
            _write_status(
                "error", startedAt=started, finishedAt=finished,
                error=f"refresh-jobs.ps1 exited with code {proc.returncode} — see data/refresh-log.txt",
            )
    except Exception as e:
        _write_status("error", startedAt=started, finishedAt=datetime.now(timezone.utc).isoformat(), error=str(e))
    finally:
        with _lock:
            _running = False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/refresh":
            self._json(404, {"error": "not found"})
            return
        global _running
        with _lock:
            if _running:
                self._json(409, {"error": "a refresh is already running"})
                return
            _running = True
        threading.Thread(target=_run_refresh, daemon=True).start()
        self._json(202, {"status": "started"})

    def do_GET(self):
        if self.path == "/api/refresh/status":
            if STATUS_FILE.exists():
                self._json(200, json.loads(STATUS_FILE.read_text(encoding="utf-8")))
            else:
                self._json(200, {"status": "idle"})
            return
        super().do_GET()

    def log_message(self, fmt, *args):
        pass  # data/refresh-log.txt has the real refresh output; keep the terminal quiet


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8791
    # A status file left "running" from a killed/crashed previous server means
    # no thread is actually watching that process anymore -- surface it as an
    # error instead of leaving the app polling forever against a stale file.
    if STATUS_FILE.exists():
        try:
            existing = json.loads(STATUS_FILE.read_text(encoding="utf-8"))
            if existing.get("status") == "running":
                _write_status("error", error="Interrupted by a server restart -- try refreshing again.")
        except Exception:
            pass
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving LocalWork at http://localhost:{port}/index.html  (Ctrl+C to stop)")
    print("POST /api/refresh triggers a background refresh-jobs.ps1 run for the app's Refresh button.")
    server.serve_forever()
