#!/bin/bash
cd ~/my/opencode-free-provider
node -e "
import('./src/egress.js').then(async (eg) => {
  // wide grind: test up to 120 candidates (all sources incl. proxyscrape top 300)
  for (let i = 0; i < 8; i++) {
    const r = await eg.sweep({ size: 30, scrape: i === 0 })
    if (eg.egressState().ok > 0) break
    if (!r.tested) break
  }
  const s = eg.egressState()
  console.log('GRIND DONE ok:', s.ok, 'best:', s.best, 'untested:', s.untested, 'dustQuota:', s.dustbinQuota, 'dustDead:', s.dustbinDead)
  if (s.top.length) console.log('TOP:', JSON.stringify(s.top))
  process.exit(0)
})
"
