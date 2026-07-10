import json
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

from pipeline.config import GatewayConfig
from pipeline.deploy import (
    pre_deploy_backup, deploy_to_gateway, scp_to_pi, ssh,
    BackupResult, DeployResult,
)
from pipeline.restore import restore_gateway
from pipeline.evidence import collect_evidence
from pipeline.checks import CheckResult


@pytest.fixture
def gw():
    return GatewayConfig(
        host="100.93.68.86", ssh_user="root", ssh_key="~/.ssh/id_ed25519",
        db_path="/data/db/farming.db", gui_url="http://100.93.68.86:1880/gui",
        backup_dir="/data/backups",
    )


# --- scp_to_pi / ssh helpers -------------------------------------------------

@patch("pipeline.deploy.subprocess.run")
def test_scp_to_pi_invokes_scp_with_gateway_key(mock_run, gw):
    scp_to_pi(gw, Path("/local/file.sh"), "/remote/file.sh")
    args = mock_run.call_args[0][0]
    assert args[0] == "scp"
    assert "-i" in args and gw.ssh_key in args
    assert args[-1] == f"{gw.ssh_user}@{gw.host}:/remote/file.sh"
    assert mock_run.call_args.kwargs["check"] is True


@patch("pipeline.deploy.subprocess.run")
def test_ssh_invokes_ssh_with_gateway_key(mock_run, gw):
    mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
    ssh(gw, "echo hi", timeout=42)
    args, kwargs = mock_run.call_args
    cmd = args[0]
    assert cmd[0] == "ssh"
    assert cmd[-2:] == [f"{gw.ssh_user}@{gw.host}", "echo hi"]
    assert kwargs["timeout"] == 42


# --- pre_deploy_backup --------------------------------------------------------

@patch("pipeline.deploy.ssh")
@patch("pipeline.deploy.scp_to_pi")
def test_pre_deploy_backup_ok_parses_baselines(mock_scp, mock_ssh, gw):
    mock_ssh.return_value = MagicMock(
        returncode=0,
        stdout=(
            "Stopping Node-RED for consistent backup...\n"
            "Taking .backup to /data/backups/pre-deploy-20260710T180000Z.db...\n"
            "Checking backup integrity...\n"
            "Recording baselines...\n"
            "db_size_bytes=4096000\n"
            "device_data_rows=1000\n"
            "irrigation_schedules_rows=12\n"
            "sync_outbox_pending=0\n"
            "OK: backup at /data/backups/pre-deploy-20260710T180000Z.db (integrity ok)\n"
            "BACKUP_PATH=/data/backups/pre-deploy-20260710T180000Z.db\n"
            "TIMESTAMP=20260710T180000Z\n"
        ),
        stderr="",
    )
    result = pre_deploy_backup(gw, "20260710T180000Z")

    assert isinstance(result, BackupResult)
    assert result.ok is True
    assert result.backup_path == "/data/backups/pre-deploy-20260710T180000Z.db"
    assert result.baselines["device_data_rows"] == "1000"
    assert result.baselines["irrigation_schedules_rows"] == "12"
    assert result.baselines["sync_outbox_pending"] == "0"
    assert result.baselines["db_size_bytes"] == "4096000"
    # "OK: ..." line must not leak into baselines
    assert not any(k.startswith("OK") for k in result.baselines)

    # both scripts deployed before running the backup
    assert mock_scp.call_count == 2
    deployed_names = {call.args[1].name for call in mock_scp.call_args_list}
    assert deployed_names == {"backup-pre-deploy.sh", "restore-pre-deploy.sh"}


@patch("pipeline.deploy.ssh")
@patch("pipeline.deploy.scp_to_pi")
def test_pre_deploy_backup_failure_returns_not_ok(mock_scp, mock_ssh, gw):
    # Three ssh calls: mkdir, chmod, then the backup script itself failing.
    mock_ssh.side_effect = [
        MagicMock(returncode=0, stdout="", stderr=""),
        MagicMock(returncode=0, stdout="", stderr=""),
        MagicMock(returncode=1, stdout="", stderr="ERROR: sqlite3 CLI not found"),
    ]
    result = pre_deploy_backup(gw, "20260710T180000Z")

    assert result.ok is False
    assert result.backup_path == ""
    assert result.baselines == {}
    assert "backup failed" in result.detail
    assert "sqlite3 CLI not found" in result.detail


# --- deploy_to_gateway ---------------------------------------------------

