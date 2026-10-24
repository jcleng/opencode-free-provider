# OpenCode Zen free-tier proxy.
#
# The proxy is pure Node with a single npm runtime dep: `undici` (used for the
# egress IP pool / ProxyAgent in src/egress.js and src/upstream.js). The
# upstream free-tier fingerprint (User-Agent + x-opencode-session id) is
# generated in pure JS by src/fingerprint.js — NO `opencode` CLI, NO MITM, NO
# openssl needed.
#
# Node >= 24 is REQUIRED: the built-in global `fetch` only honors the
# `https_proxy`/`HTTPS_PROXY` env vars (via `NODE_USE_ENV_PROXY=1`) starting in
# Node v24.0.0. See README "Outbound proxy".
#
# Override the base image at build time if you mirror it, e.g.:
#   docker build --build-arg NODE_IMAGE=registry.cn-hangzhou.aliyuncs.com/jcleng/library-node:24 .
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base

WORKDIR /app

# ca-certificates : outbound HTTPS to opencode.ai/zen/v1
# curl            : handy for health checks / debugging from inside the container
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

# Copy project (respects .dockerignore). node_modules is excluded, so install
# the runtime deps here. `npm ci` needs package-lock.json (present) for a
# reproducible, non-interactive install.
#   --omit=dev      : only production deps (we have none but be explicit)
#   --no-audit/--no-fund : quieter, faster CI builds
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .

# The proxy listens on 127.0.0.1 by default; in a container bind 0.0.0.0 so the
# host/compose port mapping reaches it. Override HOST/PORT at runtime as needed.
ENV HOST=0.0.0.0
ENV PORT=8791

EXPOSE 8791

# `node server.js` auto-listens because it is executed directly (import.meta.url).
CMD ["node", "server.js"]
