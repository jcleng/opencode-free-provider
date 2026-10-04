# OpenCode Zen free-tier proxy — minimal, dependency-free Node image.
# No npm install needed (zero runtime deps); just ship the ESM sources.
FROM node:20-alpine

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
