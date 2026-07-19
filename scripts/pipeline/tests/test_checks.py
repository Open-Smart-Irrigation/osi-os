import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
from unittest.mock import patch

from pipeline.checks import VerifyContext, CheckResult
from pipeline.checks.boot import run as check_boot
from pipeline.checks.routes import run as check_routes, ROUTES
from pipeline.checks.db import run as check_db
from pipeline.checks.errors import run as check_errors
from pipeline.checks.schema import run as check_schema
from pipeline.checks.gui import run as check_gui
from pipeline.checks.sync import run as check_sync
from pipeline.checks.ingest import run as check_ingest
from pipeline.checks.daily import run as check_daily
from pipeline.checks.canary import run as check_canary

REPO_ROOT = Path(__file__).resolve().parents[3]
FLOWS_JSON = REPO_ROOT / "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json"

CRASH_JSON = '{"count":0,"lastCrashAt":1752300000000,"startedAt":1752300000000}'
NO_SUCH_TABLE = "Error: in prepare, no such table: gateway_health_samples"


def proc(stdout="", stderr="", returncode=0):
    """A real CompletedProcess so hardened checks see returncode/stderr."""
    return subprocess.CompletedProcess(args=["ssh"], returncode=returncode,
                                       stdout=stdout, stderr=stderr)


@pytest.fixture
def ctx():
    return VerifyContext(
        gateway_host="100.93.68.86", ssh_user="root",
        ssh_key="~/.ssh/id_ed25519", db_path="/data/db/farming.db",
        gui_url="http://100.93.68.86:1880/gui",
        verification_started_at="2026-07-10T18:00:00Z",
        pre_deploy_baselines={"device_data_rows": "1000"},
    )


# --- boot -------------------------------------------------------------------

@patch("pipeline.checks.http_get", return_value=(301, ""))
def test_boot_pass(mock_get, ctx):
    r = check_boot(ctx)
    assert r.passed

@patch("pipeline.checks.http_get", return_value=(-1, "connection refused"))
def test_boot_fail(mock_get, ctx):
    r = check_boot(ctx)
    assert not r.passed


# --- routes -----------------------------------------------------------------

def _routes_responder(overrides=None):
    """Healthy defaults per the grounded expectations; overrides map
    url-substring -> (status, body)."""
    defaults = {
        "/api/system/features": (200, "{}"),
        "/api/catalog": (200, "[]"),
        "/api/devices": (401, "unauthorized"),
        "/api/irrigation-zones": (500, "auth status in flux"),
        "/api/history/zones/1/export.csv": (401, "unauthorized"),
    }
    defaults.update(overrides or {})
    def responder(url, **kw):
        for fragment, resp in sorted(defaults.items(), key=lambda kv: -len(kv[0])):
            if url.endswith(fragment):
                return resp
        raise AssertionError(f"unexpected probe: {url}")
    return responder

def test_route_list_grounded_in_shipped_flows():
    """Every probed route must exist as a GET route in the shipped flows.json
    (issue #11: the old list probed endpoints that never existed)."""
    nodes = json.loads(FLOWS_JSON.read_text())
    patterns = []
    for n in nodes:
        if not (isinstance(n, dict) and n.get("type") == "http in"):
            continue
        if n.get("method") != "get" or "*" in str(n.get("url", "")):
            continue
        segments = [
            "[^/]+" if seg.startswith(":") else re.escape(seg)
            for seg in n["url"].split("/")
        ]
        patterns.append(re.compile("^" + "/".join(segments) + "$"))
    assert patterns, "no GET routes parsed from flows.json"
    for ep, _expected in ROUTES:
        assert any(p.match(ep) for p in patterns), \
            f"{ep} is not a GET route in shipped flows.json"

@patch("pipeline.checks.http_get")
def test_routes_all_healthy(mock_get, ctx):
    mock_get.side_effect = _routes_responder()
    r = check_routes(ctx)
    assert r.passed

