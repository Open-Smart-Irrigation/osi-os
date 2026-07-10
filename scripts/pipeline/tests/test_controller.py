"""Tests for pipeline controller + git_ops."""
from pathlib import Path
from unittest.mock import patch, MagicMock, call

import pytest

from pipeline.config import PipelineState, BundleConfig
from pipeline.git_ops import (
    run_git, create_bundle_branch, merge_to_target,
    tag_checkpoint, delete_branch, cherry_pick_pr,
)
from pipeline.controller import _pr_branch_name, _first_failure


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
