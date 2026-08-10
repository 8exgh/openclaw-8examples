#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get -y autoremove --purge
apt-get clean
rm -rf /var/lib/apt/lists/*

# Networking must not be pinned to the build VM's MAC — clones get new MACs.
# Generic DHCP-on-any-ethernet netplan; cloud-init network rendering disabled.
rm -f /etc/netplan/50-cloud-init.yaml
# The desktop install ships /usr/lib/netplan/00-network-manager-all.yaml which
# flips the global renderer to NetworkManager — which isn't installed here.
# Pin networkd explicitly (and drop the vendor override).
rm -f /usr/lib/netplan/00-network-manager-all.yaml
cat > /etc/netplan/01-dhcp-all.yaml <<'EOF'
network:
  version: 2
  renderer: networkd
  ethernets:
    all-ethernet:
      match:
        name: "en*"
      dhcp4: true
EOF
chmod 600 /etc/netplan/01-dhcp-all.yaml
mkdir -p /etc/cloud/cloud.cfg.d
echo 'network: {config: disabled}' > /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg

# Each clone must get a fresh identity.
cloud-init clean --logs || true
truncate -s 0 /etc/machine-id
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id

# Fresh SSH host keys per clone: remove now, regenerate on first boot.
cat > /etc/systemd/system/regenerate-ssh-host-keys.service <<'EOF'
[Unit]
Description=Regenerate SSH host keys
Before=ssh.service
ConditionPathExists=!/etc/ssh/ssh_host_ed25519_key

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
EOF
systemctl enable regenerate-ssh-host-keys.service
rm -f /etc/ssh/ssh_host_*

# Guarantee: nothing in the agent user's home is root-owned, no matter what
# earlier provisioning steps did. Root's own tool state doesn't ship either.
rm -rf /root/.openclaw /root/.claude /root/.npm /root/.cache
chown -R "${OPENCLAW_USER}:${OPENCLAW_USER}" "/home/${OPENCLAW_USER}"

rm -f /root/.bash_history "/home/${OPENCLAW_USER}/.bash_history" || true
truncate -s 0 /var/log/wtmp /var/log/btmp /var/log/lastlog || true

sync
fstrim -av || true