@patch("pipeline.checks.http_get")
def test_routes_irrigation_zones_5xx_still_passes(mock_get, ctx):
    # Route exists but unauthenticated status is in flux — NOT-404 rule.
    mock_get.side_effect = _routes_responder({"/api/irrigation-zones": (500, "boom")})
    r = check_routes(ctx)
    assert r.passed

@patch("pipeline.checks.http_get")
def test_routes_irrigation_zones_404_fails(mock_get, ctx):
    mock_get.side_effect = _routes_responder({"/api/irrigation-zones": (404, "gone")})
    r = check_routes(ctx)
    assert not r.passed
    assert "/api/irrigation-zones=404" in r.detail

@patch("pipeline.checks.http_get")
def test_routes_irrigation_zones_connection_error_fails(mock_get, ctx):
    # -1 (connection refused) must not satisfy the NOT-404 existence rule.
    mock_get.side_effect = _routes_responder({"/api/irrigation-zones": (-1, "refused")})
    r = check_routes(ctx)
    assert not r.passed

@patch("pipeline.checks.http_get")
def test_routes_export_csv_401_is_healthy(mock_get, ctx):
    mock_get.side_effect = _routes_responder(
        {"/api/history/zones/1/export.csv": (401, "unauthorized")})
    r = check_routes(ctx)
    assert r.passed

@patch("pipeline.checks.http_get")
def test_routes_export_csv_404_fails(mock_get, ctx):
    mock_get.side_effect = _routes_responder(
        {"/api/history/zones/1/export.csv": (404, "not found")})
    r = check_routes(ctx)
    assert not r.passed
    assert "export.csv=404" in r.detail

@patch("pipeline.checks.http_get")
def test_routes_export_csv_500_fails(mock_get, ctx):
    mock_get.side_effect = _routes_responder(
        {"/api/history/zones/1/export.csv": (500, "error")})
    r = check_routes(ctx)
    assert not r.passed

@patch("pipeline.checks.http_get")
def test_routes_catalog_500_fails(mock_get, ctx):
    mock_get.side_effect = _routes_responder({"/api/catalog": (500, "error")})
    r = check_routes(ctx)
    assert not r.passed
    assert "/api/catalog=500" in r.detail


# --- errors -----------------------------------------------------------------

def _errors_responder(crash_reads=None, sample_count="5"):
    crash_reads = list(crash_reads or [proc(CRASH_JSON), proc(CRASH_JSON)])
    def responder(ctx, cmd, timeout=30):
        if "node-red-crash-count" in cmd:
            return crash_reads.pop(0)
        if cmd.startswith("date -u"):
            return proc("2026-07-13T10:00:00Z\n")
        if "gateway_health_samples" in cmd:
            return proc(sample_count + "\n") if isinstance(sample_count, str) else sample_count
        raise AssertionError(f"unexpected remote command: {cmd}")
    return responder

@patch("pipeline.checks.errors.time.sleep")
@patch("pipeline.checks.ssh_cmd")
def test_errors_happy_path(mock_ssh, _sleep, ctx):
    mock_ssh.side_effect = _errors_responder()
    r = check_errors(ctx)
    assert r.passed

@patch("pipeline.checks.errors.time.sleep")
@patch("pipeline.checks.ssh_cmd")
def test_errors_missing_crash_file_fails(mock_ssh, _sleep, ctx):
    mock_ssh.side_effect = _errors_responder(crash_reads=[
        proc(stderr="cat: can't open '/data/node-red-crash-count': "
                    "No such file or directory", returncode=1)])
    r = check_errors(ctx)
    assert not r.passed
    assert "node-red-crash-count" in r.detail

@patch("pipeline.checks.errors.time.sleep")
@patch("pipeline.checks.ssh_cmd")
def test_errors_missing_table_fails_with_stderr(mock_ssh, _sleep, ctx):
    # Issue #12: the old check read empty stdout as error-count 0 and PASSED.
    mock_ssh.side_effect = _errors_responder(
        sample_count=proc(stderr=NO_SUCH_TABLE, returncode=1))
    r = check_errors(ctx)
    assert not r.passed
    assert "no such table" in r.detail

