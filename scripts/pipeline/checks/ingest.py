"""Check 11: ChirpStack-to-edge ingest correlation.

Two false-pass paths shipped in production (docs/operations/
kaba100-lsn50-writer-outage-2026-07-15.md): the controller compared a compact
backup stamp (`YYYYMMDDThhmmssZ`) lexically against ISO `device_data.recorded_at`
values, and this check returned `passed=True` after a wait window with zero
rows — "no active devices" is indistinguishable from "the writer is broken"
under that rule, and Kaba100 dendrometers only report ~every 20 minutes.

This check instead proves persistence, not mere activity: it reads the set of
DRAGINO_LSN50 DevEUIs registered on the edge, asks ChirpStack (the LoRaWAN
network server, not the edge) which of those DevEUIs have a fresh uplink
(`last_seen_at` after `ctx.verification_started_at`), and requires each fresh
DevEUI to have a `device_data.recorded_at` row on the SAME gateway within a
bounded clock-skew window of that specific uplink's timestamp. One healthy
LSN50 must never hide another fresh dendrometer whose uplink never reached
`device_data` — so every fresh EUI is re-checked on every poll, not just the
newest.

Before any PASS, the check also rejects known false-pass evidence: a
`writer_fallback` quarantine row recorded since verification start (proof the
old/degraded path delivered instead of the new writer), and an enabled
`osi-server.cloud.lsn50_writer_disable` kill switch (the writer is force-off,
so a fresh row proves nothing about the writer under test).

A query that cannot run (missing table, ssh/UCI failure, malformed output) is
always a hard FAIL — never interpreted as "no data" or "off".
"""
from __future__ import annotations
import re
import time
from datetime import datetime, timezone

import pipeline.checks as checks
from . import CheckResult, VerifyContext

CHIRPSTACK_DB_PATH = "/srv/chirpstack/chirpstack.sqlite"
POLL_INTERVAL_SECONDS = 15
_EUI_RE = re.compile(r"^[0-9A-F]{16}$")
_ALLOWED_KILL_SWITCH_VALUES = {"0", "false", "no", "off", ""}
_TIMESTAMP_FORMATS = ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S")


def _parse_utc(value: str):
    """Parse a ChirpStack/edge timestamp as a real UTC datetime. Returns
    (datetime, None) or (None, error_detail). Never compared lexically."""
    text = (value or "").strip()
    for fmt in _TIMESTAMP_FORMATS:
        try:
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc), None
        except ValueError:
            continue
    return None, f"unparseable timestamp {text[:60]!r}"


def _registered_euis(ctx: VerifyContext):
    """Returns (sorted uppercase DevEUI list, None) or (None, error_detail)."""
    out, err = checks.remote_sql(
        ctx,
        "SELECT upper(deveui) FROM devices WHERE type_id = 'DRAGINO_LSN50' "
        "ORDER BY deveui;")
    if err:
        return None, err
    euis = [line.strip() for line in (out or "").splitlines() if line.strip()]
    for e in euis:
        if not _EUI_RE.match(e):
            return None, f"malformed DevEUI in devices table: {e!r}"
    return euis, None


