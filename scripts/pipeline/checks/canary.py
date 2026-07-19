"""Check 16: deploy-canary-gate.js wrapper."""
import os
import subprocess
from pathlib import Path
from . import CheckResult, VerifyContext

REPO_ROOT = Path(__file__).parent.parent.parent.parent

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.canary_gate_available:
        # Context-driven skip: the controller says the gate is not deployed
        # yet, so there is nothing to run (unlike missing tooling below).
        return CheckResult("canary", True, "canary gate not yet deployed (pre-B0)")
    if not os.environ.get("OSI_ADMIN_TOKEN"):
        # The gate is supposed to run but cannot — that must not PASS.
        return CheckResult("canary", False,
                           "OSI_ADMIN_TOKEN not set on runner — the canary "
                           "gate cannot run; set the token or disable the "
                           "gate explicitly via canary_gate_available")
    cmd = ["node", str(REPO_ROOT / "scripts" / "deploy-canary-gate.js"),
           "--eui", "0016C001F11766E7",
           "--since", ctx.verification_started_at,
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
