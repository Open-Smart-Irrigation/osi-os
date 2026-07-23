# AgroLink edge/cloud parity orchestrator prompt

Start now. Execute the autonomous program in
`docs/superpowers/plans/2026-07-23-agrolink-edge-cloud-parity-orchestrator.md`
from Task 0 through Task 11. Maintain the matrix and execution report beside
it as live control documents.

Do not ask the user for confirmation, preferences, prompts, approvals, or tool
permissions during the run. The decisions in the program are binding. When an
external dependency blocks one slice, record it, continue every independent
task in numbered order, then retry the blocker before final verification.

## Verified handoff

- OSI OS integration branch: `design-sync/agrolink`.
- OSI Server integration branch: `AgroLink`.
- OSI Server contains Testcontainers compatibility commit
  `bee9435cf17b14ce582db61cc4bc9f1215657b8b`.
- Network-drive design v3.1 and Phase 1 plan v2 are finished planning inputs.
  No network-drive implementation commit exists. Do not execute that plan.
- `/home/phil/Repos/osi-os-agrolink` retains unrelated generated GUI/locales
  and an office lock file. It is quarantined. Do not clean, stage, reset, or
  execute parity work there.
- Scoped Phase A source head `8921e6d1` is cumulative patch material, not a
  merge-ready branch. Revalidate and renumber it as specified by Task 3.

Fetch both repositories and verify these facts against the current refs. Use a
clean isolated worktree for every implementation slice. If an old plan
conflicts with this prompt, this prompt controls execution order and resource
limits; the orchestrator plan controls product semantics.

## Sequential execution

Use `superpowers:executing-plans`. Do not use subagents,
`subagent-driven-development`, or parallel dispatch.

Exactly one numbered task is active at a time. Within it, run one mutation,
test, build, container-backed suite, or commit operation at a time. Monitoring
the active command is the only concurrent activity allowed.

Execute:

1. Launch prerequisites and Task 0 rebaseline.
2. Task 1 governing-document refresh.
3. Task 2 cross-repository contract gate.
4. Task 3 scoped Phase A repair.
5. Task 4 durable desired state and conflict handling.
6. Task 5 journal server parity.
7. Task 6 scoped edge Phases B-D.
8. Task 7 server scoped enforcement and cloud access administration.
9. Task 8 remaining portable parity.
10. Task 9 durable history batch coverage.
11. Task 10 installation-bound recovery within the external-provider limit.
12. Task 11 full verification and handoff.

Finish and push each accepted slice before starting the next. Use test-first
implementation, then perform a separate full-diff self-review and fresh
verification. Update the matrix and execution report after every slice.

## Memory guard

The handoff sample had 23,379 MiB total RAM and 12,048 MiB available. Swap was
already populated, so decide pressure from `MemAvailable` and changing swap
counters, not from swap usage alone.

Before each task and every heavyweight command, record:

```bash
free -m
awk '/pswpin|pswpout/ {print}' /proc/vmstat
ps -eo pid,ppid,rss,comm,args --sort=-rss | head -n 12
```

For a command running longer than 30 seconds, yield or poll at most every
30 seconds and sample memory between polls.

- `MemAvailable >= 4096 MiB`: the next command may start.
- `MemAvailable` from 2048 to 4095 MiB: start no new heavyweight command.
  Finish the current owned command, then wait and recheck.
- `MemAvailable < 2048 MiB`: gracefully terminate only the heavyweight process
  started by this run. Do the same when available memory falls more than
  1024 MiB across two samples while `pswpout` rises.
- After three 30-second recovery checks below 4096 MiB, mark that heavyweight
  gate resource-blocked, continue lightweight work, and retry it before any
  dependent commit.

Run Gradle with `--no-daemon --max-workers=2`. For frontend builds, set
`NODE_OPTIONS=--max-old-space-size=2048`. Run one Docker-backed suite at a
time. Never kill unrelated user processes, clear system caches, disable swap,
or start a second build to save time.

## Product contract

- OSI OS is canonical. Cloud edits create durable desired state and REST
  pending commands.
- Zone and journal edits render immediately from desired state while sync runs
  in the background.
- Separate accounts remain the default. Roles are scoped per gateway.
- REST is the only cloud-to-edge command path.
- Device provisioning already exists. Extend its authorization and parity;
  do not redesign it.
- The supported catalog has six device families. UC512 stays hidden.
- Network-drive tables, SMB state, and imported external readings stay
  edge-local and outside this run.
- Retain the legacy durable history path.
- Do not select or provision an external recovery-key service. Implement the
  local abstraction and record provider selection as deferred.
- Do not access production, `osicloud.ch`, live gateways, or a real SMB share.

## Block without prompting

For a red base gate or code defect, diagnose and repair it within the current
slice. For missing external authority, credentials, paid services, production
access, Agroscope IT input, or an unsafe destructive action:

1. Record the exact evidence and dependent tasks in the execution report.
2. Apply the least-destructive local default already allowed by the plan.
3. Skip only work that depends on the missing input.
4. Continue the remaining numbered tasks.
5. Retry recorded blockers before Task 11.

Do not weaken tests, invent credentials, touch production, delete history, or
broaden the program to avoid a blocker. End with `blocked` only when every
remaining task depends on an unresolved external condition. Otherwise continue
until the definition of done is met.

## Delivery

Commit and push reviewed slices directly:

- OSI OS: `design-sync/agrolink`
- OSI Server: `AgroLink`

No pull request is required. Use explicit file lists, keep paired commits in
their own repositories, record both SHAs, and verify the remote branch after
each push.
