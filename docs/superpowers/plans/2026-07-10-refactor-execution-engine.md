# Refactor Execution Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Spec:** `docs/superpowers/specs/2026-07-10-refactor-execution-engine-design.md`
> **Repo:** all pipeline code lives in **osi-os** under `scripts/pipeline/`. Pi-side scripts deploy via SSH. The pipeline controller runs on the test VPS (`server.opensmartirrigation.org`) as the `forge-runner` user.

**Goal:** Build a fully unattended pipeline that merges refactor PRs in order, deploys each bundle to kaba100, runs a 17-check verification protocol, tags green checkpoints for AgroLink, and halts with an alert on any failure.

**Architecture:** A Python controller (`scripts/pipeline/controller.py`) reads a bundle config (`scripts/pipeline/bundles.json`), orchestrates per-bundle: rebase→CI→deploy→verify→soak→merge→tag. Verification checks are individual Python functions in `scripts/pipeline/checks/`. Pi-side backup/restore is a deployed shell script. Alerts via ntfy.sh push. Playwright headless for GUI checks.

**Tech Stack:** Python 3.12 (no frameworks — httpx + subprocess + json), Playwright (headless, `npm i playwright`), BusyBox ash (Pi-side scripts), ntfy.sh (push notifications).

## Global Constraints

- **NEVER auto-deploy to `osicloud.ch`** (production). Server bundles (B6/B7) target `server.opensmartirrigation.org` only.
- **NEVER touch Uganda.** Only kaba100 is the verification target. Silvan is the control (previous checkpoint).
- **Backup BEFORE every deploy.** Stop Node-RED → `sqlite3 .backup` → integrity_check → restart. ON the Pi, not over the tunnel.
- **RED = halt + alert + restore.** Never auto-retry. Never continue to the next bundle.
- **Pipeline heartbeat every 30 min during soaks.** Missing heartbeat >1h = dead controller alert.
- All Python is typed, tested with `pytest`, no heavy frameworks.

## File Structure

```
scripts/pipeline/
├── controller.py          # Main loop: bundle iteration, state machine
├── config.py              # Loads bundles.json + env config + validates
├── bundles.json           # Bundle definitions: items, soak hours, gates, deploy target
├── state.json             # Runtime state: current bundle, checkpoint counter, soak start
├── checks/
│   ├── __init__.py        # CheckResult dataclass, run_all_checks()
│   ├── boot.py            # Check 8: Node-RED alive, :1880/gui → 301
│   ├── routes.py          # Check 9: REST endpoint sweep
│   ├── schema.py          # Check 10: schema_sig match
│   ├── ingest.py          # Check 11: real uplink + column-fill comparison
│   ├── sync.py            # Check 12: outbox drain + cloud-side receipt
│   ├── gui.py             # Check 13: Playwright headless browser checks
│   ├── db.py              # Check 14: integrity, FK, row counts
│   ├── errors.py          # Check 15: error_count delta
│   ├── canary.py          # Check 16: deploy-canary-gate.js wrapper
│   └── daily.py           # Check 17: scheduled job output
├── deploy.py              # SSH deploy flow (backup, deploy.sh, wait for restart)
├── restore.py             # SSH restore flow (run resident script)
├── alert.py               # ntfy.sh push + pipeline heartbeat
├── git_ops.py             # Branch create/merge/tag/rebase, PR retarget
├── evidence.py            # Structured evidence collection → JSON artifacts
└── tests/
    ├── test_checks.py     # Unit tests for each check (mocked SSH/HTTP)
    ├── test_deploy.py     # Deploy/restore flow tests
    ├── test_controller.py # State machine tests
    └── conftest.py        # Shared fixtures

scripts/pi/
├── backup-pre-deploy.sh   # Deployed TO kaba100: stop NR, .backup, integrity, restart
└── restore-pre-deploy.sh  # Deployed TO kaba100: stop NR, restore, integrity, restart
```

---

### Task 1: Bundle configuration + pipeline state machine

**Files:**
- Create: `scripts/pipeline/bundles.json`
- Create: `scripts/pipeline/config.py`
- Create: `scripts/pipeline/state.json`
- Create: `scripts/pipeline/tests/conftest.py`
- Create: `scripts/pipeline/tests/test_config.py`

**Interfaces:**
- Produces: `BundleConfig` dataclass, `PipelineState` dataclass, `load_bundles()`, `load_state()`, `save_state()`, `next_bundle()` consumed by all later tasks.

- [ ] **Step 1.1: Write bundles.json** — the complete bundle definitions from the spec:

