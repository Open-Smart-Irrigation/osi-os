"""Stage the existing SQLite vectors and compare device results with the x86 oracle."""

import base64
import gzip
import io
import json
from pathlib import Path
import re
import shlex
import tarfile


ROOT = Path(__file__).resolve().parents[2]
VECTORS = ROOT / 'edge/vectors'
GUEST_SQLITE = '/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3'
GUEST_ROOT = '/root/osi-emulator-vectors'
GOLDEN = 'sqlite-engine.vectors.json'


def stage_vectors(path):
    workflow = ROOT / '.github/workflows/release-smoke.yml'
    pin = re.search(r"OSI_SMOKE_NODE_VERSION:\s*'([^']+)'", workflow.read_text())
    if not pin:
        raise RuntimeError('release smoke Node version pin is missing')
    source = (VECTORS / 'generate-sqlite.js').read_text()
    original = "Module.createRequire(path.join(ROOT, 'scripts/fixtures/release-smoke/package.json'))('sqlite3')"
    if source.count(original) != 1:
        raise RuntimeError('generator SQLite module path changed')
    source = source.replace(original, f'require({GUEST_SQLITE!r})')
    check = re.compile(r'^if \(process\.versions\.node !== pinned\).*$', re.MULTILINE)
    relaxed, matches = check.subn('', source)
    if matches != 1:
        raise RuntimeError('generator Node version check changed')
    with tarfile.open(path, 'w:gz') as archive:
        archive.add(VECTORS / GOLDEN, arcname=f'vectors/{GOLDEN}')
        for name, text in [
            ('.github/workflows/release-smoke.yml', pin[0] + '\n'),
            ('edge/vectors/generate-sqlite.js', source),
            ('edge/vectors/generate-sqlite-unpinned.js', relaxed),
            ('node-pin', pin[1] + '\n'),
        ]:
            blob = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(blob)
            archive.addfile(info, io.BytesIO(blob))


def compare_node_vectors(raw):
    actual = json.loads(raw)
    oracle = json.loads((VECTORS / GOLDEN).read_text())
    if [row['sql'] for row in actual['vectors']] != [row['sql'] for row in oracle['vectors']]:
        raise RuntimeError('device SQL list differs from the x86 oracle')
    return {
        'oracle': oracle['meta'],
        'device': actual['meta'],
        'compared': len(oracle['vectors']),
        'text_differences': [
            {'sql': want['sql'], 'x86': want.get('text'), 'arm64': got.get('text'),
             **({'x86_error': want.get('error'), 'arm64_error': got.get('error')}
                if want.get('error') != got.get('error') else {})}
            for want, got in zip(oracle['vectors'], actual['vectors'])
            if want.get('text') != got.get('text') or want.get('error') != got.get('error')
        ],
    }


def measure_node_vectors(vm, run_dir):
    guest = shlex.quote(GUEST_ROOT)
    result = vm.shell(vm.boot_media_script + f'''root={guest}
mkdir -p "$root"
tar -xzf "$media/vectors.tgz" -C "$root"
cd "$root"
uname -m
actual=$(node -p process.versions.node)
generator=generate-sqlite.js
if [ "$actual" != "$(cat node-pin)" ]; then generator=generate-sqlite-unpinned.js; fi
node "edge/vectors/$generator" >&2
node -e 'const f=require("node:fs"), z=require("node:zlib"); console.log(z.gzipSync(f.readFileSync("edge/vectors/{GOLDEN}")).toString("base64"))'
''', 120)
    machine, encoded = result.splitlines()
    if machine != 'aarch64':
        raise RuntimeError(f'expected guest aarch64, got {machine}')
    raw = gzip.decompress(base64.b64decode(encoded, validate=True))
    (run_dir / 'sqlite-engine.arm64.node.json').write_bytes(raw)
    report = compare_node_vectors(raw)
    report['uname_m'] = machine
    (run_dir / 'sqlite-engine.arm64.diff.json').write_text(json.dumps(report, indent=2) + '\n')
    return report


def measure_go_vectors(vm, run_dir):
    status, output = vm.command(vm.boot_media_script + f'''root={shlex.quote(GUEST_ROOT)}
mkdir -p "$root"
cp "$media/store.test" "$root/store.test"
chmod 755 "$root/store.test"
cd "$root"
./store.test -test.v -test.run '^TestSQLiteEngineVectors$'
''', 120)
    (run_dir / 'sqlite-engine.arm64.go.log').write_text(output + '\n')
    return {'exit': status, 'output': output}
