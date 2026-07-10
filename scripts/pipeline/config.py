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
    gui_url: str
    # Optional: not every gateway entry in bundles.json carries a backup_dir
    # (e.g. "silvan" is a reference-only gateway, never a deploy_target here).
    backup_dir: str | None = None


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


def next_bundle(bundles: list[BundleConfig], state: PipelineState) -> BundleConfig | None:
    """Return the bundle at the pipeline's current cursor, or None if the
    pipeline has advanced past the end of the bundle list."""
    if state.current_bundle_idx < 0 or state.current_bundle_idx >= len(bundles):
        return None
    return bundles[state.current_bundle_idx]
