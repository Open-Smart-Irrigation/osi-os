# Forge Self-Learning Loop — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Repo:** osi-server — same branch as Stage 1 (`feat/forge-controller-stage1`). This plan's tasks execute **after** Stage 1 Tasks 3-4 are complete (the forge controller must exist before we instrument it).
> **Spec:** [`docs/superpowers/specs/2026-07-10-forge-self-learning-loop-design.md`](../specs/2026-07-10-forge-self-learning-loop-design.md) §4–§6, §9 Phase A.
> **Depends on:** Stage 1 controller plan Tasks 3-4 (`forge/pipeline.py`, `forge/controller.py`, `forge/config.py`, `forge/github_pr.py`, `forge/prompts/plan_schema.json` all exist).

**Goal:** Instrument the forge controller so every job produces a complete structured record (version stamps, pipeline signals S1–S12, pass telemetry), the plan captures a machine-readable interpretation of the field request, PR bodies carry reviewer conventions for structured feedback, and a daily cron harvests human-behavior signals (merge state, fixup diffs, review comments) from GitHub — because you cannot learn from data you did not record.

**Architecture:** A new `forge/learning/` package owns a SQLite ledger (`forge-memory.db`) that stores per-job records and signals. The controller calls `extract_signals()` in its existing cleanup step. Version stamps (skills SHA, prompts hash, config id, model ids) are captured per-pass in `pipeline.py` and written alongside the job record. A daily `harvest_github.py` cron polls open agent PRs for merge state, fixup diffs, and structured review comments. No learning *actions* happen in Phase A — only recording.

**Tech Stack:** Python 3.12, SQLite (same engine as the edge), `gh` CLI for GitHub API, httpx + PyJWT (existing deps from Stage 1).

---

## Scope

This plan implements **Phase A only** — "record everything." Phase B (classify, digest, propose, phrasebook, case files) and Phase C (config trials, threshold calibration, prompt evolution) ship later once production data exists. The test suite plan's Task 5 (basic simulation feedback loop) is unaffected — it classifies *simulation* failures; Phase A records *production* signals. They coexist.

Phase A exit criterion: every job produces a complete `jobs` row with version stamps, and a merged PR produces fixup/comment signals within 24 h of the daily cron.

## Global Constraints

- **No production access.** Do not SSH to / inspect / run commands on `osicloud.ch`.
- **Credential separation unchanged.** The learning package reads only controller-side config (never codex.env).
- **The ledger is on the runner, never committed.** `forge-memory.db` and `memory/archive/` live in `/home/forge-runner/memory/` — they contain field-derived text. Nothing from Layers 0–1 enters a public repo.
- **No auto-applied learning.** Phase A records only. Nothing in this plan changes what a future job sees or does. The asymmetry principle (spec §8.1) is satisfied trivially: there is no "loosen" path to protect against.
- **Signal provenance is mandatory.** Every `signals` row carries `provenance` ∈ {`deterministic`, `human`, `llm`, `field-untrusted`}.

---

## File Structure

### New files
- Create: `forge/learning/__init__.py`
- Create: `forge/learning/schema.sql`
- Create: `forge/learning/ledger.py`
- Create: `forge/learning/extract_signals.py`
- Create: `forge/learning/harvest_github.py`
- Create: `forge/learning/redact.py`
- Create: `forge/pipeline_config.json`
- Create: `forge/tests/unit/test_ledger.py`
- Create: `forge/tests/unit/test_extract_signals.py`
- Create: `forge/tests/unit/test_harvest.py`

### Modified files (created by Stage 1 Task 4)
- Modify: `forge/config.py` — add `MEMORY_DIR`, `load_pipeline_config()`
- Modify: `forge/pipeline.py` — version stamp computation, `pass_telemetry` recording, call `extract_signals` at job end
- Modify: `forge/controller.py` — wire `extract_signals` into the cleanup step, pass `pipeline_result` to it
- Modify: `forge/github_pr.py` — render interpretation block + reviewer conventions in PR body
- Modify: `forge/prompts/plan_schema.json` — add `request_interpretation` object
- Modify: `forge/prompts/plan_system.md` — add interpretation behavioral rules
- Modify: `forge/pyproject.toml` — no new deps (SQLite is stdlib; `gh` is a system binary)

---

## Task 1: Learning Ledger Package

**Files:**
- Create: `forge/learning/__init__.py`
- Create: `forge/learning/schema.sql`
- Create: `forge/learning/ledger.py`
- Create: `forge/learning/redact.py`
- Modify: `forge/config.py`
- Create: `forge/tests/unit/test_ledger.py`

**Interfaces:**
- Consumes: `forge.config.MEMORY_DIR` (new constant)
- Produces: `Ledger` class with `record_job(job_record: dict)`, `record_signal(job_id: str, signal: dict)`, `record_pass_telemetry(job_id: str, telemetry: dict)`, `update_job(job_id: str, updates: dict)`, `get_job(job_id: str) -> dict | None`, `get_signals(job_id: str) -> list[dict]`

- [ ] **Step 1.1: Add MEMORY_DIR to config.py**

In `forge/config.py`, add after the existing path constants:

```python
# Env-overridable: tests and dev set FORGE_MEMORY_DIR to a temp dir.
MEMORY_DIR = Path(os.environ.get("FORGE_MEMORY_DIR", "/home/forge-runner/memory"))
MEMORY_DB = MEMORY_DIR / "forge-memory.db"
ARCHIVE_DIR = MEMORY_DIR / "archive"

def load_pipeline_config() -> dict:
    """Load pipeline_config.json — version-stamped category defaults."""
    cfg_path = Path(__file__).parent / "pipeline_config.json"
    if cfg_path.exists():
        import json
        return json.loads(cfg_path.read_text())
    return {"config_id": "cfg-0", "categories": {}}
```

- [ ] **Step 1.2: Write failing ledger tests**

```python
# forge/tests/unit/test_ledger.py
"""Tier A ledger tests — SQLite operations, no LLM, no network."""
import json
import sqlite3
from pathlib import Path

import pytest

from forge.learning.ledger import Ledger


@pytest.fixture
def ledger(tmp_path):
    db_path = tmp_path / "test-memory.db"
    return Ledger(db_path)


def test_record_and_retrieve_job(ledger):
    job = {
        "job_id": "req-abc12345",
        "request_uuid": "abc12345-0000-0000-0000-000000000000",
        "risk_class": 1,
        "area": "dashboard",
        "register": "farmer",
        "language": "en",
        "surfaces": ["web/react-gui/src"],
        "skills_injected": ["osi-react-gui-patterns"],
        "skills_sha": "deadbeef",
        "prompts_version": "v3-sha256abc",
        "config_id": "cfg-7",
        "plan_model": "claude-opus-4-6",
        "exec_model": "codex-5.5",
        "review_model": "claude-opus-4-6",
        "terminal_state": "PR_OPEN",
        "fix_cycles": 0,
        "cost_usd": 6.20,
        "wall_s": 480,
    }
    ledger.record_job(job)
    retrieved = ledger.get_job("req-abc12345")
    assert retrieved is not None
    assert retrieved["job_id"] == "req-abc12345"
    assert retrieved["risk_class"] == 1
    assert json.loads(retrieved["skills_injected"]) == ["osi-react-gui-patterns"]


def test_record_signal(ledger):
    ledger.record_job({"job_id": "req-test1", "terminal_state": "PR_OPEN"})
    ledger.record_signal("req-test1", {
        "type": "S1",
        "payload": {"terminal_state": "PR_OPEN", "failure_reason": None},
        "confidence": "high",
        "provenance": "deterministic",
    })
    signals = ledger.get_signals("req-test1")
    assert len(signals) == 1
    assert signals[0]["type"] == "S1"
    assert signals[0]["provenance"] == "deterministic"


def test_record_pass_telemetry(ledger):
    ledger.record_job({"job_id": "req-test2", "terminal_state": "PR_OPEN"})
    ledger.record_pass_telemetry("req-test2", {
        "pass": "plan",
        "model_id": "claude-opus-4-6",
        "cost_usd": 1.20,
        "wall_s": 45,
        "outcome": "completed",
    })
    # Verify via raw SQL
    conn = sqlite3.connect(ledger.db_path)
    rows = conn.execute(
        "SELECT * FROM pass_telemetry WHERE job_id = ?", ("req-test2",)
    ).fetchall()
    conn.close()
    assert len(rows) == 1


def test_update_job(ledger):
    ledger.record_job({"job_id": "req-upd1", "terminal_state": "PR_OPEN"})
    ledger.update_job("req-upd1", {
        "pr_url": "https://github.com/…/pull/42",
        "outcome_label": "MERGED_CLEAN",
        "merge_latency_h": 18.5,
        "human_fixup_lines": 0,
    })
    job = ledger.get_job("req-upd1")
    assert job["pr_url"] == "https://github.com/…/pull/42"
    assert job["outcome_label"] == "MERGED_CLEAN"
    assert job["human_fixup_lines"] == 0


def test_duplicate_job_id_raises(ledger):
    ledger.record_job({"job_id": "req-dup1", "terminal_state": "PR_OPEN"})
    with pytest.raises(Exception):
        ledger.record_job({"job_id": "req-dup1", "terminal_state": "AGENT_FAILED"})


def test_schema_creates_all_tables(ledger):
    conn = sqlite3.connect(ledger.db_path)
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    conn.close()
    assert tables >= {"jobs", "signals", "pass_telemetry", "lessons",
                      "proposals", "config_trials", "phrasebook"}
```

