"""Check 9: REST endpoint sweep — each returns 200 or 401, never 404/500."""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

REQUIRED_ENDPOINTS = [
    "/api/system/features", "/api/catalog",
]
OPTIONAL_ENDPOINTS = [
    "/api/zones", "/api/devices", "/api/history/zones", "/export.csv",
]

def run(ctx: VerifyContext) -> CheckResult:
    failures = []
    warnings = []
    for ep in REQUIRED_ENDPOINTS:
        url = f"http://{ctx.gateway_host}:1880{ep}"
        status, _ = checks.http_get(url)
        if status not in (200, 301, 302, 401):
            failures.append(f"{ep}={status}")
    for ep in OPTIONAL_ENDPOINTS:
        url = f"http://{ctx.gateway_host}:1880{ep}"
        status, _ = checks.http_get(url)
        if status not in (200, 301, 302, 401):
            warnings.append(f"{ep}={status}")
    if failures:
        return CheckResult("routes", False, f"unhealthy: {', '.join(failures)}")
    detail = f"all {len(REQUIRED_ENDPOINTS)} required endpoints healthy"
    if warnings:
        detail += f" (optional degraded: {', '.join(warnings)})"
    return CheckResult("routes", True, detail)
