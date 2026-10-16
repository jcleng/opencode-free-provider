#!/usr/bin/env node
// scripts/poolkeeper.mjs — standalone egress-pool daemon.
//
// Runs src/egress.js's own refresh cycle on a timer: loads the pool file,
// farms fresh candidates from the configured public list when the pool runs
// low, vets them with real zen pongs through CONNECT tunnels, and persists
// the survivors. Zero dependencies; it only speaks to its own pool file.
//
// Run:
//   node scripts/poolkeeper.mjs            # every interval
//   node scripts/poolkeeper.mjs --once     # a single cycle, then exit
//
// Env: OFP_POOL_* (see src/egress.js) — POOL_FILE, SEED_TARGET, VET_W, etc.
//   POOL_LOG    where the log goes (default ~/tmp/poolkeeper.log)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import fileURLToPath_raw from 'node:url'
import * as egress from '../src/egress.js'

const ONCE = process.argv.includes('--once')
const INTERVAL_MIN = Number(process.env.POOL_INTERVAL_MIN) > 0 ? Number(process.env.POOL_INTERVAL_MIN) : 30
const LOG_FILE = process.env.POOL_LOG || path.join(os.homedir(), 'tmp', 'poolkeeper.log')

if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
const log = (line) => {
  const line_ = `${new Date().toISOString()} ${line}`
  try { fs.appendFileSync(LOG_FILE, line_ + '\n') } catch { /* noop */ }
  console.log(line_)
}

async function cycle(why) {
  try {
    log(`cycle start (${why})`)
    const st = await egress.refresh({ force: why === 'startup' })
    log(`cycle done: live=${st.live} total=${st.total} cooling=${st.cooling} ` +
        `best=${st.entries[0] ? `${st.entries[0].proxy} ${st.entries[0].ttfbMs}ms` : '—'} ` +
        `book=${JSON.stringify(st.book)}`)
  } catch (err) {
    log(`cycle failed: ${err && err.stack || err}`)
  }
}

const main = async () => {
  await cycle('startup')
  if (ONCE) process.exit(0)
  log(`watching every ${INTERVAL_MIN}m (file: ${egress.POOL_FILE})`)
  setInterval(() => void cycle(INTERVAL_MIN + 'min tick'), INTERVAL_MIN * 60 * 1000)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

void fileURLToPath_raw
main()