- [ ] **Step 1.3: Run tests to verify they fail**

```bash
cd forge && python -m pytest tests/unit/test_ledger.py -v
# Expected: FAIL — ModuleNotFoundError: No module named 'forge.learning'
```

- [ ] **Step 1.4: Create schema.sql**

```sql
-- forge/learning/schema.sql
-- Forge institutional memory ledger (spec §5.2).
-- SQLite, owned by ledger.py. All writers go through the module.

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  request_uuid TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  risk_class INTEGER,
  area TEXT,
  register TEXT,
  language TEXT,
  surfaces TEXT,            -- JSON array of surface tags from the diff
  skills_injected TEXT,     -- JSON array
  skills_sha TEXT,          -- osi-os HEAD the skills were read at
  prompts_version TEXT,     -- forge/prompts/ content hash
  config_id TEXT,           -- pipeline_config.json version
  plan_model TEXT,
  exec_model TEXT,
  review_model TEXT,
  terminal_state TEXT,
  fix_cycles INTEGER DEFAULT 0,
  outcome_label TEXT,       -- Phase B: MERGED_CLEAN | MERGED_WITH_FIXUPS | REWORKED | REJECTED | AGENT_FAILED
  pr_outcome TEXT,          -- Phase A harvest: merged | closed_unmerged | open
  pr_url TEXT,
  merge_latency_h REAL,
  human_fixup_lines INTEGER,
  interpretation_corrected INTEGER,  -- 0/1/NULL(no verdict yet)
  cost_usd REAL,
  wall_s INTEGER
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  type TEXT NOT NULL,        -- S1..S12, H1..H8, F1..F3, M1..M3
  payload TEXT,              -- JSON, redacted
  confidence TEXT NOT NULL,  -- high | medium | low
  provenance TEXT NOT NULL,  -- deterministic | human | llm | field-untrusted
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pass_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(job_id),
  pass TEXT NOT NULL,        -- plan | exec | review | fix | escalate | judge
  model_id TEXT,
  reasoning TEXT,
  budget_usd REAL,
  cost_usd REAL,
  wall_s INTEGER,
  outcome TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signature TEXT NOT NULL,
  kind TEXT NOT NULL,         -- success | weakness | failure | interpretation
  statement TEXT,
  evidence_jobs TEXT,         -- JSON array of job_ids
  status TEXT NOT NULL DEFAULT 'candidate',  -- candidate | proposed | codified | rejected | retired
  codified_in TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER REFERENCES lessons(id),
  target TEXT NOT NULL,       -- skill | index | agents | prompt | gate | catalog | threshold | config | phrasebook | case
  artifact_path TEXT,
  status TEXT NOT NULL DEFAULT 'open',  -- open | applied | rejected | deferred
  decided_by TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS config_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  config_id TEXT NOT NULL,
  hypothesis TEXT,
  scope TEXT,
  sim_baseline TEXT,
  sim_trial TEXT,
  prod_jobs TEXT,
  verdict TEXT,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS phrasebook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase TEXT NOT NULL,
  register TEXT,
  mapping TEXT NOT NULL,
  source_job TEXT,
  status TEXT NOT NULL DEFAULT 'candidate',  -- candidate | approved | retired
  hit_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_signals_job ON signals(job_id);
CREATE INDEX IF NOT EXISTS idx_signals_type ON signals(type);
CREATE INDEX IF NOT EXISTS idx_telemetry_job ON pass_telemetry(job_id);
CREATE INDEX IF NOT EXISTS idx_lessons_signature ON lessons(signature);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_phrasebook_status ON phrasebook(status);
```

- [ ] **Step 1.5: Implement ledger.py**

```python
# forge/learning/__init__.py
```

```python
# forge/learning/ledger.py
"""SQLite ledger for forge institutional memory (spec §5.2).

All writes to forge-memory.db go through this module. The schema is
created on first connect from schema.sql.
"""
import json
import logging
import sqlite3
from pathlib import Path

log = logging.getLogger("forge.learning.ledger")

_SCHEMA_PATH = Path(__file__).parent / "schema.sql"

# Columns that store JSON arrays
_JSON_COLUMNS = {"surfaces", "skills_injected", "evidence_jobs"}


class Ledger:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _init_schema(self):
        conn = sqlite3.connect(self.db_path)
        conn.executescript(_SCHEMA_PATH.read_text())
        conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def record_job(self, job: dict):
        """Insert a new job record. Raises on duplicate job_id."""
        row = dict(job)
        for col in _JSON_COLUMNS:
            if col in row and not isinstance(row[col], str):
                row[col] = json.dumps(row[col])
        cols = ", ".join(row.keys())
        placeholders = ", ".join(f":{k}" for k in row.keys())
        conn = self._connect()
        try:
            conn.execute(f"INSERT INTO jobs ({cols}) VALUES ({placeholders})", row)
            conn.commit()
        finally:
            conn.close()

    def record_signal(self, job_id: str, signal: dict):
        """Append a signal row for a job."""
        payload = signal.get("payload")
        if payload and not isinstance(payload, str):
            payload = json.dumps(payload)
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO signals (job_id, type, payload, confidence, provenance) "
                "VALUES (?, ?, ?, ?, ?)",
                (job_id, signal["type"], payload,
                 signal["confidence"], signal["provenance"]))
            conn.commit()
        finally:
            conn.close()

    def record_pass_telemetry(self, job_id: str, telemetry: dict):
        """Append a pass telemetry row."""
        conn = self._connect()
        try:
            conn.execute(
                "INSERT INTO pass_telemetry "
                "(job_id, pass, model_id, reasoning, budget_usd, cost_usd, wall_s, outcome) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (job_id, telemetry["pass"], telemetry.get("model_id"),
                 telemetry.get("reasoning"), telemetry.get("budget_usd"),
                 telemetry.get("cost_usd"), telemetry.get("wall_s"),
                 telemetry.get("outcome")))
            conn.commit()
        finally:
            conn.close()

    def update_job(self, job_id: str, updates: dict):
        """Update selected fields on an existing job row."""
        if not updates:
            return
        row = dict(updates)
        for col in _JSON_COLUMNS:
            if col in row and not isinstance(row[col], str):
                row[col] = json.dumps(row[col])
        set_clause = ", ".join(f"{k} = :{k}" for k in row.keys())
        row["_job_id"] = job_id
        conn = self._connect()
        try:
            conn.execute(f"UPDATE jobs SET {set_clause} WHERE job_id = :_job_id", row)
            conn.commit()
        finally:
            conn.close()

    def get_job(self, job_id: str) -> dict | None:
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM jobs WHERE job_id = ?", (job_id,)
            ).fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    def get_signals(self, job_id: str) -> list[dict]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM signals WHERE job_id = ? ORDER BY id", (job_id,)
            ).fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
```

- [ ] **Step 1.6: Create redact.py**

```python
# forge/learning/redact.py
"""Redaction filter for job archives and signal payloads.

Strips secrets, credential paths, and high-entropy tokens before
any field-derived text enters the ledger or archive.
"""
import re

_REDACT_PATTERNS = [
    (re.compile(r"\bsk-[A-Za-z0-9._~+/=-]{20,}"), "[REDACTED_KEY]"),
    (re.compile(r"-----BEGIN[^-]*-----[\s\S]*?-----END[^-]*-----"), "[REDACTED_PEM]"),
    (re.compile(r"Bearer\s+[A-Za-z0-9._~+/=-]{20,}"), "Bearer [REDACTED]"),
    (re.compile(r"x-access-token:[A-Za-z0-9._~+/=-]+@"), "x-access-token:[REDACTED]@"),
    (re.compile(r'(?:password|secret|token)\s*[=:]\s*"[^"]{8,}"'), '[CREDENTIAL_REDACTED]'),
    (re.compile(r'(?:password|secret|token)\s*[=:]\s*\'[^\']{8,}\''), '[CREDENTIAL_REDACTED]'),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[IP_REDACTED]"),
]


def redact_text(text: str) -> str:
    """Apply all redaction patterns to a string."""
    for pattern, replacement in _REDACT_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact_dict(d: dict, keys_to_redact: set[str] | None = None) -> dict:
    """Redact string values in a dict. Recurses into nested dicts."""
    result = {}
    skip_keys = keys_to_redact or set()
    for k, v in d.items():
        if k in skip_keys:
            result[k] = "[REDACTED]"
        elif isinstance(v, str):
            result[k] = redact_text(v)
        elif isinstance(v, dict):
            result[k] = redact_dict(v, keys_to_redact)
        elif isinstance(v, list):
            result[k] = [
                redact_text(item) if isinstance(item, str)
                else redact_dict(item, keys_to_redact) if isinstance(item, dict)
                else item
                for item in v
            ]
        else:
            result[k] = v
    return result
```

- [ ] **Step 1.7: Run tests to verify they pass**

```bash
cd forge && python -m pytest tests/unit/test_ledger.py -v
# Expected: all 6 tests PASS
```

- [ ] **Step 1.8: Commit**

