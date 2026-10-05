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

3. **The proxy NEVER executes tools — it is a pure forwarder + translator.** The gate *requires* `bash`/`glob`/`grep`/`read` to be advertised, but many OpenAI-compatible clients (e.g. pi-agent / pi-coding-agent) do **not** register all of them — pi-agent has `bash`/`grep`/`read`/`ls`/`find`/`edit`/`write` but **no `glob`**. The proxy does **not** run these itself (no `node:child_process`, no `node:fs`, no server-side `cwd`/`/app` default). Instead, per request it computes the caller's registered tool names (`callerToolNames`) and, in `runTranslateLoop` (`src/upstream.js`), **rewrites any fingerprint tool_call the agent cannot run into an agent-supported tool** via `translateFingerprintCall` (`src/conversions.js`). Example: the model emits `glob` but the agent has no `glob` → the proxy rewrites it to `bash` with a globstar loop (`shopt -s globstar nullglob; for f in <pattern>; do echo "$f"; done`). The **agent** then executes that `bash` call in ITS OWN working directory and returns the result as ordinary text — the proxy never touches the filesystem. If **no** registered tool can stand in for a fingerprint call (e.g. the agent has neither `bash`/`find` for `glob`), the proxy relays a textual note back to upstream itself (a pure relay round-trip, still no execution) and lets the model continue. **The agent never receives a tool_call name it cannot resolve**, so it can never report `Tool <name> not found`. The agent's own registered tools are always forwarded verbatim; a fingerprint tool the agent *does* register (e.g. `glob` when the agent has one) is forwarded verbatim too — only the names the agent lacks are translated.

   The original↔translated mapping survives the stateless request boundary (the agent calls back with tool results in a separate HTTP request) by encoding the original fingerprint call into the tool_call id handed to the agent (`encodeTranslatedId`, prefix `tr:`). On the agent's follow-up, `serializeMessages` (`src/conversions.js`) decodes it and restores the original `tool_call_id`/name/args for upstream, and folds the agent's real result into the conversation as the (natural-language) result the model sees.

> If an agent reports `Tool not found`, the failing name is a fingerprint tool the caller doesn't register **and** no registered tool could stand in. The fix is to extend `translateFingerprintCall` (invariant #3) to map it onto an agent tool — do **not** add a server-side executor, and do **not** try to make the caller register `glob`/`bash`/etc. Conversely, if the caller DOES register a fingerprint tool, the proxy must NOT translate it — confirm `clientToolNames.has(name)` short-circuits the translation.

4. **The streaming SSE we emit MUST end on a chunk with a non-null `finish_reason`.** Because the proxy buffers upstream SSE and replays a synthesized OpenAI stream (`completionToChunks` in `src/upstream.js`), it is responsible for emitting the terminal chunk itself. The original implementation emitted a final chunk with `choices: []` (empty) and stashed the `finish_reason` in a fallback parameter that was shadowed by the explicit per-choice `null` — so OpenAI-compatible clients aborted with **`Stream ended without finish_reason`**. The fix: the terminal chunk always carries `choices:[{ delta:{}, finish_reason: 'stop' | 'tool_calls' }]` plus the `usage` block, and `makeChunk` only falls back to the overall finish reason when a choice omitted it (an explicit `null` is preserved as-is for non-terminal chunks).

> If an agent reports `Stream ended without finish_reason`, the cause is the proxy's synthesized SSE, not upstream. Check `completionToChunks`/`makeChunk` in `src/upstream.js`: the last yielded chunk must contain a choice with a concrete `finish_reason` (never an empty `choices` array). Also note that server-side tool execution (invariant #3) adds latency — each fingerprint tool call is an extra sequential upstream round-trip before the agent sees the final answer — so a tool-using turn legitimately takes longer to load. That latency is expected, not a stall.

### Trade-off: delegation vs. robustness (translation, not execution)
The proxy is a pure forwarder; it never executes tools. When the model emits a fingerprint tool the agent lacks, `runTranslateLoop` rewrites it onto an agent tool (invariant #3), so the agent runs it in its own cwd and returns the result as text. This keeps the agent authoritative over its working directory (no server-side `/app` leakage) and keeps the proxy free of any shell/filesystem code. The only extra latency is the natural agent↔model tool round-trips (which a real agent would incur anyway) and, in the rare case where no agent tool can stand in, one extra upstream round-trip for the relayed note. A client that registers all four fingerprint tools pays nothing (pure delegation); pi-agent (lacks `glob`) pays one translation per `glob` call it triggers.

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

The proxy does NOT receive or honor any working-directory field (no `x-opencode-cwd`
header, no body `cwd`/`workdir`). It never runs tools, so it never has a server-side
cwd to get wrong. Any tool the model requests that the agent lacks (e.g. `glob` when
the agent registers `bash`/`grep`/`read` but not `glob`) is **translated** by the
proxy into an agent-supported tool — `glob` becomes a `bash` globstar loop — which
the **agent** then executes in its own cwd. The result comes back as ordinary text,
so the model still sees a correct file listing without the proxy ever touching the
filesystem or assuming a directory. The cleanest setup is to register `glob` (and
`grep`/`read`) on the agent too, so the proxy forwards those verbatim and performs
no translation at all.

## Test / validate

```bash
npm test                 # 38 unit tests against a MOCK upstream (no network)
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
