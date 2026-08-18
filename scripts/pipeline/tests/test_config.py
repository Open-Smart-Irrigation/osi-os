import json, pytest
from pathlib import Path
from pipeline.config import (
    load_bundles, load_state, save_state, PipelineState, BUNDLES_PATH,
    GatewayConfig,
)

def test_load_bundles_from_real_file():
    bundles, gateways, servers, limits = load_bundles()
    assert len(bundles) >= 10
    assert bundles[0].id == "B0"
    assert bundles[0].needs_deploy is True
    assert gateways["kaba100"].host == "100.93.68.86"
    assert limits["max_fix_iterations"] == 3

def test_verification_timeout_s_dead_key_removed():
    # controller.py never reads limits.verification_timeout_s, and its 900s
    # value conflicts with Kaba100's 1500s ingest_wait_seconds window.
    *_, limits = load_bundles()
    assert "verification_timeout_s" not in limits

def test_ci_only_bundle_does_not_need_deploy():
    bundles, *_ = load_bundles()
    b2 = next(b for b in bundles if b.id == "B2")
    assert b2.ci_only is True
    assert b2.needs_deploy is False


# --- ingest policy (GatewayConfig) -------------------------------------------

def test_kaba100_ingest_policy_from_real_file():
    _, gateways, _, _ = load_bundles()
    kaba100 = gateways["kaba100"]
    assert kaba100.require_ingest is True
    assert kaba100.ingest_wait_seconds == 1500
    assert kaba100.ingest_quiet_seconds == 60
    assert kaba100.ingest_max_clock_skew_seconds == 30

def test_inactive_gateway_ingest_policy_defaults_to_never_required():
    # silvan is reference-only and never carries ingest_* overrides in
    # bundles.json — it must fall back to the inactive-gateway defaults.
    _, gateways, _, _ = load_bundles()
    silvan = gateways["silvan"]
    assert silvan.require_ingest is False
    assert silvan.ingest_wait_seconds == 120
    assert silvan.ingest_quiet_seconds == 10
    assert silvan.ingest_max_clock_skew_seconds == 30

def _gw(**overrides):
    base = dict(host="h", ssh_user="root", ssh_key="~/.ssh/id_ed25519",
                db_path="/data/db/farming.db", gui_url="http://h:1880/gui")
    base.update(overrides)
    return GatewayConfig(**base)

def test_gateway_config_rejects_negative_quiet_seconds():
    with pytest.raises(ValueError):
        _gw(ingest_wait_seconds=100, ingest_quiet_seconds=-1)

def test_gateway_config_rejects_quiet_equal_to_wait():
    with pytest.raises(ValueError):
        _gw(ingest_wait_seconds=100, ingest_quiet_seconds=100)

def test_gateway_config_rejects_quiet_longer_than_wait():
    with pytest.raises(ValueError):
        _gw(ingest_wait_seconds=100, ingest_quiet_seconds=101)

def test_gateway_config_accepts_quiet_zero_below_wait():
    gw = _gw(ingest_wait_seconds=100, ingest_quiet_seconds=0)
    assert gw.ingest_quiet_seconds == 0

def test_gateway_config_default_is_inactive_and_valid():
    gw = _gw()
    assert gw.require_ingest is False
    assert gw.ingest_wait_seconds == 120
    assert gw.ingest_quiet_seconds == 10
    assert gw.ingest_max_clock_skew_seconds == 30

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
