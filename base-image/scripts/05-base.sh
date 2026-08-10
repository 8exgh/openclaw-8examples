#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# Let the first-boot cloud-init finish so apt isn't locked underneath us.
cloud-init status --wait || true

apt-get update
apt-get -y upgrade
apt-get -y install \
  qemu-guest-agent spice-vdagent \
  curl wget git jq unzip ca-certificates gnupg xdg-utils dbus-x11

systemctl enable qemu-guest-agent
