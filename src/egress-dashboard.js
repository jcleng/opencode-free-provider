// src/egress-dashboard.js — single-file dashboard for the egress pool.
// Served by GET /__egress/dashboard (routes.js → handleEgressDashboard).
// Talks to /__egress (state), /__egress/import, /__egress/toggle,
// /__egress/retest, /__egress/remove-user. No build step, no dependencies.

export function egressDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode-free-provider · egress</title>
<style>
  :root {
    --bg: #F2F2F7; --panel: #FFFFFF; --line: rgba(60,60,67,.15); --text: #000;
    --dim: rgba(60,60,67,.6); --ok: #34C759; --warn: #FF9500; --bad: #FF3B30; --accent: #007AFF;
    --radius: 12px; --pad: 16px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000000; --panel: #1C1C1E; --line: rgba(84,84,88,.5); --text: #F5F5F7;
      --dim: rgba(235,235,245,.6); --ok: #30D158; --warn: #FF9F0A; --bad: #FF453A; --accent: #0A84FF;
    }
  }
  * { box-sizing: border-box }
  body { margin: 0; background: var(--bg); color: var(--text); font: 17px/1.47 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5 }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .5px }
  .pill { padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; color: var(--dim) }
  .pill.ok { color: var(--ok); border-color: var(--ok) }
  main { padding: 16px 18px 60px; max-width: 1100px; margin: 0 auto }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px }
  .card .n { font-size: 24px; font-weight: 700 }
  .card .l { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; margin-top: 2px }
  .card.ok .n { color: var(--ok) } .card.warn .n { color: var(--warn) } .card.bad .n { color: var(--bad) }
  .best { grid-column: 1 / -1; font-size: 13px; color: var(--dim) }
  .best b { color: var(--ok) }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px }
  .stat .n { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums }
  .stat .l { color: var(--dim); font-size: 10px; text-transform: uppercase; letter-spacing: .8px; margin-top: 2px }
  .stat.ok .n { color: var(--ok) } .stat.warn .n { color: var(--warn) } .stat.bad .n { color: var(--bad) }
  .spark { width: 100%; height: 56px; margin-top: 6px }
  .events { font-size: 12px; color: var(--dim); max-height: 160px; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--panel); margin-top: 10px }
  .events div { padding: 1px 0 }
  .events b { color: var(--text) }
  section { background: var(--panel); border: none; border-radius: var(--radius); padding: var(--pad); margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06) }
  @media (prefers-color-scheme: dark) { section { box-shadow: none } }
  section h2 { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px }
  table { width: 100%; border-collapse: collapse; font-size: 15px }
  td, th { padding: 10px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; font-variant-numeric: tabular-nums }
  th { color: var(--dim); font-size: 12px; text-transform: uppercase; letter-spacing: .6px }
  .tag { display: inline-block; min-width: 56px; text-align: center; padding: 1px 8px; border-radius: 6px; font-size: 11px; font-weight: 700 }
  .tag.ok { background: rgba(61,220,132,.15); color: var(--ok) }
  .tag.untested { background: rgba(133,147,173,.15); color: var(--dim) }
  .tag.quota { background: rgba(255,200,87,.15); color: var(--warn) }
  .tag.dead { background: rgba(255,93,93,.15); color: var(--bad) }
  .tag.user { background: rgba(77,159,255,.18); color: var(--accent) }
  button { cursor: pointer; background: #E5E5EA; color: #000; border: none; border-radius: 10px; padding: 0 14px; min-height: 44px; font: inherit; font-size: 15px; font-weight: 600; transition: opacity .12s }
  button:active { opacity: .6 }
  @media (prefers-color-scheme: dark) { button { background: #2C2C2E; color: #F5F5F7 } }
  button:hover { background: #232d44 }
  button.on { background: #1C7C3C; color: #fff }
  button.act { background: var(--accent); color: #fff }
  @media (prefers-color-scheme: dark) {
    button.on { background: #30D158; color: #000 }
    button.act { background: var(--accent); color: #fff }
  }
  input[type=checkbox].sw { appearance: none; width: 34px; height: 19px; border-radius: 999px; background: #2a3450; position: relative; cursor: pointer; display: inline-block; margin: 0 }
  input[type=checkbox].sw::after { content: ""; position: absolute; width: 15px; height: 15px; border-radius: 50%; background: var(--dim); top: 2px; left: 3px; transition: all .15s }
  input[type=checkbox].sw:checked { background: rgba(61,220,132,.3) }
  input[type=checkbox].sw:checked::after { left: 16px; background: var(--ok) }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end }
  label.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim); flex: 1 1 260px }
  input[type=text], textarea { background: #E5E5EA; border: none; color: var(--text); border-radius: 10px; padding: 10px 12px; font: inherit; width: 100% }
  @media (prefers-color-scheme: dark) { input[type=text], textarea { background: #2C2C2E } }
  textarea { min-height: 70px; resize: vertical }
  .hint { color: var(--dim); font-size: 11px; margin-top: 6px }
  .msg { margin-top: 8px; font-size: 12px; color: var(--dim); min-height: 16px }
  .msg.good { color: var(--ok) } .msg.bad { color: var(--bad) }
  .due { color: var(--warn) }
  .spin { animation: spin 1s linear infinite; display: inline-block }
  @keyframes spin { to { transform: rotate(360deg) } }
  label.master { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dim); letter-spacing: .8px; cursor: pointer; user-select: none }
  #masterBox { display: inline-block }
  #modeLine b.pool { color: var(--ok) } #modeLine b.direct { color: var(--warn) }
  body.direct #poolTable, body.direct #dustTable, body.direct #userTable { opacity: .4 }
</style>
</head>
<body>
<header>
  <h1>egress · opencode-free-provider</h1>
  <span class="pill" id="pill">…</span>
  <span class="pill" id="sweep"></span>
  <span style="flex:1"></span>
  <label class="master">ROUTE
    <span id="masterBox">
      <input type="checkbox" id="master" class="sw" onchange="setMode(this.checked)">
    </span>
  </label>
  <button onclick="refresh()">↻ refresh</button>
</header>
<main>
  <section style="margin-bottom:14px">
    <h2>Connection mode</h2>
    <div id="modeLine" style="font-size:13px">…</div>
    <div class="hint">OFF = every request goes out <b>directly</b> from this machine (your own IP) and the whole pool is ignored. ON = route through the best verified egress IP; your own proxies ("mine") are preferred.</div>
  </section>
  <div class="cards" id="cards"></div>

  <section>
    <h2>Live decisions</h2>
    <div class="stats-grid" id="statsGrid"></div>
    <svg class="spark" id="spark" viewBox="0 0 100 56" preserveAspectRatio="none"></svg>
    <div class="events" id="events"></div>
  </section>

  <section>
    <h2>My proxies (preferred in rotation, never auto-culled)</h2>
    <table id="userTable"><thead><tr><th></th><th>proxy</th><th>status</th><th>ttfb</th><th></th></tr></thead><tbody></tbody></table>
    <div class="hint">User-added proxies rotate before scraped ones and survive sweeper culling.</div>
  </section>

  <section>
    <h2>Add proxies</h2>
    <div class="row">
      <label class="f">Paste (one per line: ip:port or http://ip:port)
        <textarea id="addText" placeholder="203.0.113.7:3128&#10;http://198.51.100.2:8080&#10;10.1.2.3:443"></textarea>
      </label>
      <div style="display:flex;flex-direction:column;gap:6px;min-width:190px">
        <button class="act" onclick="doImport()">add + test</button>
        <input type="file" id="addFile" multiple accept=".txt,.list,.json,text/plain">
        <button onclick="doFile()">import file + test</button>
      </div>
    </div>
    <div class="msg" id="importMsg"></div>
  </section>

  <section>
    <h2>Pool</h2>
    <table id="poolTable"><thead><tr><th>on</th><th>proxy</th><th>status</th><th>ttfb</th><th>ok</th><th>src</th><th>actions</th></tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Dustbin</h2>
    <table id="dustTable"><thead><tr><th>proxy</th><th>reason</th><th>detail</th><th>retest due</th><th>actions</th></tr></thead><tbody></tbody></table>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const api = (path, opts) => fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });

async function refresh() {
  const j = await (await fetch('/__egress')).json();
  const e = j.egress;
  const state = await fetch('/__egress/full').then(r => r.ok ? r.json() : null);
  renderCards(e);
  renderMode(e);
  renderStats(state && state.stats ? state.stats : null);
  // full state comes from /__egress + the table payloads below
  const state = await fetch('/__egress/full').then(r => r.ok ? r.json() : null);
  const pools = state?.pool || e.top || [];
  renderUser(state?.user || []);
  renderPool(pools, state?.disabled || []);
  renderDust(state?.dustbin || [], e.dustbin);
  document.title = \`egress · ok \${e.ok} · user \${(state?.user||[]).length}\`;
}

function renderMode(e) {
  const on = e.egressOn !== false;
  const cb = $('#master');
  if (cb) cb.checked = on;
  document.body.classList.toggle('direct', !on);
  const ml = $('#modeLine');
  if (ml) ml.innerHTML = on
    ? 'Routing via egress pool → <b class="pool">PROXY</b> (best: ' + (e.best ? e.best : 'none verified yet') + ')'
    : '<b class="direct">DIRECT ONLY</b> — the egress pool is OFF; every request leaves this machine on its own IP.';
}

async function setMode(on) {
  await api('/__egress/set', { method: 'POST', body: JSON.stringify({ on }) });
  refresh();
}

function renderStats(st) {
  const el = $('#statsGrid');
  if (!el) return;
  if (!st) { el.innerHTML = '<div style="color:var(--dim);grid-column:1/-1">no stats yet — relay a request</div>'; return; }
  const tiles = [
    { n: st.requests ?? 0, l: 'requests' },
    { n: st.ok ?? 0, l: 'ok', c: 'ok' },
    { n: st.quota ?? 0, l: 'quota hits', c: (st.quota ?? 0) ? 'warn' : '' },
    { n: st.dead ?? 0, l: 'dead', c: (st.dead ?? 0) ? 'bad' : '' },
    { n: st.viaProxy ?? 0, l: 'via pool' },
    { n: st.directFallbacks ?? 0, l: 'direct' },
    { n: st.rotations ?? 0, l: 'rotations' },
    { n: st.recoveries ?? 0, l: 'recoveries', c: (st.recoveries ?? 0) ? 'ok' : '' },
  ];
  el.innerHTML = tiles.map(c => '<div class="stat ' + (c.c || '') + '"><div class="n">' + c.n + '</div><div class="l">' + c.l + '</div></div>').join('');
  const spark = $('#spark');
  if (spark && Array.isArray(st.series) && st.series.length >= 2) {
    const w = 100, h = 56, n2 = st.series.length;
    const max = Math.max(1, ...st.series.map(p => Math.max(p.ok || 0, p.quota || 0, p.dead || 0)));
    const xs = i => (i / (n2 - 1)) * w;
    const ys = v => h - 4 - (v / max) * (h - 10);
    const pts = key => st.series.map((p, i) => xs(i).toFixed(2) + ',' + ys(p[key] || 0).toFixed(2)).join(' ');
    spark.innerHTML =
      '<polyline points="' + pts('ok') + '" fill="none" stroke="var(--ok)" stroke-width="1.5" stroke-opacity=".9"/>'
      + '<polyline points="' + pts('quota') + '" fill="none" stroke="var(--warn)" stroke-width="1.5" stroke-opacity=".8"/>'
      + '<polyline points="' + pts('dead') + '" fill="none" stroke="var(--bad)" stroke-width="1.5" stroke-opacity=".8"/>';
  } else if (spark) {
    spark.innerHTML = '<text x="50" y="30" text-anchor="middle" font-size="4" fill="var(--dim)">needs ≥2 relay turns</text>';
  }
  const ev = $('#events');
  if (ev) {
    const es = (st.events || []).slice(-14).reverse();
    ev.innerHTML = es.map(e => '<div><b>' + new Date(e.at).toLocaleTimeString() + '</b> · ' + e.kind + ': ' + ((e.detail || '').slice(0, 140)) + '</div>').join('');
  }
}

function renderCards(e) {
  const cards = [
    { n: e.poolSize, l: 'pool', c: '' },
    { n: e.ok, l: 'verified ok', c: e.ok ? 'ok' : 'bad' },
    { n: e.untested, l: 'untested', c: 'warn' },
    { n: e.dustbinQuota, l: 'dustbin quota', c: 'warn' },
    { n: e.dustbinDead, l: 'dustbin dead', c: '' },
  ];
  $('#cards').innerHTML = cards.map(c => \`<div class="card \${c.c}"><div class="n">\${c.n}</div><div class="l">\${c.l}</div></div>\`).join('')
    + \`<div class="best">best egress: \${e.best ? '<b>' + e.best + '</b>' : '<span style="color:var(--bad)">none — direct connection in use</span>'}</div>\`;
  const p = $('#pill'); p.textContent = e.best ? 'ROUTES VIA PROXY' : 'DIRECT ONLY'; p.className = 'pill ' + (e.best ? 'ok' : '');
  const ls = e.lastSweep;
  $('#sweep').textContent = ls ? \`last sweep \${new Date(ls.at).toLocaleTimeString()}: ok \${ls.ok}/\${ls.tested}\` : 'no sweep yet';
}

function rowBtns(p, on, user) {
  let h = '<td><input type="checkbox" class="sw" ' + (on ? 'checked' : '') + ' onchange="toggle(\\'' + p + '\\', this.checked)"></td>';
  h += '<td>' + p + '</td><td data-status="' + p + '"><span class="tag untested">…</span></td>';
  h += '<td data-ttfb="' + p + '">—</td>';
  if (user) h += '<td><button onclick="retest(\\'' + p + '\\')">test</button> <button onclick="removeUser(\\'' + p + '\\')">✕</button></td>';
  else h += '<td><button onclick="retest(\\'' + p + '\\')">test</button></td>';
  return h;
}

function renderUser(user) {
  const tb = $('#userTable tbody');
  tb.innerHTML = user.length ? user.map(e => {
    const p = e.proxy;
    return '<tr>' + rowBtns(p, !e.disabled, true)
      .replace('<td>' + p + '</td>', '<td><span class="tag user">mine</span> ' + p + '</td>', 1) + '</tr>';
  }).join('') : '<tr><td colspan="5" style="color:var(--dim)">none yet — add yours below (paste or file); they rotate before scraped IPs</td></tr>';
  paintTags(user.map(e => e.proxy));
}

function renderPool(pool, disabled) {
  const tb = $('#poolTable tbody');
  const rows = (pool || []).slice().sort((a, b) => {
    const au = (a.source === 'user' ? 0 : 1), bu = (b.source === 'user' ? 0 : 1);
    if (au !== bu) return au - bu;
    return (a.ttfbMs || 9e9) - (b.ttfbMs || 9e9);
  }).slice(0, 400);
  tb.innerHTML = rows.length ? rows.map(e => '<tr>' + rowBtns(e.proxy, !disabled.includes(e.proxy), e.source === 'user')
    .replace('<td data-status="' + e.proxy + '"><span class="tag untested">…</span></td>', '<td data-status="' + e.proxy + '"><span class="tag ' + e.status + '">' + e.status + '</span></td>')
    .replace('<td data-ttfb="' + e.proxy + '">—</td>', '<td data-ttfb="' + e.proxy + '">' + (e.ttfbMs || '—') + '</td>')
    .replace('ok</td>', 'ok</td>') + '</tr>').join('')
    : '<tr><td colspan="7" style="color:var(--dim)">empty — waiting on sweeps</td></tr>';
  paintTags(rows.map(e => e.proxy));
}

function renderDust(dust, total) {
  const tb = $('#dustTable tbody');
  const rows = (dust || []).slice(0, 100);
  tb.innerHTML = rows.length ? rows.map(d => {
    const due = new Date(d.retestAt);
    const soon = due - Date.now() < 60000;
    return '<tr><td>' + d.proxy + '</td><td><span class="tag ' + d.reason + '">' + d.reason + '</span></td><td style="color:var(--dim)">' + (d.detail || '') + '</td>'
      + '<td class="' + (soon ? 'due' : '') + '">' + due.toLocaleString() + (soon ? ' ⏳' : '') + '</td>'
      + '<td><button class="act" onclick="retest(\\'' + d.proxy + '\\')">retest now</button></td></tr>';
  }).join('') : '<tr><td colspan="5" style="color:var(--dim)">dustbin empty</td></tr>';
  if (total > 100) tb.insertAdjacentHTML('beforeend', '<tr><td colspan="5" style="color:var(--dim)">… ' + total + ' total (showing 100)</td></tr>');
}

function paintTags(proxies) {
  (proxies || []).forEach(p => {
    const cell = document.querySelector('[data-status="' + CSS.escape(p) + '"]');
    if (!cell || cell.dataset.filled) return;
    cell.dataset.filled = '1'; // leave it as-is; refreshed on next full refresh
  });
}

async function toggle(p, on) {
  await api('/__egress/toggle', { method: 'POST', body: JSON.stringify({ proxy: p }) });
  refresh();
}

async function retest(p) {
  const btns = [...document.querySelectorAll('button')].filter(b => b.textContent === 'test' && b.parentElement.textContent.includes(p));
  btns.forEach(b => { b.textContent = '⟳'; b.classList.add('spin') });
  const r = await api('/__egress/retest', { method: 'POST', body: JSON.stringify({ proxy: p }) });
  const j = await r.json();
  if (!r.ok) { alert('retest failed: ' + JSON.stringify(j)); return; }
  refresh();
  const cell = document.querySelector('[data-status="' + CSS.escape(p) + '"]');
  if (cell) {
    cell.innerHTML = '<span class="tag ' + j.status + '">' + j.status + (j.retryAfterSec ? ' ' + Math.round(j.retryAfterSec / 60) + 'm' : '') + '</span>';
    cell.dataset.filled = '';
  }
  if (j.status === 'ok') flash('good', '✓ ' + p + ' verified ok');
  else flash(j.status === 'quota' ? 'warn' : 'bad', '✗ ' + p + ': ' + j.status + (j.detail ? ' (' + j.detail + ')' : ''));
}

async function removeUser(p) {
  await api('/__egress/remove-user', { method: 'POST', body: JSON.stringify({ proxy: p }) });
  refresh();
}

function flash(kind, text) {
  const m = $('#importMsg');
  m.textContent = text;
  m.className = 'msg ' + kind;
  clearTimeout(m._t); m._t = setTimeout(() => { m.textContent = ''; }, 6000);
}

async function doImport() {
  const text = $('#addText').value.trim();
  if (!text) return;
  $('#importMsg').textContent = 'adding + testing…'; $('#importMsg').className = 'msg';
  const r = await api('/__egress/import', { method: 'POST', body: text });
  const j = await r.json();
  const oks = (j.results || []).filter(x => x.status === 'ok');
  flash(oks.length ? 'good' : 'bad', 'added ' + j.added + ', ok ' + oks.length + (j.invalid?.length ? ', invalid ' + j.invalid.length : '') +
    (oks.length ? ' → ' + oks.map(x => x.proxy).join(', ') : ''));
  if (j.added) $('#addText').value = '';
  refresh();
}

async function doFile() {
  const files = [...$('#addFile').files];
  if (!files.length) return;
  let text = '';
  for (const f of files) text += (await f.text()) + '\\n';
  $('#importMsg').textContent = 'importing ' + files.length + ' file(s) + testing…'; $('#importMsg').className = 'msg';
  const r = await api('/__egress/import', { method: 'POST', body: text });
  const j = await r.json();
  const oks = (j.results || []).filter(x => x.status === 'ok');
  flash(oks.length ? 'good' : 'bad', files.map(f => f.name).join(', ') + ': added ' + j.added + ', ok ' + oks.length +
    (j.invalid?.length ? ', invalid ' + j.invalid.length : ''));
  $('#addFile').value = '';
  refresh();
}

setInterval(refresh, 15000);
refresh();
</script>
</body>
</html>
`;
}
