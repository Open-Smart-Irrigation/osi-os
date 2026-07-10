"""Git operations: branch create, merge, tag, rebase."""
from __future__ import annotations
import subprocess
from pathlib import Path


def run_git(args: list[str], cwd: Path | None = None,
            timeout: int = 120) -> subprocess.CompletedProcess:
    return subprocess.run(["git"] + args, capture_output=True, text=True,
                          cwd=cwd, timeout=timeout)


def create_bundle_branch(bundle_name: str, cwd: Path) -> str:
    branch = f"bundle/{bundle_name}"
    run_git(["checkout", "main"], cwd=cwd)
    run_git(["pull", "--ff-only"], cwd=cwd)
    run_git(["checkout", "-b", branch], cwd=cwd)
    return branch


def merge_to_main(branch: str, cwd: Path) -> bool:
    run_git(["checkout", "main"], cwd=cwd)
    r = run_git(["merge", "--no-ff", branch, "-m",
                 f"Merge {branch} — pipeline verified"], cwd=cwd)
    return r.returncode == 0


def tag_checkpoint(n: int, cwd: Path) -> str:
    tag = f"agrolink-checkpoint-{n}"
    run_git(["tag", tag], cwd=cwd)
    run_git(["push", "origin", "main", tag], cwd=cwd)
    return tag


def delete_branch(branch: str, cwd: Path) -> None:
    run_git(["branch", "-d", branch], cwd=cwd)
    run_git(["push", "origin", "--delete", branch], cwd=cwd)


def cherry_pick_pr(pr_branch: str, cwd: Path) -> bool:
    """Merge a PR branch into the current branch."""
    r = run_git(["merge", f"origin/{pr_branch}", "--no-ff",
                 "-m", f"Merge {pr_branch} into bundle"], cwd=cwd)
    if r.returncode != 0 and "CONFLICT" in (r.stdout + r.stderr):
        run_git(["merge", "--abort"], cwd=cwd)
        return False
    return r.returncode == 0