```bash
git add forge/learning/ forge/config.py forge/tests/unit/test_ledger.py
git commit -m "$(cat <<'EOF'
feat(learning): add forge memory ledger with SQLite schema

Phase A of the self-learning loop: forge-memory.db stores per-job
records, pipeline signals, pass telemetry, and institutional memory
tables (lessons, proposals, phrasebook, config_trials). All writes
go through ledger.py. Redaction filter strips secrets before archival.
EOF
)"
```

---

## Task 2: Version Stamping + Signal Extraction + Telemetry

**Files:**
- Create: `forge/pipeline_config.json`
- Create: `forge/learning/extract_signals.py`
- Modify: `forge/pipeline.py`
- Modify: `forge/controller.py`
- Create: `forge/tests/unit/test_extract_signals.py`

**Interfaces:**
- Consumes: `Ledger` from Task 1, `forge.config.load_pipeline_config()`, Stage 1's `pipeline.run_pipeline()` return dict, job directory artifacts
- Produces: `extract_signals(job_id, job_dir, pipeline_result, ledger)` that writes one `jobs` row + N `signals` rows + N `pass_telemetry` rows; `compute_version_stamp(worktree) -> dict` for the controller; `pipeline.run_pipeline()` now returns `pass_telemetry` list in its result dict

- [ ] **Step 2.1: Create pipeline_config.json**

```json
{
  "config_id": "cfg-1",
  "categories": {
    "class-0":       { "exec_reasoning": "high",  "plan_budget_usd": 1.0, "exec_timeout_s": 1800 },
    "class-1-gui":   { "exec_reasoning": "high",  "plan_budget_usd": 2.0, "exec_timeout_s": 3600 },
    "class-1-flows": { "exec_reasoning": "high",  "plan_budget_usd": 2.0, "exec_timeout_s": 3600 },
    "class-2":       { "exec_reasoning": "high",  "plan_budget_usd": 2.0, "exec_timeout_s": 3600,
                       "escalation_default": true }
  }
}
```

- [ ] **Step 2.2: Write failing extraction tests**

```python
# forge/tests/unit/test_extract_signals.py
"""Tier A signal extraction tests — deterministic, no LLM, no network."""
import json
from pathlib import Path

import pytest

from forge.learning.ledger import Ledger
from forge.learning.extract_signals import (
    extract_signals,
    compute_version_stamp,
    _extract_s1_terminal_state,
    _extract_s2_gate_results,
    _extract_s3_test_results,
    _extract_s4_verification_divergence,
    _extract_s7_skill_backstop,
    _extract_s10_plan_hallucination,
    _extract_s11_cost_telemetry,
)


@pytest.fixture
def ledger(tmp_path):
    return Ledger(tmp_path / "test.db")


@pytest.fixture
def job_dir(tmp_path):
    """Create a minimal job directory with standard artifacts."""
    d = tmp_path / "job-req-test1234"
    d.mkdir()
    (d / "logs").mkdir()

    (d / "request.json").write_text(json.dumps({
        "requestUuid": "test1234-0000-0000-0000-000000000000",
        "title": "Fix typo", "description": "The login says Passwrod",
        "type": "bug", "area": "copy", "severity": "annoying",
    }))

    (d / "plan.json").write_text(json.dumps({
        "risk_class": 0,
        "target_repo": "osi-os",
        "required_skills": ["osi-react-gui-patterns"],
        "files_to_touch": ["web/react-gui/public/locales/en/auth.json"],
        "tests_to_run": ["npm run test:unit"],
        "plan_md": "Fix typo in locale file.",
        "plan_summary": "Fix typo Passwrod → Password in auth locale.",
        "request_interpretation": {
            "normalized_statement": "Typo: 'Passwrod' → 'Password' in auth locale",
            "register": "farmer", "language": "en", "ambiguity": "low",
            "assumed_mappings": [],
        },
    }))

    (d / "gate-pre.json").write_text(json.dumps({
        "passed": True, "failures": [],
    }))

    (d / "gate-post.json").write_text(json.dumps({
        "passed": True, "failures": [], "warnings": [],
    }))

    (d / "review.json").write_text(json.dumps({
        "verdict": "approve", "findings": [], "severity": "none",
    }))

    (d / "verification-results.json").write_text(json.dumps([
        {"cmd": "npm run test:unit", "rc": 0, "stdout": "Tests: 42 passed", "stderr": ""},
    ]))

    return d


def test_s1_terminal_state():
    signal = _extract_s1_terminal_state("PR_OPEN", None)
    assert signal["type"] == "S1"
    assert signal["confidence"] == "high"
    assert signal["provenance"] == "deterministic"
    assert signal["payload"]["terminal_state"] == "PR_OPEN"


def test_s2_gate_results():
    gate_pre = {"passed": True, "failures": []}
    gate_post = {"passed": True, "failures": [], "warnings": ["unexpected file"]}
    signals = _extract_s2_gate_results(gate_pre, gate_post)
    assert len(signals) == 2
    assert signals[1]["payload"]["warnings"] == ["unexpected file"]


def test_s3_test_results():
    verification = [
        {"cmd": "npm test", "rc": 0, "stdout": "ok", "stderr": ""},
        {"cmd": "node verify.js", "rc": 1, "stdout": "", "stderr": "FAIL"},
    ]
    signal = _extract_s3_test_results(verification)
    assert signal["payload"]["total"] == 2
    assert signal["payload"]["passed"] == 1
    assert signal["payload"]["failed"] == 1


def test_s4_divergence_detected():
    exec_report = "All tests passed (42 green)"
    verification = [{"cmd": "npm test", "rc": 1, "stdout": "FAIL", "stderr": ""}]
    signal = _extract_s4_verification_divergence(exec_report, verification)
    assert signal["payload"]["divergence_detected"] is True


def test_s4_no_divergence():
    exec_report = "Tests: 2 failed"
    verification = [{"cmd": "npm test", "rc": 1, "stdout": "2 failed", "stderr": ""}]
    signal = _extract_s4_verification_divergence(exec_report, verification)
    assert signal["payload"]["divergence_detected"] is False


def test_s7_skill_backstop():
    plan_skills = ["osi-react-gui-patterns"]
    diff_files = ["web/react-gui/src/App.tsx"]
    signal = _extract_s7_skill_backstop(plan_skills, diff_files)
    assert signal["payload"]["dangling_count"] == 0


def test_s10_hallucination(tmp_path):
    planned = ["web/react-gui/src/pages/Login.tsx", "nonexistent/foo.ts"]
    signal = _extract_s10_plan_hallucination(planned, tmp_path)
    assert signal["payload"]["hallucination_count"] >= 1


def test_full_extraction(ledger, job_dir):
    pipeline_result = {
        "state": "PR_OPEN",
        "pass_telemetry": [
            {"pass": "plan", "model_id": "claude-opus-4-6",
             "cost_usd": 1.20, "wall_s": 45, "outcome": "completed"},
            {"pass": "exec", "model_id": "codex-5.5",
             "cost_usd": 3.80, "wall_s": 320, "outcome": "completed"},
            {"pass": "review", "model_id": "claude-opus-4-6",
             "cost_usd": 1.10, "wall_s": 38, "outcome": "approve"},
        ],
    }
    extract_signals("req-test1234", job_dir, pipeline_result, ledger)
    job = ledger.get_job("req-test1234")
    assert job is not None
    assert job["terminal_state"] == "PR_OPEN"
    assert isinstance(job["skills_sha"], str)  # stamp present (may be empty in test env)
    signals = ledger.get_signals("req-test1234")
    assert len(signals) >= 6  # S1, S2×2, S3, S4, S7 at minimum
```

- [ ] **Step 2.3: Run tests to verify they fail**

```bash
cd forge && python -m pytest tests/unit/test_extract_signals.py -v
# Expected: FAIL — ImportError
```

- [ ] **Step 2.4: Implement extract_signals.py**

