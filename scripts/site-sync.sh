#!/usr/bin/env bash
# Pushes claw-committed website changes upstream, every 2 minutes from cron.
#
# Claw containers have git but no ssh client, so the deploy key lives
# host-side at tenants/<t>/site_deploy_key (never mounted into the
# container) and this script does the network half: fetch, fast-forward
# when the claw's tree is clean, and push whatever the claw committed.
# The clone itself sits inside the tenant's bind-mounted workspace, named
# by tenants/<t>/site_repo_path.
set -u

BASE="$HOME/managed-openclaw/tenants"
LOG="$HOME/managed-openclaw/site-sync.log"
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
  tail -c 65536 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

for KEY in "$BASE"/*/site_deploy_key; do
  [ -f "$KEY" ] || continue
  TDIR=$(dirname "$KEY")
  TENANT=$(basename "$TDIR")
  [ -f "$TDIR/site_repo_path" ] || continue
  DIR="$TDIR/workspace/$(cat "$TDIR/site_repo_path")"
  [ -d "$DIR/.git" ] || continue

  BR=$(git -C "$DIR" symbolic-ref --short HEAD 2>/dev/null) || continue
  export GIT_SSH_COMMAND="ssh -i $KEY -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes"
  git -C "$DIR" fetch -q origin "$BR" 2>/dev/null || { echo "$(date -Is) $TENANT: fetch failed"; continue; }

  AHEAD=$(git -C "$DIR" rev-list --count "origin/$BR..$BR" 2>/dev/null || echo 0)
  BEHIND=$(git -C "$DIR" rev-list --count "$BR..origin/$BR" 2>/dev/null || echo 0)

  # Bring in upstream (template fixes, provisioner re-brands) only when the
  # claw has nothing in flight: clean tree, nothing unpushed.
  if [ "$BEHIND" -gt 0 ] && [ "$AHEAD" -eq 0 ] && [ -z "$(git -C "$DIR" status --porcelain)" ]; then
    git -C "$DIR" merge -q --ff-only "origin/$BR" 2>/dev/null || true
  fi

  if [ "$AHEAD" -gt 0 ]; then
    STATUS="$TDIR/workspace/website-deploy-status.md"
    SHA=$(git -C "$DIR" rev-parse HEAD)
    BLOCKED=""
    while IFS= read -r path; do
      case "$path" in
        .github|.github/*|.gitmodules) BLOCKED="$path"; break ;;
      esac
    done < <(git -C "$DIR" diff --name-only "origin/$BR..$BR")
    if [ -n "$BLOCKED" ]; then
      printf '# Website deployment status\n\nStatus: blocked\nCommit: %s\nReason: protected deployment path changed: %s\n\nRevert that path and commit again. Website content changes remain allowed.\n' "$SHA" "$BLOCKED" > "$STATUS"
      echo "$(date -Is) $TENANT: blocked protected path $BLOCKED"
      continue
    fi

    printf '# Website deployment status\n\nStatus: publishing\nCommit: %s\nQueued: %s\n\nThe trusted publisher accepted this commit. GitHub Actions will build, deploy, and verify the exact version.\n' "$SHA" "$(date -u +%FT%TZ)" > "$STATUS"
    if git -C "$DIR" push -q origin "$BR" 2>/dev/null; then
      echo "$(date -Is) $TENANT: pushed $AHEAD commit(s)"
    else
      printf '# Website deployment status\n\nStatus: push failed; the publisher will retry\nCommit: %s\nLast attempt: %s\n' "$SHA" "$(date -u +%FT%TZ)" > "$STATUS"
      echo "$(date -Is) $TENANT: PUSH FAILED"
    fi
  fi
done
