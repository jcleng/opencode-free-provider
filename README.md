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
| `ZEN_MODELS_TTL_SECONDS` | `600` | How long (seconds) the discovered model list is cached before re-fetching from upstream (`0` = never expire) |
| `ZEN_MODELS_TIMEOUT_MS` | `5000` | Timeout for the upstream `GET /models` discovery request |
| `https_proxy` / `HTTPS_PROXY` | _(unset)_ | Outbound HTTPS proxy for reaching `opencode.ai`. Requires `NODE_USE_ENV_PROXY=1` (see below) |
| `NODE_USE_ENV_PROXY` | _(unset)_ | Set to `1` to make the built-in `fetch` honor `https_proxy`/`HTTPS_PROXY` |

Debug endpoint (local only, never forwarded upstream):

```bash
curl http://127.0.0.1:8791/__session
curl http://127.0.0.1:8791/__models          # model-registry cache status (?refresh=1 forces re-fetch)
```

## Outbound proxy (reaching opencode.ai)

The relay itself is a plain HTTP server on `127.0.0.1:8791`; the **outbound**
request it makes to `https://opencode.ai/zen/v1` uses Node's built-in global
`fetch` (undici). That `fetch` does **not** read `https_proxy`/`HTTPS_PROXY` by
default — you must opt in.

To send the upstream traffic through an HTTP proxy (e.g. `http://127.0.0.1:20171`):

```bash
export https_proxy=http://127.0.0.1:20171
export HTTPS_PROXY=http://127.0.0.1:20171   # case-insensitive; both are read
export NODE_USE_ENV_PROXY=1                 # REQUIRED: makes global fetch honor the proxy
node server.js
```

`NODE_USE_ENV_PROXY=1` is the critical flag — without it, merely exporting
`https_proxy` has **no effect** and the relay connects to `opencode.ai`
directly. (Verified on Node ≥ 24: `fetch` only consults `https_proxy`/`HTTPS_PROXY`
when this flag is set, and emits a `CONNECT` tunnel to the proxy.)

> **Requires Node ≥ 24.** `NODE_USE_ENV_PROXY` was added in **Node v24.0.0**.
> On Node 18/20/22 the flag is silently ignored, so the relay keeps connecting
> to `opencode.ai` directly even though `https_proxy` is set and the container
> env looks correct. The bundled `Dockerfile` therefore builds on
> `node:24-alpine`. To check a running container:
>
> ```bash
> docker exec opencode-free-provider node -v        # expect v24.x or newer
> ```
>
> Quick litmus test — point `https_proxy` at a dead port; with the flag on the
> fetch **must** fail with `ECONNREFUSED`. If it succeeds, the proxy is being
> bypassed (wrong Node version, or the env vars never reached the process):
>
> ```bash
> NODE_USE_ENV_PROXY=1 https_proxy=http://127.0.0.1:39999 node -e \
>   'fetch("https://example.com").then(r=>console.log("DIRECT",r.status)).catch(e=>console.log("PROXIED ->",e.cause?.code))'
> ```

> Note: the proxy at `127.0.0.1:20171` must support the `CONNECT` tunnel method
> for HTTPS upstreams. If you prefer to pin the proxy in code (independent of the
> `NODE_USE_ENV_PROXY` experimental switch and Node version), configure an undici
> `ProxyAgent` via `setGlobalDispatcher` in `src/upstream.js` and pass it as the
> `dispatcher` on each `fetch`.

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
- `GET /__models` — local model-registry cache status (`?refresh=1` forces a re-fetch)

## Models

The model list is **discovered live**: on startup (and whenever the cache is
stale) the proxy calls
`curl https://opencode.ai/zen/v1/models` (via `GET {OPENCODE_BASE}/models` in
`src/config.js`) and keeps only the ids whose id contains `big-pickle` **or**
contains `-free` — everything else (claude/gpt/gemini/… ids on the upstream list)
is filtered out. The result is cached for `ZEN_MODELS_TTL_SECONDS` (default 600s);
on a fetch failure the last good list is kept (before the first success the
built-in fallback is `big-pickle`).

## Test

```bash
npm test             # 47 unit tests (mock upstream)
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
> `edit`/`write` but **no `glob`**. Because the gate *forces* all four names to be
> advertised, the model may call one the client cannot resolve, and the client
> would report `Tool not found`. The proxy is a **pure forwarder + translator**:
> it never executes tools itself (no `node:child_process`, no `node:fs`, no
> server-side cwd/`/app`). It keeps all four names on the wire (the gate requires
> them) and, **whenever the model emits a fingerprint tool the caller did NOT
> register**, **rewrites that tool_call into a tool the agent DOES implement** —
> via `translateFingerprintCall` (`src/conversions.js`), driven by
> `runTranslateLoop` (`src/upstream.js`). For example, a `glob` call the agent
> lacks becomes a `bash` call with a globstar loop (`shopt -s globstar nullglob;
> for f in <pattern>; do echo "$f"; done`); the **agent** then executes it in its
> own working directory and returns the listing as ordinary text. If no registered
> tool can stand in for a fingerprint call (e.g. the agent has neither `bash` nor
> `find` for `glob`), the proxy relays a textual note back to upstream itself (a
> pure relay round-trip, still no execution) and lets the model continue.
> **The agent never receives a tool_call name it cannot resolve**, so it can never
> report `Tool not found`. The agent's own registered tools (and any fingerprint
> tool it *does* register) are always forwarded verbatim; only the names the agent
> lacks are translated. The original↔translated mapping survives the stateless
> request boundary by encoding the original call into the tool_call id (`tr:`
> prefix); on the agent's follow-up, `serializeMessages` restores the original
> call and folds the agent's real result back into the conversation as natural
> language.
>
> **No working-directory plumbing.** The proxy receives no cwd — no
> `x-opencode-cwd` header, no body `cwd`/`workdir`. Because it never runs tools,
> there is no server-side directory to get wrong; the agent's filesystem is
> authoritative.
>
> **Best setup:** register `glob` (and `grep`/`read` if you can) on the client
> itself. The agent then executes those tools in its own filesystem, so the proxy
> forwards them verbatim and performs no translation at all.

## License

MIT