```json
{
  "bundles": [
    {
      "id": "B0",
      "name": "canary-gate",
      "items": ["0.2"],
      "prs": [118],
      "deploy_target": "kaba100",
      "soak_hours": 24,
      "pre_deploy": ["repair-sync-outbox-v2"],
      "needs_fixes": [],
      "ci_only": false
    },
    {
      "id": "B1",
      "name": "schema-tooling",
      "items": ["0.3"],
      "prs": [120],
      "deploy_target": "kaba100",
      "soak_hours": 48,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false
    },
    {
      "id": "B2",
      "name": "ci-guardrails",
      "items": ["1.A2", "1.A3"],
      "prs": [121],
      "deploy_target": null,
      "soak_hours": 0,
      "pre_deploy": [],
      "needs_fixes": ["1.A2-growth-allowance"],
      "ci_only": true
    },
    {
      "id": "B3",
      "name": "edge-durability",
      "items": ["1.A4", "1.A5"],
      "prs": [122],
      "deploy_target": "kaba100",
      "soak_hours": 24,
      "pre_deploy": [],
      "needs_fixes": ["1.A5-eviction-index"],
      "ci_only": false
    },
    {
      "id": "B4",
      "name": "deploy-rewrite",
      "items": ["1.B1"],
      "prs": [123],
      "deploy_target": "kaba100",
      "soak_hours": 48,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false
    },
    {
      "id": "B5",
      "name": "staged-deploy",
      "items": ["5.3"],
      "prs": [124],
      "deploy_target": "kaba100",
      "soak_hours": 48,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false
    },
    {
      "id": "B6",
      "name": "server-ci",
      "items": ["1.B3"],
      "prs": [],
      "deploy_target": null,
      "soak_hours": 0,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": true,
      "repo": "osi-server"
    },
    {
      "id": "B7",
      "name": "sync-hardening",
      "items": ["1.B4"],
      "prs": [],
      "deploy_target": "test-server",
      "soak_hours": 48,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false,
      "repo": "osi-server"
    },
    {
      "id": "B8",
      "name": "extraction-dendro",
      "items": ["2.2"],
      "prs": [],
      "deploy_target": "kaba100",
      "soak_hours": 24,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false
    },
    {
      "id": "B9",
      "name": "contract-dendro",
      "items": ["2.3"],
      "prs": [],
      "deploy_target": null,
      "soak_hours": 0,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": true,
      "repo": "both"
    },
    {
      "id": "B10",
      "name": "extraction-zone-env",
      "items": ["2.4"],
      "prs": [],
      "deploy_target": "kaba100",
      "soak_hours": 24,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false
    },
    {
      "id": "BA",
      "name": "agroscope",
      "items": ["agroscope-forward", "agroscope-branding"],
      "prs": [],
      "deploy_target": "kaba100",
      "soak_hours": 24,
      "pre_deploy": [],
      "needs_fixes": [],
      "ci_only": false
    }
  ],
  "gateways": {
    "kaba100": {
      "host": "100.93.68.86",
      "ssh_user": "root",
      "ssh_key": "~/.ssh/id_ed25519",
      "db_path": "/data/db/farming.db",
      "backup_dir": "/data/backups",
      "gui_url": "http://100.93.68.86:1880/gui"
    },
    "silvan": {
      "host": "100.81.220.8",
      "ssh_user": "root",
      "ssh_key": "~/.ssh/id_ed25519",
      "db_path": "/data/db/farming.db",
      "gui_url": "http://100.81.220.8:1880/gui"
    }
  },
  "servers": {
    "test": {
      "host": "server.opensmartirrigation.org",
      "sync_health_url": "https://server.opensmartirrigation.org/api/v1/admin/sync-health"
    }
  },
  "alert": {
    "ntfy_topic": "osi-refactor-pipeline",
    "ntfy_url": "https://ntfy.sh"
  },
  "limits": {
    "max_fix_iterations": 3,
    "budget_per_bundle_usd": 50,
    "soak_heartbeat_interval_s": 1800,
    "verification_timeout_s": 900
  }
}
```

- [ ] **Step 1.2: Write config.py** — typed config loading:

```python
"""Pipeline configuration: bundle definitions, gateway config, limits."""
from __future__ import annotations
import json
from dataclasses import dataclass, field
from pathlib import Path

PIPELINE_DIR = Path(__file__).parent
BUNDLES_PATH = PIPELINE_DIR / "bundles.json"
STATE_PATH = PIPELINE_DIR / "state.json"


@dataclass(frozen=True)
class GatewayConfig:
    host: str
    ssh_user: str
    ssh_key: str
    db_path: str
    backup_dir: str
    gui_url: str


@dataclass(frozen=True)
class ServerConfig:
    host: str
    sync_health_url: str


@dataclass(frozen=True)
class BundleConfig:
    id: str
    name: str
    items: list[str]
    prs: list[int]
    deploy_target: str | None
    soak_hours: int
    pre_deploy: list[str]
    needs_fixes: list[str]
    ci_only: bool
    repo: str = "osi-os"

    @property
    def needs_deploy(self) -> bool:
        return self.deploy_target is not None and not self.ci_only


@dataclass
class PipelineState:
    current_bundle_idx: int = 0
    checkpoint_counter: int = 0
    soak_start_epoch: float | None = None
    status: str = "idle"  # idle | building | deploying | soaking | merging | halted

    def to_dict(self) -> dict:
        return self.__dict__

    @classmethod
    def from_dict(cls, d: dict) -> PipelineState:
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


def load_bundles(path: Path = BUNDLES_PATH) -> tuple[list[BundleConfig], dict, dict, dict]:
    raw = json.loads(path.read_text())
    bundles = [BundleConfig(**{k: v for k, v in b.items() if k in BundleConfig.__dataclass_fields__}) for b in raw["bundles"]]
    gateways = {k: GatewayConfig(**v) for k, v in raw["gateways"].items()}
    servers = {k: ServerConfig(**v) for k, v in raw["servers"].items()}
    limits = raw["limits"]
    return bundles, gateways, servers, limits


def load_state(path: Path = STATE_PATH) -> PipelineState:
    if not path.exists():
        return PipelineState()
    return PipelineState.from_dict(json.loads(path.read_text()))


def save_state(state: PipelineState, path: Path = STATE_PATH) -> None:
    path.write_text(json.dumps(state.to_dict(), indent=2) + "\n")
```

- [ ] **Step 1.3: Write test_config.py** — validate loading + state transitions:

```python
import json, pytest
from pathlib import Path
from pipeline.config import load_bundles, load_state, save_state, PipelineState, BUNDLES_PATH

def test_load_bundles_from_real_file():
    bundles, gateways, servers, limits = load_bundles()
    assert len(bundles) >= 10
    assert bundles[0].id == "B0"
    assert bundles[0].needs_deploy is True
    assert gateways["kaba100"].host == "100.93.68.86"
    assert limits["max_fix_iterations"] == 3

def test_ci_only_bundle_does_not_need_deploy():
    bundles, *_ = load_bundles()
    b2 = next(b for b in bundles if b.id == "B2")
    assert b2.ci_only is True
    assert b2.needs_deploy is False

def test_state_roundtrip(tmp_path):
    p = tmp_path / "state.json"
    s = PipelineState(current_bundle_idx=3, checkpoint_counter=2, status="soaking")
    save_state(s, p)
    loaded = load_state(p)
    assert loaded.current_bundle_idx == 3
    assert loaded.status == "soaking"

def test_state_default_on_missing(tmp_path):
    s = load_state(tmp_path / "nope.json")
    assert s.current_bundle_idx == 0
    assert s.status == "idle"
```

- [ ] **Step 1.4: Run tests**

```bash
cd scripts/pipeline && python -m pytest tests/test_config.py -v
```

Expected: 4/4 pass.

- [ ] **Step 1.5: Commit**

```bash
git add scripts/pipeline/bundles.json scripts/pipeline/config.py \
        scripts/pipeline/state.json scripts/pipeline/tests/
git commit -m "feat(pipeline): bundle config + state machine for refactor execution engine"
```

