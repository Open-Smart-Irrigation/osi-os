# Deploy Canary Gate - Rollout Runbook

**Spec:** `docs/superpowers/specs/2026-07-07-deploy-canary-gate-design.md`
**Script:** `scripts/deploy-canary-gate.js`
**Scope:** operator procedure for using the gate between manual per-Pi deploy steps. The gate does not deploy, does not roll back, and does not orchestrate the fleet; it is the go/no-go check.

## When to use

After running `deploy.sh` or any manual flows/schema push against a gateway, before moving on to the next gateway or declaring the rollout done.

## Usage

```bash
export OSI_ADMIN_TOKEN=<admin JWT>
node scripts/deploy-canary-gate.js \
  --eui <GATEWAY_EUI> \
  --since <ISO8601 timestamp of when the deploy started> \
  [--server https://server.opensmartirrigation.org] \
  [--expect-schema-sig <sig>]
```

Use `--expect-schema-sig` for schema-changing deploys, such as migration `0004` delivery.

Exit codes: `0` = pass, advance to the next gateway; `1` = fail, investigate the stderr reasons before advancing; `2` = usage/auth/transport error, the gate could not judge, so treat it as fail.

## Rollout Shape

`deploy kaba100 -> gate kaba100 -> deploy Silvan -> gate Silvan`

Each gateway is gated independently before moving to the next. A fail or exit `2` stops the rollout at that gateway.

## Uganda

Uganda (#87) runs inside its own deploy window using this same gate as the final verification step. The heartbeat is Uganda's only remote post-migration signal per the Option B plan. No SSH-based verification substitutes for the gate's judgment; if the gate fails, follow the standard live-ops incident path (`osi-live-ops-runbook` skill) before retrying.

## What the Gate Does Not Do

- Does not deploy or roll back.
- Does not orchestrate multiple gateways in parallel; run one gateway per invocation.
- Does not SSH or inspect the Pi directly. It is a pure consumer of osi-server's `GET /api/v1/admin/sync-health`, so it can run from any operator machine that can reach the cloud.

## Evidence

Item 0.1's demo-gateway deploy for kaba100 and Silvan is the gate's first live validation. Record its pass output from stdout/stderr as evidence in that rollout's tracking issue or PR.
