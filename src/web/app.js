/* DassTracker frontend — vanilla JS, no build step. */

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function relative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

async function api(path, opts = {}) {
  // Only set the JSON content-type when there's actually a body — Fastify
  // rejects an empty body when content-type is application/json (used by the
  // bodyless POSTs like /api/scan and /api/test-email).
  const headers = opts.body ? { 'Content-Type': 'application/json' } : {};
  const res = await fetch(path, { ...opts, headers: { ...headers, ...opts.headers } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function loadJobs() {
  const onlyMatched = $('onlyMatched').checked;
  const box = $('jobs');
  try {
    const { jobs } = await api(`/api/jobs?matched=${onlyMatched ? 1 : 0}&limit=200`);
    if (!jobs.length) {
      box.innerHTML = '<div class="empty">// no jobs yet — waiting for first scan</div>';
      return;
    }
    box.innerHTML = jobs.map(renderJob).join('');
  } catch (err) {
    box.innerHTML = `<div class="empty">// error: ${esc(err.message)}</div>`;
  }
}

function renderJob(j) {
  const notified = j.notifiedAt
    ? '<span class="badge">NOTIFIED</span>'
    : '';
  return `
    <div class="job ${j.matched ? 'matched' : ''}">
      <div class="job-title"><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></div>
      <div class="job-meta">
        <span>${esc(j.location || 'n/a')}</span>
        <span class="cat">${esc(j.category || 'n/a')}</span>
        ${j.products ? `<span>${esc(j.products)}</span>` : ''}
        <span>posted ${esc(fmt(j.postedAt))}</span>
        <span>seen ${esc(relative(j.firstSeenAt))}</span>
      </div>
      <div class="job-foot">
        ${j.applyUrl ? `<a href="${esc(j.applyUrl)}" target="_blank" rel="noopener">Apply →</a>` : ''}
        ${notified}
      </div>
    </div>`;
}

async function loadStatus() {
  const bar = $('statusBar');
  try {
    const s = await api('/api/status');
    const last = s.lastScan;
    const lastTxt = last
      ? `last scan ${relative(last.startedAt)} · ${last.error ? `<span class="err">ERROR</span>` : `<b>${last.newCount}</b> new, <b>${last.matchedCount}</b> matched`}`
      : 'no scans yet';
    const nextTxt = s.nextScanAt ? ` · next ~${fmt(s.nextScanAt)}` : '';
    const mail = s.emailConfigured
      ? '<span class="ok">email ✓</span>'
      : '<span class="err">email off</span>';
    bar.innerHTML = `${lastTxt}${nextTxt} · <b>${s.totalJobs}</b> tracked · every ${s.intervalMinutes}m · ${mail}`;
    $('emailState').innerHTML = s.emailConfigured
      ? '● SMTP configured'
      : '○ email not configured — set GMAIL_USER / GMAIL_APP_PASSWORD in .env';
  } catch (err) {
    bar.innerHTML = `<span class="err">status error: ${esc(err.message)}</span>`;
  }
}

async function loadConfig() {
  const { config } = await api('/api/config');
  $('intervalMinutes').value = config.intervalMinutes;
  $('country').value = config.country;
  $('type').value = config.type;
  $('notifyTo').value = config.notifyTo || '';
  $('keywords').value = (config.keywords || []).join('\n');
  $('categoryWhitelist').value = (config.categoryWhitelist || []).join('\n');
}

function linesToArray(text) {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function saveConfig() {
  const msg = $('cfgMsg');
  msg.className = 'cfg-msg';
  msg.textContent = 'saving…';
  try {
    const patch = {
      intervalMinutes: Number($('intervalMinutes').value),
      country: $('country').value.trim(),
      type: $('type').value.trim(),
      notifyTo: $('notifyTo').value.trim() || null,
      keywords: linesToArray($('keywords').value),
      categoryWhitelist: linesToArray($('categoryWhitelist').value),
    };
    const { rescheduled } = await api('/api/config', {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    msg.className = 'cfg-msg ok';
    msg.textContent = rescheduled ? 'saved · scan interval rescheduled' : 'saved';
    loadStatus();
  } catch (err) {
    msg.className = 'cfg-msg err';
    msg.textContent = `error: ${err.message}`;
  }
}

async function scanNow() {
  const btn = $('scanNow');
  btn.disabled = true;
  btn.textContent = 'SCANNING…';
  try {
    await api('/api/scan', { method: 'POST' });
    await Promise.all([loadJobs(), loadStatus()]);
  } catch (err) {
    $('statusBar').innerHTML = `<span class="err">scan error: ${esc(err.message)}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'SCAN NOW';
  }
}

async function testEmail() {
  const msg = $('cfgMsg');
  const btn = $('testEmail');
  btn.disabled = true;
  msg.className = 'cfg-msg';
  msg.textContent = 'sending test email…';
  try {
    await api('/api/test-email', { method: 'POST' });
    msg.className = 'cfg-msg ok';
    msg.textContent = 'test email sent — check your inbox';
  } catch (err) {
    msg.className = 'cfg-msg err';
    msg.textContent = `error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

$('scanNow').addEventListener('click', scanNow);
$('saveConfig').addEventListener('click', saveConfig);
$('testEmail').addEventListener('click', testEmail);
$('onlyMatched').addEventListener('change', loadJobs);

function refresh() {
  loadJobs();
  loadStatus();
}

loadConfig().then(refresh);
setInterval(refresh, 30000); // auto-refresh every 30s