@patch("pipeline.checks.errors.time.sleep")
@patch("pipeline.checks.ssh_cmd")
def test_errors_restart_during_window_fails(mock_ssh, _sleep, ctx):
    restarted = CRASH_JSON.replace('"count":0', '"count":1')
    mock_ssh.side_effect = _errors_responder(
        crash_reads=[proc(CRASH_JSON), proc(restarted)])
    r = check_errors(ctx)
    assert not r.passed
    assert "crashed/restarted" in r.detail

@patch("pipeline.checks.errors.time.sleep")
@patch("pipeline.checks.ssh_cmd")
def test_errors_stalled_sampler_fails(mock_ssh, _sleep, ctx):
    mock_ssh.side_effect = _errors_responder(sample_count="0")
    r = check_errors(ctx)
    assert not r.passed
    assert "sampler impaired" in r.detail

@patch("pipeline.checks.errors.time.sleep")
@patch("pipeline.checks.ssh_cmd")
def test_errors_benign_ssh_warning_ignored(mock_ssh, _sleep, ctx):
    def responder(ctx_, cmd, timeout=30):
        warn = "** WARNING: connection is not using a post-quantum key exchange; store now decrypt later\n"
        if "node-red-crash-count" in cmd:
            return proc(CRASH_JSON, stderr=warn)
        if cmd.startswith("date -u"):
            return proc("2026-07-13T10:00:00Z\n", stderr=warn)
        if "gateway_health_samples" in cmd:
            return proc("4\n", stderr=warn)
        raise AssertionError(f"unexpected remote command: {cmd}")
    mock_ssh.side_effect = responder
    r = check_errors(ctx)
    assert r.passed


# --- schema -----------------------------------------------------------------

def test_schema_skip_without_expected_sig(ctx):
    r = check_schema(ctx)
    assert r.passed
    assert "non-schema bundle" in r.detail

@patch("pipeline.checks.ssh_cmd", return_value=proc("a1b2c3d4e5f60718\n"))
def test_schema_sig_match(mock_ssh, ctx):
    ctx.expected_schema_sig = "a1b2c3d4e5f60718"
    r = check_schema(ctx)
    assert r.passed

@patch("pipeline.checks.ssh_cmd", return_value=proc("ffff000011112222\n"))
def test_schema_sig_mismatch_fails(mock_ssh, ctx):
    ctx.expected_schema_sig = "a1b2c3d4e5f60718"
    r = check_schema(ctx)
    assert not r.passed

@patch("pipeline.checks.ssh_cmd",
       return_value=proc(stderr="Error: Cannot find module '/srv/node-red/osi-health-helper'",
                         returncode=1))
def test_schema_probe_error_fails_with_stderr(mock_ssh, ctx):
    ctx.expected_schema_sig = "a1b2c3d4e5f60718"
    r = check_schema(ctx)
    assert not r.passed
    assert "Cannot find module" in r.detail

@patch("pipeline.checks.ssh_cmd", return_value=proc(""))
def test_schema_empty_output_fails(mock_ssh, ctx):
    # Empty stdout is a failed probe, never a comparable signature.
    ctx.expected_schema_sig = "a1b2c3d4e5f60718"
    r = check_schema(ctx)
    assert not r.passed


# --- gui --------------------------------------------------------------------

def test_gui_missing_playwright_fails(ctx, monkeypatch):
    # Force the ImportError path even on runners that have Playwright.
    monkeypatch.setitem(sys.modules, "playwright.sync_api", None)
    r = check_gui(ctx)
    assert not r.passed
    assert "playwright not installed" in r.detail


# --- sync -------------------------------------------------------------------

@patch("pipeline.checks.sync.time.sleep")
@patch("pipeline.checks.ssh_cmd", return_value=proc("3\n"))
def test_sync_stable_passes(mock_ssh, _sleep, ctx):
    r = check_sync(ctx)
    assert r.passed

