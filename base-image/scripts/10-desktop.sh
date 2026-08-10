#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

# The cloud image ships the trimmed -virtual kernel: no DRM modules, no
# /dev/dri, so Xorg/GDM can never light up a display. Install the full
# generic kernel (brings linux-modules-extra and stays synced on upgrades).
apt-get -y install linux-generic
KVER=$(ls /lib/modules | sort -V | tail -1)
apt-get -y install "linux-modules-extra-${KVER}" || true

# Minimal GNOME desktop without recommends — keeps snapd/firefox-snap out.
apt-get -y install --no-install-recommends \
  ubuntu-desktop-minimal gdm3 gnome-terminal nautilus \
  fonts-ubuntu yaru-theme-gtk yaru-theme-icon

# The cloud image ships snapd preinstalled; this image is deliberately snap-free.
apt-get -y purge snapd || true
apt-get -y autoremove --purge

systemctl set-default graphical.target

# Autologin straight to the desktop for the agent user.
# Xorg session: reliable capture for Sunshine and automation tools in a VM.
cat > /etc/gdm3/custom.conf <<EOF
[daemon]
WaylandEnable=false
AutomaticLoginEnable=true
AutomaticLogin=${OPENCLAW_USER}
EOF

# No first-run wizard, no screen lock/blank/sleep — an agent desktop must stay awake.
apt-get -y purge gnome-initial-setup || true

mkdir -p /etc/dconf/profile /etc/dconf/db/local.d
cat > /etc/dconf/profile/user <<EOF
user-db:user
system-db:local
EOF
cat > /etc/dconf/db/local.d/00-openclaw <<EOF
[org/gnome/desktop/session]
idle-delay=uint32 0

[org/gnome/desktop/screensaver]
lock-enabled=false

[org/gnome/settings-daemon/plugins/power]
sleep-inactive-ac-type='nothing'
idle-dim=false
EOF
dconf update

# Caffeine, belt-and-suspenders: X-server-level DPMS/blanking off in every
# session, and the whole sleep stack masked at the systemd level.
cat > /etc/xdg/autostart/no-blank.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Disable screen blanking
Exec=sh -c "xset s off s noblank -dpms"
X-GNOME-Autostart-enabled=true
EOF
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
