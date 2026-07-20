"""Tests for pipeline controller + git_ops."""
import re
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import pytest

from pipeline.config import PipelineState, BundleConfig, GatewayConfig
from pipeline.git_ops import (
    run_git, create_bundle_branch, merge_to_target,
    tag_checkpoint, delete_branch, cherry_pick_pr,
)
from pipeline.controller import _pr_branch_name, _first_failure, run_pipeline
from pipeline.deploy import BackupResult, DeployResult
from pipeline.checks import CheckResult


# --- PipelineState -----------------------------------------------------------

def test_state_transitions():
    s = PipelineState()
    assert s.status == "idle"
    s.status = "building"
    assert s.status == "building"
    s.status = "halted"
    assert s.status == "halted"


# --- BundleConfig.needs_deploy -----------------------------------------------

def test_bundle_needs_deploy():
    b = BundleConfig(id="B0", name="test", items=[], prs=[], deploy_target="kaba100",
                     soak_hours=24, pre_deploy=[], needs_fixes=[], ci_only=False)
    assert b.needs_deploy is True


def test_ci_only_no_deploy():
    b = BundleConfig(id="B2", name="test", items=[], prs=[], deploy_target=None,
                     soak_hours=0, pre_deploy=[], needs_fixes=[], ci_only=True)
    assert b.needs_deploy is False


# --- _pr_branch_name ---------------------------------------------------------

def test_pr_branch_name_known():
    assert _pr_branch_name(118) == "deploy-canary-gate"
    assert _pr_branch_name(124) == "53-staged-atomic-deploy"


def test_pr_branch_name_unknown_fallback():
    assert _pr_branch_name(999) == "pr-999"


# --- _first_failure ----------------------------------------------------------

def test_first_failure_returns_first():
    from pipeline.checks import CheckResult
    results = [
        CheckResult("boot", True, "ok"),
        CheckResult("db", False, "integrity failed"),
        CheckResult("sync", False, "timeout"),
    ]
    assert _first_failure(results) == "db: integrity failed"


def test_first_failure_all_pass():
    from pipeline.checks import CheckResult
    results = [CheckResult("boot", True, "ok")]
    assert _first_failure(results) == "unknown"


# --- git_ops ------------------------------------------------------------------

@patch("pipeline.git_ops.subprocess.run")
def test_create_bundle_branch(mock_run):
    mock_run.return_value = MagicMock(returncode=0)
    branch = create_bundle_branch("canary-gate", Path("/repo"), "feat/refactor-and-forge-handoff")
    assert branch == "bundle/canary-gate"
    cmds = [c.args[0] for c in mock_run.call_args_list]
    assert ["git", "checkout", "feat/refactor-and-forge-handoff"] in cmds
    assert ["git", "pull", "--ff-only"] in cmds
    assert ["git", "checkout", "-b", "bundle/canary-gate"] in cmds


@patch("pipeline.git_ops.subprocess.run")
def test_merge_to_target_success(mock_run):
    mock_run.return_value = MagicMock(returncode=0)
    assert merge_to_target("bundle/canary-gate", Path("/repo"), "feat/refactor-and-forge-handoff") is True


@patch("pipeline.git_ops.subprocess.run")
def test_merge_to_target_conflict(mock_run):
    mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="")
    assert merge_to_target("bundle/canary-gate", Path("/repo")) is False


@patch("pipeline.git_ops.subprocess.run")
def test_tag_checkpoint(mock_run):
    mock_run.return_value = MagicMock(returncode=0)
    tag = tag_checkpoint(3, Path("/repo"))
    assert tag == "agrolink-checkpoint-3"
    cmds = [c.args[0] for c in mock_run.call_args_list]
    assert ["git", "tag", "agrolink-checkpoint-3"] in cmds


@patch("pipeline.git_ops.subprocess.run")
def test_cherry_pick_pr_conflict_aborts(mock_run):
    mock_run.return_value = MagicMock(returncode=1, stdout="CONFLICT in flows.json", stderr="")
    assert cherry_pick_pr("origin/feat/test", Path("/repo")) is False
    cmds = [c.args[0] for c in mock_run.call_args_list]
    assert ["git", "merge", "--abort"] in cmds


# --- run_pipeline: backup -> deploy -> gateway_clock -> checks ordering -----

