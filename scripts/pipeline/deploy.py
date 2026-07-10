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
        ["scp", "-O", "-i", gw.ssh_key, "-o", "IdentitiesOnly=yes",
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
    ssh(gw, f"mkdir -p {gw.backup_dir}")
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
    gui_dir = repo_root / "web" / "react-gui"
    subprocess.run(["npm", "run", "build"], cwd=gui_dir, check=True, timeout=300)

    tar_path = repo_root / "react_gui.tar.gz"
    subprocess.run(
        ["tar", "czf", str(tar_path), "-C", str(gui_dir / "build"), "."],
        check=True
    )

    import http.server, threading, functools
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(repo_root))
    srv = http.server.HTTPServer(("127.0.0.1", 9876), handler)
    srv_thread = threading.Thread(target=srv.serve_forever, daemon=True)
    srv_thread.start()

    try:
        # Reverse tunnel so Pi's localhost:9876 reaches workstation HTTP server.
        # Two-step curl→sh avoids masking curl failures in a pipeline.
        r = subprocess.run(
            ["ssh", "-i", gw.ssh_key, "-o", "IdentitiesOnly=yes",
             "-o", "ConnectTimeout=10",
             "-R", "9876:localhost:9876",
             f"{gw.ssh_user}@{gw.host}",
             "curl -fsS http://localhost:9876/deploy.sh -o /tmp/deploy.sh && sh /tmp/deploy.sh"],
            capture_output=True, text=True, timeout=600
        )
        if r.returncode != 0:
            return DeployResult(False, f"deploy.sh failed: {r.stderr[:500]}")
    finally:
        srv.shutdown()

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
