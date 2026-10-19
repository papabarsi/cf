# syntax=docker/dockerfile:1.7
# cf — Cloudflare's agentic CLI, packaged for agents (ECS Fargate, local Docker).
#
# Stage 1 builds the CLI from THIS checkout (so fork patches ship), packs it as
# an npm tarball, and stage 2 installs that tarball into a slim Node 22 image.
# The generated command tree (packages/cli/src/commands/_generated) is tracked
# in git, so the build skips `task:generate` (which needs the forge wasm plugin
# and a network fetch of the pinned OpenAPI release) and runs `vp pack` directly.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/cli/package.json ./packages/cli/package.json
COPY packages/wrangler-tests/package.json ./packages/wrangler-tests/package.json
COPY fixtures ./fixtures
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts=false
COPY . .
# Build the CLI bundle (dist/) without regenerating the command tree.
RUN cd packages/cli && pnpm exec vp pack \
 && pnpm pack --pack-destination /out \
 && ls -la /out

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="cf" \
      org.opencontainers.image.description="Cloudflare agentic CLI (cf) for agent consumption" \
      org.opencontainers.image.source="https://github.com/papabarsi/cf"
ENV NODE_ENV=production \
    CF_QUIET=1 \
    NO_COLOR=1 \
    CF_TELEMETRY_DISABLED=1 \
    HOME=/home/agent \
    XDG_CONFIG_HOME=/home/agent/.config
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates jq tini \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 agent && useradd -m -u 10001 -g agent -d /home/agent agent
COPY --from=build /out/*.tgz /tmp/cf.tgz
RUN npm install -g /tmp/cf.tgz && rm /tmp/cf.tgz && npm cache clean --force \
 && cf --version
COPY docker/agent-gateway /opt/agent-gateway
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh && mkdir -p /home/agent/.config && chown -R agent:agent /home/agent
USER agent
WORKDIR /work
EXPOSE 8080
# Meaningful in gateway mode (GATEWAY=1); a one-shot CLI container exits before the first probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
# Default: run the CLI. `docker run cf dns records list -z example.com`
# `docker run -e GATEWAY=1 -p 8080:8080 cf` starts the HTTP gateway instead.
CMD ["--help"]