@patch("pipeline.controller.send_alert")
@patch("pipeline.controller.collect_evidence")
@patch("pipeline.controller.run_all_checks")
@patch("pipeline.controller.gateway_utc_now")
@patch("pipeline.controller.deploy_to_gateway")
@patch("pipeline.controller.pre_deploy_backup")
@patch("pipeline.controller.save_state")
@patch("pipeline.controller.load_state")
@patch("pipeline.controller.load_bundles")
@patch("pipeline.git_ops.run_git")
def test_run_pipeline_orders_backup_deploy_clock_checks_and_builds_ctx(
    mock_run_git, mock_load_bundles, mock_load_state, mock_save_state,
    mock_backup, mock_deploy, mock_clock, mock_run_checks,
    mock_collect_evidence, mock_send_alert,
):
    events = []
    captured = {}

    kaba100 = GatewayConfig(
        host="100.93.68.86", ssh_user="root", ssh_key="~/.ssh/id_ed25519",
        db_path="/data/db/farming.db", gui_url="http://100.93.68.86:1880/gui",
        backup_dir="/data/backups",
        ingest_wait_seconds=1500, ingest_quiet_seconds=60,
        require_ingest=True, ingest_max_clock_skew_seconds=30,
    )
    # No PRs (skip the merge-branch phase entirely) and no soak (skip the
    # post-soak re-verification phase) so the run exercises exactly one pass
    # through Phase 2 before completing.
    bundle = BundleConfig(id="B0", name="test-bundle", items=[], prs=[],
                          deploy_target="kaba100", soak_hours=0, pre_deploy=[],
                          needs_fixes=[], ci_only=False)
    mock_load_bundles.return_value = (
        [bundle], {"kaba100": kaba100}, {}, {"soak_heartbeat_interval_s": 1800})
    mock_load_state.return_value = PipelineState(current_bundle_idx=0)
    mock_run_git.return_value = MagicMock(returncode=0, stdout="", stderr="")

    def backup_side_effect(gw, ts):
        events.append("backup")
        captured["backup_stamp"] = ts
        return BackupResult(True, "/data/backups/x.db", {}, "backup ok")
    mock_backup.side_effect = backup_side_effect

    def deploy_side_effect(gw, repo_root):
        events.append("deploy")
        return DeployResult(True, "deploy ok")
    mock_deploy.side_effect = deploy_side_effect

    def clock_side_effect(gw):
        events.append("gateway_clock")
        return "2026-07-15T09:00:00Z", None
    mock_clock.side_effect = clock_side_effect

    def checks_side_effect(ctx):
        events.append("checks")
        captured["ctx"] = ctx
        return [CheckResult("boot", True, "ok")]
    mock_run_checks.side_effect = checks_side_effect

    mock_collect_evidence.return_value = {"passed": True}

    run_pipeline(dry_run=False)

    assert events == ["backup", "deploy", "gateway_clock", "checks"]

    backup_stamp = captured["backup_stamp"]
    assert re.fullmatch(r"\d{8}T\d{6}Z", backup_stamp)

    ctx = captured["ctx"]
    assert ctx.verification_started_at == "2026-07-15T09:00:00Z"
    # verification_started_at must never be the compact backup_stamp filename
    # format that caused the original lexical-comparison false pass.
    assert ctx.verification_started_at != backup_stamp
    assert ctx.ingest_wait_seconds == 1500
    assert ctx.ingest_quiet_seconds == 60
    assert ctx.require_ingest is True
    assert ctx.ingest_max_clock_skew_seconds == 30


@patch("pipeline.controller.send_alert")
@patch("pipeline.controller.restore_gateway")
@patch("pipeline.controller.gateway_utc_now")
@patch("pipeline.controller.deploy_to_gateway")
@patch("pipeline.controller.pre_deploy_backup")
@patch("pipeline.controller.save_state")
@patch("pipeline.controller.load_state")
@patch("pipeline.controller.load_bundles")
@patch("pipeline.git_ops.run_git")
def test_run_pipeline_halts_and_restores_when_gateway_clock_read_fails(
    mock_run_git, mock_load_bundles, mock_load_state, mock_save_state,
    mock_backup, mock_deploy, mock_clock, mock_restore, mock_send_alert,
):
    # A row written by the old payload during backup/deploy must never
    # satisfy a post-deploy check — if the gateway clock can't be read at
    # all, the pipeline must restore and halt rather than fabricate a
    # verification boundary (e.g. falling back to the runner's own clock).
    kaba100 = GatewayConfig(
        host="100.93.68.86", ssh_user="root", ssh_key="~/.ssh/id_ed25519",
        db_path="/data/db/farming.db", gui_url="http://100.93.68.86:1880/gui",
        backup_dir="/data/backups",
    )
    bundle = BundleConfig(id="B0", name="test-bundle", items=[], prs=[],
                          deploy_target="kaba100", soak_hours=0, pre_deploy=[],
                          needs_fixes=[], ci_only=False)
    mock_load_bundles.return_value = (
        [bundle], {"kaba100": kaba100}, {}, {"soak_heartbeat_interval_s": 1800})
    mock_load_state.return_value = PipelineState(current_bundle_idx=0)
    mock_run_git.return_value = MagicMock(returncode=0, stdout="", stderr="")
    mock_backup.return_value = BackupResult(True, "/data/backups/x.db", {}, "backup ok")
    mock_deploy.return_value = DeployResult(True, "deploy ok")
    mock_clock.return_value = (None, "gateway clock read timed out")

    run_pipeline(dry_run=False)

    mock_restore.assert_called_once_with(kaba100, "/data/backups/x.db")
    halt_alert = [c for c in mock_send_alert.call_args_list
                  if "HALT" in c.args[1]]
    assert halt_alert, "expected a HALT alert on gateway clock read failure"
    assert "gateway clock" in halt_alert[0].args[2].lower()
