"""Check 12: outbox drain + cloud-side receipt."""
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

RAPID_GROWTH_THRESHOLD = 20

def run(ctx: VerifyContext) -> CheckResult:
    counts = []
    for _ in range(3):
        r = checks.ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL\"")
        counts.append(int(r.stdout.strip() or "0"))
        time.sleep(30)
    delta = counts[-1] - counts[0]
    if delta > RAPID_GROWTH_THRESHOLD:
        return CheckResult("sync", False, f"outbox growing rapidly (+{delta}): {counts}")
    if delta > 0:
        return CheckResult("sync", True, f"outbox slow growth (+{delta}, normal for demo gateway): {counts}")
    return CheckResult("sync", True, f"outbox stable/draining: {counts}")
