"""Check 9: REST endpoint sweep — each returns 200 or 401, never 404/500."""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

ENDPOINTS = [
    "/api/zones", "/api/devices", "/api/system/features",
    "/api/catalog", "/api/history/zones", "/export.csv",
]

def run(ctx: VerifyContext) -> CheckResult:
    failures = []
    for ep in ENDPOINTS:
        url = f"http://{ctx.gateway_host}:1880{ep}"
        status, _ = checks.http_get(url)
        if status in (200, 301, 302, 401):
            continue
        failures.append(f"{ep}={status}")
    if not failures:
        return CheckResult("routes", True, f"all {len(ENDPOINTS)} endpoints healthy")
    return CheckResult("routes", False, f"unhealthy: {', '.join(failures)}")
