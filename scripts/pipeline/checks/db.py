"""Check 14: DB integrity, FK check, row counts.

Every sqlite invocation is checked for transport/SQL failure: an
integrity_check that never ran must FAIL loudly, not be compared against
"ok" as an empty string (which happened to fail, but with a blank, useless
detail and no stderr).
"""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    integ, err = checks.remote_sql(ctx, "PRAGMA integrity_check")
    if err:
        return CheckResult("db", False, err)
    if integ != "ok":
        return CheckResult("db", False, f"integrity_check: {integ[:300]}")
    fk, err = checks.remote_sql(ctx, "PRAGMA foreign_key_check")
    if err:
        return CheckResult("db", False, err)
    fk_warning = f" (pre-existing FK violations: {fk[:200]})" if fk else ""
    out, err = checks.remote_sql(ctx, "SELECT COUNT(*) FROM device_data")
    if err:
        return CheckResult("db", False, err)
    rows, err = checks.parse_count(out, "device_data row count")
    if err:
        return CheckResult("db", False, err)
    pre_raw = (ctx.pre_deploy_baselines or {}).get("device_data_rows", 0)
    pre, err = checks.parse_count(str(pre_raw), "pre-deploy device_data baseline")
    if err:
        return CheckResult("db", False, err)
    if rows < pre:
        return CheckResult("db", False, f"device_data rows decreased: {pre} -> {rows}")
    return CheckResult("db", True, f"integrity ok, device_data={rows} (was {pre}){fk_warning}")