@patch("http.server.HTTPServer")
@patch("pipeline.checks.http_get", return_value=(301, ""))
@patch("pipeline.deploy.subprocess.run")
def test_deploy_to_gateway_ok(mock_run, mock_http_get, mock_httpserver_cls, gw, tmp_path):
    (tmp_path / "web" / "react-gui" / "build").mkdir(parents=True)

    mock_srv = MagicMock()
    mock_httpserver_cls.return_value = mock_srv
    mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")

    result = deploy_to_gateway(gw, tmp_path)

    assert isinstance(result, DeployResult)
    assert result.ok is True
    assert "Node-RED alive" in result.detail
    mock_srv.shutdown.assert_called_once()

    invoked = [call.args[0] for call in mock_run.call_args_list]
    assert ["npm", "run", "build"] in invoked
    assert any(cmd[0] == "tar" for cmd in invoked)
    ssh_call = [cmd for cmd in invoked if cmd[0] == "ssh"]
    assert len(ssh_call) == 1
    assert "-R" in ssh_call[0]


@patch("http.server.HTTPServer")
@patch("pipeline.deploy.subprocess.run")
def test_deploy_to_gateway_deploy_sh_failure(mock_run, mock_httpserver_cls, gw, tmp_path):
    (tmp_path / "web" / "react-gui" / "build").mkdir(parents=True)
    mock_srv = MagicMock()
    mock_httpserver_cls.return_value = mock_srv

    ok_result = MagicMock(returncode=0, stdout="", stderr="")
    fail_result = MagicMock(returncode=1, stdout="", stderr="deploy.sh: permission denied")
    mock_run.side_effect = [ok_result, ok_result, fail_result]

    result = deploy_to_gateway(gw, tmp_path)

    assert result.ok is False
    assert "deploy.sh failed" in result.detail
    mock_srv.shutdown.assert_called_once()


@patch("http.server.HTTPServer")
@patch("pipeline.checks.http_get", return_value=(-1, "connection refused"))
@patch("pipeline.deploy.time.sleep", return_value=None)
@patch("pipeline.deploy.time.time")
@patch("pipeline.deploy.subprocess.run")
def test_deploy_to_gateway_nodered_never_comes_up(
    mock_run, mock_time, mock_sleep, mock_http_get, mock_httpserver_cls, gw, tmp_path
):
    (tmp_path / "web" / "react-gui" / "build").mkdir(parents=True)
    mock_srv = MagicMock()
    mock_httpserver_cls.return_value = mock_srv
    mock_run.return_value = MagicMock(returncode=0, stdout="", stderr="")
    mock_time.side_effect = [1000.0, 1200.0]

    result = deploy_to_gateway(gw, tmp_path)

    assert result.ok is False
    assert "did not come up" in result.detail


# --- restore_gateway ----------------------------------------------------------

@patch("pipeline.restore.ssh")
def test_restore_gateway_ok(mock_ssh, gw, capsys):
    mock_ssh.return_value = MagicMock(returncode=0, stdout="OK: restored", stderr="")
    assert restore_gateway(gw, "/data/backups/pre-deploy-20260710T180000Z.db") is True
    cmd = mock_ssh.call_args[0][1]
    assert cmd == f"sh {gw.backup_dir}/restore-pre-deploy.sh /data/backups/pre-deploy-20260710T180000Z.db"
    assert "Restored from" in capsys.readouterr().out


@patch("pipeline.restore.ssh")
def test_restore_gateway_failure(mock_ssh, gw, capsys):
    mock_ssh.return_value = MagicMock(returncode=2, stdout="", stderr="integrity_check failed")
    assert restore_gateway(gw, "/data/backups/bad.db") is False
    assert "RESTORE FAILED" in capsys.readouterr().out


# --- collect_evidence ----------------------------------------------------------

def test_collect_evidence_all_passed_no_output_dir():
    results = [
        CheckResult("boot", True, "up", {"status": 301}),
        CheckResult("routes", True, "all 200", None),
    ]
    ev = collect_evidence("B0", results)
    assert ev["bundle"] == "B0"
    assert ev["passed"] is True
    assert len(ev["checks"]) == 2
    assert ev["checks"][0] == {"name": "boot", "passed": True, "detail": "up", "evidence": {"status": 301}}


def test_collect_evidence_any_failed_marks_bundle_failed():
    results = [
        CheckResult("boot", True, "up"),
        CheckResult("db", False, "integrity_check failed"),
    ]
    ev = collect_evidence("B1", results)
    assert ev["passed"] is False


def test_collect_evidence_writes_json_file(tmp_path):
    results = [CheckResult("boot", True, "up")]
    ev = collect_evidence("B2", results, output_dir=tmp_path)

    files = list(tmp_path.glob("evidence-B2-*.json"))
    assert len(files) == 1
    on_disk = json.loads(files[0].read_text())
    assert on_disk == ev
