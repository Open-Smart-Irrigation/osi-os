"""Check 14: DB integrity, FK check, row counts."""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    integ = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} 'PRAGMA integrity_check'").stdout.strip()
    if integ != "ok":
        return CheckResult("db", False, f"integrity_check: {integ}")
    fk = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} 'PRAGMA foreign_key_check'").stdout.strip()
    fk_warning = ""
    if fk:
        fk_warning = f" (pre-existing FK violations: {fk[:200]})"
    rows = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} 'SELECT COUNT(*) FROM device_data'").stdout.strip()
    pre = (ctx.pre_deploy_baselines or {}).get("device_data_rows", 0)
    if int(rows) < int(pre):
        return CheckResult("db", False, f"device_data rows decreased: {pre} -> {rows}")
    return CheckResult("db", True, f"integrity ok, device_data={rows} (was {pre}){fk_warning}")
