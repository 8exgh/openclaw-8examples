#!/usr/bin/env bash
# E2E: a cron job's turn through the rendered gateway provider survives a
# model-gateway that stays silent past every implicit OpenClaw idle watchdog
# (60s for scheduled cron runs, 120s otherwise). The provider timeout is
# checked before either, so outlasting the 120s default proves the override.
#
# Runs the real OpenClaw image with a mock gateway (scripts/e2e/silent-gateway.mjs)
# that, like the gateway's Claude Code backend, sends nothing until the turn is
# done. Pass --control to drop the rendered timeoutSeconds and confirm the
# watchdog still kills the turn (proves the test can see the bug).
#
#   scripts/e2e/gateway-provider-timeout.sh [--control] [image]
set -euo pipefail

mode=fix
if [[ "${1:-}" == "--control" ]]; then mode=control; shift; fi
image="${1:-ghcr.io/openclaw/openclaw:2026.8.1-browser}"
delay_ms="${DELAY_MS:-130000}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
name="e2e-gwtimeout-$mode-$$"
net="$name-net"
trap 'docker rm -f "$name" "$name-mgw" >/dev/null 2>&1 || true; docker network rm "$net" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

flag=""
[[ $mode == control ]] && flag="--without-timeout"
# The mock answers as `model-gateway`, the rendered baseUrl's own hostname. A
# loopback baseUrl would be classed as a local model, which has no watchdog.
(cd "$repo" && npx tsx scripts/e2e/render-gateway-config.ts "$work" http://model-gateway:8790 $flag)
# Like the tenant compose file's ./browser-cache mount: OpenClaw needs it writable.
mkdir -p "$work/cache"

docker network create "$net" >/dev/null
docker run -d --name "$name-mgw" --network "$net" --network-alias model-gateway \
  -e DELAY_MS="$delay_ms" -v "$repo/scripts/e2e:/e2e:ro" --entrypoint node "$image" /e2e/silent-gateway.mjs >/dev/null
docker run -d --name "$name" --init --network "$net" -e MODEL_GATEWAY_KEY=mgw_e2e_key \
  -v "$work/state:/home/node/.openclaw" -v "$work/cache:/home/node/.cache" \
  --entrypoint node "$image" openclaw.mjs gateway >/dev/null

oc() { docker exec "$name" node openclaw.mjs "$@" --token e2e-token; }
for _ in $(seq 1 90); do
  oc cron status >/dev/null 2>&1 && break
  sleep 2
done
oc cron status >/dev/null || { docker logs "$name" 2>&1 | tail -20; exit 1; }

at="$(date -u -d '+1 hour' +%Y-%m-%dT%H:%M:%SZ)"
job="$(oc cron add --name e2e-slow-turn --at "$at" --message 'Reply with one word.' --no-deliver --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.id??j.job?.id)})')"
echo "mode=$mode job=$job delayMs=$delay_ms"
oc cron run "$job" >/dev/null
# `cron run` only enqueues; wait for the run history to record a finished run.
for _ in $(seq 1 120); do
  oc cron runs --id "$job" --json >"$work/runs.json" 2>/dev/null || true
  status="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(r.entries??r.runs??r)[0];console.log(e?.status??"")' "$work/runs.json" 2>/dev/null || true)"
  [[ -n "$status" && "$status" != running && "$status" != queued ]] && break
  sleep 5
done

mock="$(docker logs "$name-mgw" 2>&1)"
echo "--- mock gateway"
echo "$mock"
echo "--- cron run: status=${status:-none}"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const e=(r.entries??r.runs??r)[0]??{};console.log(JSON.stringify({status:e.status,error:e.error,summary:e.summary,durationMs:e.durationMs}))' "$work/runs.json" 2>/dev/null || cat "$work/runs.json"

cancelled=$(grep -c '"client-cancelled"' <<<"$mock" || true)
replied=$(grep -c '"replied"' <<<"$mock" || true)
if [[ $mode == fix ]]; then
  [[ $cancelled -eq 0 && $replied -ge 1 && $status == ok ]] || { echo "FAIL: cancelled=$cancelled replied=$replied status=$status"; exit 1; }
  echo "PASS: ${delay_ms}ms silent turn completed with no client cancellation"
else
  [[ $cancelled -ge 1 && $status != ok ]] || { echo "FAIL: control expected the implicit watchdog to cancel the turn (cancelled=$cancelled status=$status)"; exit 1; }
  echo "PASS (control): watchdog cancelled the silent turn without the rendered timeout"
fi