```python
# forge/learning/extract_signals.py
"""Signal extraction — reads job artifacts, writes structured records to the ledger.

Called by the controller after every job completes. Produces signals S1–S12
per the spec §2.1 taxonomy. Human-behavior signals (H1–H7) are harvested
separately by harvest_github.py.
"""
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tarfile
from pathlib import Path

from . import redact
from .ledger import Ledger
from ..skill_index import SURFACE_SKILL_MAP

log = logging.getLogger("forge.learning.extract_signals")


def compute_version_stamp(worktree: Path) -> dict:
    """Compute the version stamp for a job (spec §5.2)."""
    skills_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        capture_output=True, text=True, cwd=worktree
    ).stdout.strip()[:12]

    prompts_dir = Path(__file__).parent.parent / "prompts"
    prompts_hash = ""
    if prompts_dir.exists():
        hasher = hashlib.sha256()
        for f in sorted(prompts_dir.glob("*")):
            if f.is_file():
                hasher.update(f.read_bytes())
        prompts_hash = hasher.hexdigest()[:12]

    from ..config import load_pipeline_config
    cfg = load_pipeline_config()

    return {
        "skills_sha": skills_sha,
        "prompts_version": prompts_hash,
        "config_id": cfg.get("config_id", "cfg-0"),
    }


def extract_signals(job_id: str, job_dir: Path,
                    pipeline_result: dict, ledger: Ledger):
    """Extract all pipeline signals and write them to the ledger."""
    request = _read_json(job_dir / "request.json")
    plan = _read_json(job_dir / "plan.json")
    gate_pre = _read_json(job_dir / "gate-pre.json")
    gate_post = _read_json(job_dir / "gate-post.json")
    review = _read_json(job_dir / "review.json")
    verification = _read_json(job_dir / "verification-results.json")
    exec_report = _read_text(job_dir / "worktree" / "execution-report.md")
    fix_instructions = _read_text(job_dir / "fix-instructions.md")

    terminal_state = pipeline_result.get("state", "AGENT_FAILED")
    failure_reason = pipeline_result.get("reason")
    fix_cycles = 1 if (job_dir / "gate-post-fix.json").exists() else 0

    # Diff files for surface tagging
    diff_files = []
    worktree = job_dir / "worktree"
    if worktree.exists():
        diff_result = subprocess.run(
            ["git", "diff", "--name-only", "origin/main...HEAD"],
            capture_output=True, text=True, cwd=worktree)
        diff_files = [f.strip() for f in diff_result.stdout.splitlines() if f.strip()]

    surfaces = list({_surface_tag(f) for f in diff_files if _surface_tag(f)})

    interpretation = plan.get("request_interpretation", {})

    # Version stamps from pipeline_result or compute fresh
    stamps = pipeline_result.get("version_stamp", {})

    # Telemetry
    pass_telemetry = pipeline_result.get("pass_telemetry", [])
    total_cost = sum(t.get("cost_usd", 0) for t in pass_telemetry)
    total_wall = sum(t.get("wall_s", 0) for t in pass_telemetry)

    # Model ids per pass
    model_map = {}
    for t in pass_telemetry:
        model_map[t["pass"]] = t.get("model_id", "")

    # --- Write job record ---
    job_record = {
        "job_id": job_id,
        "request_uuid": request.get("requestUuid", ""),
        "risk_class": plan.get("risk_class"),
        "area": request.get("area", ""),
        "register": interpretation.get("register", ""),
        "language": interpretation.get("language", ""),
        "surfaces": surfaces,
        "skills_injected": plan.get("required_skills", []),
        "skills_sha": stamps.get("skills_sha", ""),
        "prompts_version": stamps.get("prompts_version", ""),
        "config_id": stamps.get("config_id", ""),
        "plan_model": model_map.get("plan", ""),
        "exec_model": model_map.get("exec", ""),
        "review_model": model_map.get("review", ""),
        "terminal_state": terminal_state,
        "fix_cycles": fix_cycles,
        "pr_url": pipeline_result.get("pr_url"),
        "cost_usd": round(total_cost, 2),
        "wall_s": total_wall,
    }
    ledger.record_job(job_record)

    # --- Write pass telemetry ---
    for t in pass_telemetry:
        ledger.record_pass_telemetry(job_id, t)

    # --- Extract and write signals ---
    signals = []

    # S1: terminal state
    signals.append(_extract_s1_terminal_state(terminal_state, failure_reason))

    # S2: gate results (pre + post)
    signals.extend(_extract_s2_gate_results(gate_pre, gate_post))

    # S3: test results
    if verification:
        signals.append(_extract_s3_test_results(
            verification if isinstance(verification, list) else []))

    # S4: Codex-claim vs controller-rerun divergence
    if exec_report and verification:
        signals.append(_extract_s4_verification_divergence(
            exec_report, verification if isinstance(verification, list) else []))

    # S5: review verdict
    if review:
        signals.append({
            "type": "S5",
            "payload": redact.redact_dict({
                "verdict": review.get("verdict"),
                "findings_count": len(review.get("findings", [])),
                "findings_summary": [f.get("summary", "")[:200]
                                     for f in review.get("findings", [])[:5]],
            }),
            "confidence": "medium",
            "provenance": "deterministic",
        })

    # S6: fix cycle
    if fix_cycles > 0:
        signals.append({
            "type": "S6",
            "payload": {
                "fix_cycles": fix_cycles,
                "instructions_preview": redact.redact_text(
                    fix_instructions[:500]) if fix_instructions else None,
            },
            "confidence": "high",
            "provenance": "deterministic",
        })

    # S7: skill backstop
    signals.append(_extract_s7_skill_backstop(
        plan.get("required_skills", []), diff_files))

    # S8: skill selection reasoning
    if plan.get("skill_reasoning"):
        signals.append({
            "type": "S8",
            "payload": {"reasoning": plan["skill_reasoning"][:1000]},
            "confidence": "medium",
            "provenance": "llm",
        })

    # S9: escalation
    if plan.get("escalation_needed"):
        signals.append({
            "type": "S9",
            "payload": {"escalation_reason": plan.get("escalation_reason", "")[:500]},
            "confidence": "high",
            "provenance": "deterministic",
        })

    # S10: plan hallucination
    if worktree.exists():
        signals.append(_extract_s10_plan_hallucination(
            plan.get("files_to_touch", []), worktree))

    # S11: cost/latency
    signals.append(_extract_s11_cost_telemetry(pass_telemetry))

    # S12: injection/sanitizer hits
    sanitizer_hits = gate_pre.get("failures", []) + gate_post.get("failures", [])
    injection_hits = [f for f in sanitizer_hits if "secret" in f.lower() or "pattern" in f.lower()]
    if injection_hits:
        signals.append({
            "type": "S12",
            "payload": {"hits": injection_hits[:10]},
            "confidence": "high",
            "provenance": "deterministic",
        })

    for sig in signals:
        ledger.record_signal(job_id, sig)

    log.info(f"Extracted {len(signals)} signals for {job_id}")

    # --- Archive (redacted, compressed) ---
    _archive_job(job_id, job_dir)


def _extract_s1_terminal_state(state: str, reason: str | None) -> dict:
    return {
        "type": "S1",
        "payload": {"terminal_state": state, "failure_reason": reason},
        "confidence": "high",
        "provenance": "deterministic",
    }


def _extract_s2_gate_results(gate_pre: dict, gate_post: dict) -> list[dict]:
    signals = []
    if gate_pre:
        signals.append({
            "type": "S2",
            "payload": {"gate": "pre", "passed": gate_pre.get("passed"),
                        "failures": gate_pre.get("failures", [])},
            "confidence": "high",
            "provenance": "deterministic",
        })
    if gate_post:
        signals.append({
            "type": "S2",
            "payload": {"gate": "post", "passed": gate_post.get("passed"),
                        "failures": gate_post.get("failures", []),
                        "warnings": gate_post.get("warnings", [])},
            "confidence": "high",
            "provenance": "deterministic",
        })
    return signals


def _extract_s3_test_results(verification: list[dict]) -> dict:
    passed = sum(1 for v in verification if v.get("rc") == 0)
    failed = len(verification) - passed
    return {
        "type": "S3",
        "payload": {"total": len(verification), "passed": passed, "failed": failed,
                     "commands": [v.get("cmd", "") for v in verification]},
        "confidence": "high",
        "provenance": "deterministic",
    }


def _extract_s4_verification_divergence(exec_report: str,
                                         verification: list[dict]) -> dict:
    codex_claims_pass = any(
        phrase in exec_report.lower()
        for phrase in ["all tests passed", "tests: 0 failed", "all green",
                       "verification successful", "tests passed"])
    controller_all_pass = all(v.get("rc") == 0 for v in verification)
    divergence = codex_claims_pass and not controller_all_pass
    return {
        "type": "S4",
        "payload": {"divergence_detected": divergence,
                     "codex_claims_pass": codex_claims_pass,
                     "controller_all_pass": controller_all_pass},
        "confidence": "high",
        "provenance": "deterministic",
    }


def _extract_s7_skill_backstop(plan_skills: list[str],
                                diff_files: list[str]) -> dict:
    from ..skill_index import check_dangling_skills
    dangling = check_dangling_skills(diff_files, plan_skills)
    return {
        "type": "S7",
        "payload": {"dangling_count": len(dangling), "dangling": dangling[:5]},
        "confidence": "high",
        "provenance": "deterministic",
    }


def _extract_s10_plan_hallucination(planned_files: list[str],
                                     worktree: Path) -> dict:
    missing = []
    for f in planned_files:
        full = worktree / f
        if not full.exists() and not full.parent.exists():
            missing.append(f)
    return {
        "type": "S10",
        "payload": {"planned_count": len(planned_files),
                     "hallucination_count": len(missing),
                     "missing_paths": missing[:10]},
        "confidence": "high",
        "provenance": "deterministic",
    }


def _extract_s11_cost_telemetry(pass_telemetry: list[dict]) -> dict:
    return {
        "type": "S11",
        "payload": {
            "passes": [{
                "pass": t.get("pass"),
                "model_id": t.get("model_id"),
                "cost_usd": t.get("cost_usd"),
                "wall_s": t.get("wall_s"),
            } for t in pass_telemetry],
            "total_cost_usd": round(sum(t.get("cost_usd", 0) for t in pass_telemetry), 2),
            "total_wall_s": sum(t.get("wall_s", 0) for t in pass_telemetry),
        },
        "confidence": "high",
        "provenance": "deterministic",
    }


def _surface_tag(filepath: str) -> str | None:
    """Map a file path to a coarse surface tag."""
    if filepath.startswith("web/react-gui/"):
        return "web/react-gui"
    if "flows.json" in filepath:
        return "flows.json"
    if filepath.startswith("database/"):
        return "database"
    if filepath.startswith("scripts/"):
        return "scripts"
    if filepath.startswith("conf/"):
        return "conf"
    if filepath.startswith("docs/"):
        return "docs"
    return None


def _archive_job(job_id: str, job_dir: Path):
    """Create a redacted, compressed archive of the job directory."""
    try:
        from ..config import ARCHIVE_DIR
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        archive_path = ARCHIVE_DIR / f"{job_id}.tar.gz"
        # Redact sensitive content before archiving
        redacted_dir = job_dir / ".redacted"
        redacted_dir.mkdir(exist_ok=True)
        for item in job_dir.iterdir():
            if item.name in ("worktree", ".redacted"):
                continue
            if item.suffix == ".json" and item.is_file():
                content = json.loads(item.read_text())
                redacted = redact.redact_dict(content)
                (redacted_dir / item.name).write_text(json.dumps(redacted, indent=2))
            elif item.is_file() and item.stat().st_size < 100_000:
                (redacted_dir / item.name).write_text(redact.redact_text(item.read_text()))
        with tarfile.open(archive_path, "w:gz") as tar:
            for item in redacted_dir.iterdir():
                tar.add(item, arcname=f"{job_id}/{item.name}")
        shutil.rmtree(redacted_dir, ignore_errors=True)
        log.info(f"Archived {job_id} to {archive_path}")
    except Exception as e:
        log.warning(f"Archive failed for {job_id}: {e}")


def _read_json(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _read_text(path: Path) -> str:
    return path.read_text() if path.exists() else ""
```