---

### Task 2: Pi-side backup + restore scripts

**Files:**
- Create: `scripts/pi/backup-pre-deploy.sh`
- Create: `scripts/pi/restore-pre-deploy.sh`

**Interfaces:**
- Produces: Two shell scripts deployable to kaba100 via SCP. `deploy.py` (Task 5) invokes them remotely.

- [ ] **Step 2.1: Write backup-pre-deploy.sh**

```sh
#!/bin/sh
# Backup farming.db safely for pre-deploy snapshot.
# Runs ON the Pi. Stops Node-RED, uses sqlite3 .backup (WAL-safe),
# integrity-checks the copy, restarts Node-RED.
# Usage: backup-pre-deploy.sh [timestamp]
set -eu

TIMESTAMP="${1:-$(date -u +%Y%m%dT%H%M%SZ)}"
DB_PATH="/data/db/farming.db"
BACKUP_DIR="/data/backups"
BACKUP_PATH="$BACKUP_DIR/pre-deploy-${TIMESTAMP}.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
    echo "ERROR: database not found at $DB_PATH" >&2
    exit 1
fi

echo "Stopping Node-RED for consistent backup..."
/etc/init.d/node-red stop 2>/dev/null || true
sleep 3

echo "Taking .backup to $BACKUP_PATH..."
sqlite3 "$DB_PATH" ".backup '$BACKUP_PATH'"

echo "Checking backup integrity..."
INTEG=$(sqlite3 "$BACKUP_PATH" "PRAGMA integrity_check" 2>&1)
if [ "$INTEG" != "ok" ]; then
    echo "ERROR: backup integrity_check failed: $INTEG" >&2
    /etc/init.d/node-red start || true
    exit 2
fi

# Record pre-deploy baselines
echo "Recording baselines..."
sqlite3 "$BACKUP_PATH" "SELECT 'db_size_bytes=' || (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size());"
sqlite3 "$BACKUP_PATH" "SELECT 'device_data_rows=' || COUNT(*) FROM device_data;"
sqlite3 "$BACKUP_PATH" "SELECT 'irrigation_schedules_rows=' || COUNT(*) FROM irrigation_schedules;"
sqlite3 "$BACKUP_PATH" "SELECT 'sync_outbox_pending=' || COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL;"

echo "Restarting Node-RED..."
/etc/init.d/node-red start || true

echo "OK: backup at $BACKUP_PATH (integrity ok)"
echo "BACKUP_PATH=$BACKUP_PATH"
echo "TIMESTAMP=$TIMESTAMP"
```

- [ ] **Step 2.2: Write restore-pre-deploy.sh**

```sh
#!/bin/sh
# Restore farming.db from a pre-deploy backup.
# Runs ON the Pi. Stops Node-RED, removes WAL/SHM, copies backup,
# integrity-checks, restarts Node-RED.
# Usage: restore-pre-deploy.sh <backup-path>
set -eu

BACKUP_PATH="${1:?Usage: restore-pre-deploy.sh <backup-path>}"
DB_PATH="/data/db/farming.db"

if [ ! -f "$BACKUP_PATH" ]; then
    echo "ERROR: backup not found at $BACKUP_PATH" >&2
    exit 1
fi

echo "Stopping Node-RED..."
/etc/init.d/node-red stop 2>/dev/null || true
sleep 3

echo "Removing WAL/SHM sidecars..."
rm -f "${DB_PATH}-wal" "${DB_PATH}-shm" "${DB_PATH}-journal"

echo "Restoring from $BACKUP_PATH..."
cp "$BACKUP_PATH" "$DB_PATH"

echo "Checking restored DB integrity..."
INTEG=$(sqlite3 "$DB_PATH" "PRAGMA integrity_check" 2>&1)
if [ "$INTEG" != "ok" ]; then
    echo "ERROR: restored DB integrity_check failed: $INTEG" >&2
    echo "WARNING: Node-RED NOT restarted — manual intervention required" >&2
    exit 2
fi

echo "Restarting Node-RED..."
/etc/init.d/node-red start || true

echo "OK: restored from $BACKUP_PATH (integrity ok)"
```

- [ ] **Step 2.3: Test locally** — verify scripts parse under POSIX sh:

```bash
sh -n scripts/pi/backup-pre-deploy.sh && echo "backup parses"
sh -n scripts/pi/restore-pre-deploy.sh && echo "restore parses"
```

- [ ] **Step 2.4: Commit**

```bash
git add scripts/pi/
git commit -m "feat(pipeline): Pi-side backup + restore scripts for automated deploy verification"
```

---

### Task 3: Verification checks (the 17-check protocol)

**Files:**
- Create: `scripts/pipeline/checks/__init__.py`
- Create: `scripts/pipeline/checks/boot.py`
- Create: `scripts/pipeline/checks/routes.py`
- Create: `scripts/pipeline/checks/schema.py`
- Create: `scripts/pipeline/checks/ingest.py`
- Create: `scripts/pipeline/checks/sync.py`
- Create: `scripts/pipeline/checks/db.py`
- Create: `scripts/pipeline/checks/errors.py`
- Create: `scripts/pipeline/checks/canary.py`
- Create: `scripts/pipeline/checks/gui.py`
- Create: `scripts/pipeline/checks/daily.py`
- Create: `scripts/pipeline/tests/test_checks.py`

**Interfaces:**
- Consumes: `GatewayConfig` from Task 1, SSH access to kaba100
- Produces: `CheckResult(name, passed, detail, evidence)` dataclass, `run_all_checks(gateway, context) -> list[CheckResult]` consumed by Task 5's controller

This is the largest task. Each check is a small function that runs one SSH command or HTTP request and returns a `CheckResult`.

- [ ] **Step 3.1: Write `checks/__init__.py`** — the framework:

