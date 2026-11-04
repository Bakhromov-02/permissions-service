#!/usr/bin/env sh
# Runs the k6 load test inside the compose network against the running stack.
# Usage: loadtest/run.sh [RATE] [DURATION] — extra k6 env vars can be passed through, e.g.
#   WRITE_RATE=50 HOT_KEYS=10 loadtest/run.sh 1000 30s
set -eu

cd "$(dirname "$0")/.."
[ -f .env ] && . ./.env

NETWORK="$(docker compose ps -q gateway | xargs docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"

docker run --rm -i --network "$NETWORK" \
  -v "$PWD/loadtest:/scripts:ro" \
  -e ADMIN_TOKEN="$ADMIN_TOKEN" -e SERVICE_TOKEN="$SERVICE_TOKEN" \
  -e RATE="${1:-500}" -e DURATION="${2:-30s}" \
  -e KEYS="${KEYS:-200}" -e WRITE_RATE="${WRITE_RATE:-0}" -e HOT_KEYS="${HOT_KEYS:-200}" \
  grafana/k6:1.2.2 run --quiet /scripts/check.js
