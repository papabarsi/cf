#!/usr/bin/env sh
# Entrypoint: run the CLI directly (default) or the HTTP agent gateway (GATEWAY=1).
set -eu
CLI="${GATEWAY_CLI:-cf}"
if [ "${GATEWAY:-0}" = "1" ] || [ "${1:-}" = "gateway" ]; then
  [ "${1:-}" = "gateway" ] && shift
  exec node /opt/agent-gateway/server.mjs "$@"
fi
exec "$CLI" "$@"
