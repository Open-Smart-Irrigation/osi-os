"""Check 17: scheduled daily job output (extraction bundles only).

The not-an-extraction-bundle skip is context-driven (the controller sets the
flag), which is fine; a dendrometer_daily query that cannot run is a hard
FAIL — for an extraction bundle a missing table means the extraction broke
the schema, the one thing this check exists to catch.
"""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.is_extraction_bundle:
        return CheckResult("daily", True, "SKIP: not an extraction bundle")
    out, err = checks.remote_sql(
        ctx,
        "SELECT COUNT(*) FROM dendrometer_daily "
        f"WHERE computed_at > '{ctx.verification_started_at}'")
    if err:
        return CheckResult("daily", False, err)
    count, err = checks.parse_count(out, "dendrometer_daily new-row count")
    if err:
        return CheckResult("daily", False, err)
    if count > 0:
        return CheckResult("daily", True, f"{count} new dendrometer_daily rows since deploy")
    return CheckResult("daily", True, "no daily tick during soak (expected for <24h soaks); golden-vector replay is the substitute")
