# Security Implementation Plan

This plan is based on the `dendrov2` branch in both:

- `osi-os`
- `osi-server`

It is intentionally pragmatic for this project context:

- offline-first operation matters
- field maintenance and recovery matter
- some operational simplicity is worth preserving
- fixes should avoid breaking the existing OSI OS <-> OSI Server sync model unless explicitly redesigned

## Guiding Principles

1. Eliminate trivial compromise paths first.
2. Preserve offline usability and maintenance workflows.
3. Avoid coordinated cross-repo protocol changes until they are clearly designed.
4. Prefer hardening that fits the current architecture before redesigning the architecture.

## Current Architectural Constraint

The main design constraint is the linked-account flow between `osi-os` and `osi-server`.

Today, `osi-os` account linking:

1. Authenticates to `osi-server` via `/auth/local-sync`
2. Receives back cloud auth data including `passwordHash`
3. Stores that verifier locally
4. Uses it for later local login when `auth_mode='server'`

Because of that, `osi-server` cannot simply stop returning `passwordHash` without first redesigning how linked-user login works on the Pi.

## Phase 1: High-Value Changes That Fit The Existing Design

These should be done first because they reduce risk significantly without disrupting the current edge/cloud sync model.

### 1. OSI OS: Replace Base64 Tokens With Signed Tokens

Goal:

- remove trivial token forgery
- keep the frontend contract unchanged

Approach:

- keep bearer-token usage in the frontend unchanged
- change Node-RED auth generation and verification to use signed tokens
- update all protected endpoints consistently

Notes:

- this is compatible with the current UI because the frontend treats the token as opaque
- do not leave mixed auth paths where some endpoints still trust decoded base64 usernames

### 2. OSI OS: Hash Local Passwords With Bcrypt

Goal:

- stop storing plaintext local passwords

Approach:

- hash passwords during local registration
- validate local passwords with `bcrypt.compare`
- preserve the current `auth_mode='local'` vs `auth_mode='server'` split

Notes:

- this change is compatible with the current linked-account flow as long as server-linked login behavior remains unchanged for now

### 3. OSI OS: Remove Or Gate Database Download

Goal:

- prevent full DB exfiltration over HTTP

Approach:

- disable `/download/database` by default
- if operationally needed, expose it only in a maintenance mode or over trusted support workflows

Recommended project-fit option:

- maintenance-mode gate instead of permanent removal

### 4. OSI OS: Add Real Authorization To Privileged Endpoints

Priority endpoints:

- system reboot
- fan control
- zone location updates
- account-link endpoints
- other device/admin actions that currently trust weak auth

Goal:

- require valid signed auth and ownership/admin checks before state changes

### 5. OSI Server: Validate Command ACK Against Device Ownership

Goal:

- ensure a command acknowledgment only updates the command for the device it belongs to

Approach:

- when processing `command_ack`, verify that the `commandId` belongs to the same `deviceEui` topic that submitted the ACK

Notes:

- this should not require a protocol change on the Pi side

## Phase 2: Sync-Compatible Hardening

These changes improve security while staying aligned with the current design.

### 6. OSI Server: Remove Telemetry-Based `cloudUserId` Auto-Claim

Goal:

- stop assigning ownership based on telemetry payload fields

Why this fits:

- the active account-link flow already claims devices via `/api/v1/devices/claim-bulk`
- `cloudUserId` auto-claim appears to be an extra path, not the main workflow

### 7. OSI Server: Add WebSocket Subscription Authorization

Goal:

- ensure users only receive updates for devices they own
- allow admin access where needed

Approach:

- authorize subscriptions by device ownership or admin role
- preserve the existing frontend subscription model where possible

### 8. OSI OS: Reduce SQL String Construction In High-Risk Flows

Goal:

- reduce injection risk and improve maintainability

Start with flows related to:

- auth
- account linking
- device ownership and claims
- privileged system endpoints

Notes:

- this is both a security improvement and a robustness improvement
- prioritize high-impact flows rather than trying to rewrite all Node-RED SQL at once

### 9. OSI OS: Constrain Account-Link `serverUrl` Pragmatically

Goal:

- reduce SSRF and credential exfiltration risk

Recommended behavior:

- default to `https`
- block loopback/private targets unless a maintenance or dev flag is enabled
- keep flexibility for field setups rather than enforcing a rigid global allowlist

## Phase 3: Redesign Linked Account Auth

This is the only area that requires a coordinated design change across both repos.

### Problem

The current linked-account design reuses cloud password-verifier material on the Pi.

That creates two problems:

- cloud password-derived material leaves the server
- `local-sync` cannot be hardened cleanly without breaking offline linked-user login

### Recommended Replacement

Introduce a dedicated Pi-scoped offline auth verifier for linked accounts.

### Proposed Flow

1. `osi-os` submits account-link request to `osi-server`
2. `osi-server` authenticates the cloud user
3. `osi-server` returns:
   - token
   - username
   - userId
   - Pi-scoped `offlineVerifier` or linked-login secret
4. `osi-os` stores that verifier locally
5. `osi-os` uses that verifier only for `auth_mode='server'` local login
6. `osi-server` stops returning cloud password hashes

### Why This Is The Best Fit

- preserves offline login after linking
- preserves field usability
- avoids syncing cloud password-hash material to the Pi
- fits the project better than forcing cloud-linked users to always be online

## Recommended Delivery Order

1. `osi-os`: signed tokens
2. `osi-os`: bcrypt for local accounts
3. `osi-os`: protect or disable DB download
4. `osi-os`: authz on privileged endpoints
5. `osi-server`: validate command ACK device ownership
6. `osi-server`: remove telemetry `cloudUserId` auto-claim
7. `osi-server`: authorize WebSocket subscriptions
8. `osi-os`: targeted SQL hardening
9. coordinated redesign of linked-account offline verifier
10. remove `passwordHash` from `osi-server` `local-sync`

## Suggested Work Split

### First `osi-os` PR

- signed auth tokens
- bcrypt local passwords
- privileged endpoint authz
- DB download gating

### First `osi-server` PR

- command ACK validation
- remove telemetry auto-claim
- WebSocket authorization groundwork

### Coordinated Cross-Repo PR Pair

- redesign `local-sync`
- add Pi-specific offline verifier for linked accounts
- remove cloud password-hash return path

## Things Not To Prioritize First

These may still be worth doing later, but they are not the highest-leverage first moves for this project.

- replacing frontend `localStorage` auth with cookies
- aggressively removing flexible maintenance workflows
- broad hardening that increases support burden before trivial auth flaws are fixed

## Project Policy Recommendation

For this platform, a good operating rule is:

> Anything that can reboot hardware, expose databases, change ownership, or sync credentials must require strong authenticated access.

Everything else can remain simpler if it stays local, understandable, and maintainable.
