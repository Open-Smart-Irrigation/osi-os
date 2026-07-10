"""Check 16: deploy-canary-gate.js wrapper."""
import subprocess
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.canary_gate_available:
        return CheckResult("canary", True, "canary gate not yet deployed (pre-B0)")
    cmd = ["node", "scripts/deploy-canary-gate.js",
           "--gateway-eui", "0016C001F11766E7",  # kaba100 EUI
           "--since", ctx.deploy_timestamp,
           "--timeout", "900"]
    if ctx.expected_schema_sig:
        cmd += ["--expect-schema-sig", ctx.expected_schema_sig]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=960)
        if r.returncode == 0:
            return CheckResult("canary", True, "canary gate PASS")
        return CheckResult("canary", False, f"canary gate FAIL (rc={r.returncode}): {r.stderr[:300]}")
    except subprocess.TimeoutExpired:
        return CheckResult("canary", False, "canary gate timed out")
