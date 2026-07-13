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
        deploy_timestamp="2026-07-10T18:00:00Z",
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

@patch("pipeline.checks.ssh_cmd",
       return_value=proc(stderr="Error: in prepare, no such table: device_data",
                         returncode=1))
def test_ingest_missing_table_fails(mock_ssh, ctx):
    r = check_ingest(ctx)
    assert not r.passed
    assert "no such table" in r.detail


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
