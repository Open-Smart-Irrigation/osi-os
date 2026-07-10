"""Check 15: error_count delta <= 0 over 5-minute window."""
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def _get_error_count(ctx: VerifyContext) -> int:
    r = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT value FROM gateway_health WHERE key='errors_total' ORDER BY recorded_at DESC LIMIT 1\"")
    return int(r.stdout.strip() or "0")

def run(ctx: VerifyContext) -> CheckResult:
    start = _get_error_count(ctx)
    time.sleep(300)
    end = _get_error_count(ctx)
    delta = end - start
    if delta <= 0:
        return CheckResult("errors", True, f"error_count stable: {start} -> {end}")
    return CheckResult("errors", False, f"error_count rising: {start} -> {end} (+{delta})")