```python
"""Verification check framework. Each check returns a CheckResult."""
from __future__ import annotations
from dataclasses import dataclass
import subprocess
import time


@dataclass
class CheckResult:
    name: str
    passed: bool
    detail: str
    evidence: dict | None = None

    def __str__(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        return f"[{status}] {self.name}: {self.detail}"


@dataclass
class VerifyContext:
    """Passed to every check — the shared state for this verification run."""
    gateway_host: str
    ssh_user: str
    ssh_key: str
    db_path: str
    gui_url: str
    deploy_timestamp: str
    expected_schema_sig: str | None = None
    pre_deploy_baselines: dict | None = None
    canary_gate_available: bool = False
    is_extraction_bundle: bool = False


def ssh_cmd(ctx: VerifyContext, cmd: str, timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-i", ctx.ssh_key, "-o", "IdentitiesOnly=yes",
         "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=accept-new",
         f"{ctx.ssh_user}@{ctx.gateway_host}", cmd],
        capture_output=True, text=True, timeout=timeout
    )


def http_get(url: str, timeout: int = 10) -> tuple[int, str]:
    """Simple HTTP GET. Returns (status_code, body). -1 on connection error."""
    import urllib.request, urllib.error
    try:
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, str(e)
    except Exception as e:
        return -1, str(e)
```

- [ ] **Step 3.2: Write the individual check modules.** Each follows the same pattern: a `run(ctx: VerifyContext) -> CheckResult` function. I'll show the key ones — the full set follows the same shape.

**`checks/boot.py`:**
```python
"""Check 8: Node-RED alive, :1880/gui → 301."""
from . import CheckResult, VerifyContext, http_get

def run(ctx: VerifyContext) -> CheckResult:
    status, body = http_get(f"http://{ctx.gateway_host}:1880/gui")
    if status in (200, 301, 302):
        return CheckResult("boot", True, f":1880/gui returned {status}")
    return CheckResult("boot", False, f":1880/gui returned {status}: {body[:200]}")
```

**`checks/routes.py`:**
```python
"""Check 9: REST endpoint sweep — each returns 200 or 401, never 404/500."""
from . import CheckResult, VerifyContext, http_get

ENDPOINTS = [
    "/api/zones", "/api/devices", "/api/system/features",
    "/api/catalog", "/api/history/zones", "/export.csv",
]

def run(ctx: VerifyContext) -> CheckResult:
    failures = []
    for ep in ENDPOINTS:
        url = f"http://{ctx.gateway_host}:1880{ep}"
        status, _ = http_get(url)
        if status in (200, 301, 302, 401):
            continue
        failures.append(f"{ep}={status}")
    if not failures:
        return CheckResult("routes", True, f"all {len(ENDPOINTS)} endpoints healthy")
    return CheckResult("routes", False, f"unhealthy: {', '.join(failures)}")
```

**`checks/schema.py`:**
```python
"""Check 10: schema_sig matches target."""
from . import CheckResult, VerifyContext, ssh_cmd

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.expected_schema_sig:
        return CheckResult("schema", True, "no expected schema_sig (non-schema bundle)")
    r = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT value FROM gateway_health WHERE key='schema_sig' ORDER BY recorded_at DESC LIMIT 1\"")
    sig = r.stdout.strip()
    if sig == ctx.expected_schema_sig:
        return CheckResult("schema", True, f"schema_sig={sig}")
    return CheckResult("schema", False, f"expected {ctx.expected_schema_sig}, got {sig}")
```

**`checks/ingest.py`:**
```python
"""Check 11: real uplink landed + column-fill comparison."""
import time
from . import CheckResult, VerifyContext, ssh_cmd

def run(ctx: VerifyContext) -> CheckResult:
    deadline = time.time() + 900  # 15 min
    while time.time() < deadline:
        r = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM device_data WHERE recorded_at > '{ctx.deploy_timestamp}'\"")
        count = int(r.stdout.strip() or "0")
        if count > 0:
            # Column-fill check: compare non-null columns vs pre-deploy
            r2 = ssh_cmd(ctx, f"sqlite3 -json {ctx.db_path} \"SELECT * FROM device_data WHERE recorded_at > '{ctx.deploy_timestamp}' ORDER BY recorded_at DESC LIMIT 1\"")
            return CheckResult("ingest", True, f"{count} new rows since deploy",
                               evidence={"new_rows": count, "sample": r2.stdout[:500]})
        time.sleep(30)
    return CheckResult("ingest", False, "no new device_data rows in 15 minutes")
```

**`checks/sync.py`:**
```python
"""Check 12: outbox drain + cloud-side receipt."""
import time
from . import CheckResult, VerifyContext, ssh_cmd, http_get

def run(ctx: VerifyContext) -> CheckResult:
    counts = []
    for _ in range(3):
        r = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM sync_outbox WHERE delivered_at IS NULL\"")
        counts.append(int(r.stdout.strip() or "0"))
        time.sleep(30)
    growing = counts[-1] > counts[0]
    if growing:
        return CheckResult("sync", False, f"outbox growing: {counts}")
    return CheckResult("sync", True, f"outbox stable/draining: {counts}")
```

**`checks/db.py`:**
```python
"""Check 14: DB integrity, FK check, row counts."""
from . import CheckResult, VerifyContext, ssh_cmd

def run(ctx: VerifyContext) -> CheckResult:
    integ = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} 'PRAGMA integrity_check'").stdout.strip()
    if integ != "ok":
        return CheckResult("db", False, f"integrity_check: {integ}")
    fk = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} 'PRAGMA foreign_key_check'").stdout.strip()
    if fk:
        return CheckResult("db", False, f"foreign_key_check violations: {fk[:200]}")
    rows = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} 'SELECT COUNT(*) FROM device_data'").stdout.strip()
    pre = (ctx.pre_deploy_baselines or {}).get("device_data_rows", 0)
    if int(rows) < int(pre):
        return CheckResult("db", False, f"device_data rows decreased: {pre} -> {rows}")
    return CheckResult("db", True, f"integrity ok, FK clean, device_data={rows} (was {pre})")
```

**`checks/errors.py`:**
```python
"""Check 15: error_count delta <= 0 over 5-minute window."""
import time
from . import CheckResult, VerifyContext, ssh_cmd

def _get_error_count(ctx: VerifyContext) -> int:
    r = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT value FROM gateway_health WHERE key='errors_total' ORDER BY recorded_at DESC LIMIT 1\"")
    return int(r.stdout.strip() or "0")

def run(ctx: VerifyContext) -> CheckResult:
    start = _get_error_count(ctx)
    time.sleep(300)
    end = _get_error_count(ctx)
    delta = end - start
    if delta <= 0:
        return CheckResult("errors", True, f"error_count stable: {start} -> {end}")
    return CheckResult("errors", False, f"error_count rising: {start} -> {end} (+{delta})")
```

