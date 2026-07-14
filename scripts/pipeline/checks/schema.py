"""Check 10: live DB structural signature matches the bundle's target.

The original implementation read `SELECT value FROM gateway_health WHERE
key='schema_sig'` — that key-value table has never existed on shipped images
(issue #12's sibling read), so with an expected sig set the check compared
against an empty string, and sqlite errors on stderr were dropped.

The authoritative schema_sig is computed by the shipped osi-health-helper
structuralSignature() over the live DB — the same code path that feeds the
heartbeat schema_sig which deploy-canary-gate.js compares. Run exactly that
helper on the gateway (Node-RED userDir /srv/node-red, per
feeds/.../node-red/files/settings.js and deploy.sh) so there is a single
source of truth for the signature algorithm; a Python reimplementation would
drift. Any probe failure (node missing, module missing, sqlite error) is a
hard FAIL with stderr in detail.
"""
import pipeline.checks as checks
from . import CheckResult, VerifyContext

# Runs on the gateway via `node -e '<script>' <db_path>`. Double quotes only:
# the whole script is single-quoted for the remote BusyBox shell.
# process.argv[1] is the first argument after the -e script.
_SIG_SCRIPT = (
    'const sqlite3 = require("/srv/node-red/node_modules/sqlite3");'
    'const health = require("/srv/node-red/osi-health-helper");'
    'const raw = new sqlite3.Database(process.argv[1], sqlite3.OPEN_READONLY);'
    'const db = { all: (sql) => new Promise((res, rej) => '
    'raw.all(sql, (e, r) => e ? rej(e) : res(r || []))) };'
    'health.structuralSignature(db)'
    '.then((sig) => { console.log(sig); raw.close(); })'
    '.catch((e) => { console.error(String(e && e.message || e)); '
    'process.exitCode = 1; raw.close(); });'
)


def run(ctx: VerifyContext) -> CheckResult:
    if not ctx.expected_schema_sig:
        return CheckResult("schema", True, "no expected schema_sig (non-schema bundle)")
    r, err = checks.remote(ctx, f"node -e '{_SIG_SCRIPT}' {ctx.db_path}", timeout=60)
    if err:
        return CheckResult("schema", False, f"schema_sig probe failed: {err}")
    sig = r.stdout.strip()
    if not sig:
        stderr = checks.filtered_stderr(r.stderr) or "no stderr"
        return CheckResult("schema", False,
                           f"schema_sig probe returned no output ({stderr})")
    if sig == ctx.expected_schema_sig:
        return CheckResult("schema", True, f"schema_sig={sig}")
    return CheckResult("schema", False,
                       f"expected {ctx.expected_schema_sig}, got {sig}")
