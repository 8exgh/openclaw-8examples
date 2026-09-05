# Fleet deployment and backups

The fleet checkout is `/home/openclaw/managed-openclaw`. The relay runs as
`openclaw-meta-glasses-relay-1` and listens only on `127.0.0.1:8795` on the host.
Its public origin is **https://glasses.fusenv.com**, through the existing
`cloudflared-hooks` tunnel. Public health and unauthenticated-access checks pass.
See [the checklist](../../todo-meta-glasses.md) for the remaining app setup.

After pulling a reviewed release, run on the fleet host:

```bash
cd /home/openclaw/managed-openclaw
bash openclaw-meta-glasses/deploy/deploy.sh
```

The script preserves generated keys, backs up an existing database, runs the
relay and backup tests, checks dependencies, rebuilds only the glasses relay,
waits for its health check, and installs the backup timer. It verifies Docker
access to `openclaw-openclaw1` without running an assistant task. Push credentials
and enabling the tenant's glasses capability remain separate checklist steps.

Both manual GitHub workflows are published in `8exgh/devops`, where the fleet
runner and Cloudflare secrets are configured:

- [Deploy OpenClaw glasses backend](https://github.com/8exgh/devops/actions/workflows/deploy-openclaw-glasses.yml)
  runs `deploy.sh` and verifies public HTTPS. It shares the fleet deployment lock.
- [Configure OpenClaw glasses Cloudflare route](https://github.com/8exgh/devops/actions/workflows/configure-openclaw-glasses-cloudflare.yml)
  configures the tunnel and DNS, then verifies access from a GitHub-hosted runner.

`github-deploy.yml` and `github-cloudflare.yml` are copies of those published
workflows for reference; they do not execute from this folder. To redeploy:

```bash
gh workflow run deploy-openclaw-glasses.yml --repo 8exgh/devops --ref main
```

The Cloudflare workflow preserves existing tunnel rules, refuses to overwrite
an unrelated DNS record, and checks public HTTPS and authentication after setup.
It follows [Cloudflare's tunnel configuration and DNS API](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel-api/).
The health probe uses `User-Agent: OpenClaw-Glasses-Deployment/1.0` because the
zone rejects Python's default user-agent with error 1010. Curl and the relay's
Node HTTP client also pass the public API checks.

## Scheduled backups

`openclaw-glasses-backup.timer` runs daily at 03:30 fleet-host time, with up to
15 minutes of jitter and catch-up after downtime. Archives are stored privately
on the fleet host in `/home/openclaw/openclaw-backups/meta-glasses` for 14 days.
The directory is mode 0700 and archives are mode 0600, owned by root.

Each archive includes `.env` (including the database encryption key),
`config.local.json`, a consistent SQLite backup of `data/glasses.sqlite`, other
data files, and files in `secrets/`. An APNs key placed there later is included
automatically. The script checks SQLite integrity and archive checksums before
pruning expired backups. It uses SQLite's online backup API, so the relay can
continue serving requests during a backup.

```bash
sudo systemctl start openclaw-glasses-backup.service
systemctl show openclaw-glasses-backup.service -p Result -p ExecMainStatus
systemctl list-timers openclaw-glasses-backup.timer --no-pager
sudo journalctl -u openclaw-glasses-backup.service -n 20 --no-pager
```

For recovery, stop the relay and backup timer, save the current files, then
restore the database and configuration from the **same archive**. Remove stale
`data/glasses.sqlite-wal` and `data/glasses.sqlite-shm` while the relay is stopped
before installing the restored database. Restore any `secrets/` files as well,
keep private permissions, and restart the relay and timer. Check `/health` and
the inbox before resubmitting work. Restored in-flight jobs become uncertain;
inspect their actual outcome before issuing a new request.

Run the backup tests locally or on the fleet host with:

```bash
cd openclaw-meta-glasses
python3 -m unittest discover -s test -p '*_test.py'
```
