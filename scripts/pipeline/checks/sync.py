"""Check 12: outbox drain + cloud-side receipt.

A failed outbox query (missing table, ssh failure) is a hard FAIL — the old
`int(stdout or "0")` pattern would have read a broken sync_outbox as three
stable zeros and passed.
"""
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

RAPID_GROWTH_THRESHOLD = 20

def run(ctx: VerifyContext) -> CheckResult:
    counts = []
    for i in range(3):
        out, err = checks.remote_sql(
            ctx, "SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL")
        if err:
            return CheckResult("sync", False, err)
        count, err = checks.parse_count(out, "sync_outbox pending count")
        if err:
            return CheckResult("sync", False, err)
        counts.append(count)
        if i < 2:
            time.sleep(30)
    delta = counts[-1] - counts[0]
    if delta > RAPID_GROWTH_THRESHOLD:
        return CheckResult("sync", False, f"outbox growing rapidly (+{delta}): {counts}")
    if delta > 0:
        return CheckResult("sync", True, f"outbox slow growth (+{delta}, normal for demo gateway): {counts}")
    return CheckResult("sync", True, f"outbox stable/draining: {counts}")
