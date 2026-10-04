# agents.md — opencode-free-provider

Operational + maintenance guide for coding agents working on this repo.

## What this project is

A tiny, dependency-free **OpenAI-compatible proxy** that relays chat completions to
the [OpenCode Zen free tier](https://opencode.ai/zen/v1). Any OpenAI-compatible
agent (OpenCode, rikkahub, etc.) points at `http://127.0.0.1:8791/v1` with
`apiKey: public` and uses the free models — no API key, no login.

```
Agent  ──►  http://127.0.0.1:8791/v1  ──►  OpenCode Zen free tier (opencode.ai/zen/v1)
```

## Why a proxy is needed (the core insight)

`opencode.ai/zen/v1` enforces a **client-fingerprint gate**. A bare request is
rejected with:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

The upstream only accepts a request that carries **all** of the following
(reverse-engineered, see [Fly143/OpenCode-Zen-free-api](https://github.com/Fly143/OpenCode-Zen-free-api),
their `zen_check.py` `ablate` test):

| Requirement | Value |
|---|---|
| `User-Agent` | `opencode/1.18+` (lowercase, version ≥ 1.18; older → `426`, non-opencode → `403`) |
| `x-opencode-session` | `ses_` + 12 hex + 14 hex chars (UUID format → `403`) |
| body `stream` | **must be `true`** (false → `403`) |
| body `tools` | must contain **all four** `bash`/`glob`/`grep`/`read` **(exactly once each; a duplicate name → `403`)** (missing any → `403`) |
| `Authorization` | `Bearer public` (not validated server-side, but sent for parity) |

This proxy injects every required header/field, so plain OpenAI clients just work.

## File map (who owns what)

| File | Responsibility |
|---|---|
| `server.js` | HTTP server, routing, `/__session` debug endpoint, direct-run guard |
| `src/routes.js` | `/v1/models`, `/v1/models/:id`, `/v1/chat/completions`, `/__session` |
| `src/models.js` | Local model registry + `opencode-free/` id prefix handling |
| `src/config.js` | **Fingerprint source of truth**: UA, session/request id generation, mandatory tools, env overrides |
| `src/conversions.js` | OpenAI↔upstream normalization; `buildRequestBody` forces `stream:true` + injects the 4 tools; SSE aggregation for non-stream |
| `src/upstream.js` | **Request injection + relay**: builds fingerprint headers, POSTs upstream, aggregates SSE→JSON for non-stream |

## Maintenance philosophy (read this before "fixing" a 403)

The free-tier detection is server-side and the vendor **keeps tightening it**
(multiple changes reported since 2026-09). When the upstream starts rejecting us
with `403 FreeTierError` again, the fix is almost always localized to the
**fingerprint**, not the proxy plumbing:

> **Only ever change `src/config.js` and `src/upstream.js`.**
> This matches the strategy in the reference project `zen_relay.py` — keep the
> OpenAI-compatible surface (routes / models / conversions *shape*) stable, and
> change the fingerprint in one place.

Concretely:
- **Header/UA/session/tool fingerprint changed?** → edit `src/config.js`
  (`OPENCODE_UA`, `OPENCODE_CLIENT`, `OPENCODE_PROJECT`, the session/request id
  generators `newSessionId`/`newRequestId`, or `ZEN_FREE_TOOLS`).
- **How the fingerprint is applied or how upstream SSE is read/aggregated?** →
  edit `src/upstream.js` (`fingerprintHeaders`, `aggregateSse`, the fetch call).
- **Never** need to touch `server.js`, `src/models.js`, or the OpenAI response
  shape in `src/conversions.js` (translate/`shapeCompletion`) for a fingerprint
  change — those are the stable downstream contract.

### The `tools` array has TWO hard invariants (both cause failures)

1. **All four names present, no duplicates.** `mergeTools()` keeps the agent's
   own tools verbatim and injects each required name **only when missing**.
   Never append the four fingerprint tools unconditionally — OpenCode already
   sends `bash`/`glob`/`grep`/`read` with its *real* schemas, so naively
   appending duplicates the names → upstream `403 FreeTierError`.
2. **Preserve the agent's tool schemas.** When the caller already provides
   `bash` (with `command`), `glob`/`grep` (with `pattern`), `read` (with `path`),
   those are the tools OpenCode can actually *execute*. Injecting a same-named
   fingerprint tool with a different schema (`p`) corrupts the tool namespace and
   makes the model emit `tool_call`s the agent cannot resolve — surfaced by
   OpenCode as **`Tool not found`** (it maps `Unknown tool: <name>` →
   `tool.unknown`). Keep the caller's schema; only fill gaps with the minimal
   `p`-param stub.

> If an agent reports `Tool not found` when calling a tool, suspect invariant #2:
> the model is calling a name/param the agent did not register. Verify
> `mergeTools()` is not overriding the agent's real tools with fingerprint stubs.

3. **Fingerprint tools are executed server-side on BOTH streaming and non-streaming paths.** The gate *requires* `bash`/`glob`/`grep`/`read` to be advertised, but many OpenAI-compatible clients (e.g. pi-agent / pi-coding-agent) do **not** register all of them — pi-agent has `bash`/`grep`/`read`/`ls`/`find`/`edit`/`write` but **no `glob`**. When the model emits a tool_call for ANY fingerprint-named tool (even `bash`/`read`/`grep`), the proxy runs it itself via `executeFingerprintTool` (`src/conversions.js`) and feeds the result back to the model as a synthetic tool message, looping with upstream until the model either emits only agent-executable tool_calls or a final answer. This is implemented in `runServerSideLoop` (`src/upstream.js`), which both paths share. **The agent never receives a tool_call whose name is a fingerprint tool**, so it can never report `Tool <name> not found`. The agent's own registered tools (`ls`/`find`/`edit`/`write`/…) are always forwarded verbatim for the agent to execute — only the four fingerprint tools are intercepted. Output is capped (20 KB/tool result) and the loop is bounded to 4 internal tool rounds.

> If an agent reports `Tool not found`, the failing name is almost certainly a fingerprint tool the caller doesn't register. The fix is NOT to add that tool to the caller — it's to ensure the proxy executes it server-side (invariant #3) and never forwards it. Do **not** try to make the caller register `glob`/`bash`/etc.; the proxy owns those names by design.

> The server-side implementations are dependency-free Node builtins: `bash` via `node:child_process` (`sh -c`), `glob`/`grep` via `node:fs` (recursive `.gitignore`-unaware walk), `read` via `node:fs/promises`. They run with `cwd` = the proxy's working directory (or `opts.cwd`).

### Where to re-verify the gate
`https://github.com/Fly143/OpenCode-Zen-free-api` `zen_check.py` is the canonical
probe (it runs `ablate`/`host`/`relay` checks). Re-run it (or the live checks in
this repo's `tests`) whenever a change is suspected, before editing code.

## Run / configure

```bash
npm start            # http://127.0.0.1:8791/v1
node server.js
```

| Env | Default | Notes |
|---|---|---|
| `PORT` | `8791` | listen port |
| `HOST` | `127.0.0.1` | bind host |
| `OPENCODE_BASE_OVERRIDE` | `https://opencode.ai/zen/v1` | redirect relay (used by tests) |
| `ZEN_SESSION_MODE` | `per-request` | `per-request` (fresh `ses_` each call) or `sticky` (reuse one) |
| `ZEN_SESSION_ROTATE_SECONDS` | `0` | when `sticky`, rotate session every N seconds |

Local debug (never forwarded upstream):
```bash
curl http://127.0.0.1:8791/__session
```

## Connect an agent

```
baseURL: http://127.0.0.1:8791/v1
apiKey:  public
model:   opencode-free/big-pickle
```

## Test / validate

```bash
npm test                 # 28 unit tests against a MOCK upstream (no network)
```

Live end-to-end against the real free tier (expect 200 + SSE / aggregated JSON):

```bash
# stream
curl -N -H 'Authorization: Bearer public' -H 'Content-Type: application/json' \
  -d '{"model":"opencode-free/big-pickle","stream":true,"messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8791/v1/chat/completions

# non-stream (proxy aggregates upstream SSE into one JSON)
curl -H 'Authorization: Bearer public' -H 'Content-Type: application/json' \
  -d '{"model":"opencode-free/big-pickle","stream":false,"messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8791/v1/chat/completions
```

## Models

Only `big-pickle` is enabled (see `MODELS` in `src/config.js`). Each model must be
verified live against the free tier before being added back. Note `big-pickle` is
served by the free tier even though it is not a `*-free`-suffixed model.
