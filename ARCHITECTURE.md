# ARCHITECTURE — cf (fork: container + agent gateway)

This is a fork of [cloudflare/cf](https://github.com/cloudflare/cf), Cloudflare's agentic
CLI. Upstream's own architecture notes live in `AGENTS.md` (authoritative for the CLI
itself). This file documents only what the fork adds: a container image and an HTTP agent
gateway for running `cf` on ECS Fargate. Keep the fork's footprint to `Dockerfile`,
`.dockerignore`, `docker/`, `deploy/` and this file so `git merge upstream/main` stays clean.

## 1. Purpose

Give agents (Claude Code, Codex, in-house SOC automation) a way to call the whole
Cloudflare API through `cf`'s searchable, JSON-first command tree without a Node toolchain
on the caller, from a container that can run locally or as a Fargate service. The contract:
`POST /run` with an argv array returns `cf`'s stdout/stderr/exit code; reads work out of the
box, writes require an explicit opt-in.

## 2. Components

| Component | Path | Responsibility | Runtime |
|---|---|---|---|
| `cf` CLI (upstream) | `packages/cli/` | Generated + hand-written Cloudflare commands | process in container |
| image build | `Dockerfile` | Build from checkout → npm tarball → `node:22-slim` runtime, non-root `agent` | docker build |
| entrypoint | `docker/entrypoint.sh` | `cf <args>` by default; `GATEWAY=1` → gateway | process |
| agent gateway | `docker/agent-gateway/server.mjs` | HTTP `/run`, `/tools`, `/healthz`; bearer auth; read-only guard; output caps | long-running process (:8080) |
| ECS example | `deploy/ecs/task-definition.example.json` | Fargate task wired to Secrets Manager | reference |

The same `entrypoint.sh` and `server.mjs` are vendored byte-identical in the sibling
`zs` project (Zscaler); change them in both places.

## 3. Dependencies

| Dependency | Kind | Hard / Soft | Failure Mode |
|---|---|---|---|
| Node 22 (`node:22-bookworm[-slim]`) | runtime | hard | image build fails / `cf` refuses to start |
| pnpm 12 + `@cloudflare/forge` from pkg.pr.new | build | hard (build only) | `pnpm install --frozen-lockfile` fails |
| Cloudflare API (`api.cloudflare.com`) | SaaS | hard at call time | `APIError`, exit 3 |
| tini, jq, ca-certificates | OS pkgs | hard | missing TLS roots → every call fails |

## 4. Integrations

| Direction | Integration | Protocol | Auth | Notes |
|---|---|---|---|---|
| out | Cloudflare API | HTTPS/JSON | `CLOUDFLARE_API_TOKEN` env | scoped API token; no OAuth login in containers |
| in | agents → gateway | HTTP/JSON on :8080 | `Authorization: Bearer $GATEWAY_TOKEN` | `/healthz` unauthenticated |
| out | ECS awslogs | stdout/stderr | task role | gateway logs one line per start; no request bodies |

## 5. Data Model

Stateless. The gateway keeps one in-memory cache (`cf tools` output). `cf` may write
completion/telemetry state under `$XDG_CONFIG_HOME` (`/home/agent/.config`), which is
ephemeral per task. Request/response shape of `/run`:

```jsonc
// request
{ "args": ["dns","records","list","-z","example.com"], "stdin": "", "timeoutMs": 60000 }
// response
{ "ok": true, "exitCode": 0, "stdout": "...", "stderr": "", "result": <parsed JSON if any>,
  "durationMs": 812, "timedOut": false, "truncated": false,
  "classification": { "leaf": "list", "mutating": false, "dryRun": false } }
```

## 6. Configuration & Secrets

| Variable | Required | Source | Purpose |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | yes | Secrets Manager (work) / 1P `Ai Agent Managed/Cloudflare API` (home, via `cf-op`) | API auth |
| `CLOUDFLARE_ACCOUNT_ID` | mostly | same item, `username` field | account-scoped commands |
| `GATEWAY` | no | task env | `1` → start gateway instead of CLI |
| `GATEWAY_TOKEN` | gateway: yes | Secrets Manager | bearer token for `/run`, `/tools` |
| `GATEWAY_WRITE_ENABLED` | no | task env | `1` allows mutating verbs (default read-only) |
| `GATEWAY_ALLOW_UNAUTH` | no | — | dev only; never in a task definition |
| `GATEWAY_PORT` / `GATEWAY_BIND` | no | | default `8080` / `0.0.0.0` |
| `GATEWAY_MAX_TIMEOUT_MS` / `GATEWAY_MAX_OUTPUT` | no | | caps (300 s / 8 MiB) |
| `CF_QUIET`, `NO_COLOR`, `CF_TELEMETRY_DISABLED` | set in image | | plain JSON output |

## 7. Patterns Used

- **PAT-07** — `docker/README.md` — credentials come from `op run` locally and Secrets
  Manager on Fargate; never baked into the image.
- **LL-06** — `docker/agent-gateway/server.mjs` — tokens travel in env/headers, never argv.
- **LL-22** — n/a here, but see `zs` for the SPA-scraping lesson that produced its spec.

## 8. Lessons Learned

#### `cf` exits 0 on declined destructive commands — 2026-10-01 (pre-fork, see `cf-op`)
**Symptom:** non-interactive `cf … delete` printed `Aborted.` and exited 0.
**Root cause:** upstream treats a declined confirm as a no-op success.
**Fix:** gateway maps `Aborted.` + exit 0 to `ok:false, exitCode:4` (same as `~/bin/cf-op`).
**Guardrail:** `docker/README.md` documents it; `zs` exits 4 natively.

## 9. Known Gaps & Risks

- Read-only guard is a verb heuristic (`create|update|delete|…|--force`); a generated
  command with an unusual verb could slip through. Mitigation: `--dry-run` first; keep
  `GATEWAY_WRITE_ENABLED` off; scope the API token to read where possible.
- No MCP transport yet — agents use `/run` + `/tools`. Follow-up: streamable-HTTP MCP.
- Image is ~460 MB (miniflare/workerd ship with `cf`). Acceptable for Fargate; trim later.
- `cf` is beta; upstream merges may move files the Dockerfile copies (`packages/cli`).

## 10. Health Checks

```yaml
checks:
  - id: cf-image-builds
    description: cf-agent image builds from this checkout
    type: command
    command: cd /home/barsi/projects/cf && docker build -q -t cf-agent:healthcheck . >/dev/null
    severity: info
    interval: 7d
    timeout_sec: 1200
    owner: image build
```
