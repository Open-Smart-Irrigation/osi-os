"""Verification check framework. Each check returns a CheckResult."""
from __future__ import annotations
from dataclasses import dataclass
import subprocess
import time


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str
    evidence: dict | None = None

    def __str__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.name}: {self.detail}"


@dataclass
class VerifyContext:
    """Passed to every check — the shared state for this verification run."""
    gateway_host: str
    ssh_user: str
    ssh_key: str
    db_path: str
    gui_url: str
    deploy_timestamp: str
    expected_schema_sig: str | None = None
    pre_deploy_baselines: dict | None = None
    canary_gate_available: bool = False
    is_extraction_bundle: bool = False


def ssh_cmd(ctx: VerifyContext, cmd: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-i", ctx.ssh_key, "-o", "IdentitiesOnly=yes",
         "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
         f"{ctx.ssh_user}@{ctx.gateway_host}", cmd],
        capture_output=True, text=True, timeout=timeout
    )


def http_get(url: str, timeout: int = 10) -> tuple[int, str]:
    """Simple HTTP GET. Returns (status_code, body). -1 on connection error."""
    import urllib.request, urllib.error
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except Exception as e:
        return -1, str(e)


def run_all_checks(ctx: VerifyContext) -> list[CheckResult]:
    from .boot import run as check_boot
    from .routes import run as check_routes
    from .schema import run as check_schema
    from .ingest import run as check_ingest
    from .sync import run as check_sync
    from .gui import run as check_gui
    from .db import run as check_db
    from .errors import run as check_errors
    from .canary import run as check_canary
    from .daily import run as check_daily

    checks = [
        check_boot, check_routes, check_schema, check_ingest,
        check_sync, check_gui, check_db, check_errors,
        check_canary, check_daily,
    ]
    results = []
    for check in checks:
        try:
            result = check(ctx)
        except Exception as e:
            result = CheckResult(check.__module__.split(".")[-1], False, f"check crashed: {e}")
        results.append(result)
        print(result)
        if not result.passed:
            print(f"  ^^^ FAIL — remaining checks skipped")
            break
    return results
