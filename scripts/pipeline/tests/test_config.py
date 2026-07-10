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
