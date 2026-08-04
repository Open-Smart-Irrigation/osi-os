ARG BUILDER_PLATFORM=linux/amd64
FROM --platform=${BUILDER_PLATFORM} docker.io/debian@sha256:4cc40147060d766a649b100b175ac0a346a5b5c8fbcc5677c2f471854ee4e55c

ARG DEBIAN_SNAPSHOT=20260715T000000Z
ARG NODE_VERSION=22.14.0
ARG NODE_ARCH=linux-x64
ARG NODE_TARBALL_SHA256=69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec
ARG NPM_VERSION=11.10.1
ARG NPM_TARBALL_SHA256=2190945151842685142f5085b3c5dd356b1021ab390d7d02c2bb2c580f0c4840
ARG RUST_SOURCE_VERSION=1.85.0
ARG RUST_SOURCE_SHA256=2f4f3142ffb7c8402139cfa0796e24baaac8b9fd3f96b2deec3b94b4045c6a8a
ARG MUSL_VERSION=1.2.5-3.1~deb13u1
ARG MUSL_ARM64_SHA256=46cf1fcaa2d49d1573ef0ceabdb36e04a359a9a37d8e4304024f9018682e3f35
ARG MUSL_DEV_ARM64_SHA256=384ea029e3694baac696d3993d93246f9a4b3741c493697e1ceb7256d8820748
ARG MUSL_ARMHF_SHA256=e3a3adee81ad494a4c36521377ed078a453bf4a4400e747fe267a569fd8aa420
ARG MUSL_DEV_ARMHF_SHA256=db485234c01cb9887da0907f3e47d36d101a3299528afd3bbeb46edd551c8264
ARG RUST_CHANNEL=stable
ARG RUST_VERSION=1.85.0
ARG LLVM_MAJOR=19

ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workdir

# This is the complete OpenWrt tool list from Dockerfile-devel, with the
# Debian-stable ncurses package name and explicit GCC/LLVM support added.
# The snapshot source is immutable; package versions are recorded by the
# validation evidence rather than resolved from a moving Debian mirror.
RUN export DEBIAN_FRONTEND=noninteractive GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01' \
  && dpkg --add-architecture arm64 \
  && dpkg --add-architecture armhf \
  && rm -f /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources \
  && printf '%s\n' \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ stable main" \
    "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ stable-security main" \
    > /etc/apt/sources.list \
  && apt-get update \
  && apt-get install --no-install-recommends --no-install-suggests --yes \
    build-essential ca-certificates clang flex bison g++ gawk gcc-multilib g++-multilib \
    gettext git libncurses-dev libssl-dev python3 python3-setuptools rsync unzip zlib1g-dev nodejs npm \
    file wget curl quilt nano diffutils pkg-config gcc-14 g++-14 llvm-dev libpolly-19-dev \
    libzstd-dev rustc cargo rust-src rust-llvm xz-utils sqlite3 \
  && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-14 140 \
  && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-14 140 \
  && ln -s /usr/lib/x86_64-linux-gnu/libz3.so /usr/lib/llvm-19/lib/liblibz3.so.so \
  && mkdir -p /tmp/target-musl-packages /opt/target-sysroots/aarch64 /opt/target-sysroots/armv7 \
  && cd /tmp/target-musl-packages \
  && apt-get download "musl:arm64=${MUSL_VERSION}" "musl-dev:arm64=${MUSL_VERSION}" "musl:armhf=${MUSL_VERSION}" "musl-dev:armhf=${MUSL_VERSION}" \
  && printf '%s  %s\n' "${MUSL_ARM64_SHA256}" "musl_${MUSL_VERSION}_arm64.deb" "${MUSL_DEV_ARM64_SHA256}" "musl-dev_${MUSL_VERSION}_arm64.deb" "${MUSL_ARMHF_SHA256}" "musl_${MUSL_VERSION}_armhf.deb" "${MUSL_DEV_ARMHF_SHA256}" "musl-dev_${MUSL_VERSION}_armhf.deb" | sha256sum --check --status \
  && dpkg-deb --extract "musl_${MUSL_VERSION}_arm64.deb" /opt/target-sysroots/aarch64 \
  && dpkg-deb --extract "musl-dev_${MUSL_VERSION}_arm64.deb" /opt/target-sysroots/aarch64 \
  && dpkg-deb --extract "musl_${MUSL_VERSION}_armhf.deb" /opt/target-sysroots/armv7 \
  && dpkg-deb --extract "musl-dev_${MUSL_VERSION}_armhf.deb" /opt/target-sysroots/armv7 \
  && printf '%s\n' "musl:arm64=${MUSL_VERSION}" "musl-dev:arm64=${MUSL_VERSION}" "musl:armhf=${MUSL_VERSION}" "musl-dev:armhf=${MUSL_VERSION}" > /opt/target-sysroots/package-versions \
  && test -f /opt/target-sysroots/aarch64/usr/include/aarch64-linux-musl/stdio.h \
  && test -f /opt/target-sysroots/armv7/usr/include/arm-linux-musleabihf/stdio.h \
  && test -f /opt/target-sysroots/aarch64/usr/lib/aarch64-linux-musl/crt1.o \
  && test -f /opt/target-sysroots/armv7/usr/lib/arm-linux-musleabihf/crt1.o \
  && printf '%s\n' '#!/bin/sh' 'exec clang --target=aarch64-unknown-linux-musl --sysroot=/opt/target-sysroots/aarch64 -nostdinc -isystem /usr/lib/llvm-19/lib/clang/19/include -isystem /opt/target-sysroots/aarch64/usr/include/aarch64-linux-musl -L/opt/target-sysroots/aarch64/usr/lib/aarch64-linux-musl -fuse-ld=lld "$@"' > /usr/local/bin/aarch64-linux-musl-gcc \
  && cp /usr/local/bin/aarch64-linux-musl-gcc /usr/local/bin/aarch64-linux-musl-g++ \
  && printf '%s\n' '#!/bin/sh' 'exec clang --target=armv7-unknown-linux-musleabihf --sysroot=/opt/target-sysroots/armv7 -nostdinc -isystem /usr/lib/llvm-19/lib/clang/19/include -isystem /opt/target-sysroots/armv7/usr/include/arm-linux-musleabihf -L/opt/target-sysroots/armv7/usr/lib/arm-linux-musleabihf -fuse-ld=lld "$@"' > /usr/local/bin/arm-linux-musleabihf-gcc \
  && cp /usr/local/bin/arm-linux-musleabihf-gcc /usr/local/bin/arm-linux-musleabihf-g++ \
  && chmod 0755 /usr/local/bin/aarch64-linux-musl-gcc /usr/local/bin/aarch64-linux-musl-g++ /usr/local/bin/arm-linux-musleabihf-gcc /usr/local/bin/arm-linux-musleabihf-g++ \
  && printf '#include <stdio.h>\nint main(void) { return 0; }\n' > /tmp/target-sysroot.c \
  && /usr/local/bin/aarch64-linux-musl-gcc -c /tmp/target-sysroot.c -o /tmp/aarch64-target-sysroot.o \
  && /usr/local/bin/arm-linux-musleabihf-gcc -c /tmp/target-sysroot.c -o /tmp/armv7-target-sysroot.o \
  && file -b /tmp/aarch64-target-sysroot.o | grep -i 'aarch64' \
  && file -b /tmp/armv7-target-sysroot.o | grep -i 'ARM' \
  && rm -rf /tmp/target-musl-packages /tmp/target-sysroot.c /tmp/aarch64-target-sysroot.o /tmp/armv7-target-sysroot.o

