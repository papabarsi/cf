#!/usr/bin/env sh
# Entrypoint: run the CLI directly (default) or the HTTP agent gateway (GATEWAY=1).
set -eu
CLI="${GATEWAY_CLI:-cf}"
if [ "${GATEWAY:-0}" = "1" ] || [ "${1:-}" = "gateway" ]; then
  [ "${1:-}" = "gateway" ] && shift
  # The CLI enforces read-only itself, not just the gateway's verb heuristic (zs honours
  # ZS_READ_ONLY; cf ignores it).
  [ "${GATEWAY_WRITE_ENABLED:-0}" = "1" ] || export ZS_READ_ONLY=1
  exec node /opt/agent-gateway/server.mjs "$@"
fi
exec "$CLI" "$@"
