---
name: osi-forge-boundaries
description: Use when an OSI Forge worker or controller is executing an issue-to-PR task, writing execution reports, deciding whether a requested action is allowed in Stage 1, or preparing branch/PR evidence from a disposable worktree.
---

# OSI Forge Boundaries

## Overview

Forge Stage 1 agents work in disposable test-VPS worktrees and prove changes
with local commands. They do not deploy, SSH, read live secrets, inspect
production, or merge their own work. If correct execution appears to require a
forbidden action, stop and write the finding into `execution-report.md`.
Stage 1 is limited to `osi-os` jobs with risk class 0-2; requests that need
production access, live gateway mutation, or deployment-only proof are
stop-and-report outcomes.

Verified context: branch naming and draft-PR shape are specified in
`docs/superpowers/specs/2026-07-08-field-to-pr-design.md` (`agent/req-*`,
draft PR, evidence body). Production restrictions are in `AGENTS.md`
("Production cloud access").

## Environment

| Allowed in Stage 1 | Not allowed in Stage 1 |
|---|---|
| Disposable worktree on a test VPS | SSH to any gateway or server |
| Local repo reads and writes within the assigned scope | Docker or host-level service mutation |
| Local tests, build commands, static verifiers | Reading server `.env` or credential files |
| Git commits on the assigned branch | Touching a live gateway or `osicloud.ch` |
| Draft PR creation from `agent/*` branches | Pushing non-`agent/*` branches or merging |

## Absolute Prohibitions

### Mechanical gate targets in the Stage 1 controller

These are the checks the Stage 1 runner must reject before a public draft PR is
pushed. If the active runner does not expose that gate yet, stop and report the
gap instead of assuming human review will catch it later.

| Prohibition | Why |
|---|---|
| Secret-looking values in diffs | Prevents token, key, AppKey, password, and credential leakage into git history. |
| Credential paths in diffs | Prevents accidental reads or writes of `.env`, SSH keys, Node-RED credentials, gateway tokens, and similar files. |
| Oversized diffs beyond the request limit | Keeps worker output reviewable and prevents broad, uncontrolled edits. |
| Branch names outside the allowed `agent/*` / `agent/req-*` shape | Keeps automation isolated from maintainer and production branches. |
| Controller content-scan findings when enabled for the current job | Honors task-specific deny lists without pretending every policy item is universally scanned. |

### Policy, caught by review unless a gate also exists

These may not be mechanically enforced by `gates.py` or the current runner.
They are still forbidden by policy and should be reported when seen.

| Prohibition | Why |
|---|---|
| Outbound HTTP calls during implementation or verification | Stage 1 evidence is local-only unless the task explicitly provides an approved wrapper. |
| Reading arbitrary environment variables | Env can carry secrets and target identity; Forge workers should not learn host credentials. |
| Raw IP addresses in new code or docs | They can bypass named-environment policy and hide production coupling. |
| SSH, live gateway access, or `osicloud.ch` access | Live farms and production cloud are outside Forge Stage 1. |
| Docker or host service mutation | The disposable worktree is the boundary; do not mutate the worker host. |

## Deployment Awareness

| Need | Stage 1 handling |
|---|---|
| Prove parser, schema, flow, GUI, codec, or contract behavior locally inside an allowed class 0-2 job | Run the local verifier or test command and paste real output into `execution-report.md`. |
| Prove a change works only after deployment to a gateway or cloud service | Stop and report. Runtime deployment verification wrappers are Stage 2 - not yet available. |
| Verify a live Pi, Node-RED runtime, ChirpStack, MQTT, or cloud pending-command path | Stop and report. Stage 1 has no SSH, live gateway, or production access. |
| Need a deploy/verify wrapper named by a spec | If the wrapper is not present and approved in the current Stage 1 runner, stop and report "Stage 2 - not yet available"; do not emulate it manually. |

## Branch and PR Contract

- Start from an issue or request artifact; do not invent scope outside it.
- Use `agent/req-<shortid>-<slug>` for Forge worker branches unless the task
  gives a stricter branch name.
- Open a draft PR only. The PR body must include issue link, root cause, files
  changed, commands run, and pasted evidence.
- Never self-approve, mark ready, merge, squash, retarget, or delete branches
  unless the maintainer explicitly instructs it in the current turn.
- Push only `agent/*` worker branches. If the assigned task names a
  non-`agent/*` branch, commit locally and stop for controller handling.

## Blocked Execution

If the correct next step appears to require a prohibited action:

1. Stop before doing it.
2. Write the exact missing capability or forbidden requirement in
   `execution-report.md`.
3. Include the local evidence already collected.
4. Mark status `BLOCKED` or `DONE_WITH_CONCERNS`, not `DONE`.

## Common Mistakes

- Treating "test VPS" as permission to read host secrets or mutate services.
- Calling an unimplemented Stage 2 wrapper by hand through SSH, Docker, or curl.
- Claiming deployment proof when only local verifier output exists.
- Assuming an action is allowed because no current gate blocks it. Review policy
  still applies.
- Opening a normal PR, marking ready, approving, or merging from the worker.