@patch("pipeline.checks.sync.time.sleep")
@patch("pipeline.checks.ssh_cmd",
       return_value=proc(stderr="Error: in prepare, no such table: sync_outbox",
                         returncode=1))
def test_sync_missing_table_fails(mock_ssh, _sleep, ctx):
    r = check_sync(ctx)
    assert not r.passed
    assert "no such table" in r.detail


# --- ingest -----------------------------------------------------------------
#
# check_ingest correlates ChirpStack `device(dev_eui, last_seen_at)` (network-
# server truth) with edge `device_data.recorded_at` (did it persist?) for the
# registered DRAGINO_LSN50 fleet. The mock branches on `db_path` and
# recognizable SQL text, never on a fragile call count, so tests exercise the
# real polling/quiet-interval control flow.

CHIRPSTACK_DB = "/srv/chirpstack/chirpstack.sqlite"
A8 = "A8404101FD5ECF41"
B1 = "B1234567890ABCDE"


def _ingest_responder(registered=f"{A8}\n",
                       chirpstack_polls=(f"{A8}|2026-07-15T09:00:00Z\n",),
                       edge_polls=None,
                       quarantine_count="0",
                       devices_err=None,
                       chirpstack_err=None):
    """Branches on db_path (ChirpStack vs farming) and recognizable SQL.

    chirpstack_polls: one raw stdout string per poll (last value repeats once
    exhausted, so a single-element tuple models an unchanging fresh set).
    edge_polls: {eui: [raw stdout per query to that eui]}; an eui absent from
    this dict answers every MAX(recorded_at) query for it with "" (no row).
    """
    edge_polls = edge_polls or {}
    state = {"chirpstack": 0, "edge": {}}

    def responder(ctx_, sql, timeout=30, extra_args="", db_path=None):
        if "FROM devices WHERE type_id" in sql:
            if devices_err:
                return None, devices_err
            return registered, None
        if db_path == CHIRPSTACK_DB:
            if chirpstack_err:
                return None, chirpstack_err
            idx = min(state["chirpstack"], len(chirpstack_polls) - 1)
            state["chirpstack"] += 1
            return chirpstack_polls[idx], None
        if "FROM device_data WHERE deveui" in sql:
            for eui, polls in edge_polls.items():
                if f"deveui = '{eui}'" in sql:
                    i = state["edge"].get(eui, 0)
                    idx = min(i, len(polls) - 1)
                    state["edge"][eui] = i + 1
                    return polls[idx], None
            return "", None  # no post-boundary row for this EUI
        if "ingest_quarantine" in sql:
            return quarantine_count, None
        raise AssertionError(f"unexpected SQL: {sql!r} db_path={db_path!r}")
    return responder


def _uci_responder(value="0\n", err=None):
    def responder(ctx_, cmd, timeout=30):
        if "lsn50_writer_disable" in cmd:
            if err:
                return None, err
            return proc(value), None
        raise AssertionError(f"unexpected remote command: {cmd}")
    return responder


@patch("pipeline.checks.ssh_cmd",
       return_value=proc(stderr="Error: in prepare, no such table: device_data",
                         returncode=1))
def test_ingest_missing_table_fails(mock_ssh, ctx):
    r = check_ingest(ctx)
    assert not r.passed
    assert "no such table" in r.detail


@patch("pipeline.checks.ssh_cmd")
def test_ingest_database_stderr_with_exit_zero_fails(mock_ssh, ctx):
    # Real remote_sql path (not mocked): exit 0 but stderr present must never
    # be misread as a clean empty result.
    mock_ssh.return_value = proc(
        "", stderr="Error: near line 1: no such column: type_id", returncode=0)
    result = check_ingest(ctx)
    assert not result.passed
    assert "sqlite reported errors despite exit 0" in result.detail


@patch("pipeline.checks.remote_sql")
def test_ingest_no_registered_devices_required_fails(mock_remote_sql, ctx):
    ctx.require_ingest = True
    mock_remote_sql.side_effect = _ingest_responder(registered="")
    result = check_ingest(ctx)
    assert not result.passed
    assert "no DRAGINO_LSN50 devices registered" in result.detail


