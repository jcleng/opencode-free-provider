# OpenCode Zen free-tier proxy — runs on BUN.
#
# WHY BUN (not Node)
# ------------------
# The free tier fingerprints the outbound **TLS client hello**. The official
# OpenCode client is a Bun binary; a request sent with Bun's TLS stack is
# accepted, while the byte-identical request sent with Node/OpenSSL is answered
# with
#
#   429 {"type":"error","error":{"type":"FreeUsageLimitError",
#        "message":"Free usage limit reached. Free models work in OpenCode …"}}
#
# even when the egress IP still has free quota (verified by routing the very
# same request through a TLS-terminating tunnel: Node → 429, Bun → 200). Node's
# TLS options (ciphers / curves / sigalgs) do not change the verdict, so the only
# reliable fix is to relay with the same runtime OpenCode itself uses.
#
# The proxy is still dependency-free pure JS — Bun just supplies `fetch`.
#
# Override the base image at build time if you mirror it, e.g.:
#   docker build --build-arg BUN_IMAGE=registry.cn-hangzhou.aliyuncs.com/jcleng/bun:1.4.4 .
ARG BUN_IMAGE=oven/bun:1.4.4
FROM ${BUN_IMAGE} AS base

WORKDIR /app

# ca-certificates : outbound HTTPS to opencode.ai/inference/openai/v1
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

# Bun's fetch honors HTTPS_PROXY/HTTP_PROXY on its own; keep the Node-compat flag
# for any code path that still consults it.
ENV NODE_USE_ENV_PROXY=1

# Node's Happy Eyeballs gives each resolved address only 250ms to connect. The
# opencode.ai Cloudflare edge often needs longer, which surfaced as intermittent
# "fetch failed (ETIMEDOUT)". See src/network.js (best-effort: Bun may not expose
# the net helper).
ENV ZEN_CONNECT_ATTEMPT_TIMEOUT_MS=3000

EXPOSE 8791

CMD ["bun", "server.js"]
