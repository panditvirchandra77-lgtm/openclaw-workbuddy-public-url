#!/usr/bin/env bash
# OpenClaw gateway watchdog
#
# Keeps `openclaw gateway run` alive. This sandbox has no systemd (the systemctl
# binary exists but there's no running init), so nothing restarts the gateway
# after it dies — which happens whenever the sandbox hibernates. This loop polls
# the gateway's HTTP port and restarts it when it stops answering.
#
# Usage:
#   ./openclaw-watchdog.sh                 # run in foreground (Ctrl-C to stop)
#   ./openclaw-watchdog.sh --background    # detach with setsid
#
# Env:
#   OPENCLAW_GW_PORT      gateway port        (default 18789)
#   OPENCLAW_WD_INTERVAL  poll interval, sec  (default 20)
#   OPENCLAW_WD_LOG       log file            (default /tmp/openclaw-watchdog.log)

set -uo pipefail

PORT="${OPENCLAW_GW_PORT:-18789}"
INTERVAL="${OPENCLAW_WD_INTERVAL:-20}"
LOG="${OPENCLAW_WD_LOG:-/tmp/openclaw-watchdog.log}"
PIDFILE="/tmp/openclaw-gateway.pid"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$LOG"; }

port_up() {
  curl -sf --max-time 5 -o /dev/null "http://127.0.0.1:${PORT}/"
}

start_gateway() {
  setsid nohup openclaw gateway run >>"$LOG" 2>&1 &
  local pid=$!
  echo "$pid" >"$PIDFILE"
  log "gateway started pid=$pid"
}

stop_gateway() {
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
    log "stopped stale gateway pid=$pid"
  fi
  rm -f "$PIDFILE"
}

cleanup() {
  log "watchdog stopping"
  stop_gateway
  exit 0
}
trap cleanup SIGTERM SIGINT

if [ "${1:-}" = "--background" ]; then
  setsid nohup "$0" >>"$LOG" 2>&1 &
  echo "watchdog detached, logging to $LOG"
  exit 0
fi

log "watchdog up port=$PORT interval=${INTERVAL}s"

while true; do
  if ! port_up; then
    log "gateway not answering on :$PORT — restarting"
    stop_gateway
    start_gateway
    for _ in $(seq 1 20); do
      sleep 2
      if port_up; then
        log "gateway back up on :$PORT"
        break
      fi
    done
    port_up || log "WARN gateway still down after 40s"
  fi
  sleep "$INTERVAL"
done