- [ ] **Step 2.5: Modify pipeline.py — add version stamp computation and pass_telemetry collection**

In `forge/pipeline.py`, add these changes:

1. At the top of `run_pipeline()`, compute and store the version stamp:

```python
from .learning.extract_signals import compute_version_stamp

def run_pipeline(job, job_dir, worktree, ctrl_cfg, codex_env):
    _setup_worktree(job, job_dir, worktree)

    version_stamp = compute_version_stamp(worktree)
    _write_json(job_dir / "version_stamp.json", version_stamp)

    pass_telemetry = []
    # ... rest of pipeline
```

2. After each CLI pass, record telemetry. For example, after `_run_planning()`:

```python
    t0 = time.time()
    plan = _run_planning(job, job_dir, worktree, ctrl_cfg)
    plan_wall = int(time.time() - t0)
    # Parse model_id from the CLI JSON envelope, not hardcoded.
    # _parse_model_id reads the same log as _parse_cost.
    pass_telemetry.append({
        "pass": "plan",
        "model_id": _parse_model_id(job_dir / "logs" / "claude-plan.log"),
        "cost_usd": _parse_cost(job_dir / "logs" / "claude-plan.log"),
        "wall_s": plan_wall, "outcome": "completed",
    })
```

3. Same pattern for exec, review, and fix passes. **IMPORTANT:** Also add
   telemetry capture after `_run_fix_cycle()` if it exists as a separate
   function (the Stage 1 code may have it factored out). The fix cycle has
   its own Codex and review passes that each need a telemetry entry.

4. **Persist stamps and telemetry incrementally to disk** — this is critical for
   the failure path. The controller's except block can read these from disk
   even when `run_pipeline()` raised before returning:

```python
    # After computing version_stamp at the top:
    _write_json(job_dir / "version_stamp.json", version_stamp)

    # After each pass, append to a telemetry file on disk:
    def _append_telemetry(entry):
        pass_telemetry.append(entry)
        _write_json(job_dir / "pass_telemetry.json", pass_telemetry)
```

5. Include `version_stamp` and `pass_telemetry` in **all** return dicts (success,
   fix-cycle, and failure paths):

```python
    if review["verdict"] == "approve":
        return {"state": "PR_OPEN", "plan": plan, "review": review,
                "version_stamp": version_stamp, "pass_telemetry": pass_telemetry}
    # ... also in the fix cycle return and any early-return paths
```

6. In `extract_signals`, if `pipeline_result` has empty stamps/telemetry,
   fall back to reading from disk:

```python
    stamps = pipeline_result.get("version_stamp", {})
    if not stamps:
        stamp_file = job_dir / "version_stamp.json"
        if stamp_file.exists():
            stamps = json.loads(stamp_file.read_text())

    pass_telemetry = pipeline_result.get("pass_telemetry", [])
    if not pass_telemetry:
        telem_file = job_dir / "pass_telemetry.json"
        if telem_file.exists():
            pass_telemetry = json.loads(telem_file.read_text())
```

5. Add the cost parser helper:

```python
def _parse_cost(log_path: Path) -> float:
    """Best-effort cost extraction from CLI log output."""
    if not log_path.exists():
        return 0.0
    text = log_path.read_text()[-2000:]
    match = re.search(r'"total_cost_usd":\s*([\d.]+)', text)
    if match:
        return float(match.group(1))
    match = re.search(r'Cost:\s*\$?([\d.]+)', text)
    return float(match.group(1)) if match else 0.0


def _parse_model_id(log_path: Path) -> str:
    """Extract the actual model id from CLI JSON envelope."""
    if not log_path.exists():
        return ""
    text = log_path.read_text()[-2000:]
    match = re.search(r'"model":\s*"([^"]+)"', text)
    return match.group(1) if match else ""
```

- [ ] **Step 2.6: Modify controller.py — wire extract_signals into cleanup**

In `forge/controller.py`, in the `_run_claimed_job()` function (NOT `_tick()` — verify
the actual function name in the Stage 1 code before editing). The extraction call must
run **before** `_cleanup_worktree()` in the `finally` block, because `extract_signals`
reads job_dir artifacts and the worktree for diff/surface data.

**IMPORTANT:** Read `controller.py` first to find the actual function name and structure.
The Stage 1 code may differ from the Stage 1 plan. Also note that `run_pipeline` has a
6th `report_state` parameter — match the real signature.

```python
from .learning.ledger import Ledger
from .learning.extract_signals import extract_signals
from .config import MEMORY_DB

# At the top of the job-handling function, initialize the ledger:
ledger = Ledger(MEMORY_DB)

# In the try block, after pipeline returns successfully:
try:
    extract_signals(job_id, job_dir, result, ledger)
except Exception as e:
    log.warning(f"Signal extraction failed for {job_id}: {e}")

# In the except block (pipeline raised), 'result' may be unbound — build a
# minimal dict from the exception context, NOT from 'result':
except Exception as pipeline_exc:
    try:
        # Read version_stamp.json from disk if it was written before the failure
        stamp_path = job_dir / "version_stamp.json"
        saved_stamp = json.loads(stamp_path.read_text()) if stamp_path.exists() else {}
        extract_signals(job_id, job_dir,
                        {"state": "AGENT_FAILED",
                         "reason": str(pipeline_exc),
                         "version_stamp": saved_stamp,
                         "pass_telemetry": []}, ledger)
    except Exception as e:
        log.warning(f"Signal extraction failed for {job_id}: {e}")
```

- [ ] **Step 2.7: Run tests**

```bash
cd forge && python -m pytest tests/unit/test_extract_signals.py -v
# Expected: all tests PASS
```

- [ ] **Step 2.8: Commit**

```bash
git add forge/learning/extract_signals.py forge/pipeline_config.json \
        forge/pipeline.py forge/controller.py \
        forge/tests/unit/test_extract_signals.py
git commit -m "$(cat <<'EOF'
feat(learning): version stamps, signal extraction, pass telemetry

Every job now records: skills_sha, prompts_version, config_id, model
ids per pass (version stamp); S1–S12 pipeline signals; and per-pass
cost/latency telemetry. extract_signals() runs in the controller
cleanup step. Job archives are redacted and compressed to memory/archive/.
EOF
)"
```

---

## Task 3: Request Interpretation + PR Body Conventions

**Files:**
- Modify: `forge/prompts/plan_schema.json`
- Modify: `forge/prompts/plan_system.md`
- Modify: `forge/github_pr.py`
- Create: `forge/tests/unit/test_interpretation.py`

**Interfaces:**
- Consumes: Stage 1's `plan_schema.json`, `plan_system.md`, `github_pr.push_and_create_pr()`
- Produces: `request_interpretation` block in every plan; interpretation block + reviewer conventions in every PR body; `INTERPRETATION:` / `LESSON:` / `GATE:` prefix parsing convention documented in PR template

- [ ] **Step 3.1: Write failing tests**

