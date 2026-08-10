# openclaw-base-image

Packer build for the **golden base VM image** behind managed OpenClaw: Ubuntu 24.04
(noble) with a minimal GNOME desktop, OpenClaw, Claude Code CLI, and Chrome (deb,
snap-free). The image is built entirely from this repo — the repo is the version
control; the qcow2 is just a build artifact.

## Build

```bash
make build                      # -> output/openclaw-base-0.1.0/openclaw-base-0.1.0.qcow2
make build VERSION=0.2.0 SSH_PASSWORD=something-better
make creds                      # print the login credentials for a built image
```

Needs qemu/KVM on the build host; `make` downloads Packer into `.tools/` if absent.
Build path: Ubuntu cloud image + cloud-init seed → provision scripts over SSH → qcow2.

## Logging in (manual access)

Everything uses one account, printed to `output/<image>/credentials.txt` after a build:

- **user**: `openclaw` — desktop autologin, SSH (password auth enabled), and sudo
- **password**: `openclaw` unless overridden with `SSH_PASSWORD=` at build time

```bash
ssh openclaw@<vm-ip>      # password: openclaw
```

## Connecting your Claude subscription

Three ways, most convenient first:

1. **On the VM desktop**: double-click **"Connect Claude"** (or run `claude-login`
   in a terminal). The OAuth flow opens in Chrome; sign into claude.ai; done.
2. **From your workstation**: run `claude setup-token` locally, then
   `ssh openclaw@<vm> claude-login --token sk-ant-oat-...`.
3. **Seeded (for tenant clones)**: drop the token at `/etc/openclaw/claude-token.seed`
   (e.g. via cloud-init `write_files`); the `openclaw-token-import` service installs
   it before the gateway starts and shreds the file. Clones boot already logged in.

OpenClaw also reuses a local Claude CLI login if you just run `claude` and sign in.

## Remote desktop (Moonlight)

Sunshine is preinstalled, autostarts with the desktop session (Xorg), and its web
UI listens on the LAN: **https://\<vm-ip\>:47990**, login `openclaw` / the image
password. Open it once per Moonlight client to enter the pairing PIN, then
connect with any Moonlight app to watch or drive the assistant's desktop.

## What's inside

- Ubuntu 24.04 cloud image + `ubuntu-desktop-minimal` (no recommends, **snapd purged**),
  GDM autologin on **Xorg**, screen blank/lock/sleep disabled (agent desktops must
  stay awake), networkd renderer pinned (clone-safe generic DHCP netplan)
- Google Chrome from Google's apt repo, set as default browser
- Node 22 (NodeSource), `openclaw` + `@anthropic-ai/claude-code` global installs
- Dev toolchains: build-essential, cmake, Python 3 (pip/venv/pipx), Go, .NET SDK
  (newest in archive), sqlite3, shellcheck, git-lfs, gh, docker + compose,
  corepack (yarn/pnpm)
- Convenience: htop/btop, tmux, ripgrep, fd, fzf, bat, ncdu, tree, vim, 7zip,
  dig/netcat/mtr/whois, clipboard tools; document/media: poppler-utils, pandoc,
  imagemagick, ffmpeg
- Sunshine (Moonlight host) with pre-set credentials, LAN web UI, session autostart
- `openclaw.service` (systemd): enabled, starts only once
  `~openclaw/.openclaw/openclaw.json` exists — i.e. after `openclaw onboard` or
  tenant provisioning writes a config
- Fresh identity per clone: machine-id cleared, SSH host keys regenerate on first
  boot, cloud-init cleaned (ready to accept a per-tenant NoCloud seed)

## Test-boot a built image

```bash
qemu-img create -f qcow2 -b output/openclaw-base-0.1.0/openclaw-base-0.1.0.qcow2 \
  -F qcow2 /tmp/test-openclaw.qcow2
qemu-system-x86_64 -enable-kvm -cpu host -m 4096 -smp 4 \
  -drive file=/tmp/test-openclaw.qcow2,if=virtio \
  -netdev user,id=n0,hostfwd=tcp::2222-:22 -device virtio-net,netdev=n0 \
  -vga virtio -display gtk
# desktop appears with autologin; or: ssh -p 2222 openclaw@localhost
```

Always boot tenants from a **backing-file overlay** (as above), never the base
qcow2 directly — the base stays pristine, one file per tenant.

## Versioning

- `VERSION` is the image version; tag the repo `v<VERSION>` at the commit that
  built it, so image ↔ source is always traceable.
- `output/<image>/manifest.json` + `SHA256SUMS` identify the artifact.
- Rebuild rather than mutate: any tweak made inside a running VM is drift — put it
  in a script here and bump the version.

## Relationship to the control plane

`managed-openclaw` (the fleet control plane) today renders per-tenant Docker
containers; this image is the VM-driver counterpart. The intended split: this base
holds everything common; per-tenant identity (openclaw.json, workspace, Claude
token seed) arrives at first boot via a NoCloud cloud-init seed, and durable state
lives on a second data disk so base-image upgrades never touch it.
