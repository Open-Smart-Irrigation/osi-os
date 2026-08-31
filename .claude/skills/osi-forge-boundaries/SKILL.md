---
name: osi-forge-boundaries
description: Use when an OSI Forge worker or controller is executing an issue-to-PR task, writing execution reports, deciding whether a requested action is allowed in Stage 1, or preparing branch/PR evidence from a disposable worktree.
---

# OSI Forge Boundaries

## Overview

Forge Stage 1 agents work in disposable test-VPS worktrees and prove changes
with local commands. The two approved repositories are `osi-os` and
`osi-server`, with exactly one repository assigned to each job. Agents do not
deploy, SSH, read live secrets, inspect production, or merge their own work. If
correct execution appears to require a forbidden action, stop and write the
finding into `execution-report.md`.

Stage 1 accepts risk class 0-2 jobs. Requests that need production access, live
gateway mutation, or deployment-only proof are stop-and-report outcomes.

Verified context: the current controller creates branches named
`forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>`. Legacy
`agent/req-*` branches remain readable only for historical jobs. Draft-PR and
evidence requirements originate in
`docs/superpowers/specs/2026-07-08-field-to-pr-design.md`. Production
restrictions are in `AGENTS.md` ("Production cloud access").

## Environment

| Allowed in Stage 1 | Not allowed in Stage 1 |
|---|---|
| Disposable worktree on a test VPS | SSH to any gateway or server |
| Local repo reads and writes within the assigned scope | Docker or host-level service mutation |
| Repository-owned tests, builds, and static verifiers | Reading server `.env` or credential files |
| Git commits on the assigned `forge/*` branch | Touching a live gateway or `osicloud.ch` |
| Draft PR creation from the assigned `forge/*` branch | Pushing any other branch, marking ready, or merging |

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
| Branch names outside `forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>` | Keeps each repository, issue, and immutable attempt bound to one automation branch. |
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
| Tailscale or controller admin commands | Worker identities cannot enter the operator control plane. |
| Provider, model-routing, or authentication changes | These are controller policy, not job scope. |

## Repository Boundary

An `osi-os` job may edit and verify only its assigned OSI OS worktree. Existing
edge, hardware, profile-parity, schema, migration, live-Pi, and production
restrictions continue to apply.

An `osi-server` job may run repository-owned backend, frontend, and
prediction-service checks in its assigned OSI Server worktree. It may not
deploy the server, access production, read live secrets, open a Docker socket,
or mutate a host service.

Cross-repository evidence may identify a required companion change, but the
worker must not edit the sister repository. Record the dependency and leave it
for a separate job.

## Provider and Control Boundary

The controller owns role assignment, subscription authentication, model
routing, cancellation, and publication. Workers cannot change those policies
or invoke a provider outside the assigned stage. Subscription exhaustion marks
the job `BLOCKED_USAGE`; it never enables API-key, metered, or other paid
fallback.

After implementation or repair, the controller runs the deterministic
post-execution gate and repository verification before any reviewer. A failed
gate or verification command vetoes publication; no model may override it.
For a passing candidate, Codex Sol reviews first, OpenCode Go reviews the same
SHA independently, and Claude Opus independently reviews the diff before its
final adjudication. Draft publication requires all three reviewers to approve
evidence bound to that candidate SHA and repair count.

The controller permits at most one Luna repair. Starting that repair discards
all earlier gate, verification, and review approvals. The repaired candidate
must pass fresh gates, repository verification, and the complete three-reviewer
sequence. Any remaining rejection blocks the job; the controller must not
start a second repair.

The human `forge-admin` Tailscale path is an operator capability. It is not
available to workers and does not grant them SSH, controller admin commands,
deployment rights, or secret access.

Authenticated GitHub Mobile commands are limited to `start`, `status`,
`cancel`, `retry`, and an allowlisted OpenCode reviewer override. No mobile
command may change the worker model, controller policy, repository, base
branch, risk class, or authentication source.

## Deployment Awareness

| Need | Stage 1 handling |
|---|---|
| Prove parser, schema, flow, GUI, codec, backend, frontend, or contract behavior locally inside an allowed class 0-2 job | Run the repository-owned verifier or test command and paste real output into `execution-report.md`. |
| Prove a change works only after deployment to a gateway or cloud service | Stop and report. Runtime deployment verification wrappers are Stage 2 - not yet available. |
| Verify a live Pi, Node-RED runtime, ChirpStack, MQTT, or cloud pending-command path | Stop and report. Stage 1 has no SSH, live gateway, or production access. |
| Need a deploy/verify wrapper named by a spec | If the wrapper is not present and approved in the current Stage 1 runner, stop and report "Stage 2 - not yet available"; do not emulate it manually. |

## Branch and PR Contract

- Start from an issue or request artifact; do not invent scope outside it.
- Use the controller-assigned
  `forge/<repo-short-name>/<issue-number>-<slug>/attempt-<n>` branch. Never
  choose or rewrite the repository, issue, slug, or attempt identity.
- Treat `agent/req-*` as a historical read-only shape. Do not create a new
  branch with that prefix.
- Open a draft PR only. The PR body must include issue link, root cause, files
  changed, commands run, and pasted evidence.
- Never self-approve, mark ready, merge, squash, retarget, or delete branches.
  Human integration actions remain outside the worker path.
- Push only the exact controller-assigned `forge/*` branch. A different branch
  name is a stop-and-report condition.

## Blocked Execution

If the correct next step appears to require a prohibited action:

1. Stop before doing it.
2. Write the exact missing capability or forbidden requirement in
   `execution-report.md`.
3. Include the local evidence already collected.
4. Mark status `BLOCKED` or `DONE_WITH_CONCERNS`, not `DONE`.

## Common Mistakes

- Treating "test VPS" as permission to read host secrets or mutate services.
- Editing both repositories in one job because a cross-repository dependency
  was discovered.
- Calling an unimplemented Stage 2 wrapper by hand through SSH, Docker, or curl.
- Treating the human `forge-admin` Tailscale path as a worker capability.
- Falling back to API-key or metered provider usage when a subscription is
  exhausted.
- Claiming deployment proof when only local verifier output exists.
- Assuming an action is allowed because no current gate blocks it. Review policy
  still applies.
- Opening a normal PR, marking ready, approving, or merging from the worker.