```python
# forge/tests/unit/test_interpretation.py
"""Tests for plan schema interpretation field and PR body rendering."""
import json
from pathlib import Path

import pytest


def test_plan_schema_has_interpretation_field():
    """The plan JSON schema must include request_interpretation."""
    schema_path = Path(__file__).parent.parent.parent / "prompts" / "plan_schema.json"
    schema = json.loads(schema_path.read_text())
    props = schema.get("properties", {})
    assert "request_interpretation" in props
    interp = props["request_interpretation"]
    required = interp.get("required", [])
    assert "normalized_statement" in required
    assert "register" in required
    assert "ambiguity" in required
    assert "assumed_mappings" in required
    # Register enum
    reg_enum = interp["properties"]["register"]["enum"]
    assert set(reg_enum) >= {"farmer", "agronomist", "engineer", "mixed"}


def test_pr_body_contains_interpretation_block():
    """PR body must render the interpretation for reviewer feedback."""
    from forge.github_pr import build_pr_body
    job = {
        "title": "Fix typo",
        "githubIssueNumber": 42,
    }
    plan = {
        "plan_summary": "Fix typo in locale file.",
        "request_interpretation": {
            "normalized_statement": "Typo 'Passwrod' in auth locale",
            "register": "farmer",
            "language": "en",
            "ambiguity": "low",
            "assumed_mappings": [
                {"phrase": "login screen", "technical_meaning": "auth page locale",
                 "confidence": "high"},
            ],
        },
    }
    body = build_pr_body(job, plan, "Tests passed")
    assert "## Interpretation" in body
    assert "Passwrod" in body
    assert "register: farmer" in body.lower() or "farmer" in body
    assert "INTERPRETATION:" in body  # reviewer instruction


def test_pr_body_contains_reviewer_conventions():
    """PR body must document the three reviewer prefix conventions."""
    from forge.github_pr import build_pr_body
    body = build_pr_body(
        {"title": "Test", "githubIssueNumber": 1},
        {"plan_summary": "x", "request_interpretation": {
            "normalized_statement": "test", "register": "engineer",
            "ambiguity": "low", "assumed_mappings": [],
        }},
        "ok")
    assert "INTERPRETATION:" in body
    assert "LESSON:" in body
    assert "GATE:" in body


def test_pr_body_without_interpretation_still_works():
    """Jobs where planning didn't produce interpretation should still render."""
    from forge.github_pr import build_pr_body
    body = build_pr_body(
        {"title": "Test"},
        {"plan_summary": "x"},
        "ok")
    assert "## Summary" in body
```

- [ ] **Step 3.2: Run tests to verify they fail**

```bash
cd forge && python -m pytest tests/unit/test_interpretation.py -v
# Expected: FAIL
```

- [ ] **Step 3.3: Extend plan_schema.json with request_interpretation**

Add to the `properties` object in `forge/prompts/plan_schema.json`:

```json
"request_interpretation": {
  "type": "object",
  "required": ["normalized_statement", "register", "ambiguity", "assumed_mappings"],
  "properties": {
    "normalized_statement": {
      "type": "string",
      "description": "Restate the request in repo-technical terms. The fenced original is the only authority-free evidence."
    },
    "register": {
      "type": "string",
      "enum": ["farmer", "agronomist", "engineer", "mixed"],
      "description": "Submitter register — determines evidence weight of the stated diagnosis."
    },
    "language": {
      "type": "string",
      "description": "ISO 639-1 code of the request text."
    },
    "ambiguity": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "description": "How much of the request required interpretation."
    },
    "assumed_mappings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["phrase", "technical_meaning", "confidence"],
        "properties": {
          "phrase": { "type": "string" },
          "technical_meaning": { "type": "string" },
          "confidence": { "type": "string", "enum": ["low", "medium", "high"] }
        }
      },
      "description": "Each vernacular phrase mapped to a technical concept. Low-confidence on a load-bearing phrase + high ambiguity → escalation_needed or needs-info."
    }
  }
}
```

Also add `"request_interpretation"` to the top-level `"required"` array.

- [ ] **Step 3.4: Add interpretation behavioral rules to plan_system.md**

Append to `forge/prompts/plan_system.md`:

```markdown
## Request Interpretation (required)

You MUST fill `request_interpretation` in your plan output.

- `normalized_statement`: restate the field request in repo-technical terms.
  The fenced original remains the only authority-free evidence — your
  restatement is a hypothesis, not a replacement.
- `register`: infer from vocabulary and framing. Farmer text is strong
  evidence of a symptom, weak evidence of a cause. Engineer text is strong
  evidence of a hypothesis that still needs verification — cite `file:line`
  confirming or refuting the stated diagnosis before building on it.
- `ambiguity: high` + any `confidence: low` mapping on a load-bearing phrase
  → you MUST set `escalation_needed: true` or recommend `needs-info`.
  Confidently inventing a fix for a vague report is the failure mode.
- `assumed_mappings`: for every non-obvious term you interpreted, record
  the phrase, your mapping, and your confidence. This is how the reviewer
  catches misinterpretations at near-zero cost.
```

- [ ] **Step 3.5: Modify github_pr.py — render interpretation block + conventions**

**IMPORTANT:** First read `forge/github_pr.py` to find the existing function name.
Stage 1's code exports `build_pr_body()` (public, no underscore), which `pipeline.py`
imports as `from .github_pr import build_pr_body`. Extend this existing function in
place — do NOT rename it or add a second function. Keep the same export name so
existing imports continue to work. The function below shows the target implementation:

```python
def build_pr_body(job: dict, plan: dict, exec_report: str) -> str:
    """Build the PR body with interpretation block and reviewer conventions."""
    issue = job.get("githubIssueNumber")
    parts = [
        "## Summary\n\nAutomated implementation of field request.",
        f"Closes #{issue}" if issue else "",
        f"\n## Plan\n\n{plan.get('plan_summary', '')}",
    ]

    # Interpretation block (spec §6.2)
    interp = plan.get("request_interpretation")
    if interp:
        mappings_text = ""
        for m in interp.get("assumed_mappings", []):
            mappings_text += f"\n  - \"{m.get('phrase')}\" → {m.get('technical_meaning')} (confidence: {m.get('confidence')})"

        parts.append(
            f"\n## Interpretation\n\n"
            f"**Normalized statement:** {interp.get('normalized_statement', 'N/A')}\n"
            f"**Register:** {interp.get('register', 'unknown')} · "
            f"**Language:** {interp.get('language', '?')} · "
            f"**Ambiguity:** {interp.get('ambiguity', '?')}\n"
            f"**Assumed mappings:**{mappings_text if mappings_text else ' (none)'}\n\n"
            f"> If any mapping is wrong, reply `INTERPRETATION: <correction>`."
        )

    parts.append(f"\n## Verification\n\n```\n{exec_report[:3000]}\n```")

    parts.append(
        "\n## Reviewer conventions\n\n"
        "These structured prefixes feed the forge's learning loop:\n"
        "- `INTERPRETATION: <correction>` — a mapping above is wrong\n"
        "- `LESSON: <statement>` — explicit guidance for future jobs\n"
        "- `GATE: noise` / `GATE: valid` — verdict on a gate warning\n"
    )

    parts.append("\n---\n*Created by OSI Forge. Human review and merge required.*")

    return "\n".join(filter(None, parts))
```

Update `push_and_create_pr()` to use `_build_pr_body()` instead of inlining the body construction.

- [ ] **Step 3.6: Run tests**

```bash
cd forge && python -m pytest tests/unit/test_interpretation.py -v
# Expected: all 4 tests PASS
```

- [ ] **Step 3.7: Commit**

```bash
git add forge/prompts/plan_schema.json forge/prompts/plan_system.md \
        forge/github_pr.py forge/tests/unit/test_interpretation.py
git commit -m "$(cat <<'EOF'
feat(learning): request interpretation in plan schema + PR body conventions

Plan schema now requires request_interpretation (normalized_statement,
register, ambiguity, assumed_mappings). PR bodies render the interpretation
block with reviewer instruction and document the three structured-prefix
conventions (INTERPRETATION:/LESSON:/GATE:) that feed the learning loop.
EOF
)"
```

---

## Task 4: GitHub Harvest Cron

**Files:**
- Create: `forge/learning/harvest_github.py`
- Create: `forge/tests/unit/test_harvest.py`

**Interfaces:**
- Consumes: `Ledger` from Task 1, GitHub App token from `forge.github_pr._get_installation_token()`, `gh` CLI on the runner
- Produces: `harvest_github(ledger, ctrl_cfg)` that polls agent PRs, writes H1–H7 signals, updates `jobs` rows with `pr_outcome`, `merge_latency_h`, `human_fixup_lines`, `interpretation_corrected`

- [ ] **Step 4.1: Write failing tests**

