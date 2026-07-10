import pytest
from unittest.mock import patch, MagicMock
from pipeline.checks import VerifyContext, CheckResult
from pipeline.checks.boot import run as check_boot
from pipeline.checks.routes import run as check_routes
from pipeline.checks.db import run as check_db

@pytest.fixture
def ctx():
    return VerifyContext(
        gateway_host="100.93.68.86", ssh_user="root",
        ssh_key="~/.ssh/id_ed25519", db_path="/data/db/farming.db",
        gui_url="http://100.93.68.86:1880/gui",
        deploy_timestamp="2026-07-10T18:00:00Z",
        pre_deploy_baselines={"device_data_rows": "1000"},
    )

@patch("pipeline.checks.http_get", return_value=(301, ""))
def test_boot_pass(mock_get, ctx):
    r = check_boot(ctx)
    assert r.passed

@patch("pipeline.checks.http_get", return_value=(-1, "connection refused"))
def test_boot_fail(mock_get, ctx):
    r = check_boot(ctx)
    assert not r.passed

@patch("pipeline.checks.http_get")
def test_routes_404_is_fail(mock_get, ctx):
    mock_get.side_effect = lambda url, **kw: (404, "not found") if "/api/zones" in url else (200, "ok")
    r = check_routes(ctx)
    assert not r.passed
    assert "/api/zones=404" in r.detail

@patch("pipeline.checks.ssh_cmd")
def test_db_integrity_fail(mock_ssh, ctx):
    mock_ssh.return_value = MagicMock(stdout="*** in database main ***\nPage 42: btree problem")
    r = check_db(ctx)
    assert not r.passed
