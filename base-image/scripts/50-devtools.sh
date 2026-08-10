#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- Programming toolchains -------------------------------------------------
apt-get -y install \
  build-essential cmake pkg-config \
  clang clang-format gdb valgrind ninja-build ccache \
  python3-pip python3-venv python3-dev pipx \
  golang-go \
  openjdk-21-jdk maven \
  sqlite3 \
  shellcheck \
  git-lfs gh

# Rust via rustup for the agent user (apt's rustc is too old to be useful)
sudo -u "${OPENCLAW_USER}" -H bash -c \
  'curl -fsSL https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default'
sudo -u "${OPENCLAW_USER}" -H bash -c '~/.cargo/bin/rustc --version && ~/.cargo/bin/cargo --version'
java -version

# Yarn/pnpm shims via Node's corepack (Node itself installed in 30-openclaw.sh)
corepack enable || true

# .NET SDK — newest version available in the Ubuntu archive for noble
apt-get -y install dotnet-sdk-10.0 \
  || apt-get -y install dotnet-sdk-9.0 \
  || apt-get -y install dotnet-sdk-8.0
dotnet --list-sdks

# --- Docker (agents build/run things; also usable by OpenClaw sandboxing) ---
apt-get -y install docker.io docker-compose-v2
systemctl enable docker
usermod -aG docker "${OPENCLAW_USER}"

# --- Convenience / inspection ----------------------------------------------
apt-get -y install \
  htop btop tmux tree ncdu vim nano less \
  ripgrep fd-find fzf bat \
  rsync p7zip-full zip \
  netcat-openbsd dnsutils net-tools traceroute mtr-tiny whois \
  xclip wl-clipboard

# Ubuntu renames these; give them their upstream names too.
ln -sf /usr/bin/fdfind /usr/local/bin/fd
ln -sf /usr/bin/batcat /usr/local/bin/bat

# --- Document & media handling (paperwork is the whole point) ---------------
apt-get -y install \
  poppler-utils pandoc \
  imagemagick ffmpeg
