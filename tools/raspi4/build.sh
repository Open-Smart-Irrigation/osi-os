#!/usr/bin/env bash
# Build outside the repository, inside an osi-heavy reservation.
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../raspi5/fetch-source.sh"
build_dir=${1:?usage: build.sh NEW_BUILD_DIRECTORY}
PYTHONPATH="$here/../raspi5" python3 -B -c 'from pathlib import Path; from sys import argv; from suite_vm import external_path
external_path(Path(argv[1]).parent, off_tmp=True)' "$build_dir"
mkdir "$build_dir"
cd "$build_dir"
export TMPDIR="$PWD" TMP="$PWD" TEMP="$PWD"

fetch_tree https://codeload.github.com/qemu/qemu/tar.gz/206c72c719c6542bfefed2a7122c14a7ef5541ce \
    c05ca069fb03bec9334525f7b05848c63a0cea0fb0656875c4c3056b6b77bb50 qemu
# The git archive omits these pinned Meson subprojects. Populate them and
# QEMU's accompanying Meson files before running configure offline.
(
    cd qemu/subprojects
    fetch_tree https://codeload.github.com/qemu/keycodemapdb/tar.gz/f5772a62ec52591ff6870b7e8ef32482371f22c6 \
        d014b53382dbb17b8196ad12f50de7f20d0ef1b9f7d54b0be51a6cbb14209195 keycodemapdb
    fetch_tree https://codeload.github.com/qemu/berkeley-softfloat-3/tar.gz/b64af41c3276f97f0e181920400ee056b9c88037 \
        faae889814ea6a292f7ca03d9b36e6c7e95bab2a64777804883cc822b8d48757 berkeley-softfloat-3
    fetch_tree https://codeload.github.com/qemu/berkeley-testfloat-3/tar.gz/e7af9751d9f9fd3b47911f51a5cfd08af256a9ab \
        e7a09d51dc7e96cb8422c919c85fc3833d4f788567638c9162ef5cd7db59b1df berkeley-testfloat-3
    for name in berkeley-softfloat-3 berkeley-testfloat-3; do
        cp -a "packagefiles/$name/." "$name/"
    done
)
fetch_tree https://codeload.github.com/raspberrypi/utils/tar.gz/5e9e2da862917107d5819be4a8903d9560595b9e \
    2ccde1fa1b62abdc1c852a3e1abc317cdf3671bb26e981f7dd8fc8577b89763c pi-utils
fetch_verified https://raw.githubusercontent.com/raspberrypi/tools/439b6198a9b340de5998dd14a26a0d9d38a6bcac/armstubs/armstub7.S \
    56a4556c240c72537a30da741ab7c6a2214817f5ecaddd64308bc1da03aa042e armstub7.S

python3 -B "$here/hat.py" qemu
(cd qemu && ./configure --target-list=aarch64-softmmu --disable-docs --disable-debug-info \
    --disable-download --disable-rust --enable-fdt=system)
ninja -C qemu/build -j "${JOBS:-4}" qemu-system-aarch64
qemu/build/qemu-system-aarch64 -machine help | grep '^raspi4b '

cc -O2 pi-utils/dtmerge/{dtmerge,dtoverlay}.c -lfdt -o qemu/build/dtmerge
cross=${CROSS_COMPILE:-arm-linux-gnueabihf-}
"${cross}gcc" -march=armv7-a -mfloat-abi=soft -DGIC=1 -DBCM2710=1 -DBCM2711=1 -c armstub7.S -o armstub.o
"${cross}ld" --section-start=.init=0 armstub.o -o armstub.elf
"${cross}objcopy" -O binary armstub.elf qemu/build/armstub8-32-gic.bin