RUN export CARGO_HOME=/opt/cargo CARGO_BUILD_JOBS=2 \
  && mkdir -p /tmp/rust-source \
  && curl --fail --location --retry 3 --output /tmp/rust-source/rust.tar.gz "https://static.rust-lang.org/dist/rustc-${RUST_SOURCE_VERSION}-src.tar.gz" \
  && printf '%s  %s\n' "${RUST_SOURCE_SHA256}" /tmp/rust-source/rust.tar.gz | sha256sum --check --status \
  && tar --extract --gzip --file /tmp/rust-source/rust.tar.gz --directory /tmp/rust-source \
  && printf '%s\n' \
    '[build]' \
    'jobs = 2' \
    'target = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-musl", "armv7-unknown-linux-musleabihf"]' \
    'host = ["x86_64-unknown-linux-gnu"]' \
    'cargo = "/usr/bin/cargo"' \
    'rustc = "/usr/bin/rustc"' \
    '[llvm]' \
    'download-ci-llvm = false' \
    '[target.x86_64-unknown-linux-gnu]' \
    'llvm-config = "/usr/bin/llvm-config"' \
    '[target.aarch64-unknown-linux-musl]' \
    'cc = "/usr/local/bin/aarch64-linux-musl-gcc"' \
    'cxx = "/usr/local/bin/aarch64-linux-musl-gcc"' \
    'linker = "/usr/local/bin/aarch64-linux-musl-gcc"' \
    'ar = "/usr/bin/llvm-ar"' \
    'musl-root = "/opt/target-sysroots/aarch64"' \
    'musl-libdir = "/opt/target-sysroots/aarch64/usr/lib/aarch64-linux-musl"' \
    '[target.armv7-unknown-linux-musleabihf]' \
    'cc = "/usr/local/bin/arm-linux-musleabihf-gcc"' \
    'cxx = "/usr/local/bin/arm-linux-musleabihf-gcc"' \
    'linker = "/usr/local/bin/arm-linux-musleabihf-gcc"' \
    'ar = "/usr/bin/llvm-ar"' \
    'musl-root = "/opt/target-sysroots/armv7"' \
    'musl-libdir = "/opt/target-sysroots/armv7/usr/lib/arm-linux-musleabihf"' \
    > /tmp/rust-source/rustc-${RUST_SOURCE_VERSION}-src/config.toml \
  && cd /tmp/rust-source/rustc-${RUST_SOURCE_VERSION}-src \
  && python3 x.py build --stage 1 library/std \
  && mkdir -p /opt/rust-system/toolchains/${RUST_VERSION}-x86_64-unknown-linux-gnu \
  && cp -a build/x86_64-unknown-linux-gnu/stage1/. /opt/rust-system/toolchains/${RUST_VERSION}-x86_64-unknown-linux-gnu/ \
  && rm -f /usr/bin/rustc \
  && ln -s /opt/rust-system/toolchains/${RUST_VERSION}-x86_64-unknown-linux-gnu/bin/rustc /usr/bin/rustc \
  && rm -rf /tmp/rust-source \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# Debian stable currently ships Node 20, so use the immutable upstream Node
