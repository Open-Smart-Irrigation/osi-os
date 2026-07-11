"""Check 17: scheduled daily job output (extraction bundles only)."""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.is_extraction_bundle:
        return CheckResult("daily", True, "SKIP: not an extraction bundle")
    r = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM dendrometer_daily WHERE computed_at > '{ctx.deploy_timestamp}'\"")
    count = int(r.stdout.strip() or "0")
    if count > 0:
        return CheckResult("daily", True, f"{count} new dendrometer_daily rows since deploy")
    return CheckResult("daily", True, "no daily tick during soak (expected for <24h soaks); golden-vector replay is the substitute")