```python
# forge/tests/unit/test_harvest.py
"""Tier A harvest tests — deterministic parsing, mocked git/gh output."""
import json
from unittest.mock import patch, MagicMock

import pytest

from forge.learning.harvest_github import (
    parse_review_comments,
    compute_fixup_diff_stats,
    _parse_structured_prefix,
)


def test_parse_interpretation_comment():
    comments = [
        {"body": "INTERPRETATION: 'the water thing' is not the pump, it's the STREGA valve",
         "user": {"login": "phil"}, "author_association": "OWNER",
         "created_at": "2026-07-11T10:00:00Z"},
    ]
    parsed = parse_review_comments(comments)
    assert len(parsed) == 1
    assert parsed[0]["prefix"] == "INTERPRETATION"
    assert "STREGA valve" in parsed[0]["content"]
    assert parsed[0]["provenance"] == "human"


def test_parse_lesson_comment():
    comments = [
        {"body": "LESSON: check for an existing formatter before adding one",
         "user": {"login": "phil"}, "author_association": "OWNER",
         "created_at": "2026-07-11T10:00:00Z"},
    ]
    parsed = parse_review_comments(comments)
    assert parsed[0]["prefix"] == "LESSON"


def test_parse_gate_comment():
    comments = [
        {"body": "GATE: noise",
         "user": {"login": "phil"}, "author_association": "OWNER",
         "created_at": "2026-07-11T10:00:00Z"},
    ]
    parsed = parse_review_comments(comments)
    assert parsed[0]["prefix"] == "GATE"
    assert parsed[0]["content"] == "noise"


def test_parse_unprefixed_comment():
    comments = [
        {"body": "This looks good but the variable name could be clearer.",
         "user": {"login": "phil"}, "author_association": "OWNER",
         "created_at": "2026-07-11T10:00:00Z"},
    ]
    parsed = parse_review_comments(comments)
    assert parsed[0]["prefix"] is None
    assert parsed[0]["provenance"] == "human"


def test_compute_fixup_stats_empty():
    stats = compute_fixup_diff_stats("")
    assert stats["total_added"] == 0
    assert stats["total_removed"] == 0


def test_compute_fixup_stats_with_diff():
    diff = """diff --git a/src/App.tsx b/src/App.tsx
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -10,3 +10,5 @@
-const old = "bad";
+const fixed = "good";
+const extra = "line";
"""
    stats = compute_fixup_diff_stats(diff)
    assert stats["total_added"] == 2
    assert stats["total_removed"] == 1
    assert "src/App.tsx" in stats["files"]


def test_structured_prefix_parsing():
    assert _parse_structured_prefix("INTERPRETATION: fix") == ("INTERPRETATION", "fix")
    assert _parse_structured_prefix("LESSON: always check") == ("LESSON", "always check")
    assert _parse_structured_prefix("GATE: noise") == ("GATE", "noise")
    assert _parse_structured_prefix("GATE: valid") == ("GATE", "valid")
    assert _parse_structured_prefix("Just a normal comment") == (None, "Just a normal comment")
    assert _parse_structured_prefix("interpretation: lowercase") == ("INTERPRETATION", "lowercase")
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd forge && python -m pytest tests/unit/test_harvest.py -v
# Expected: FAIL — ImportError
```

- [ ] **Step 4.3: Implement harvest_github.py**

```python
# forge/learning/harvest_github.py
"""Daily GitHub harvest — polls agent PRs for human-behavior signals H1–H7.

Runs as a daily cron under forge-runner. Uses the GitHub App token
(read-only calls) via httpx.
"""
import json
import logging
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .ledger import Ledger
from . import redact

log = logging.getLogger("forge.learning.harvest")

_PREFIX_RE = re.compile(
    r"^(INTERPRETATION|LESSON|GATE)\s*:\s*(.+)",
    re.IGNORECASE | re.DOTALL,
)


def harvest_github(ledger: Ledger, ctrl_cfg: dict, repo: str = "Open-Smart-Irrigation/osi-os"):
    """Poll agent PRs and extract human-behavior signals."""
    from ..github_pr import _get_installation_token
    token = _get_installation_token(ctrl_cfg)
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
    }

    import httpx

    with httpx.Client(headers=headers, timeout=30.0) as client:
        # Fetch recently updated agent PRs (last 14 days)
        prs = _fetch_agent_prs(client, repo)
        log.info(f"Found {len(prs)} agent PRs to process")

        for pr in prs:
            job_id = _extract_job_id(pr["head"]["ref"])
            if not job_id:
                continue

            job = ledger.get_job(job_id)
            if not job:
                log.debug(f"No ledger entry for {job_id}, skipping PR #{pr['number']}")
                continue

            # Skip if already harvested and PR state hasn't changed.
            # Phase A never sets outcome_label (that's Phase B), so check H1 signals
            # and compare the PR's current state to the stored pr_outcome.
            existing_signals = ledger.get_signals(job_id)
            existing_h1 = [s for s in existing_signals if s["type"] == "H1"]
            if existing_h1:
                current_state = "merged" if pr.get("merged_at") else (
                    "closed_unmerged" if pr.get("state") == "closed" else "open")
                if job.get("pr_outcome") == current_state:
                    continue  # no state change since last harvest

            updates = {}
            signals = []

            # H1: merge state
            merged = pr.get("merged_at") is not None
            closed = pr.get("state") == "closed"
            if merged:
                updates["pr_outcome"] = "merged"
                # H5: merge latency
                created = datetime.fromisoformat(pr["created_at"].replace("Z", "+00:00"))
                merged_at = datetime.fromisoformat(pr["merged_at"].replace("Z", "+00:00"))
                latency_h = (merged_at - created).total_seconds() / 3600
                updates["merge_latency_h"] = round(latency_h, 1)
            elif closed:
                updates["pr_outcome"] = "closed_unmerged"
            else:
                updates["pr_outcome"] = "open"

            signals.append({
                "type": "H1",
                "payload": {"pr_number": pr["number"],
                             "state": pr["state"], "merged": merged},
                "confidence": "high",
                "provenance": "deterministic",
            })

            # H2: fixup diff (only for merged PRs)
            if merged:
                fixup = _compute_fixup(client, repo, pr)
                if fixup["total_added"] > 0 or fixup["total_removed"] > 0:
                    updates["human_fixup_lines"] = fixup["total_added"] + fixup["total_removed"]
                    signals.append({
                        "type": "H2",
                        "payload": redact.redact_dict(fixup),
                        "confidence": "high",
                        "provenance": "deterministic",
                    })
                else:
                    updates["human_fixup_lines"] = 0

            # H4/H6/H7: review comments
            comments = _fetch_review_comments(client, repo, pr["number"])
            parsed = parse_review_comments(comments)

            # Only trust structured prefixes from maintainers (OWNER, MEMBER,
            # COLLABORATOR). Other commenters on this public repo are untrusted.
            _TRUSTED_ASSOCIATIONS = {"OWNER", "MEMBER", "COLLABORATOR"}
            interpretation_corrected = None
            for p in parsed:
                is_trusted = p.get("author_association", "") in _TRUSTED_ASSOCIATIONS
                if p["prefix"] and not is_trusted:
                    p["provenance"] = "field-untrusted"
                    p["prefix"] = None  # demote to unprefixed
                if p["prefix"] == "INTERPRETATION":
                    # "INTERPRETATION: correct" = confirmed (0).
                    # Anything else = corrected (1). Use exact match to avoid
                    # false negatives like "the correct mapping is the valve".
                    interpretation_corrected = 0 if p["content"].strip().lower() == "correct" else 1
                    signals.append({
                        "type": "H6",
                        "payload": {"correction": p["content"][:500]},
                        "confidence": "high",
                        "provenance": "human",
                    })
                elif p["prefix"] == "LESSON":
                    signals.append({
                        "type": "H7",
                        "payload": {"lesson": p["content"][:500]},
                        "confidence": "high",
                        "provenance": "human",
                    })
                elif p["prefix"] == "GATE":
                    signals.append({
                        "type": "H4",
                        "payload": {"gate_verdict": p["content"].strip().lower(),
                                     "comment": p["raw"][:200]},
                        "confidence": "high",
                        "provenance": "human",
                    })
                else:
                    signals.append({
                        "type": "H4",
                        "payload": {"comment": p["content"][:500]},
                        "confidence": "medium",
                        "provenance": "human",
                    })

            if interpretation_corrected is not None:
                updates["interpretation_corrected"] = interpretation_corrected

            # H5: review round count (distinct dates with comments, not distinct users)
            review_rounds = len(set(
                (c.get("created_at") or c.get("createdAt", ""))[:10]
                for c in comments if c.get("body", "").strip()
            ))
            signals.append({
                "type": "H5",
                "payload": {"merge_latency_h": updates.get("merge_latency_h"),
                             "review_rounds": review_rounds},
                "confidence": "medium",
                "provenance": "deterministic",
            })

            # Write to ledger
            if updates:
                ledger.update_job(job_id, updates)
            for sig in signals:
                ledger.record_signal(job_id, sig)

            log.info(f"Harvested PR #{pr['number']} for {job_id}: "
                     f"{len(signals)} signals, fixup={updates.get('human_fixup_lines', 'N/A')}")


def parse_review_comments(comments: list[dict]) -> list[dict]:
    """Parse review comments, extracting structured prefixes."""
    parsed = []
    for c in comments:
        body = c.get("body", "").strip()
        if not body:
            continue
        prefix, content = _parse_structured_prefix(body)
        # REST API shape: "user" (not "author"), "created_at" (not "createdAt")
        user = c.get("user") or c.get("author") or {}
        login = user.get("login", "")
        created = c.get("created_at") or c.get("createdAt", "")
        parsed.append({
            "prefix": prefix,
            "content": content,
            "raw": body,
            "author": login,
            "author_association": c.get("author_association", ""),
            "created_at": created,
            "provenance": "human",
        })
    return parsed


def _parse_structured_prefix(text: str) -> tuple[str | None, str]:
    """Extract INTERPRETATION:/LESSON:/GATE: prefix if present."""
    match = _PREFIX_RE.match(text.strip())
    if match:
        return match.group(1).upper(), match.group(2).strip()
    return None, text


def compute_fixup_diff_stats(diff: str) -> dict:
    """Compute per-file add/remove line counts from a diff."""
    files = {}
    current_file = None
    total_added = 0
    total_removed = 0

    for line in diff.splitlines():
        if line.startswith("diff --git"):
            match = re.search(r"b/(.+)$", line)
            current_file = match.group(1) if match else None
            if current_file:
                files[current_file] = {"added": 0, "removed": 0}
        elif line.startswith("+") and not line.startswith("+++"):
            total_added += 1
            if current_file and current_file in files:
                files[current_file]["added"] += 1
        elif line.startswith("-") and not line.startswith("---"):
            total_removed += 1
            if current_file and current_file in files:
                files[current_file]["removed"] += 1

    return {
        "total_added": total_added,
        "total_removed": total_removed,
        "files": files,
    }


def _fetch_agent_prs(client, repo: str) -> list[dict]:
    """Fetch recently updated PRs with agent/* head branches."""
    since = (datetime.now(timezone.utc) - timedelta(days=14)).strftime("%Y-%m-%dT%H:%M:%SZ")
    prs = []
    page = 1
    while True:
        resp = client.get(
            f"https://api.github.com/repos/{repo}/pulls",
            params={"state": "all", "sort": "updated", "direction": "desc",
                     "per_page": 30, "page": page})
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        for pr in batch:
            if pr.get("updated_at", "") < since:
                return prs
            if pr.get("head", {}).get("ref", "").startswith("agent/"):
                prs.append(pr)
        page += 1
        if page > 5:
            break
    return prs


def _fetch_review_comments(client, repo: str, pr_number: int) -> list[dict]:
    """Fetch all review comments for a PR."""
    resp = client.get(
        f"https://api.github.com/repos/{repo}/pulls/{pr_number}/comments")
    resp.raise_for_status()
    comments = resp.json()

    # Also fetch issue comments (general PR comments)
    resp2 = client.get(
        f"https://api.github.com/repos/{repo}/issues/{pr_number}/comments")
    resp2.raise_for_status()
    comments.extend(resp2.json())

    return comments


def _compute_fixup(client, repo: str, pr: dict) -> dict:
    """Compute the human fixup diff for a merged PR."""
    # Find the last agent commit vs merge commit
    resp = client.get(
        f"https://api.github.com/repos/{repo}/pulls/{pr['number']}/commits")
    resp.raise_for_status()
    commits = resp.json()

    # Identify agent commits by git author email (from _setup_worktree config).
    # Top-level "author" can be null when the email doesn't map to a GitHub account.
    agent_commits = [
        c for c in commits
        if (c.get("commit", {}).get("author", {}).get("email") == "forge@opensmartirrigation.org"
            or (c.get("author") and c["author"].get("login") in ("osi-forge[bot]",)))
    ]
    if not agent_commits:
        return compute_fixup_diff_stats("")

    last_agent_sha = agent_commits[-1]["sha"]

    # Diff from last agent commit to the merge commit
    merge_sha = pr.get("merge_commit_sha")
    if not merge_sha or merge_sha == last_agent_sha:
        return compute_fixup_diff_stats("")

    resp = client.get(
        f"https://api.github.com/repos/{repo}/compare/{last_agent_sha}...{merge_sha}",
        headers={"Accept": "application/vnd.github.diff"})
    if resp.status_code == 200:
        return compute_fixup_diff_stats(resp.text)

    return compute_fixup_diff_stats("")


def _extract_job_id(branch: str) -> str | None:
    """Extract job_id from branch name: agent/req-<shortid>-<slug> → req-<shortid>."""
    match = re.match(r"agent/(req-[a-f0-9]{8})", branch)
    return match.group(1) if match else None


def main():
    """CLI entry point for daily cron."""
    import logging
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(name)s %(levelname)s %(message)s")

    from ..config import MEMORY_DB, load_controller_config
    ledger = Ledger(MEMORY_DB)
    ctrl_cfg = load_controller_config()
    harvest_github(ledger, ctrl_cfg)


if __name__ == "__main__":
    main()
```

