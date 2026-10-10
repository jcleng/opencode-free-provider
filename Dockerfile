# OpenCode Zen free-tier proxy — minimal, dependency-free Node image.
# No npm install needed (zero runtime deps); just ship the ESM sources.
#
# Node >= 24 is REQUIRED: the built-in global `fetch` only honors the
# `https_proxy`/`HTTPS_PROXY` env vars (via `NODE_USE_ENV_PROXY=1`) starting in
# Node v24.0.0. On node:20-alpine the flag is silently ignored and outbound
# traffic bypasses the proxy entirely. See README "Outbound proxy".
FROM node:24-alpine

WORKDIR /app

# CA certificates for outbound HTTPS to opencode.ai/zen/v1
RUN apk add --no-cache ca-certificates

# Copy project (respects .dockerignore). Keep node_modules out of the image.
COPY . .

# The proxy listens on 127.0.0.1 by default; in a container bind 0.0.0.0 so the
# host/compose port mapping reaches it. Override HOST/PORT at runtime as needed.
ENV HOST=0.0.0.0
ENV PORT=8791

EXPOSE 8791

# `node server.js` auto-listens because it is executed directly (import.meta.url).
CMD ["node", "server.js"]