# 22.14.0 archive and verify its published SHA-256 before installation.
RUN curl --fail --silent --show-error --location --retry 3 \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz" \
      --output /tmp/node.tar.xz \
  && printf '%s  %s\n' \
      "${NODE_TARBALL_SHA256}" \
      /tmp/node.tar.xz | sha256sum --check --status \
  && tar --extract --file /tmp/node.tar.xz --strip-components=1 --directory /usr/local \
  && rm -f /tmp/node.tar.xz \
  && node --version | grep -- "^v${NODE_VERSION%%.*}\." \
  && npm --version

# Node bundles Debian's npm 10, which cannot consume the current lockfile.
# Replace it with the exact npm release required by the OSI workspace.
RUN curl --fail --silent --show-error --location --retry 3 \
      "https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz" \
      --output /tmp/npm.tgz \
  && printf '%s  %s\n' \
      "${NPM_TARBALL_SHA256}" \
      /tmp/npm.tgz | sha256sum --check --status \
  && rm -rf /usr/local/lib/node_modules/npm \
  && mkdir -p /usr/local/lib/node_modules/npm \
  && tar --extract --gzip --file /tmp/npm.tgz --strip-components=1 --directory /usr/local/lib/node_modules/npm \
  && rm -f /tmp/npm.tgz \
  && npm --version | grep -- "^${NPM_VERSION}$"

# The runner invokes only this fixed, image-owned operation entry. It is not
# reachable through the worktree bind mount and is executable by buildbot.
COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-tool.js /opt/osi-image-builder/operations/osi-image-builder-tool.js
COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-module-probe.js /opt/osi-image-builder/operations/osi-image-builder-module-probe.js
COPY --chown=root:root --chmod=0555 builder/operations/osi-image-builder-exec-guard.js /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js
COPY --chown=root:root --chmod=0555 builder/operations/osi-dependency-egress-proxy.cjs /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs
COPY --chown=root:root --chmod=0555 builder/operations/osi-proxy-credential-environment.cjs /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs
COPY --chown=root:root --chmod=0444 builder/operations/osi-wgetrc /opt/osi-image-builder/operations/osi-wgetrc
RUN test -f /opt/osi-image-builder/operations/osi-image-builder-tool.js \
  && test -f /opt/osi-image-builder/operations/osi-image-builder-module-probe.js \
  && test -f /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js \
  && test -f /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs \
  && test -f /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs \
  && test -f /opt/osi-image-builder/operations/osi-wgetrc \
  && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-tool.js)" = '0:0' \
  && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-module-probe.js)" = '0:0' \
  && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js)" = '0:0' \
  && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs)" = '0:0' \
  && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs)" = '0:0' \
  && test "$(stat -c '%u:%g' /opt/osi-image-builder/operations/osi-wgetrc)" = '0:0' \
  && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-tool.js)" = '555' \
  && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-module-probe.js)" = '555' \
  && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-image-builder-exec-guard.js)" = '555' \
  && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-dependency-egress-proxy.cjs)" = '555' \
  && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-proxy-credential-environment.cjs)" = '555' \
  && test "$(stat -c '%a' /opt/osi-image-builder/operations/osi-wgetrc)" = '444'

# OpenWrt invokes the same non-interactive host toolchain for all operations.
RUN useradd --create-home --shell /bin/bash --user-group buildbot \
  && chown --recursive buildbot:buildbot /workdir

USER buildbot
