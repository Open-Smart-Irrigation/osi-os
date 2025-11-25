FROM jenkins/jenkins:lts

USER root

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
    && rm -rf /var/lib/apt/lists/*
