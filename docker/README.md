# Running `cf` in a container (agents, ECS Fargate)

This fork adds a container image so agents can call Cloudflare's `cf` CLI without a Node
toolchain on the host, and an optional HTTP **agent gateway** so a long-running Fargate
task can serve many agents.

## Build

```bash
docker build -t cf-agent:dev .
```

Stage 1 builds the CLI from this checkout (so fork patches ship) and packs it as an npm
tarball; stage 2 installs that tarball into `node:22-bookworm-slim` with `tini`, `jq`
and a non-root `agent` user (uid 10001). The generated command tree is tracked in git, so
the build does not need the forge wasm plugin or network access to the OpenAPI release.

## Run the CLI directly

```bash
docker run --rm -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID cf-agent:dev auth whoami
docker run --rm -e CLOUDFLARE_API_TOKEN cf-agent:dev dns records list -z example.com
docker run --rm cf-agent:dev cli search "purge the cache for a zone"
```

`CF_QUIET=1`, `NO_COLOR=1` and `CF_TELEMETRY_DISABLED=1` are set in the image, so output
is plain JSON suitable for piping into `jq` or an agent. Pass the token through the task's
**secrets**, never bake it into the image or a `.env` layer.

## Agent gateway mode

```bash
docker run -d -p 8080:8080 -e GATEWAY=1 -e GATEWAY_TOKEN=… \
  -e CLOUDFLARE_API_TOKEN -e CLOUDFLARE_ACCOUNT_ID cf-agent:dev
```

| route | purpose |
|---|---|
| `POST /run` `{"args":["dns","records","list","-z","example.com"],"stdin":"","timeoutMs":60000}` | spawn `cf` with that argv (no shell); returns `{ok, exitCode, stdout, stderr, durationMs, truncated, classification}` |
| `GET /tools` | `cf tools` output (MCP-style tool definitions) |
| `GET /healthz` | liveness (unauthenticated) |

Rules baked into `docker/agent-gateway/server.mjs`:

- Every request except `/healthz` needs `Authorization: Bearer $GATEWAY_TOKEN` (at least 32
  characters). The gateway refuses to start without one unless `GATEWAY_ALLOW_UNAUTH=1` (local dev only).
- The child CLI gets an allow-listed environment only (never `GATEWAY_*`), at most
  `GATEWAY_MAX_CONCURRENCY` (4) run at once, and responses carry raw `stdout` (no parsed `result`).
- **Read-only by default.** An argv whose command words contain a mutating verb
  (`create`, `update`, `delete`, `purge`, `deploy`, …) or `--force` is rejected with 403 unless
  it carries `--dry-run` or the gateway runs with `GATEWAY_WRITE_ENABLED=1`.
- `cf` prints `Aborted.` and exits 0 when a destructive command is declined
  non-interactively; the gateway reports that as `ok:false, exitCode:4`.
- Output is capped (`GATEWAY_MAX_OUTPUT`, 8 MiB per stream) and timed out
  (`GATEWAY_MAX_TIMEOUT_MS`, 300 s).

## ECS Fargate

`deploy/ecs/task-definition.example.json` is a starting point: 0.25 vCPU / 512 MiB,
`GATEWAY=1`, secrets from Secrets Manager (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`GATEWAY_TOKEN`), awslogs, and a health check on `/healthz`. Deploy it as a service in
**private subnets with no public IP**; allow port 8080 only from the agents' security
group (or front it with an internal ALB / ECS Service Connect). Rotate `GATEWAY_TOKEN` and
the Cloudflare token in Secrets Manager; the task picks them up on the next deployment.

```bash
aws ecr create-repository --repository-name cf-agent
docker tag cf-agent:dev 123456789012.dkr.ecr.us-east-1.amazonaws.com/cf-agent:latest
docker push 123456789012.dkr.ecr.us-east-1.amazonaws.com/cf-agent:latest
aws ecs register-task-definition --cli-input-json file://deploy/ecs/task-definition.example.json
```

## Keeping the fork current

```bash
git fetch upstream && git merge upstream/main
```

The fork only adds `Dockerfile`, `.dockerignore`, `docker/`, `deploy/` and this README
section, so upstream merges should be conflict-free.
