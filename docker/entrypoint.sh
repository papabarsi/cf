#!/usr/bin/env sh
# Entrypoint: run the CLI directly (default) or the HTTP agent gateway (GATEWAY=1).
set -eu
CLI="${GATEWAY_CLI:-cf}"
if [ "${GATEWAY:-0}" = "1" ] || [ "${1:-}" = "gateway" ]; then
  [ "${1:-}" = "gateway" ] && shift
  # The CLI enforces read-only itself, not just the gateway's verb heuristic, and may not
  # read container files named in argv (zs honours ZS_READ_ONLY / ZS_NO_FILE_REFS; cf
  # ignores them). server.mjs sets both for its children too.
  [ "${GATEWAY_WRITE_ENABLED:-0}" = "1" ] || export ZS_READ_ONLY=1
  [ "${GATEWAY_ALLOW_FILE_REFS:-0}" = "1" ] || export ZS_NO_FILE_REFS=1
  exec node /opt/agent-gateway/server.mjs "$@"
fi
exec "$CLI" "$@"