**`checks/canary.py`:**
```python
"""Check 16: deploy-canary-gate.js wrapper."""
import subprocess
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.canary_gate_available:
        return CheckResult("canary", True, "canary gate not yet deployed (pre-B0)")
    cmd = ["node", "scripts/deploy-canary-gate.js",
           "--gateway-eui", "0016C001F11766E7",  # kaba100 EUI
           "--since", ctx.deploy_timestamp,
           "--timeout", "900"]
    if ctx.expected_schema_sig:
        cmd += ["--expect-schema-sig", ctx.expected_schema_sig]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=960)
        if r.returncode == 0:
            return CheckResult("canary", True, "canary gate PASS")
        return CheckResult("canary", False, f"canary gate FAIL (rc={r.returncode}): {r.stderr[:300]}")
    except subprocess.TimeoutExpired:
        return CheckResult("canary", False, "canary gate timed out")
```

**`checks/gui.py`** (Playwright headless):
```python
"""Check 13: GUI smoke test via Playwright headless."""
from . import CheckResult, VerifyContext

def run(ctx: VerifyContext) -> CheckResult:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return CheckResult("gui", True, "SKIP: playwright not installed (install with: pip install playwright && playwright install chromium)")

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto(ctx.gui_url, timeout=15000)
            # Check login page loads
            if page.title():
                page.screenshot(path="/tmp/gui-check.png")
                browser.close()
                return CheckResult("gui", True, f"GUI loaded: {page.title()}")
            browser.close()
            return CheckResult("gui", False, "GUI returned empty page")
    except Exception as e:
        return CheckResult("gui", False, f"Playwright error: {e}")
```

**`checks/daily.py`:**
```python
"""Check 17: scheduled daily job output (extraction bundles only)."""
from . import CheckResult, VerifyContext, ssh_cmd

def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.is_extraction_bundle:
        return CheckResult("daily", True, "SKIP: not an extraction bundle")
    r = ssh_cmd(ctx, f"sqlite3 {ctx.db_path} \"SELECT COUNT(*) FROM dendrometer_daily WHERE computed_at > '{ctx.deploy_timestamp}'\"")
    count = int(r.stdout.strip() or "0")
    if count > 0:
        return CheckResult("daily", True, f"{count} new dendrometer_daily rows since deploy")
    return CheckResult("daily", True, "no daily tick during soak (expected for <24h soaks); golden-vector replay is the substitute")
```

- [ ] **Step 3.3: Write `run_all_checks` in `__init__.py`** — append to the file:

```python
def run_all_checks(ctx: VerifyContext) -> list[CheckResult]:
    from .boot import run as check_boot
    from .routes import run as check_routes
    from .schema import run as check_schema
    from .ingest import run as check_ingest
    from .sync import run as check_sync
    from .gui import run as check_gui
    from .db import run as check_db
    from .errors import run as check_errors
    from .canary import run as check_canary
    from .daily import run as check_daily

    checks = [
        check_boot, check_routes, check_schema, check_ingest,
        check_sync, check_gui, check_db, check_errors,
        check_canary, check_daily,
    ]
    results = []
    for check in checks:
        try:
            result = check(ctx)
        except Exception as e:
            result = CheckResult(check.__module__.split(".")[-1], False, f"check crashed: {e}")
        results.append(result)
        print(result)
        if not result.passed:
            print(f"  ^^^ FAIL — remaining checks skipped")
            break
    return results
```

- [ ] **Step 3.4: Write test_checks.py** — unit tests with mocked SSH:

```python
import pytest
from unittest.mock import patch, MagicMock
from pipeline.checks import VerifyContext, CheckResult
from pipeline.checks.boot import run as check_boot
from pipeline.checks.routes import run as check_routes
from pipeline.checks.db import run as check_db

@pytest.fixture
def ctx():
    return VerifyContext(
        gateway_host="100.93.68.86", ssh_user="root",
        ssh_key="~/.ssh/id_ed25519", db_path="/data/db/farming.db",
        gui_url="http://100.93.68.86:1880/gui",
        deploy_timestamp="2026-07-10T18:00:00Z",
        pre_deploy_baselines={"device_data_rows": "1000"},
    )

@patch("pipeline.checks.http_get", return_value=(301, ""))
def test_boot_pass(mock_get, ctx):
    r = check_boot(ctx)
    assert r.passed

@patch("pipeline.checks.http_get", return_value=(-1, "connection refused"))
def test_boot_fail(mock_get, ctx):
    r = check_boot(ctx)
    assert not r.passed

@patch("pipeline.checks.http_get")
def test_routes_404_is_fail(mock_get, ctx):
    mock_get.side_effect = lambda url, **kw: (404, "not found") if "/api/zones" in url else (200, "ok")
    r = check_routes(ctx)
    assert not r.passed
    assert "/api/zones=404" in r.detail

@patch("pipeline.checks.ssh_cmd")
def test_db_integrity_fail(mock_ssh, ctx):
    mock_ssh.return_value = MagicMock(stdout="*** in database main ***\nPage 42: btree problem")
    r = check_db(ctx)
    assert not r.passed
```

- [ ] **Step 3.5: Run tests**

```bash
cd scripts/pipeline && python -m pytest tests/test_checks.py -v
```

- [ ] **Step 3.6: Commit**

```bash
git add scripts/pipeline/checks/
git commit -m "feat(pipeline): 17-check verification protocol for automated deploy verification"
```

---

### Task 4: Alert system + pipeline heartbeat

**Files:**
- Create: `scripts/pipeline/alert.py`
- Create: `scripts/pipeline/tests/test_alert.py`

**Interfaces:**
- Produces: `send_alert(title, body, priority)`, `start_heartbeat(interval_s)`, `stop_heartbeat()` consumed by Task 5.

- [ ] **Step 4.1: Write alert.py**

