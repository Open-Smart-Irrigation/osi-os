"""Build synthetic ARMv7 upgrade inputs from the 0.8.2 board and tagged OSI files."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'raspi5'))
from archives import verified_archive
from suite_vm import external_path

TAGS = {'v0.8.0': 'a0fe1ab72e733b49c8a27fecb94dab2b5f9c8b6a',
        'v0.8.1': '5e20911a6575edaa647d11ae72ba54920c10420f'}
BASE_COMMIT = '1f94aa9cd43c44b2bfc57f7d413387cd45c19c0f'
BASE_HASH = '02f896f1a61b60e69d76a8862e47b7f2095ba819fc01bee337b5c1cb5b3132a8'
ROOT = Path(__file__).resolve().parents[2]
OVERLAY = 'conf/full_raspberrypi_bcm27xx_bcm2709/files'
PACKAGE = 'feeds/chirpstack-openwrt-feed/apps/node-red/files'


def install(revision, dest, previous, *, scratch):
    installed = set()
    # Apply the package install layout, then the bcm2709 profile overlay.
    for prefix in (PACKAGE, OVERLAY):
        with tempfile.TemporaryFile(dir=scratch) as stream:
            subprocess.run(['git', '-C', ROOT, 'archive', revision, prefix], stdout=stream, check=True)
            stream.seek(0)
            with tarfile.open(fileobj=stream) as archive:
                for entry in archive:
                    if entry.isdir():
                        continue
                    name = entry.name.removeprefix(prefix + '/')
                    if prefix == PACKAGE:
                        if name.startswith('gui/'):
                            name = 'usr/lib/node-red/' + name
                        else:
                            name = {'node-red.init': 'etc/init.d/node-red',
                                    'node-red.nginx': 'etc/nginx/conf.d/node-red.locations',
                                    'settings.js': 'srv/node-red/settings.js'}.get(name)
                            if not name:
                                continue
                    installed.add(name)
                    if dest is None:
                        continue
                    path = dest / name
                    if not path.parent.resolve().is_relative_to(dest):
                        raise ValueError(f'overlay escapes fixture at {name}')
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.unlink(missing_ok=True)
                    if entry.issym():
                        path.symlink_to(entry.linkname)
                    elif entry.isfile():
                        path.write_bytes(archive.extractfile(entry).read())
                        # OpenWrt uses INSTALL_BIN for the service and INSTALL_DATA
                        # for its settings. Git tracks node-red.init as plain data.
                        mode = entry.mode
                        if prefix == PACKAGE and not name.startswith('usr/lib/node-red/gui/'):
                            mode = 0o755 if name == 'etc/init.d/node-red' else 0o644
                        path.chmod(mode)
                    else:
                        raise ValueError(f'unexpected archive member {name}')
    if dest:
        for name in previous - installed:
            path = dest/name
            if not path.parent.resolve().is_relative_to(dest):
                raise ValueError(f'path escapes fixture at {name}')
            path.unlink(missing_ok=True)
    return installed


def build(base, toolroot, output):
    with tempfile.TemporaryDirectory(prefix='verified-pi4-base-', dir=output.parent) as tmp:
        pinned = verified_archive(base, BASE_HASH, Path(tmp)/'base.img.gz', label='Pi 4 0.8.2 base')
        build_fixtures(pinned, toolroot, output)


def build_fixtures(base, toolroot, output):
    output.mkdir(mode=0o700)
    previous = install(BASE_COMMIT, None, set(), scratch=output)
    for tag, commit in TAGS.items():
        actual = subprocess.check_output(['git', '-C', ROOT, 'rev-parse', tag+'^{commit}'], text=True).strip()
        if actual != commit:
            raise ValueError(f'fixture tag moved: {tag}')
        folder = output/tag
        folder.mkdir()
        with tempfile.TemporaryDirectory(dir=folder) as tmp:
            work = Path(tmp)
            with gzip.open(base, 'rb') as source:
                mbr = source.read(512)
                off = struct.unpack_from('<I', mbr, 470)[0] * 512
                prefix = mbr + source.read(off - 512)
                squash = work/'original.squashfs'
                with squash.open('wb') as f:
                    shutil.copyfileobj(source, f)
            root = work/'rootfs'
            subprocess.run([toolroot/'bin/unsquashfs4', '-processors', '2', '-d', root, squash], check=True)
            installed = install(commit, root, previous, scratch=work)
            subprocess.run([toolroot/'bin/mksquashfs4', root, work/'root.squashfs',
                            '-noappend', '-comp', 'xz', '-b', '256k', '-processors', '2', '-mem', '256M'], check=True)
            evidence = {'tag': tag, 'commit': commit, 'base_sha256': BASE_HASH,
                        'tagged_payload_files': len(installed), 'payload_sha256': {}}
            key_files = {'usr/share/db/farming.db': OVERLAY+'/usr/share/db/farming.db',
                         'usr/share/flows.json': OVERLAY+'/usr/share/flows.json',
                         'etc/init.d/node-red': PACKAGE+'/node-red.init',
                         'usr/lib/node-red/gui/index.html': PACKAGE+'/gui/index.html'}
            listing = subprocess.check_output([toolroot/'bin/unsquashfs4', '-lln',
                                               work/'root.squashfs', 'etc/init.d/node-red'], text=True)
            if not any(line.startswith('-rwxr-xr-x ') and line.endswith('/etc/init.d/node-red')
                       for line in listing.splitlines()):
                raise ValueError(f'{tag} fixture Node-RED init script has the wrong installed mode')
            for name, source in key_files.items():
                data = subprocess.check_output([toolroot/'bin/unsquashfs4', '-processors', '1',
                                                '-cat', work/'root.squashfs', name])
                expected = subprocess.check_output(['git', '-C', ROOT, 'show', commit+':'+source])
                if data != expected:
                    raise ValueError(f'{tag} fixture mismatch at {name}')
                evidence['payload_sha256'][name] = hashlib.sha256(data).hexdigest()
            image = work/f'osi-os_{tag[1:]}-rpi4-TESTFIXTURE.img.gz'
            with gzip.open(image, 'wb', compresslevel=2) as dest:
                dest.write(prefix)
                with (work/'root.squashfs').open('rb') as f:
                    shutil.copyfileobj(f, dest)
                dest.write(bytes((-dest.tell()) % 65536))
                dest.write(bytes.fromhex('deadc0de'))
            with image.open('rb') as f:
                digest = hashlib.file_digest(f, 'sha256').hexdigest()
            image.replace(folder/image.name)
            (folder/'SHA256SUMS').write_text(f'{digest}  {image.name}\n')
            evidence['image_sha256'] = digest
            (folder/'provenance.json').write_text(json.dumps(evidence, indent=2)+'\n')
            print(tag, digest, flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', required=True, type=Path, help='pinned Pi 4 0.8.2 factory archive')
    parser.add_argument('--tools', required=True, type=Path, help='read-only OpenWrt staging_dir/host')
    parser.add_argument('--output', required=True, type=Path, help='new fixture directory')
    args = parser.parse_args()
    try:
        base = external_path(args.base, off_tmp=True)
        parent = external_path(args.output.parent, off_tmp=True)
    except (OSError, ValueError, RuntimeError):
        parser.error('base and output parent must exist outside Git trees and /tmp')
    try:
        tools = args.tools.resolve(strict=True)
    except (OSError, RuntimeError):
        parser.error('--tools must identify an existing OpenWrt staging_dir/host')
    if not tools.is_dir():
        parser.error('--tools must identify an OpenWrt staging_dir/host directory')
    os.umask(0o077)
    build(base, tools, parent/args.output.name)
