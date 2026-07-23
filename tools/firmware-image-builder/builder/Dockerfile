FROM docker.io/debian@sha256:4cc40147060d766a649b100b175ac0a346a5b5c8fbcc5677c2f471854ee4e55c

ENV DEBIAN_FRONTEND=noninteractive \
    GCC_COLORS='error=01;31:warning=01;35:note=01;36:caret=01;32:locus=01:quote=01' \
    RUST_LLVM_CONFIG=/usr/bin/llvm-config \
    RUST_CHANNEL=stable \
    RUST_VERSION=1.85.0 \
    LLVM_MAJOR=19 \
    CARGO_BUILD_JOBS=2

WORKDIR /workdir

# This is the complete OpenWrt tool list from Dockerfile-devel, with the
# Debian-stable ncurses package name and explicit GCC/LLVM support added.
RUN apt-get update \
  && apt-get install --no-install-recommends --no-install-suggests --yes \
    build-essential ca-certificates clang flex bison g++ gawk gcc-multilib g++-multilib \
    gettext git libncurses-dev libssl-dev python3 python3-setuptools rsync unzip zlib1g-dev nodejs npm \
    file wget curl quilt nano diffutils pkg-config gcc-14 g++-14 llvm-dev libpolly-19-dev \
    libzstd-dev rustc cargo xz-utils \
  && update-alternatives --install /usr/bin/gcc gcc /usr/bin/gcc-14 140 \
  && update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-14 140 \
  && rm -rf /var/lib/apt/lists/* /var/cache/apt/*

# Debian stable currently ships Node 20, so use the immutable upstream Node
# 22.14.0 archive and verify its published SHA-256 before installation.
RUN curl --fail --silent --show-error --location --retry 3 \
      https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz \
      --output /tmp/node.tar.xz \
  && printf '%s  %s\n' \
      69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec \
      /tmp/node.tar.xz | sha256sum --check --status \
  && tar --extract --file /tmp/node.tar.xz --strip-components=1 --directory /usr/local \
  && rm -f /tmp/node.tar.xz \
  && node --version | grep -- '^v22\.' \
  && npm --version

# OpenWrt invokes the same non-interactive host toolchain for all operations.
RUN useradd --create-home --shell /bin/bash --user-group buildbot \
  && chown --recursive buildbot:buildbot /workdir

USER buildbot