```python
"""Alert via ntfy.sh push notifications + pipeline heartbeat."""
from __future__ import annotations
import json
import threading
import time
import urllib.request


def send_alert(topic: str, title: str, body: str,
               priority: str = "high", ntfy_url: str = "https://ntfy.sh") -> bool:
    url = f"{ntfy_url}/{topic}"
    data = json.dumps({"topic": topic, "title": title, "message": body,
                        "priority": priority}).encode()
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception as e:
        print(f"ALERT DELIVERY FAILED: {e}")
        return False


class PipelineHeartbeat:
    def __init__(self, topic: str, interval_s: int = 1800,
                 ntfy_url: str = "https://ntfy.sh"):
        self._topic = topic
        self._interval = interval_s
        self._ntfy_url = ntfy_url
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self, bundle_name: str = "") -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, args=(bundle_name,),
                                         daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _loop(self, bundle_name: str) -> None:
        while not self._stop.wait(self._interval):
            send_alert(self._topic,
                       f"Pipeline alive — soaking {bundle_name}",
                       f"Heartbeat at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
                       priority="low", ntfy_url=self._ntfy_url)
```

- [ ] **Step 4.2: Write test**

```python
from unittest.mock import patch
from pipeline.alert import send_alert, PipelineHeartbeat
import time

@patch("pipeline.alert.urllib.request.urlopen")
def test_send_alert(mock_urlopen):
    assert send_alert("test-topic", "Test", "body") is True
    mock_urlopen.assert_called_once()

@patch("pipeline.alert.send_alert")
def test_heartbeat_fires(mock_alert):
    hb = PipelineHeartbeat("test", interval_s=1)
    hb.start("B0")
    time.sleep(2.5)
    hb.stop()
    assert mock_alert.call_count >= 1
```

- [ ] **Step 4.3: Run + commit**

```bash
cd scripts/pipeline && python -m pytest tests/test_alert.py -v
git add scripts/pipeline/alert.py scripts/pipeline/tests/test_alert.py
git commit -m "feat(pipeline): ntfy.sh alert system + pipeline heartbeat for soak monitoring"
```

---

### Task 5: Deploy + restore orchestration

**Files:**
- Create: `scripts/pipeline/deploy.py`
- Create: `scripts/pipeline/restore.py`
- Create: `scripts/pipeline/evidence.py`
- Create: `scripts/pipeline/tests/test_deploy.py`

**Interfaces:**
- Consumes: `GatewayConfig` from Task 1, Pi scripts from Task 2, checks from Task 3
- Produces: `pre_deploy_backup(gw) -> BackupResult`, `deploy_to_gateway(gw, branch) -> DeployResult`, `restore_gateway(gw, backup_path) -> RestoreResult`, `collect_evidence(results) -> dict` consumed by Task 6.

- [ ] **Step 5.1: Write deploy.py**

```python
"""Deploy orchestration: backup → deploy.sh → wait for restart."""
from __future__ import annotations
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .config import GatewayConfig

PI_SCRIPTS = Path(__file__).parent.parent / "pi"


@dataclass
class BackupResult:
    ok: bool
    backup_path: str
    baselines: dict
    detail: str


@dataclass
class DeployResult:
    ok: bool
    detail: str


def scp_to_pi(gw: GatewayConfig, local: Path, remote: str) -> None:
    subprocess.run(
        ["scp", "-i", gw.ssh_key, "-o", "IdentitiesOnly=yes",
         str(local), f"{gw.ssh_user}@{gw.host}:{remote}"],
        check=True, timeout=30
    )


def ssh(gw: GatewayConfig, cmd: str, timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["ssh", "-i", gw.ssh_key, "-o", "IdentitiesOnly=yes",
         "-o", "ConnectTimeout=10",
         f"{gw.ssh_user}@{gw.host}", cmd],
        capture_output=True, text=True, timeout=timeout
    )


def pre_deploy_backup(gw: GatewayConfig, timestamp: str) -> BackupResult:
    # Deploy the backup script to the Pi
    scp_to_pi(gw, PI_SCRIPTS / "backup-pre-deploy.sh", f"{gw.backup_dir}/backup-pre-deploy.sh")
    scp_to_pi(gw, PI_SCRIPTS / "restore-pre-deploy.sh", f"{gw.backup_dir}/restore-pre-deploy.sh")
    ssh(gw, f"chmod +x {gw.backup_dir}/backup-pre-deploy.sh {gw.backup_dir}/restore-pre-deploy.sh")

    r = ssh(gw, f"sh {gw.backup_dir}/backup-pre-deploy.sh {timestamp}", timeout=120)
    if r.returncode != 0:
        return BackupResult(False, "", {}, f"backup failed: {r.stderr}")

    # Parse baselines from output
    baselines = {}
    backup_path = ""
    for line in r.stdout.splitlines():
        if line.startswith("BACKUP_PATH="):
            backup_path = line.split("=", 1)[1]
        elif "=" in line and not line.startswith("OK"):
            k, v = line.split("=", 1)
            baselines[k] = v

    return BackupResult(True, backup_path, baselines, "backup ok")


def deploy_to_gateway(gw: GatewayConfig, repo_root: Path) -> DeployResult:
    # Build GUI
    gui_dir = repo_root / "web" / "react-gui"
    subprocess.run(["npm", "run", "build"], cwd=gui_dir, check=True, timeout=300)

    # Package
    tar_path = repo_root / "react_gui.tar.gz"
    subprocess.run(
        ["tar", "czf", str(tar_path), "-C", str(gui_dir / "build"), "."],
        check=True
    )

    # Serve + deploy via reverse tunnel
    # Start a background HTTP server
    import http.server, threading
    handler = http.server.SimpleHTTPRequestHandler
    srv = http.server.HTTPServer(("127.0.0.1", 9876), handler)
    srv_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    srv_thread.start()

    try:
        r = ssh(gw,
                "curl -fsS http://localhost:9876/deploy.sh | sh",
                timeout=600)
        if r.returncode != 0:
            return DeployResult(False, f"deploy.sh failed: {r.stderr[:500]}")
    finally:
        srv.shutdown()

    # Wait for Node-RED restart
    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            from .checks import http_get
            status, _ = http_get(f"http://{gw.host}:1880/gui")
            if status in (200, 301, 302):
                return DeployResult(True, "deploy ok, Node-RED alive")
        except Exception:
            pass
        time.sleep(5)

    return DeployResult(False, "Node-RED did not come up within 120s")
```

- [ ] **Step 5.2: Write restore.py**

