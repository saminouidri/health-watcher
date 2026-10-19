// Health page. Plain browser JS (no build step): polls the API and renders endpoint cards.
const POLL_MS = 10_000;
const LABEL = { up: 'Up', degraded: 'Degraded', down: 'Down', pending: 'Pending' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let endpoints = [];
const busy = new Set(); // ids with a manual check in flight

function ago(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleString();
}
const ms = (v) => (v == null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

function badge(status) {
  return `<span class="badge ${status}"><span class="dot"></span>${LABEL[status]}</span>`;
}

/** One thin bar per check: height = latency, colour = status (down = full height). */
function sparkline(history) {
  if (history.length === 0) return '<div class="spark-empty">No history yet</div>';
  const W = 300, H = 36, n = history.length, slot = W / Math.max(n, 30);
  const max = Math.max(1, ...history.filter((h) => h.status !== 'down').map((h) => h.latencyMs ?? 0));
  const bars = history.map((h, i) => {
    const x = W - (n - i) * slot;
    const bh = h.status === 'down' ? H : Math.max(3, ((h.latencyMs ?? 0) / max) * (H - 2));
    const tip = `${new Date(h.t).toLocaleTimeString()} · ${LABEL[h.status]} · ${ms(h.latencyMs)}`;
    return `<rect class="${h.status}" x="${(x + 0.5).toFixed(1)}" y="${(H - bh).toFixed(1)}" width="${Math.max(1, slot - 1.5).toFixed(1)}" height="${bh.toFixed(1)}" rx="1"/>` +
      `<rect class="hit" data-tip="${esc(tip)}" x="${x.toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H}"/>`;
  });
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Latency history">${bars.join('')}</svg>`;
}

function card(e) {
  const status = e.configError ? 'down' : e.latest?.status ?? 'pending';
  const checking = e.running || busy.has(e.id);
  const err = e.configError
    ? `<div class="error">${esc(e.configError)}</div>`
    : e.lastError
      ? `<div class="error">${esc(e.lastError.error)} <span class="when">· ${ago(e.lastError.at)}</span></div>`
      : '';
  return `<section class="card ${status}" data-id="${esc(e.id)}">
    <div class="top">
      <span class="name" title="${esc(e.name)}">${esc(e.name)}</span>
      ${badge(status)}
      <button data-check="${esc(e.id)}" ${checking || e.configError ? 'disabled' : ''}>${checking ? 'Checking…' : 'Check now'}</button>
    </div>
    <div class="target">${esc(e.target || e.type)}</div>
    <div class="stats">
      <span>Latency <b>${ms(e.latest?.latencyMs)}</b></span>
      <span>Checked <b>${e.latest ? ago(e.latest.checkedAt) : 'never'}</b></span>
      <span>Every <b>${e.intervalSeconds}s</b></span>
    </div>
    ${sparkline(e.history)}
    ${err}
  </section>`;
}

function render() {
  $('grid').innerHTML = endpoints.map(card).join('');
  const counts = { up: 0, degraded: 0, down: 0 };
  for (const e of endpoints) {
    const s = e.configError ? 'down' : e.latest?.status;
    if (s) counts[s]++;
  }
  $('summary').textContent = `${counts.up} up · ${counts.degraded} degraded · ${counts.down} down`;
  document.title = counts.down ? `(${counts.down} down) Health` : 'Health';
}

async function api(path, method = 'GET') {
  const res = await fetch(path, { method });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    endpoints = await api('/api/endpoints');
    $('banner').innerHTML = '';
  } catch (e) {
    $('banner').innerHTML = `<div class="banner">Can't reach the health monitor: ${esc(e.message)}</div>`;
  }
  render();
}

$('grid').addEventListener('click', async (ev) => {
  const id = ev.target.closest('[data-check]')?.dataset.check;
  if (!id) return;
  busy.add(id);
  render();
  try {
    const updated = await api(`/api/endpoints/${encodeURIComponent(id)}/check`, 'POST');
    endpoints = endpoints.map((e) => (e.id === id ? updated : e));
  } catch (e) {
    $('banner').innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  } finally {
    busy.delete(id);
    render();
  }
});

$('check-all').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Checking…';
  endpoints.forEach((e) => busy.add(e.id));
  render();
  try {
    endpoints = await api('/api/check-all', 'POST');
  } catch (e) {
    $('banner').innerHTML = `<div class="banner">${esc(e.message)}</div>`;
  } finally {
    busy.clear();
    btn.disabled = false;
    btn.textContent = 'Check all';
    render();
  }
});

// Sparkline tooltips (delegated, so they survive re-renders).
const tip = $('tooltip');
document.addEventListener('pointermove', (ev) => {
  const t = ev.target.closest?.('[data-tip]');
  if (!t) return void (tip.style.display = 'none');
  tip.textContent = t.dataset.tip;
  tip.style.display = 'block';
  const x = Math.min(ev.clientX + 12, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${ev.clientY + 14}px`;
});

api('/api/meta').then((m) => {
  if (m.workspaceUrl) Object.assign($('workspace-link'), { href: m.workspaceUrl, hidden: false });
}).catch(() => {});

refresh();
setInterval(refresh, POLL_MS);
setInterval(render, 5_000); // keep "x ago" fresh between polls
