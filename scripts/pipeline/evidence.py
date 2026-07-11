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
