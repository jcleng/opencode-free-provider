# opencode-free-provider

A local **OpenAI-compatible** proxy that relays chat requests to the
[OpenCode Zen free tier](https://opencode.ai/zen/v1). Point any OpenAI-compatible
agent (OpenCode, rikkahub, etc.) at it and use the free models with no API key.

```
Agent  ──►  http://127.0.0.1:8791/v1  ──►  OpenCode Zen free tier (opencode.ai/zen/v1)
```

## Why a proxy is needed

`opencode.ai/zen/v1` enforces a **client-fingerprint gate**: a bare request is
rejected with `403 FreeTierError: OpenCode's free tier can only be used from
within OpenCode`. The upstream only accepts a request that carries **all** of:

| Requirement | Value |
|---|---|
| `User-Agent` | `opencode/1.18+` (lowercase, version ≥ 1.18; older → `426`) |
| `x-opencode-session` | `ses_` + 12 hex + 14 hex chars (UUID format → `403`) |
| body `stream` | **must be `true`** (false → `403`) |
| body `tools` | must contain **all four** of `bash`/`glob`/`grep`/`read` (missing any → `403`) |
| `Authorization` | `Bearer public` (not validated server-side, but sent for parity) |

This proxy injects every required header/field for you, so plain OpenAI clients
just work. (These conditions were reverse-engineered with gratitude from
[Fly143/OpenCode-Zen-free-api](https://github.com/Fly143/OpenCode-Zen-free-api).)

## Run

```bash
npm start            # listens on http://127.0.0.1:8791/v1
# or
node server.js
```

Env overrides:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8791` | Listen port |
| `HOST` | `127.0.0.1` | Bind host |
| `OPENCODE_BASE_OVERRIDE` | `https://opencode.ai/zen/v1` | Point the relay elsewhere (used by tests) |
| `ZEN_SESSION_MODE` | `per-request` | `per-request` (fresh `ses_` each call, safest) or `sticky` (reuse one for the process) |
| `ZEN_SESSION_ROTATE_SECONDS` | `0` | When `sticky`, rotate the session every N seconds |

Debug endpoint (local only, never forwarded upstream):

```bash
curl http://127.0.0.1:8791/__session
```

## Connect an agent

```
baseURL: http://127.0.0.1:8791/v1
apiKey:  public            (any non-empty string works)
model:   opencode-free/big-pickle
```

OpenCode (`~/.config/opencode/opencode.json`) example:

```json
{
  "provider": {
    "opencode-free": {
      "npm": "@opencode-ai/opencode",
      "options": {
        "baseURL": "http://127.0.0.1:8791/v1",
        "apiKey": "public"
      },
      "models": [{ "id": "opencode-free/big-pickle", "name": "Big Pickle (Free)" }]
    }
  }
}
```

PI Agent example:

```json
  "opencode-zen": {
      "baseUrl": "http://127.0.0.1:8791/v1",
      "api": "openai-completions",
      "apiKey": "public",
      "models": [
        { "id": "big-pickle" }
      ]
    }
```

## Endpoints

- `GET /v1/models` — OpenAI-style model list
- `GET /v1/models/:id` — single model
- `POST /v1/chat/completions` — streaming (`stream:true`) and non-streaming
  (`stream:false`, aggregated from upstream SSE by this proxy)
- `GET /health`, `/` — health text
- `GET /__session` — local fingerprint/session status

## Models

Only `big-pickle` is enabled for now (see `MODELS` in `src/config.js`). Each model
must be verified live against the free tier before being added back.

## Test

```bash
npm test             # 28 unit tests (mock upstream)
```

Live end-to-end against the real free tier is exercised manually with the
fingerprint described above.

> **Tool calls / `Tool not found`:** the upstream free tier requires the four tool
> names `bash`/`glob`/`grep`/`read` in the body, but a **duplicate name** triggers
> `403`. The proxy (`mergeTools` in `src/conversions.js`) keeps the agent's own
> tools and injects each required name only when missing, so the agent's real
> `bash`/`glob`/`grep`/`read` (with their `command`/`path`/`pattern` schemas) are
> preserved — the model emits tool calls the agent can actually execute.
>
> Some OpenAI-compatible clients (e.g. pi-agent / pi-coding-agent) do **not**
> register every fingerprint tool — pi-agent has `bash`/`grep`/`read`/`ls`/`find`/
> `edit`/`write` but **no `glob`**, and historically its `bash` is not wired through
> custom OpenAI providers. Because the gate *forces* all four names to be
> advertised, the model may call one the client cannot resolve, and the client
> would report `Tool not found`. To avoid that, the proxy **executes ALL four
> fingerprint tools server-side** (`executeFingerprintTool` in `src/conversions.js`,
> wired through `runServerSideLoop` in `src/upstream.js`) on **both streaming and
> non-streaming paths**, feeds the result back to the model as a synthetic tool
> message, and loops with upstream until the model emits only agent-executable
> tool calls or a final answer. **The agent never receives a tool_call with a
> fingerprint name**, so it can never report `Tool not found`. The agent's own
> registered tools (`ls`/`find`/`edit`/`write`/…) are always forwarded verbatim.
> The server-side implementations use only Node builtins (glob/grep via `node:fs`,
> bash via `node:child_process`) — no extra dependencies.

## License

MIT