- [ ] **Step 4.4: Run tests**

```bash
cd forge && python -m pytest tests/unit/test_harvest.py -v
# Expected: all 7 tests PASS
```

- [ ] **Step 4.5: Commit**

```bash
git add forge/learning/harvest_github.py forge/tests/unit/test_harvest.py
git commit -m "$(cat <<'EOF'
feat(learning): daily GitHub harvest for human-behavior signals

harvest_github.py polls agent/* PRs via the GitHub API, extracts:
H1 merge state, H2 human fixup diffs, H4 review comments (with
INTERPRETATION:/LESSON:/GATE: prefix parsing), H5 merge latency,
H6 interpretation corrections, H7 explicit lessons. Updates the
forge-memory.db ledger. Designed as a daily cron under forge-runner.
EOF
)"
```

- [ ] **Step 4.6: Wire harvest cron on test server (ops, not code)**

```bash
ssh rocky@server.opensmartirrigation.org '
sudo -u forge-runner bash -c "
(crontab -l 2>/dev/null; echo \"30 6 * * * cd /home/forge-runner && ~/venv/bin/python -m forge.learning.harvest_github >> ~/logs/harvest.log 2>&1\") | crontab -
"
'
```

---

## Self-Review

**Spec coverage (checked against self-learning-loop-design.md §9 Phase A):**
- A1 (`forge/learning/` skeleton + `schema.sql` + `ledger.py`): Task 1 ✓
- A2 (version stamping in controller): Task 2, Step 2.5 ✓
- A3 (`extract_signals.py` wired into cleanup): Task 2, Steps 2.4 + 2.6 ✓
- A4 (`request_interpretation` + PR body + reviewer conventions): Task 3 ✓
- A5 (`harvest_github.py` daily cron): Task 4 ✓
- A6 (`pipeline_config.json` + `pass_telemetry`): Task 2, Steps 2.1 + 2.5 ✓

**Phase A exit criterion:** "every job produces a complete `jobs` row with stamps, and a merged PR produces fixup/comment signals within 24 h" — the extraction runs per-job (Task 2) and the harvest runs daily (Task 4), satisfying both halves.

**Placeholder scan:** No TBDs. Every step has exact code. The `_parse_cost` helper in Step 2.5 is best-effort (CLI output format varies) but has a concrete implementation, not a placeholder.

**Type consistency:** `Ledger.record_job(dict)` ← called with the exact columns from `schema.sql`. `extract_signals(job_id, job_dir, pipeline_result, ledger)` ← called in controller.py with the same signature. `_build_pr_body(job, plan, exec_report)` ← used by both the test and `push_and_create_pr`. `parse_review_comments(list[dict]) → list[dict]` ← tested with the same input/output shapes.

**Integration with Stage 1:** All modifications are additive to Stage 1 files (new imports, new calls in existing functions, extended return dicts). No Stage 1 behavior is changed — only instrumented.

**Integration with test suite plan:** The test suite plan's Task 5 (`classify.py` + `propose_skill_edits.py`) operates on *simulation* data. This plan's `extract_signals.py` operates on *production* data. They share the `Ledger` but do not conflict. Phase B will extend the test suite's classifier to also read production evidence from the ledger.

---

## Fable Review Errata (2026-07-11)

**Critical instruction:** This plan was originally written against the Stage 1 *plan*
document. The actual Stage 1 code in `feat/forge-controller-stage1` differs in structure.
Before executing any "Modify" step, **read the real file first** and match function names,
signatures, and control flow. Known divergences (fixed inline above):

- `_tick()` → actual name is `_run_claimed_job()` (verify)
- `run_pipeline` has a 6th `report_state` param the plan omitted
- `_run_fix_cycle()` is a separate function, not inline — it builds its own return dict
- `build_pr_body()` is the public export (no underscore), imported by `pipeline.py`

**Remaining medium findings to address during execution:**

- **M4:** After a fix cycle, the final review verdict is in `review-fix.json`, not `review.json`.
  S5 extraction should read both; S6's `fix-instructions.md` may not exist — Stage 1 stores fix
  instructions inside `review.json.fix_instructions`. Adapt accordingly.
- **M5:** S10 (plan hallucination) currently runs post-execution, which means Codex-created files
  mask hallucinations. Ideally S10 checks `files_to_touch` against the repo state at plan time
  (pre-execution). In practice this means computing it from `version_stamp.json`'s `skills_sha`
  baseline, not the post-execution worktree.
- **M6:** Fixup diff under squash-merge includes the agent's entire change. Use `git log
  --author=!forge@opensmartirrigation.org` on the branch instead of comparing SHAs. Under
  merge-commit, filter out commits concurrent to main.
- **M7:** Stage 1 tests are flat `forge/tests/test_*.py`. This plan creates `forge/tests/unit/`.
  Ensure `__init__.py` exists in both and imports work from the project root.

**Low findings (no plan edit needed, just awareness):**

- **L3:** Remove dead imports (`os`, `re`, `shutil`, `SURFACE_SKILL_MAP`) from extract_signals.py
  as part of implementation. The IP-redaction regex also catches version strings like `1.2.3.4` —
  consider using `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` only when not preceded by `v` or
  followed by `-`.
- **L4:** The forge README must document the three reviewer conventions (`INTERPRETATION:`,
  `LESSON:`, `GATE:`). Add a section to the forge's README as part of Task 3.
- **H3 (duplicate job_id on retries):** If a failed job is retried, the same `req-<shortid>` would
  collide on PK. Options: (a) use `INSERT OR REPLACE` (upsert) in `record_job`, or (b) key by
  the job_dir name which includes a timestamp. The executor should choose based on the actual retry
  semantics in the controller. If retries exist, use upsert.