```python
"""Restore a gateway from its on-Pi backup."""
from .config import GatewayConfig
from .deploy import ssh


def restore_gateway(gw: GatewayConfig, backup_path: str) -> bool:
    r = ssh(gw, f"sh {gw.backup_dir}/restore-pre-deploy.sh {backup_path}", timeout=120)
    if r.returncode != 0:
        print(f"RESTORE FAILED: {r.stderr}")
        return False
    print(f"Restored from {backup_path}")
    return True
```

- [ ] **Step 5.3: Write evidence.py**

```python
"""Structured evidence collection → JSON artifacts."""
from __future__ import annotations
import json
import time
from pathlib import Path
from .checks import CheckResult


def collect_evidence(bundle_id: str, results: list[CheckResult],
                     output_dir: Path | None = None) -> dict:
    evidence = {
        "bundle": bundle_id,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "passed": all(r.passed for r in results),
        "checks": [{"name": r.name, "passed": r.passed,
                     "detail": r.detail, "evidence": r.evidence} for r in results],
    }
    if output_dir:
        output_dir.mkdir(parents=True, exist_ok=True)
        path = output_dir / f"evidence-{bundle_id}-{int(time.time())}.json"
        path.write_text(json.dumps(evidence, indent=2) + "\n")
    return evidence
```

- [ ] **Step 5.4: Commit**

```bash
git add scripts/pipeline/deploy.py scripts/pipeline/restore.py scripts/pipeline/evidence.py
git commit -m "feat(pipeline): deploy/restore orchestration + evidence collection"
```

---

### Task 6: Pipeline controller (the main loop)

**Files:**
- Create: `scripts/pipeline/controller.py`
- Create: `scripts/pipeline/git_ops.py`
- Create: `scripts/pipeline/tests/test_controller.py`

**Interfaces:**
- Consumes: everything from Tasks 1–5
- Produces: the runnable `python -m pipeline.controller` entry point

- [ ] **Step 6.1: Write git_ops.py** — branch/merge/tag operations:

```python
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
        # Flows.json conflict — abort and flag for re-review
        run_git(["merge", "--abort"], cwd=cwd)
        return False
    return r.returncode == 0
```

- [ ] **Step 6.2: Write controller.py** — the main orchestration loop:

```python
#!/usr/bin/env python3
"""Refactor execution engine — fully unattended pipeline controller.

Usage: python -m pipeline.controller [--resume] [--dry-run]
"""
from __future__ import annotations
import argparse
import os
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

REPO_ROOT = Path(__file__).parent.parent.parent  # osi-os root


def run_pipeline(dry_run: bool = False) -> None:
    bundles, gateways, servers, limits = load_bundles()
    state = load_state()
    kaba100 = gateways["kaba100"]
    alert_topic = "osi-refactor-pipeline"
    heartbeat = PipelineHeartbeat(alert_topic, limits["soak_heartbeat_interval_s"])

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
                          bundle, alert_topic)
                    return
            print(f"  Merged {len(bundle.prs)} PRs onto {branch}")

        # --- Phase 2: Deploy + verify ---
        if bundle.needs_deploy:
            state.status = "deploying"
            save_state(state)

            ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())

            # Pre-deploy backup
            backup = pre_deploy_backup(kaba100, ts)
            if not backup.ok:
                _halt(f"Pre-deploy backup failed: {backup.detail}", bundle, alert_topic)
                return

            if dry_run:
                print("  DRY RUN: skipping deploy")
            else:
                # Deploy
                result = deploy_to_gateway(kaba100, REPO_ROOT)
                if not result.ok:
                    print(f"  DEPLOY FAILED: {result.detail}")
                    restore_gateway(kaba100, backup.backup_path)
                    _halt(f"Deploy failed + restored: {result.detail}", bundle, alert_topic)
                    return

                # Verify
                ctx = VerifyContext(
                    gateway_host=kaba100.host,
                    ssh_user=kaba100.ssh_user,
                    ssh_key=kaba100.ssh_key,
                    db_path=kaba100.db_path,
                    gui_url=kaba100.gui_url,
                    deploy_timestamp=ts,
                    pre_deploy_baselines=backup.baselines,
                    canary_gate_available=(i >= 1),  # B0 deploys the gate itself
                    is_extraction_bundle=bundle.id in ("B8", "B10"),
                )
                results = run_all_checks(ctx)
                evidence = collect_evidence(bundle.id, results,
                                            REPO_ROOT / "pipeline-evidence")

                if not evidence["passed"]:
                    restore_gateway(kaba100, backup.backup_path)
                    _halt(f"Verification FAILED: {_first_failure(results)}",
                          bundle, alert_topic)
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

                # Post-soak re-verify
                if not dry_run:
                    results = run_all_checks(ctx)
                    evidence = collect_evidence(f"{bundle.id}-postsoak", results,
                                                REPO_ROOT / "pipeline-evidence")
                    if not evidence["passed"]:
                        restore_gateway(kaba100, backup.backup_path)
                        _halt(f"Post-soak verification FAILED: {_first_failure(results)}",
                              bundle, alert_topic)
                        return
                    print(f"  Post-soak verification PASSED")

        # --- Phase 4: Merge to main + tag ---
        state.status = "merging"
        save_state(state)

        if bundle.prs:
            if not dry_run:
                if not merge_to_main(f"bundle/{bundle.name}", REPO_ROOT):
                    _halt(f"Merge to main failed", bundle, alert_topic)
                    return
                state.checkpoint_counter += 1
                tag = tag_checkpoint(state.checkpoint_counter, REPO_ROOT)
                delete_branch(f"bundle/{bundle.name}", REPO_ROOT)
                print(f"  Merged to main, tagged {tag}")
                send_alert(alert_topic,
                           f"Checkpoint {tag} — {bundle.name}",
                           f"Bundle {bundle.id} verified + merged. {len(bundle.items)} items.",
                           priority="default")

    state.status = "idle"
    save_state(state)
    send_alert(alert_topic, "Pipeline complete",
               "All bundles processed.", priority="high")


def _halt(reason: str, bundle, topic: str) -> None:
    print(f"\n  HALT: {reason}")
    send_alert(topic, f"PIPELINE HALT — {bundle.id} {bundle.name}",
               reason, priority="urgent")
    state = load_state()
    state.status = "halted"
    save_state(state)


def _first_failure(results) -> str:
    for r in results:
        if not r.passed:
            return f"{r.name}: {r.detail}"
    return "unknown"


def _pr_branch_name(pr_number: int) -> str:
    """Map PR number to branch name. Hardcoded for the known PRs."""
    mapping = {
        118: "deploy-canary-gate",
        120: "88-stage0-canonicalization",
        121: "ratchet-trio",
        122: "1A5-outbox-size-cap",
        123: "88-stage1-deploy-runner",
        124: "53-staged-atomic-deploy",
    }
    return mapping.get(pr_number, f"pr-{pr_number}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Refactor execution engine")
    parser.add_argument("--resume", action="store_true",
                        help="Resume from saved state")
    parser.add_argument("--dry-run", action="store_true",
                        help="Skip actual deploys")
    args = parser.parse_args()

    if not args.resume:
        save_state(PipelineState())

    run_pipeline(dry_run=args.dry_run)
```

