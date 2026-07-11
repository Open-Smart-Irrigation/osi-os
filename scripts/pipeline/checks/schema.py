"""Check 10: schema_sig matches target."""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.expected_schema_sig:
        return CheckResult("schema", True, "no expected schema_sig (non-schema bundle)")
    r = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT value FROM gateway_health WHERE key='schema_sig' ORDER BY recorded_at DESC LIMIT 1\"")
    sig = r.stdout.strip()
    if sig == ctx.expected_schema_sig:
        return CheckResult("schema", True, f"schema_sig={sig}")
    return CheckResult("schema", False, f"expected {ctx.expected_schema_sig}, got {sig}")
