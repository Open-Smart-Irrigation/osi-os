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


# ssh to the gateways prints a benign OpenSSH "post-quantum ... store now"
# warning on every connection; strip it so real errors (sqlite, shell) are
# not drowned out and clean runs are not misread as noisy.
BENIGN_SSH_STDERR_MARKERS = ("post-quantum", "store now")


def filtered_stderr(text: str) -> str:
    lines = [
        line for line in (text or "").splitlines()
        if line.strip() and not any(m in line for m in BENIGN_SSH_STDERR_MARKERS)
    ]
    return "\n".join(lines).strip()


def remote(ctx: VerifyContext, cmd: str, timeout: int = 30):
    """Run a command on the gateway. Returns (CompletedProcess, None) on
    success or (None, error_detail) on any transport/command failure.

    Checks must treat error_detail as a hard FAIL: a command that could not
    run has measured nothing, and reporting PASS on it is how issue #12
    shipped a 300 s errors soak that observed an empty string.
    """
    try:
        r = ssh_cmd(ctx, cmd, timeout)
    except subprocess.TimeoutExpired:
        return None, f"remote command timed out after {timeout}s: {cmd[:120]}"
    except OSError as e:
        return None, f"ssh could not start: {e}"
    if r.returncode != 0:
        err = filtered_stderr(r.stderr) or r.stdout.strip() or "no output"
        return None, f"remote command failed (exit {r.returncode}): {err[:300]}"
    return r, None


def remote_sql(ctx: VerifyContext, sql: str, timeout: int = 30, extra_args: str = ""):
    """Run a sqlite3 query against the gateway DB. Returns (stdout, None) or
    (None, error_detail).

    sqlite3 reports missing tables and SQL errors on stderr with a nonzero
    exit while stdout stays empty — never interpret a failed query as an
    empty (zero) result.
    """
    args = f"{extra_args} " if extra_args else ""
    r, err = remote(ctx, f'sqlite3 {args}{ctx.db_path} "{sql}"', timeout)
    if err:
        return None, err
    stderr = filtered_stderr(r.stderr)
    if stderr:
        return None, f"sqlite reported errors despite exit 0: {stderr[:300]}"
    return r.stdout.strip(), None


def parse_count(value, what: str):
    """Parse an integer from sqlite output. Returns (int, None) or
    (None, error_detail). Empty output is an error, not zero: COUNT(*)
    always prints a number, so silence means the query never ran."""
    text = (value or "").strip()
    if not text:
        return None, f"{what}: query returned no output (expected an integer)"
    try:
        return int(text), None
    except ValueError:
        return None, f"{what}: expected integer, got {text[:80]!r}"


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
