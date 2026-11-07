// .find-clean.mjs — hunt for an egress IP with free quota left.
// Scrapes fresh candidates, probes them 30-in-parallel, dustbins quota/dead,
// keeps the first 'ok' and reports it. Run: node .find-clean.mjs
import * as eg from './src/egress.js'

const st = eg.egressFullState()
const dusted = new Set(st.dustbin.map((d) => d.proxy))
const seen = new Set(st.pool.map((p) => p.proxy))

const fresh = await eg.scrapeSources({ timeoutMs: 15000 })
const cands = [...new Set(fresh)].filter((p) => !dusted.has(p) && !seen.has(p))
console.log('fresh candidates after dedup:', cands.length)

let found = null
let tested = 0
for (let i = 0; i < cands.length && !found; i += 30) {
  const batch = cands.slice(i, i + 30)
  const rs = await Promise.all(
    batch.map((p) => eg.testProxy(p).catch((e) => ({ proxy: p, status: 'dead', detail: String(e) })))
  )
  tested += rs.length
  let okN = 0, qN = 0, dN = 0
  for (const r of rs) {
    if (r.status === 'ok') {
      okN++
      eg.reportEgress(r.proxy, 'ok')
      if (!found) { found = r.proxy; console.log('FOUND_OK ' + r.proxy + ' ttfb=' + r.ttfbMs + 'ms') }
    } else if (r.status === 'quota') {
      qN++
      eg.reportEgress(r.proxy, 'quota', { retryAfterSec: r.retryAfterSec })
    } else {
      dN++
      eg.reportEgress(r.proxy, 'dead', { detail: r.detail })
    }
  }
  console.log(`batch ${Math.floor(i / 30) + 1}: tested ${tested} — ok ${okN}, quota ${qN}, dead ${dN}`)
}
console.log(found ? 'RESULT_OK ' + found : 'RESULT_NONE tested=' + tested)
