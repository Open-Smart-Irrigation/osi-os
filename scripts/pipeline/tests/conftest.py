"""Pytest bootstrap: make `pipeline` importable as a package regardless of cwd.

Tests are run as `cd scripts/pipeline && python -m pytest tests/ -v`, so the
package root (`scripts/`, the parent of `pipeline/`) must be on sys.path for
`from pipeline.config import ...` to resolve.
"""
from __future__ import annotations
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[2]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))
