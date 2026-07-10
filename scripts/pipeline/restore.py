"""Restore a gateway from its on-Pi backup."""
from __future__ import annotations
from .config import GatewayConfig
from .deploy import ssh


def restore_gateway(gw: GatewayConfig, backup_path: str) -> bool:
    r = ssh(gw, f"sh {gw.backup_dir}/restore-pre-deploy.sh {backup_path}", timeout=120)
    if r.returncode != 0:
        print(f"RESTORE FAILED: {r.stderr}")
        return False
    print(f"Restored from {backup_path}")
    return True
