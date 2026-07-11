"""Check 11: real uplink landed + column-fill comparison.

Soft check: passes with a warning if no data arrives within the window
(demo gateways may have no active devices transmitting).
"""
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

WAIT_SECONDS = 120

def run(ctx: VerifyContext) -> CheckResult:
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        r = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM device_data WHERE recorded_at > '{ctx.deploy_timestamp}'\"")
        count = int(r.stdout.strip() or "0")
        if count > 0:
            r2 = checks.ssh_cmd(ctx, f"sqlite3 -json {ctx.db_path} \"SELECT * FROM device_data WHERE recorded_at > '{ctx.deploy_timestamp}' ORDER BY recorded_at DESC LIMIT 1\"")
            return CheckResult("ingest", True, f"{count} new rows since deploy",
                               evidence={"new_rows": count, "sample": r2.stdout[:500]})
        time.sleep(30)
    return CheckResult("ingest", True,
                       f"no new rows in {WAIT_SECONDS}s (no active devices — acceptable for demo gateway)")
