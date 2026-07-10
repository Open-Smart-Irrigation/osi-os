#!/usr/bin/env python3
"""Refactor execution engine — fully unattended pipeline controller.

Usage: python -m pipeline.controller [--resume] [--dry-run]
"""
from __future__ import annotations
import argparse
import sys
import time
from pathlib import Path

from .config import load_bundles, load_state, save_state, PipelineState
from .checks import VerifyContext, run_all_checks
from .deploy import pre_deploy_backup, deploy_to_gateway
from .restore import restore_gateway
from .alert import send_alert, PipelineHeartbeat
from .evidence import collect_evidence
from .git_ops import (create_bundle_branch, merge_to_main, tag_checkpoint,
                      delete_branch, cherry_pick_pr)

REPO_ROOT = Path(__file__).parent.parent.parent
ALERT_TOPIC = "osi-refactor-pipeline"

PR_BRANCH_MAP = {
    118: "deploy-canary-gate",
    120: "88-stage0-canonicalization",
    121: "ratchet-trio",
    122: "1A5-outbox-size-cap",
    123: "88-stage1-deploy-runner",
    124: "53-staged-atomic-deploy",
}


def _pr_branch_name(pr_number: int) -> str:
    return PR_BRANCH_MAP.get(pr_number, f"pr-{pr_number}")


def _first_failure(results) -> str:
    for r in results:
        if not r.passed:
            return f"{r.name}: {r.detail}"
    return "unknown"


def _halt(reason: str, bundle, state: PipelineState) -> None:
    print(f"\n  HALT: {reason}")
    send_alert(ALERT_TOPIC, f"PIPELINE HALT — {bundle.id} {bundle.name}",
               reason, priority="urgent")
    state.status = "halted"
    save_state(state)


def run_pipeline(dry_run: bool = False) -> None:
    bundles, gateways, servers, limits = load_bundles()
    state = load_state()
    kaba100 = gateways["kaba100"]
    heartbeat = PipelineHeartbeat(ALERT_TOPIC, limits["soak_heartbeat_interval_s"])

    for i, bundle in enumerate(bundles):
        if i < state.current_bundle_idx:
            continue

        print(f"\n{'='*60}")
        print(f"BUNDLE {bundle.id}: {bundle.name}")
        print(f"  Items: {bundle.items}")
        print(f"  Deploy: {bundle.deploy_target or 'CI-only'}")
        print(f"  Soak: {bundle.soak_hours}h")
        print(f"{'='*60}\n")

        state.status = "building"
        state.current_bundle_idx = i
        save_state(state)

        # --- Phase 1: Merge PRs into bundle branch ---
        if bundle.prs:
            branch = create_bundle_branch(bundle.name, REPO_ROOT)
            for pr in bundle.prs:
                pr_branch = f"origin/feat/{_pr_branch_name(pr)}"
                if not cherry_pick_pr(pr_branch, REPO_ROOT):
                    _halt(f"flows.json conflict merging PR #{pr} — needs manual resolution + re-review",
                          bundle, state)
                    return

            print(f"  Merged {len(bundle.prs)} PRs onto {branch}")

        # --- Phase 2: Deploy + verify ---
        if bundle.needs_deploy:
            state.status = "deploying"
            save_state(state)

            ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

            backup = pre_deploy_backup(kaba100, ts)
            if not backup.ok:
                _halt(f"Pre-deploy backup failed: {backup.detail}", bundle, state)
                return

            if dry_run:
                print("  DRY RUN: skipping deploy")
            else:
                result = deploy_to_gateway(kaba100, REPO_ROOT)
                if not result.ok:
                    print(f"  DEPLOY FAILED: {result.detail}")
                    restore_gateway(kaba100, backup.backup_path)
                    _halt(f"Deploy failed + restored: {result.detail}", bundle, state)
                    return

                ctx = VerifyContext(
                    gateway_host=kaba100.host,
                    ssh_user=kaba100.ssh_user,
                    ssh_key=kaba100.ssh_key,
                    db_path=kaba100.db_path,
                    gui_url=kaba100.gui_url,
                    deploy_timestamp=ts,
                    pre_deploy_baselines=backup.baselines,
                    canary_gate_available=(i >= 1),
                    is_extraction_bundle=bundle.id in ("B8", "B10"),
                )
                results = run_all_checks(ctx)
                evidence = collect_evidence(bundle.id, results,
                                            REPO_ROOT / "pipeline-evidence")

                if not evidence["passed"]:
                    restore_gateway(kaba100, backup.backup_path)
                    _halt(f"Verification FAILED: {_first_failure(results)}",
                          bundle, state)
                    return

                print(f"  Verification PASSED ({len(results)} checks)")

            # --- Phase 3: Soak ---
            if bundle.soak_hours > 0:
                state.status = "soaking"
                state.soak_start_epoch = time.time()
                save_state(state)
                heartbeat.start(bundle.name)
                print(f"  Soaking for {bundle.soak_hours}h...")

                soak_end = time.time() + bundle.soak_hours * 3600
                while time.time() < soak_end:
                    time.sleep(min(3600, soak_end - time.time()))

                heartbeat.stop()

                if not dry_run:
                    results = run_all_checks(ctx)
                    evidence = collect_evidence(f"{bundle.id}-postsoak", results,
                                                REPO_ROOT / "pipeline-evidence")
                    if not evidence["passed"]:
                        restore_gateway(kaba100, backup.backup_path)
                        _halt(f"Post-soak verification FAILED: {_first_failure(results)}",
                              bundle, state)
                        return
                    print("  Post-soak verification PASSED")

        # --- Phase 4: Merge to main + tag ---
        state.status = "merging"
        save_state(state)

        if bundle.prs:
            if not dry_run:
                if not merge_to_main(f"bundle/{bundle.name}", REPO_ROOT):
                    _halt("Merge to main failed", bundle, state)
                    return
                state.checkpoint_counter += 1
                tag = tag_checkpoint(state.checkpoint_counter, REPO_ROOT)
                delete_branch(f"bundle/{bundle.name}", REPO_ROOT)
                print(f"  Merged to main, tagged {tag}")
                send_alert(ALERT_TOPIC,
                           f"Checkpoint {tag} — {bundle.name}",
                           f"Bundle {bundle.id} verified + merged. {len(bundle.items)} items.",
                           priority="default")

    state.status = "complete"
    save_state(state)
    send_alert(ALERT_TOPIC, "Pipeline complete",
               "All bundles processed.", priority="high")


def main() -> None:
    parser = argparse.ArgumentParser(description="Refactor execution engine")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from saved state")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip actual deploys")
    args = parser.parse_args()

    if not args.resume:
        save_state(PipelineState())

    run_pipeline(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
