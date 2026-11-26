"""Build the zone archive from the public-domain IANA release used by Node.

Extract https://data.iana.org/time-zones/releases/tzdata2024b.tar.gz and
pass its directory to this script. The checked-in archive uses glibc zic 2.43.
"""

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


def main(source):
    here = Path(__file__).resolve().parent
    corpus = json.loads((here / "zones_iana.vectors.json").read_text())
    release = corpus["source"]["tz"]
    if (source / "version").read_text().strip() != release:
        raise SystemExit(f"Expected IANA tzdata {release}")
    names = sorted({
        name for _, name, _ in corpus["cases"] if name and not name.startswith("SystemV/")
    })
    files = "africa antarctica asia australasia europe northamerica southamerica etcetera backward"
    with TemporaryDirectory(dir=source.parent) as compiled:
        subprocess.run(["zic", "-b", "slim", "-d", compiled, *files.split()],
                       cwd=source, check=True)
        with ZipFile(here / f"zones_tzdata{release}.zip", "w") as archive:
            for name in names:
                archive.writestr(ZipInfo(name), (Path(compiled) / name).read_bytes(),
                                 compress_type=ZIP_DEFLATED, compresslevel=9)
            archive.comment = f"IANA tzdata {release} (public domain)".encode()


if __name__ == "__main__":
    main(Path(sys.argv[1]).resolve())
