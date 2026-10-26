# OpenCode Zen free-tier proxy.
#
# The proxy is pure Node with zero npm runtime deps. The upstream free-tier
# fingerprint (User-Agent + x-opencode-session id) is generated in pure JS by
# src/fingerprint.js — NO `opencode` CLI, NO MITM, NO openssl needed.
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

# Copy project (respects .dockerignore). node_modules is excluded.
COPY . .

# The proxy listens on 127.0.0.1 by default; in a container bind 0.0.0.0 so the
# host/compose port mapping reaches it. Override HOST/PORT at runtime as needed.
ENV HOST=0.0.0.0
ENV PORT=8791

# Make the built-in fetch honor https_proxy/HTTPS_PROXY when an outbound proxy is
# supplied at runtime (Node >= 24). No proxy env set = direct connection.
ENV NODE_USE_ENV_PROXY=1

# Node's Happy Eyeballs gives each resolved address only 250ms to connect. The
# opencode.ai Cloudflare edge often needs longer, which surfaced as intermittent
# "fetch failed (ETIMEDOUT)" even though curl worked. See src/network.js.
ENV ZEN_CONNECT_ATTEMPT_TIMEOUT_MS=3000

EXPOSE 8791

# `node server.js` auto-listens because it is executed directly (import.meta.url).
CMD ["node", "server.js"]
