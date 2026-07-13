"""Check 15: no crashes/restarts and live health sampling over a 5-minute window.

The original implementation read `SELECT value FROM gateway_health WHERE
key='errors_total'` — that key-value table has never existed on shipped
images (issue #12). Only gateway_health_samples / gateway_health_hourly exist
(schema: database/migrations/ordered/0002__gateway_health.sql) and neither
carries an error counter. The live errors_total counter is a Node-RED
in-memory context global (fed into the cloud heartbeat), and Node-RED context
is memory-only on these images — it is not SSH-readable. sqlite3 errored to
stderr, the check read the empty stdout as 0, and a 300 s soak measured
nothing.

This check therefore watches the two real, on-disk error signals the gateway
exposes over SSH:

1. /data/node-red-crash-count — JSON {count, lastCrashAt, startedAt} written
   by osi-health-helper registerStartup() on every Node-RED start
   (crash-loop-register-fn fires once at startup). A count increase or a
   startedAt change during the window means Node-RED crashed or restarted
   mid-soak — the soak gate's "zero Node-RED restarts" criterion.
2. gateway_health_samples cadence — gateway-health-sample-tick inserts one
   row per 60 s. Fewer than MIN_NEW_SAMPLES new rows over the window means
   the runtime (or its DB writes) is impaired.

A missing file, missing table, or any ssh/sqlite error is a hard FAIL with
the stderr in detail — never a silent zero.
"""
import json
import time
import pipeline.checks as checks
from . import CheckResult, VerifyContext

WAIT_SECONDS = 300
CRASH_FILE = "/data/node-red-crash-count"
# 60 s cadence over a 300 s window is 4-5 inserts; require 2 to tolerate
# boundary jitter while still failing on a stalled sampler.
MIN_NEW_SAMPLES = 2


def _crash_state(ctx: VerifyContext):
    """Returns ((count, started_at), None) or (None, error_detail)."""
    r, err = checks.remote(ctx, f"cat {CRASH_FILE}")
    if err:
        return None, f"crash-count file {CRASH_FILE} unreadable: {err}"
    try:
        state = json.loads(r.stdout.strip())
        count = int(state["count"])
    except (ValueError, TypeError, KeyError) as e:
        return None, f"crash-count file unparseable ({e}): {r.stdout.strip()[:120]!r}"
    return (count, state.get("startedAt")), None


def _pi_utc_now(ctx: VerifyContext):
    """Window-start timestamp from the Pi's own clock (avoids runner skew)."""
    r, err = checks.remote(ctx, "date -u +%Y-%m-%dT%H:%M:%SZ")
    if err:
        return None, f"could not read gateway clock: {err}"
    stamp = r.stdout.strip()
    if len(stamp) != 20 or not stamp.endswith("Z"):
        return None, f"gateway clock returned unexpected output: {stamp[:80]!r}"
    return stamp, None


def run(ctx: VerifyContext) -> CheckResult:
    start_crash, err = _crash_state(ctx)
    if err:
        return CheckResult("errors", False, err)
    window_start, err = _pi_utc_now(ctx)
    if err:
        return CheckResult("errors", False, err)

    time.sleep(WAIT_SECONDS)

    end_crash, err = _crash_state(ctx)
    if err:
        return CheckResult("errors", False, err)
    if end_crash != start_crash:
        return CheckResult(
            "errors", False,
            f"Node-RED crashed/restarted during window: crash state "
            f"{start_crash} -> {end_crash}")

    out, err = checks.remote_sql(
        ctx,
        "SELECT COUNT(*) FROM gateway_health_samples "
        f"WHERE sampled_at > '{window_start}'")
    if err:
        return CheckResult("errors", False, err)
    new_samples, err = checks.parse_count(out, "gateway_health_samples window count")
    if err:
        return CheckResult("errors", False, err)
    if new_samples < MIN_NEW_SAMPLES:
        return CheckResult(
            "errors", False,
            f"health sampler impaired: {new_samples} new gateway_health_samples "
            f"rows in {WAIT_SECONDS}s (expected >= {MIN_NEW_SAMPLES})")

    return CheckResult(
        "errors", True,
        f"no restarts (crash state {start_crash}), {new_samples} health "
        f"samples in {WAIT_SECONDS}s")
