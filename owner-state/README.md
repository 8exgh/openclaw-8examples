# The customer owns the Claw

Provisioning supplies defaults and hosting integrations. It does not own the
customer's OpenClaw configuration, plugins, skills or instructions.

`index.mjs` reconciles the previous proposed configuration, the current owner
configuration, and new defaults. Owner edits win conflicts, including `false`,
empty arrays, additions and deletions. Unchanged defaults can advance. The first
adoption keeps an existing configuration byte for byte. Invalid JSON aborts the
operation without replacing the file. Configuration backups are available to the
owner under `~/.openclaw/owner-backups/` before a provisioner changes it.

Plugin path/trust lists retain owner additions and removals while updating
unchanged managed paths. Other arrays are treated as complete owner values.
Managed plugin installers preserve disabled flags, hook permissions, owner
configuration and deleted entries. Provisioning does not grant consent or update
unrelated owner-installed plugins.

The AGENTS body and the named browser/phone/terminal blocks are tracked separately.
Owner modifications and deletions win; surrounding personal text is preserved.
HEARTBEAT, shipped skill text and capability documentation update only while
unchanged. Unknown files and installed skill directories are never cleared.
Baseline files live in the private tenant `.owner-state/` directory; do not
delete that directory to apply an update. Baselines and backups may contain
credentials and are not logged or committed to Git.

An active owner terminal defers normal provisioning. Files are written atomically
and checked for intervening edits before replacement. This is not a filesystem
lock against arbitrary concurrent writes from other programs.

## Container administration

`.owner-admin` enables the root option for a tenant. The normal shell stays the
default. Docker receives only the fixed tenant container name and `node` or
`root`; no host shell or Docker socket is exposed. A bounded capability set
supports package installs, ownership changes and process administration while
the container retains its own namespaces and hosting resource limits.

Before a normal managed apply recreates an admin-enabled container,
`checkpointOwnerImage` saves its writable system filesystem in a **local-only**
image and records it in `.owner-image.json`. Mounted configuration/workspace data
remain in their existing persistent directories. Runtime-injected environment
credentials are replaced with base-image defaults or empty values in the image;
current credentials continue to come from the tenant environment at startup.
The checkpoint briefly pauses the container. It is never pushed to a registry.

Owner system images take precedence over fleet image changes. This avoids
silently discarding packages and system configuration; updating the upstream
base image of such a Claw requires an explicit migration of the owner's system
changes. `openclaw update` or package updates performed inside the owner's
container are retained by the next checkpoint. Direct manual `docker rm` or an
out-of-band recreation that bypasses this provisioner does not make a checkpoint.

## Canary rollout

Push root commits with `[skip ci]` so the ordinary fleet rollout does not run.
Dispatch `deploy-openclaw-remote-terminal.yml` with a full reviewed source SHA,
`owner_control=true`, and normal installation enabled. This updates the control
plane checkout for future operations, adopts only openclaw1's configuration,
checkpoints its existing system filesystem, and recreates only that canary with
admin capabilities. Other tenants receive no root option or restart.

After the website deployment succeeds, use `verify_only=true`,
`verify_public=true`, `verify_agent=true` to verify the actual chat handoff and
root terminal through public HTTPS. Do not grant the verifier chat delivery.

To withdraw administration, remove the tenant's `.owner-admin` marker and use
the normal apply path to recreate without added capabilities. Retain the owner
image, configuration, workspace, backups and ownership baselines. Stopping the
terminal broker closes active terminals but does not delete owner data.

## Explicit stable application upgrade

`upgrade-canary.mjs` and the `update-openclaw1-stable.yml` devops workflow upgrade
only openclaw1, on the owner's request. Supply a full reviewed source SHA and the
exact npm `latest` version, then set `apply=true`. It checks the qualified official
image manifest and matching Node runtime, stops the canary for a consistent full-state
backup, and replaces `/app` in a checkpoint of the owner's existing system.
System packages and all persistent mounts are retained. A rehearsal runs on
copied state without network access before activation. Failure restores the old
application and state; failed-state files and private diagnostics are retained.
The final workflow verifies the real private-chat terminal handoff through public
HTTPS without delivering a chat message. This is an application upgrade, not a
replacement of the owner's OS filesystem; a different Node/base runtime requires
a separate migration.

The 2026.9.4 application requires a canonical agent SQLite index that can be
missing in 2026.8.1 state. `repair-agent-schema-2026.9.4.mjs` invokes that pinned
release's own schema migration routine, checks canonical schema and integrity,
and verifies that conversation counts, configuration, and workspace instructions
are unchanged. The full Doctor repair also disables unavailable skills and
migrates workspace files; this upgrade deliberately confines the repair to agent
databases. The repair runs on the isolated copy first, then on backed-up live
state while the old Gateway is stopped. A future release must qualify its own
manifest and migration entry point instead of reusing this pinned adapter.

## Telegram processing recovery

On 2026.9.4, openclaw1 encountered `attempt disposed before transcript write`:
the Telegram listener and API probe remained healthy, while the same spooled
message repeatedly failed before a new transcript write. Restarting the existing
container cleared the stale in-memory attempt and the normal Telegram pipeline
sent a reply. No session reset, configuration rewrite, or image recreation was
needed. This is an operational recovery, not an upstream lifecycle code fix.

`recover-openclaw1-telegram.yml` runs a reviewed `source_ref`. Its default is
read-only; `restart=true` requires the diagnosed error in recent logs and no
active owner terminal. It checks owner-file fingerprints, container/image IDs,
other Claws, and a real outbound reply from the normal queue after recovery.
`verify-upgrade.mjs` now checks enabled accounts' live listeners and probes, plus
recent disposed-attempt errors, rather than accepting configuration-only health.