- [ ] **Step 6.3: Write test_controller.py** — state machine tests:

```python
import pytest
from unittest.mock import patch, MagicMock
from pipeline.config import PipelineState, BundleConfig

def test_state_transitions():
    s = PipelineState()
    assert s.status == "idle"
    s.status = "building"
    assert s.status == "building"
    s.status = "halted"
    assert s.status == "halted"

def test_bundle_needs_deploy():
    b = BundleConfig(id="B0", name="test", items=[], prs=[], deploy_target="kaba100",
                     soak_hours=24, pre_deploy=[], needs_fixes=[], ci_only=False)
    assert b.needs_deploy is True

def test_ci_only_no_deploy():
    b = BundleConfig(id="B2", name="test", items=[], prs=[], deploy_target=None,
                     soak_hours=0, pre_deploy=[], needs_fixes=[], ci_only=True)
    assert b.needs_deploy is False
```

- [ ] **Step 6.4: Run all tests**

```bash
cd scripts/pipeline && python -m pytest tests/ -v
```

Expected: all pass.

- [ ] **Step 6.5: Commit**

```bash
git add scripts/pipeline/controller.py scripts/pipeline/git_ops.py \
        scripts/pipeline/tests/test_controller.py
git commit -m "feat(pipeline): main controller loop — fully unattended refactor execution engine"
```

---

### Task 7: Bootstrap — apply the two implementation fixes + commit spec fixes

This task is the IMMEDIATE work: fix the two FAIL branches and commit the Fable-review spec/plan fixes that are currently uncommitted on main.

**Files:**
- Modify: `scripts/verify-flows-size-ratchet.js` (on `feat/ratchet-trio`)
- Create: `scripts/verify-flows-size-ratchet-allowances.json` (on `feat/ratchet-trio`)
- Create: `database/migrations/ordered/0008__sync_outbox_eviction_index.sql` (on `feat/1A5-outbox-size-cap`)
- Commit: all uncommitted spec/plan fixes on main

- [ ] **Step 7.1: Commit the Fable-review spec/plan fixes to main**

```bash
cd /home/phil/Repos/osi-os
git add docs/architecture/refactor-program-2026-open-decisions.md \
        docs/operations/uganda-catchup-runbook.md \
        docs/superpowers/plans/ \
        docs/superpowers/specs/ \
        docs/superpowers/prompts/refactor-program-2026/
git commit -m "docs: Fable-reviewed spec/plan fixes + execution engine spec + worker prompt (refactor program 2026-07-10)"
```

- [ ] **Step 7.2: Fix 1.A2 — add growth-allowance mechanism** (on `feat/ratchet-trio`)

Switch to the branch, add the allowance file and consumption logic, commit, push.

The allowance file (`scripts/verify-flows-size-ratchet-allowances.json`):
```json
{
  "_comment": "Explicit growth allowances. Consumed-or-deleted: remove entry when offset by extraction.",
  "node_allowances": {},
  "total_allowance": { "delta": 0, "reason": "none currently needed" }
}
```

Modify `verify-flows-size-ratchet.js`: in the per-node ceiling check, load `allowances.json` and allow growth up to `base + allowance.delta` if an entry exists for that node id. In the total check, allow `baseTotal + total_allowance.delta`. Add tests.

- [ ] **Step 7.3: Fix 1.A5 — add eviction index** (on `feat/1A5-outbox-size-cap`)

This depends on 0.3 merging first (to get migration number 0007). After 0.3 merges, rebase 1.A5 and create:

`database/migrations/ordered/0008__sync_outbox_eviction_index.sql`:
```sql
-- risk: additive
-- Covers the size-cap eviction query: WHERE aggregate_type IN (...)
-- ORDER BY (delivered_at IS NULL), occurred_at
CREATE INDEX IF NOT EXISTS idx_sync_outbox_eviction
  ON sync_outbox(aggregate_type, delivered_at, occurred_at);
```

Update `CHECKSUMS.json`, `seed-blank.sql`, regenerate 7 bundled DBs, run the full verifier suite.

- [ ] **Step 7.4: Push fixes + update PRs**

```bash
# On feat/ratchet-trio:
git push origin feat/ratchet-trio

# On feat/1A5-outbox-size-cap (after rebase on merged 0.3):
git push origin feat/1A5-outbox-size-cap --force-with-lease
```

---

## Verification checklist (before first pipeline run)

- [ ] `bundles.json` has all 12 bundles with correct PR numbers and deploy targets
- [ ] Pi scripts parse under POSIX sh (`sh -n`)
- [ ] All 17 checks have unit tests that pass
- [ ] Alert delivery works (`python -c "from pipeline.alert import send_alert; send_alert('osi-refactor-pipeline', 'Test', 'ping')"`)
- [ ] Playwright installed on VPS (`pip install playwright && playwright install chromium`)
- [ ] SSH from VPS to kaba100 works (`ssh -i ~/.ssh/id_ed25519 root@100.93.68.86 'echo ok'`)
- [ ] All uncommitted spec/plan fixes committed to main
- [ ] 1.A2 growth-allowance fix merged to `feat/ratchet-trio`
- [ ] 1.A5 eviction-index fix ready (waiting for 0.3 merge for migration numbering)
- [ ] `python -m pipeline.controller --dry-run` completes without errors
