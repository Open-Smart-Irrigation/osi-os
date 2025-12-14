FROM jenkins/jenkins:lts-jdk17

USER root

# Install Node.js (LTS) for React GUI builds
RUN curl -fsSL https://deb.nodesource.com/setup_lts.x | bash - \
    && apt-get install -y nodejs

# Install build dependencies for OpenWrt/ChirpStack Gateway OS
# Added: pkg-config, clang, cmake, zstd, xz-utils, libncurses-dev
RUN apt-get update && apt-get install -y \
    build-essential \
    gcc \
    g++ \
    binutils \
    patch \
    libacl1-dev \
    libattr1-dev \
    gettext \
    zlib1g-dev \
    gawk \
    bzip2 \
    flex \
    bison \
    make \
    autoconf \
    texinfo \
    unzip \
    zip \
    sharutils \
    subversion \
    ncurses-dev \
    libncurses-dev \
    git \
    ccache \
    rsync \
    curl \
    wget \
    python3 \
    python3-dev \
    python3-setuptools \
    libssl-dev \
    libelf-dev \
    file \
    quilt \
    xsltproc \
    libxml-parser-perl \
    pkg-config \
    clang \
    cmake \
    zstd \
    xz-utils \
    libclang-dev \
    protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

# Verify Node.js installation
RUN node --version && npm --version
