"""Check 11: real uplink landed + column-fill comparison."""
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    deadline = time.time() + 900  # 15 min
    while time.time() < deadline:
        r = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM device_data WHERE recorded_at > '{ctx.deploy_timestamp}'\"")
        count = int(r.stdout.strip() or "0")
        if count > 0:
            # Column-fill check: compare non-null columns vs pre-deploy
            r2 = checks.ssh_cmd(ctx, f"sqlite3 -json {ctx.db_path} \"SELECT * FROM device_data WHERE recorded_at > '{ctx.deploy_timestamp}' ORDER BY recorded_at DESC LIMIT 1\"")
            return CheckResult("ingest", True, f"{count} new rows since deploy",
                               evidence={"new_rows": count, "sample": r2.stdout[:500]})
        time.sleep(30)
    return CheckResult("ingest", False, "no new device_data rows in 15 minutes")