def _fresh_chirpstack(ctx: VerifyContext, registered: list[str]):
    """Query ChirpStack for the fresh subset of `registered` DevEUIs.
    Returns ({eui: (datetime, raw_str)}, None) or (None, error_detail)."""
    in_clause = ", ".join(f"'{e}'" for e in registered)
    out, err = checks.remote_sql(
        ctx,
        "SELECT upper(hex(dev_eui)) AS deveui, last_seen_at FROM device "
        f"WHERE upper(hex(dev_eui)) IN ({in_clause}) "
        f"AND datetime(last_seen_at) > datetime('{ctx.verification_started_at}') "
        "ORDER BY upper(hex(dev_eui));",
        extra_args='-separator "|"',
        db_path=CHIRPSTACK_DB_PATH,
    )
    if err:
        return None, err
    fresh: dict[str, tuple[datetime, str]] = {}
    for line in (out or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("|")
        if len(parts) != 2:
            return None, f"malformed ChirpStack row (expected 'DEVEUI|timestamp'): {line!r}"
        eui, ts_raw = parts[0].strip(), parts[1].strip()
        if not _EUI_RE.match(eui):
            return None, f"malformed ChirpStack DevEUI: {eui!r}"
        if eui not in registered:
            return None, (f"ChirpStack reports DevEUI {eui} with a fresh uplink "
                          "but it is not a registered DRAGINO_LSN50 device")
        if eui in fresh:
            return None, f"duplicate ChirpStack row for DevEUI {eui}"
        ts, ts_err = _parse_utc(ts_raw)
        if ts_err:
            return None, f"malformed ChirpStack last_seen_at for {eui}: {ts_raw!r}"
        fresh[eui] = (ts, ts_raw)
    return fresh, None


def _edge_max(ctx: VerifyContext, eui: str):
    """Returns (datetime | None, None) — None datetime means no post-boundary
    row — or (None, error_detail) on a malformed value."""
    out, err = checks.remote_sql(
        ctx,
        "SELECT MAX(recorded_at) FROM device_data "
        f"WHERE deveui = '{eui}' "
        f"AND datetime(recorded_at) > datetime('{ctx.verification_started_at}');")
    if err:
        return None, err
    val = (out or "").strip()
    if not val or val.upper() == "NULL":
        return None, None
    ts, ts_err = _parse_utc(val)
    if ts_err:
        return None, f"malformed edge recorded_at for {eui}: {val!r}"
    return ts, None


def _correlate(ctx: VerifyContext, fresh: dict):
    """Correlate every fresh ChirpStack EUI with its edge maximum. Returns
    ({eui: fact_dict} for unmatched EUIs only, None) or (None, error_detail)."""
    unmatched = {}
    for eui in sorted(fresh):
        cs_ts, cs_raw = fresh[eui]
        edge_ts, err = _edge_max(ctx, eui)
        if err:
            return None, err
        if edge_ts is None:
            unmatched[eui] = {
                "chirpstack_last_seen_at": cs_raw,
                "edge_recorded_at": None,
            }
            continue
        delta = (edge_ts - cs_ts).total_seconds()
        if delta < -ctx.ingest_max_clock_skew_seconds:
            reason = "predates selected ChirpStack uplink"
        elif delta > ctx.ingest_max_clock_skew_seconds:
            reason = "exceeds selected ChirpStack uplink"
        else:
            continue  # inside the closed skew interval: matched
        unmatched[eui] = {
            "chirpstack_last_seen_at": cs_raw,
            "edge_recorded_at": edge_ts.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "delta_seconds": delta,
            "reason": reason,
        }
    return unmatched, None


def _unmatched_detail(unmatched: dict) -> str:
    parts = []
    for eui in sorted(unmatched):
        info = unmatched[eui]
        if info.get("edge_recorded_at") is None:
            parts.append(
                f"{eui}: no edge device_data row correlated to ChirpStack uplink "
                f"(last_seen_at={info['chirpstack_last_seen_at']})")
        else:
            parts.append(
                f"{eui}: edge recorded_at={info['edge_recorded_at']} "
                f"{info['reason']} (chirpstack last_seen_at="
                f"{info['chirpstack_last_seen_at']}, delta={info['delta_seconds']:.0f}s)")
    return ("ChirpStack uplink(s) fresh but not correlated to an edge device_data "
            "row within the clock-skew window: " + "; ".join(parts))


def _fallback_used_error(ctx: VerifyContext):
    """Non-None (error string) if a writer_fallback quarantine row landed
    since verification start — proof the old/degraded delivery path ran."""
    out, err = checks.remote_sql(
        ctx,
        "SELECT COUNT(*) FROM ingest_quarantine WHERE reason = 'writer_fallback' "
        f"AND datetime(received_at) > datetime('{ctx.verification_started_at}');")
    if err:
        return f"could not check ingest_quarantine for writer_fallback: {err}"
    count, err = checks.parse_count(out, "ingest_quarantine writer_fallback count")
    if err:
        return err
    if count > 0:
        return (f"ingest_quarantine recorded {count} writer_fallback row(s) since "
                "verification start — the deploy would false-pass on fallback "
                "delivery instead of the writer under test")
    return None


def _kill_switch_error(ctx: VerifyContext):
    """Non-None (error string) unless osi-server.cloud.lsn50_writer_disable
    normalizes to an off/empty value. A command failure is a hard failure,
    never interpreted as an empty (off) setting."""
    r, err = checks.remote(ctx, "uci -q get osi-server.cloud.lsn50_writer_disable")
    if err:
        return f"could not read osi-server.cloud.lsn50_writer_disable: {err}"
    value = r.stdout.strip().lower()
    if value in _ALLOWED_KILL_SWITCH_VALUES:
        return None
    return (f"osi-server.cloud.lsn50_writer_disable={value!r} — the LSN50 writer "
            "is forced off, so a fresh row cannot prove the writer under test")


def _pre_pass_checks(ctx: VerifyContext):
    """Non-None (error string) if fallback/kill-switch evidence must block a
    PASS that the correlation loop would otherwise grant."""
    return _fallback_used_error(ctx) or _kill_switch_error(ctx)


def _finalize_pass(ctx: VerifyContext, detail: str, evidence: dict) -> CheckResult:
    err = _pre_pass_checks(ctx)
    if err:
        return CheckResult("ingest", False, err)
    return CheckResult("ingest", True, detail, evidence=evidence)


def run(ctx: VerifyContext) -> CheckResult:
    registered, err = _registered_euis(ctx)
    if err:
        return CheckResult("ingest", False, err)
    if not registered:
        if ctx.require_ingest:
            return CheckResult(
                "ingest", False,
                "no DRAGINO_LSN50 devices registered on this gateway — "
                "required ingest cannot be satisfied")
        return CheckResult(
            "ingest", True,
            "no DRAGINO_LSN50 devices registered (ingest not required for this gateway)")

    deadline = time.time() + ctx.ingest_wait_seconds
    quiet_since = None
    prev_state_key = None
    fresh: dict = {}
    unmatched: dict = {}

    while True:
        now = time.time()
        fresh, err = _fresh_chirpstack(ctx, registered)
        if err:
            return CheckResult("ingest", False, err)

        if not fresh:
            quiet_since = None
            prev_state_key = None
            unmatched = {}
            if not ctx.require_ingest:
                return _finalize_pass(
                    ctx,
                    "no ChirpStack uplink observed (acceptable — ingest not "
                    "required for this gateway)",
                    evidence={"deveui": None, "matched": []})
        else:
            unmatched, err = _correlate(ctx, fresh)
            if err:
                return CheckResult("ingest", False, err)
            state_key = tuple(sorted((eui, raw) for eui, (_, raw) in fresh.items()))
            if unmatched or state_key != prev_state_key:
                quiet_since = now
            prev_state_key = state_key

            if not unmatched and now - quiet_since >= ctx.ingest_quiet_seconds:
                matched = sorted(fresh.keys())
                return _finalize_pass(
                    ctx,
                    f"{len(matched)} DevEUI(s) correlated ChirpStack uplink -> edge "
                    f"device_data within {ctx.ingest_max_clock_skew_seconds}s skew, "
                    f"stable for {ctx.ingest_quiet_seconds}s",
                    evidence={"deveui": matched[0], "matched": matched})

        if now >= deadline:
            break
        time.sleep(max(1, min(POLL_INTERVAL_SECONDS,
                              ctx.ingest_quiet_seconds or POLL_INTERVAL_SECONDS,
                              deadline - now)))

    if not fresh:
        return CheckResult(
            "ingest", False,
            f"required ingest: no ChirpStack uplink observed within "
            f"{ctx.ingest_wait_seconds}s")
    return CheckResult("ingest", False, _unmatched_detail(unmatched))