@patch("pipeline.checks.remote_sql")
def test_ingest_no_registered_devices_not_required_passes(mock_remote_sql, ctx):
    mock_remote_sql.side_effect = _ingest_responder(registered="")
    result = check_ingest(ctx)
    assert result.passed


@patch("pipeline.checks.remote_sql")
def test_ingest_registered_deveui_malformed_fails(mock_remote_sql, ctx):
    mock_remote_sql.side_effect = _ingest_responder(registered="A840410-BAD\n")
    result = check_ingest(ctx)
    assert not result.passed
    assert "malformed DevEUI in devices table" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_ingest_fails_when_chirpstack_is_fresh_but_edge_has_no_row(
    mock_remote_sql, mock_time, mock_sleep, ctx
):
    # ChirpStack has a fresh uplink for a registered DevEUI; edge has no
    # post-boundary row for it at all.
    ctx.ingest_wait_seconds = 0
    ctx.require_ingest = True
    mock_remote_sql.side_effect = _ingest_responder(edge_polls={})
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "ChirpStack uplink" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_passes_only_when_same_deveui_reaches_edge(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    # ChirpStack returns A8404101FD5ECF41; edge max timestamp (+10s) is
    # inside the symmetric skew bound.
    mock_remote_sql.side_effect = _ingest_responder(
        edge_polls={A8: ["2026-07-15 09:00:10\n"]})
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [1000.0, 1000.0, 1015.0]  # deadline calc, poll 1, poll 2
    result = check_ingest(ctx)
    assert result.passed
    assert result.evidence["deveui"] == A8


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_required_ingest_fails_when_observation_window_expires(
    mock_remote_sql, mock_time, mock_sleep, ctx
):
    # ChirpStack has zero fresh rows for the whole (zero-length) window.
    ctx.ingest_wait_seconds = 0
    ctx.require_ingest = True
    mock_remote_sql.side_effect = _ingest_responder(chirpstack_polls=("",))
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "no ChirpStack uplink" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_fails_when_fallback_marker_exists(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    # Would otherwise pass (matched + quiet elapsed), but a writer_fallback
    # quarantine row landed since verification start.
    mock_remote_sql.side_effect = _ingest_responder(
        edge_polls={A8: ["2026-07-15 09:00:10\n"]}, quarantine_count="2")
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [1000.0, 1000.0, 1015.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "writer_fallback" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_runs_one_probe_when_wait_is_zero(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(chirpstack_polls=("",))
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [1000.0, 1000.0]
    check_ingest(ctx)
    assert mock_remote_sql.call_count > 0


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_post_boundary_edge_row_older_than_selected_uplink_does_not_pass(
    mock_remote_sql, mock_time, mock_sleep, ctx
):
    # Edge has a post-boundary row, but it predates the latest selected
    # ChirpStack observation by more than the skew tolerance.
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(
        edge_polls={A8: ["2026-07-15 08:59:00\n"]})  # -60s vs 09:00:00
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "predates selected ChirpStack uplink" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_post_boundary_edge_row_too_far_after_selected_uplink_does_not_pass(
    mock_remote_sql, mock_time, mock_sleep, ctx
):
    # A future-dated edge row cannot prove persistence of the selected uplink.
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(
        edge_polls={A8: ["2026-07-15 09:01:00\n"]})  # +60s vs 09:00:00
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "exceeds selected ChirpStack uplink" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_inclusive_skew_boundaries_pass(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    # Exactly +/- the configured skew must still match (closed interval).
    mock_remote_sql.side_effect = _ingest_responder(
        registered=f"{A8}\n{B1}\n",
        chirpstack_polls=(f"{A8}|2026-07-15T09:00:00Z\n{B1}|2026-07-15T09:05:00Z\n",),
        edge_polls={
            A8: ["2026-07-15 08:59:30\n"],  # delta exactly -30s
            B1: ["2026-07-15 09:05:30\n"],  # delta exactly +30s
        },
    )
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [1000.0, 1000.0, 1015.0]
    result = check_ingest(ctx)
    assert result.passed
    assert result.evidence["matched"] == [A8, B1]


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_ingest_malformed_chirpstack_row_fails(mock_remote_sql, mock_time, mock_sleep, ctx):
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(
        chirpstack_polls=(f"{A8}-2026-07-15T09:00:00Z\n",))  # missing '|' separator
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "malformed ChirpStack row" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_ingest_duplicate_chirpstack_rows_fails(mock_remote_sql, mock_time, mock_sleep, ctx):
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(
        chirpstack_polls=(f"{A8}|2026-07-15T09:00:00Z\n{A8}|2026-07-15T09:00:05Z\n",))
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "duplicate" in result.detail.lower()


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_ingest_unregistered_deveui_in_chirpstack_fails(mock_remote_sql, mock_time, mock_sleep, ctx):
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(
        registered=f"{A8}\n",
        chirpstack_polls=("FFFFFFFFFFFFFFFF|2026-07-15T09:00:00Z\n",))
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "not a registered" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote_sql")
def test_ingest_two_devices_second_fresh_eui_missing_from_edge_fails(
    mock_remote_sql, mock_time, mock_sleep, ctx
):
    # The newest DevEUI is healthy, but a second fresh EUI never reached
    # device_data — it must not be hidden behind the first EUI's success.
    ctx.ingest_wait_seconds = 0
    mock_remote_sql.side_effect = _ingest_responder(
        registered=f"{A8}\n{B1}\n",
        chirpstack_polls=(f"{A8}|2026-07-15T09:00:00Z\n{B1}|2026-07-15T09:05:00Z\n",),
        edge_polls={A8: ["2026-07-15 09:00:05\n"]},  # B1 has no edge row
    )
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert B1 in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_two_healthy_devices_passes(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    mock_remote_sql.side_effect = _ingest_responder(
        registered=f"{A8}\n{B1}\n",
        chirpstack_polls=(f"{A8}|2026-07-15T09:00:00Z\n{B1}|2026-07-15T09:05:00Z\n",),
        edge_polls={
            A8: ["2026-07-15 09:00:05\n"],
            B1: ["2026-07-15 09:05:05\n"],
        },
    )
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [1000.0, 1000.0, 1015.0]
    result = check_ingest(ctx)
    assert result.passed
    assert result.evidence["matched"] == [A8, B1]


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_late_second_uplink_resets_quiet_interval_passes(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    # Poll 1 sees only A8 fresh; poll 2 sees B1 newly fresh too (a late
    # second uplink) — this must reset the quiet timer rather than let it
    # ride out on A8's already-elapsed window. Only poll 3, after the set is
    # unchanged for a full quiet interval, may pass.
    mock_remote_sql.side_effect = _ingest_responder(
        registered=f"{A8}\n{B1}\n",
        chirpstack_polls=(
            f"{A8}|2026-07-15T09:00:00Z\n",
            f"{A8}|2026-07-15T09:00:00Z\n{B1}|2026-07-15T09:05:00Z\n",
        ),
        edge_polls={
            A8: ["2026-07-15 09:00:05\n"],
            B1: ["2026-07-15 09:05:05\n"],
        },
    )
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [900.0, 1000.0, 1011.0, 1026.0]
    result = check_ingest(ctx)
    assert result.passed
    # 1 (registered) + poll1(chirpstack+edge(A8)=2) + poll2(chirpstack+edge(A8)+edge(B1)=3)
    # + poll3(chirpstack+edge(A8)+edge(B1)=3) + 1 (quarantine) = 10. A no-reset
    # implementation would have passed already at poll 2 (call_count == 7).
    assert mock_remote_sql.call_count == 10


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_empty_fresh_set_demo_gateway_passes_with_warning(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    ctx.ingest_wait_seconds = 0
    ctx.require_ingest = False
    mock_remote_sql.side_effect = _ingest_responder(chirpstack_polls=("",))
    mock_remote.side_effect = _uci_responder()
    mock_time.side_effect = [1000.0, 1000.0]
    result = check_ingest(ctx)
    assert result.passed
    assert "not required" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_kill_switch_command_failure_is_hard_fail(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    mock_remote_sql.side_effect = _ingest_responder(
        edge_polls={A8: ["2026-07-15 09:00:10\n"]})
    mock_remote.side_effect = _uci_responder(
        err="remote command failed (exit 255): ssh: connect to host: Connection refused")
    mock_time.side_effect = [1000.0, 1000.0, 1015.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "lsn50_writer_disable" in result.detail
    # A command failure must never be read as an empty (off) setting.
    assert "Connection refused" in result.detail


@patch("pipeline.checks.ingest.time.sleep")
@patch("pipeline.checks.ingest.time.time")
@patch("pipeline.checks.remote")
@patch("pipeline.checks.remote_sql")
def test_ingest_kill_switch_enabled_fails(
    mock_remote_sql, mock_remote, mock_time, mock_sleep, ctx
):
    mock_remote_sql.side_effect = _ingest_responder(
        edge_polls={A8: ["2026-07-15 09:00:10\n"]})
    mock_remote.side_effect = _uci_responder(value="1\n")
    mock_time.side_effect = [1000.0, 1000.0, 1015.0]
    result = check_ingest(ctx)
    assert not result.passed
    assert "lsn50_writer_disable" in result.detail


# --- daily ------------------------------------------------------------------

def test_daily_skip_non_extraction(ctx):
    r = check_daily(ctx)
    assert r.passed
    assert "SKIP" in r.detail

@patch("pipeline.checks.ssh_cmd",
       return_value=proc(stderr="Error: in prepare, no such table: dendrometer_daily",
                         returncode=1))
def test_daily_missing_table_fails(mock_ssh, ctx):
    ctx.is_extraction_bundle = True
    r = check_daily(ctx)
    assert not r.passed
    assert "no such table" in r.detail


# --- db ---------------------------------------------------------------------

def _db_responder(integrity="ok", fk="", count=proc("1500\n")):
    def responder(ctx_, cmd, timeout=30):
        if "integrity_check" in cmd:
            return proc(integrity + "\n") if isinstance(integrity, str) else integrity
        if "foreign_key_check" in cmd:
            return proc(fk)
        if "COUNT(*) FROM device_data" in cmd:
            return count
        raise AssertionError(f"unexpected remote command: {cmd}")
    return responder

@patch("pipeline.checks.ssh_cmd")
def test_db_healthy_passes(mock_ssh, ctx):
    mock_ssh.side_effect = _db_responder()
    r = check_db(ctx)
    assert r.passed

@patch("pipeline.checks.ssh_cmd")
def test_db_integrity_fail(mock_ssh, ctx):
    mock_ssh.side_effect = _db_responder(
        integrity="*** in database main ***\nPage 42: btree problem")
    r = check_db(ctx)
    assert not r.passed

@patch("pipeline.checks.ssh_cmd")
def test_db_ssh_failure_fails(mock_ssh, ctx):
    mock_ssh.side_effect = _db_responder(
        integrity=proc(stderr="ssh: connect to host: Connection refused",
                       returncode=255))
    r = check_db(ctx)
    assert not r.passed
    assert "Connection refused" in r.detail

@patch("pipeline.checks.ssh_cmd")
def test_db_row_count_query_error_fails(mock_ssh, ctx):
    mock_ssh.side_effect = _db_responder(
        count=proc(stderr="Error: database disk image is malformed", returncode=1))
    r = check_db(ctx)
    assert not r.passed
    assert "malformed" in r.detail


# --- canary -----------------------------------------------------------------

def test_canary_pre_b0_skip_passes(ctx):
    r = check_canary(ctx)
    assert r.passed

def test_canary_missing_token_fails(ctx, monkeypatch):
    ctx.canary_gate_available = True
    monkeypatch.delenv("OSI_ADMIN_TOKEN", raising=False)
    r = check_canary(ctx)
    assert not r.passed
    assert "OSI_ADMIN_TOKEN" in r.detail
