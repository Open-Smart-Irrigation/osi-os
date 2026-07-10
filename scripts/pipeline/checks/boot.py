"""Check 8: Node-RED alive, :1880/gui → 301."""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    status, body = checks.http_get(f"http://{ctx.gateway_host}:1880/gui")
    if status in (200, 301, 302):
        return CheckResult("boot", True, f":1880/gui returned {status}")
    return CheckResult("boot", False, f":1880/gui returned {status}: {body[:200]}")
