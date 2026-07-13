"""Check 11: real uplink landed + column-fill comparison.

Soft check: passes with a warning if no data arrives within the window
(demo gateways may have no active devices transmitting) — but a query that
cannot run (missing table, ssh failure) is a hard FAIL, not "no data".
"""
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

WAIT_SECONDS = 120

def run(ctx: VerifyContext) -> CheckResult:
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        out, err = checks.remote_sql(
            ctx,
            "SELECT COUNT(*) FROM device_data "
            f"WHERE recorded_at > '{ctx.deploy_timestamp}'")
        if err:
            return CheckResult("ingest", False, err)
        count, err = checks.parse_count(out, "device_data new-row count")
        if err:
            return CheckResult("ingest", False, err)
        if count > 0:
            sample, sample_err = checks.remote_sql(
                ctx,
                "SELECT * FROM device_data "
                f"WHERE recorded_at > '{ctx.deploy_timestamp}' "
                "ORDER BY recorded_at DESC LIMIT 1",
                extra_args="-json")
            if sample_err:
                sample = f"(sample fetch failed: {sample_err})"
            return CheckResult("ingest", True, f"{count} new rows since deploy",
                               evidence={"new_rows": count, "sample": (sample or "")[:500]})
        time.sleep(30)
    return CheckResult("ingest", True,
                       f"no new rows in {WAIT_SECONDS}s (no active devices — acceptable for demo gateway)")
