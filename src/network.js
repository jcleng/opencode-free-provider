// src/network.js
//
// Outbound TCP tuning for the relay's global `fetch` (undici).
//
// WHY THIS EXISTS
// ---------------
// Node enables "Happy Eyeballs" (RFC 8305) by default and gives each candidate
// address only 250ms to accept the TCP connection (`autoSelectFamilyAttemptTimeout`
// defaults to 250). From this host, Cloudflare's opencode.ai edge addresses
// (172.65.90.20-23) routinely need 300ms-2.5s to complete the TLS handshake /
// TCP connect. With the 250ms budget, Node abandons every IPv4 address and fails
// the whole fetch with:
//
//     TypeError: fetch failed (ETIMEDOUT)
//       cause: AggregateError [ETIMEDOUT] { connect ETIMEDOUT 172.65.90.20:443, ... }
//
// while `curl` (which waits far longer per address) succeeds against the very
// same endpoint. That is why the proxy log shows sporadic
// `upstream attempt 1/3 failed: fetch failed (ETIMEDOUT)` even though the
// network is reachable.
//
// Raising the per-address attempt budget fixes it. Set
// ZEN_CONNECT_ATTEMPT_TIMEOUT_MS=0 to keep Node's default (250ms).
import net from 'node:net'

const DEFAULT_ATTEMPT_TIMEOUT_MS = 3000

const configured = Number(process.env.ZEN_CONNECT_ATTEMPT_TIMEOUT_MS)
const attemptMs = Number.isFinite(configured) && configured >= 0
  ? configured
  : DEFAULT_ATTEMPT_TIMEOUT_MS

if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(attemptMs)
}

export { attemptMs }
