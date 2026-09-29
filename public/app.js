'use strict';

// ---- helpers ----------------------------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : n ?? '—');
const when = (s) => (s ? new Date(s.replace(' ', 'T') + (s.includes('Z') ? '' : 'Z')).toLocaleString() : '—');
const md = (text) => `<div class="md">${window.renderMarkdown(text)}</div>`;

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || data || res.statusText);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
}

async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try { return await fn(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.textContent = label; }
}

function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') {
      if (el.dataset.multi) (out[el.name] ||= []).push(...(el.checked ? [el.value] : []));
      else out[el.name] = el.checked;
    } else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}

// Opens the shared <dialog>. `onSubmit` returns false to keep it open.
function openDialog(html, onSubmit, onMount) {
  const dialog = $('#dialog');
  const form = $('#dialog-form');
  form.innerHTML = html;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('button[type=submit]', form);
    const keep = await busy(btn, () => onSubmit(formData(form), form));
    if (keep !== false) dialog.close();
  };
  $$('[data-close]', form).forEach((b) => { b.onclick = () => dialog.close(); });
  dialog.showModal();
  if (onMount) onMount(form);
}

const badge = (text, cls = text) => `<span class="badge ${esc(cls)}">${esc(text)}</span>`;
const stat = (label, value) => `<div class="stat"><div class="v">${value}</div><div class="l">${esc(label)}</div></div>`;
const plusMinus = (a, d) => `<span class="add">+${fmt(a)}</span> <span class="del">−${fmt(d)}</span>`;

// ---- status & router --------------------------------------------------------------------------------
let status = {};
async function refreshStatus() {
  try {
    status = await api('GET', '/api/status');
    $('#side-status').innerHTML = `
      <div><span class="dot ${status.emailConfigured ? 'ok' : 'bad'}"></span>Email ${status.emailConfigured ? 'ready' : 'not set up'}</div>
      <div><span class="dot ${status.aiConfigured ? 'ok' : 'bad'}"></span>AI ${status.aiConfigured ? 'ready' : 'not set up'}</div>
      <div><span class="dot ${status.running ? 'busy' : ''}"></span>${status.running ? `${status.running} scan(s) running` : 'Idle'}</div>`;
  } catch (_) { /* offline */ }
}

const routes = {
  '': dashboard, assistant, scans, repos, schedules, settings,
};
let pollTimer;
async function router() {
  clearInterval(pollTimer);
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  $$('.side a').forEach((a) => a.classList.toggle('active', a.dataset.route === (name || 'dashboard')));
  await refreshStatus();
  try {
    await (routes[name] || dashboard)(arg);
  } catch (err) {
    view.innerHTML = `<div class="card empty"><h2>Something went wrong</h2><p>${esc(err.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', router);
setInterval(refreshStatus, 10000);

// ---- dashboard --------------------------------------------------------------------------------------
async function dashboard() {
  const list = await api('GET', '/api/scans?limit=50');
  const done = list.filter((s) => s.status === 'done');
  if (!status.repos) {
    view.innerHTML = `<div class="card empty"><h2>Welcome to Git Insights</h2>
      <p>Add the git repositories you want to track, then run a scan or set up a schedule that emails a report.</p>
      <div class="row" style="justify-content:center"><a class="btn primary" href="#/repos">Add a repository</a><a class="btn" href="#/settings">Set up email &amp; AI</a></div></div>`;
    return;
  }
  if (!done.length) {
    const running = list.find((s) => s.status === 'queued' || s.status === 'running');
    view.innerHTML = `<div class="card empty"><h2>No reports yet</h2>
      <p>${running ? 'A scan is running now. This page refreshes when it finishes.' : 'Run the first scan to see contributions, branches and code health.'}</p>
      ${running ? `<a class="btn" href="#/scans/${running.id}">Watch progress</a>` : '<button class="btn primary" id="run">Run scan now</button>'}</div>`;
    $('#run')?.addEventListener('click', () => runScanDialog());
    if (running) pollTimer = setInterval(async () => { const s = await api('GET', `/api/scans/${running.id}`); if (s.status !== 'running' && s.status !== 'queued') router(); }, 3000);
    return;
  }

  const selected = Number(sessionStorage.getItem('dashScan')) || done[0].id;
  const scan = done.find((s) => s.id === selected) || done[0];
  const report = await api('GET', `/api/scans/${scan.id}/report`);
  const s = report.summary;
  const devs = report.developers.filter((d) => !d.isBot);
  const maxChurn = Math.max(1, ...devs.map((d) => d.churn));
  const tl = report.timeline.slice(-24);
  const maxTl = Math.max(1, ...tl.map((m) => m.commits));
  const open = report.branches.filter((b) => b.status === 'unmerged' || b.status === 'unpushed');
  const lvl = { warn: 'warn', good: 'good', info: 'info' };

  view.innerHTML = `
    <div class="page-head">
      <div><h1>${esc(report.meta.title)}</h1>
        <div class="sub">Scan #${scan.id} · ${when(scan.finished_at)} · history ${esc(s.firstCommit)} → ${esc(s.lastCommit)}${scan.params.since ? ` · since ${esc(scan.params.since)}` : ''}</div></div>
      <div class="row">
        <select id="pick" aria-label="Choose scan">${done.map((d) => `<option value="${d.id}" ${d.id === scan.id ? 'selected' : ''}>#${d.id} · ${esc(d.summary?.meta?.title || '')} · ${when(d.finished_at)}</option>`).join('')}</select>
        <a class="btn" href="/api/scans/${scan.id}/html" target="_blank">Full report</a>
        <button class="btn primary" id="run">Run scan</button>
      </div>
    </div>
    <div class="grid stats">
      ${stat('commits', fmt(s.commits))}${stat('developers', fmt(s.developers))}${stat('lines changed', plusMinus(s.additions, s.deletions))}
      ${stat('active last 30 days', fmt(s.activeLast30Days))}${stat('unmerged commits', fmt(s.unmergedCommits))}${stat('stale branches', fmt(s.staleBranches))}${stat('bus factor', fmt(s.busFactor))}
    </div>
    <div class="grid two">
      <div class="card">
        <div class="row"><h2 class="grow">AI summary</h2>${status.aiConfigured ? `<button class="btn small" id="gen">${scan.ai_summary ? 'Regenerate' : 'Generate'}</button><a class="btn small" href="#/assistant">Ask a question</a>` : ''}</div>
        <div id="ai">${scan.ai_summary ? md(scan.ai_summary) : `<p class="muted">${status.aiConfigured ? 'No summary for this scan yet.' : 'Add an Anthropic API key in <a href="#/settings">Settings</a> to get AI summaries and the assistant.'}</p>`}</div>
      </div>
      <div class="card"><h2>Insights</h2>
        <ul class="insights">${report.insights.map((i) => `<li>${badge(i.level, lvl[i.level])}<span>${esc(i.text)}</span></li>`).join('')}</ul>
      </div>
    </div>
    <div class="card"><h2>Commits per month</h2>
      <div class="bars">${tl.map((m) => `<div class="b" style="height:${(m.commits / maxTl) * 100}%" title="${esc(m.month)}: ${m.commits} commits, ${m.developers} developers"></div>`).join('')}</div>
      <div class="bar-axis"><span>${esc(tl[0]?.month || '')}</span><span>${esc(tl[tl.length - 1]?.month || '')}</span></div>
    </div>
    <div class="card"><h2>Developers</h2><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Developer</th><th class="num">Commits</th><th class="num">Lines</th><th>Share</th><th class="num">Unmerged</th><th class="num">Active days</th><th class="num">Last commit</th></tr></thead>
      <tbody>${devs.slice(0, 25).map((d) => `<tr><td class="muted">${d.rank}</td><td>${esc(d.name)}<div class="small muted">${esc(d.email)}</div></td>
        <td class="num">${fmt(d.commits)}</td><td class="num">${plusMinus(d.additions, d.deletions)}</td>
        <td><div class="share" title="${d.shareOfChurn}% of changed lines"><span style="width:${(d.churn / maxChurn) * 100}%"></span></div></td>
        <td class="num">${d.unmerged.commits ? fmt(d.unmerged.commits) : '<span class="muted">0</span>'}</td><td class="num">${fmt(d.activeDays)}</td><td class="num">${esc(d.lastCommit)}</td></tr>`).join('')}</tbody>
    </table></div>${devs.length > 25 ? `<p class="small muted">${devs.length - 25} more in the full report.</p>` : ''}</div>
    <div class="grid two">
      <div class="card"><h2>Repositories</h2><div class="table-wrap"><table>
        <thead><tr><th>Repo</th><th class="num">Commits</th><th class="num">Devs</th><th class="num">Unmerged br.</th><th class="num">Bus factor</th></tr></thead>
        <tbody>${report.repositories.map((r) => `<tr><td>${esc(r.name)}<div class="small muted">${esc(r.mainBranch || '')}</div></td><td class="num">${fmt(r.commits)}</td><td class="num">${fmt(r.developers)}</td><td class="num">${fmt(r.unmergedBranches)}</td><td class="num">${fmt(r.busFactor)}</td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="card"><h2>Work not merged yet</h2>${open.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Branch</th><th class="num">Ahead</th><th class="num">Idle</th><th>Who</th></tr></thead>
        <tbody>${open.slice(0, 12).map((b) => `<tr><td>${esc(b.name)} ${b.stale ? badge('stale', 'warn') : ''}${b.status === 'unpushed' ? badge('unpushed', 'bad') : ''}<div class="small muted">${esc(b.repo)}</div></td><td class="num">${fmt(b.aheadCommits)}</td><td class="num">${b.daysIdle ?? '—'}d</td><td class="small">${esc(b.developers.slice(0, 3).map((d) => d.name).join(', '))}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Everything is merged.</p>'}</div>
    </div>
    <div class="grid two">
      <div class="card"><h2>Hotspot files</h2><div class="table-wrap"><table>
        <thead><tr><th>File</th><th class="num">Commits</th><th class="num">Lines</th><th class="num">Devs</th></tr></thead>
        <tbody>${report.hotspots.slice(0, 10).map((f) => `<tr><td><code>${esc(f.path)}</code><div class="small muted">${esc(f.repo)}</div></td><td class="num">${fmt(f.commits)}</td><td class="num">${fmt(f.churn)}</td><td class="num">${fmt(f.authors)}</td></tr>`).join('')}</tbody>
      </table></div></div>
      <div class="card"><h2>Knowledge silos</h2>${report.silos.length ? `<div class="table-wrap"><table>
        <thead><tr><th>File</th><th>Owner</th><th class="num">Share</th></tr></thead>
        <tbody>${report.silos.slice(0, 10).map((f) => `<tr><td><code>${esc(f.path)}</code></td><td>${esc(f.topAuthor)}</td><td class="num">${f.topAuthorShare}%</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No single-owner hotspots.</p>'}</div>
    </div>`;

  $('#pick').onchange = (e) => { sessionStorage.setItem('dashScan', e.target.value); router(); };
  $('#run').onclick = () => runScanDialog();
  $('#gen')?.addEventListener('click', (e) => busy(e.target, async () => {
    $('#ai').innerHTML = '<p class="muted typing">The agent is reading the report</p>';
    const r = await api('POST', `/api/scans/${scan.id}/summary`);
    $('#ai').innerHTML = md(r.ai_summary);
  }));
}

async function runScanDialog() {
  const repoList = await api('GET', '/api/repos');
  openDialog(`
    <h2>Run a scan</h2>
    <div class="stack" style="display:grid;gap:14px">
      <div><div class="small muted" style="margin-bottom:6px">Repositories (none selected = all enabled)</div>
        <div class="checks">${repoList.map((r) => `<label class="check"><input type="checkbox" name="repo_ids" data-multi="1" value="${r.id}">${esc(r.name)}</label>`).join('')}</div></div>
      <div class="fields">
        <label class="f">Since <input type="text" name="since" placeholder="e.g. 30 days ago, 2025-01-01"><span class="hint">Empty = full history</span></label>
        <label class="f">Email to <input type="text" name="recipients" placeholder="Default recipients"></label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="noBots" checked>Ignore bots</label>
        <label class="check"><input type="checkbox" name="aiSummary" ${status.aiConfigured ? 'checked' : 'disabled'}>AI summary</label>
        <label class="check"><input type="checkbox" name="sendEmail" ${status.emailConfigured ? '' : 'disabled'}>Email the report</label>
        <label class="check"><input type="checkbox" name="blame">Code ownership (git blame, slower)</label>
      </div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Start scan</button></div>
    </div>`, async (data) => {
    const { scanId } = await api('POST', '/api/scans', data);
    location.hash = `#/scans/${scanId}`;
  });
}

// ---- scans ------------------------------------------------------------------------------------------
async function scans(scanId) {
  if (scanId) return scanDetail(Number(scanId));
  const [list, scheds] = await Promise.all([api('GET', '/api/scans?limit=200'), api('GET', '/api/schedules')]);
  const schedName = Object.fromEntries(scheds.map((s) => [s.id, s.name]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Scans</h1><div class="sub">Every manual, scheduled and agent-started scan.</div></div><button class="btn primary" id="run">Run scan</button></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Status</th><th>Trigger</th><th>Started</th><th>Filters</th><th class="num">Commits</th><th class="num">Devs</th><th>Email</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td><a href="#/scans/${s.id}">#${s.id}</a></td><td>${badge(s.status)}</td>
        <td>${esc(s.trigger)}${s.schedule_id ? `<div class="small muted">${esc(schedName[s.schedule_id] || 'deleted schedule')}</div>` : ''}</td>
        <td class="small">${when(s.started_at || s.created_at)}</td>
        <td class="small muted">${esc(s.params.since ? `since ${s.params.since}` : 'full history')}</td>
        <td class="num">${fmt(s.summary?.summary.commits)}</td><td class="num">${fmt(s.summary?.summary.developers)}</td>
        <td class="small muted">${esc(s.email_status || '')}</td>
        <td class="num">${s.status === 'done' ? `<a class="btn small" href="/api/scans/${s.id}/html" target="_blank">Report</a>` : ''}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty">No scans yet.</div>'}</div>`;
  $('#run').onclick = () => runScanDialog();
  if (list.some((s) => s.status === 'queued' || s.status === 'running')) pollTimer = setInterval(() => scans(), 4000);
}

async function scanDetail(id) {
  const s = await api('GET', `/api/scans/${id}`);
  const active = s.status === 'queued' || s.status === 'running';
  const sum = s.summary?.summary;
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Scan #${s.id} ${badge(s.status)}</h1><div class="sub">${esc(s.trigger)} · queued ${when(s.created_at)}${s.finished_at ? ` · finished ${when(s.finished_at)}` : ''}</div></div>
      <div class="row">
        ${s.status === 'done' ? `<a class="btn" href="/api/scans/${s.id}/html" target="_blank">Full report</a>
          <button class="btn" id="dash">Open in dashboard</button>
          <button class="btn" id="email" ${status.emailConfigured ? '' : 'disabled title="Set up email in Settings"'}>Email report</button>
          ${status.aiConfigured ? `<button class="btn" id="gen">${s.ai_summary ? 'Regenerate' : 'Generate'} AI summary</button>` : ''}` : ''}
        ${active ? '' : '<button class="btn danger" id="del">Delete</button>'}
      </div>
    </div>
    ${s.error ? `<div class="card"><strong class="del">Error:</strong> ${esc(s.error)}</div>` : ''}
    ${sum ? `<div class="grid stats">${stat('commits', fmt(sum.commits))}${stat('developers', fmt(sum.developers))}${stat('lines changed', plusMinus(sum.additions, sum.deletions))}${stat('unmerged commits', fmt(sum.unmergedCommits))}${stat('bus factor', fmt(sum.busFactor))}</div>` : ''}
    ${s.ai_summary ? `<div class="card"><h2>AI summary</h2>${md(s.ai_summary)}</div>` : ''}
    <div class="card"><h2>Details</h2>
      <table><tbody>
        <tr><td class="muted">Filters</td><td><code>${esc(JSON.stringify(s.params))}</code></td></tr>
        <tr><td class="muted">Repositories</td><td>${s.repo_ids.length ? esc(s.repo_ids.join(', ')) : 'all enabled'}</td></tr>
        <tr><td class="muted">Email</td><td>${esc(s.email_status || '—')}</td></tr>
      </tbody></table>
    </div>
    <div class="card"><h2>Log ${active ? '<span class="muted typing">running</span>' : ''}</h2><pre><code>${esc(s.log || '(empty)')}</code></pre></div>`;

  $('#dash')?.addEventListener('click', () => { sessionStorage.setItem('dashScan', s.id); location.hash = '#/'; });
  $('#gen')?.addEventListener('click', (e) => busy(e.target, async () => { await api('POST', `/api/scans/${id}/summary`); scanDetail(id); }));
  $('#del')?.addEventListener('click', async () => {
    if (!confirm(`Delete scan #${id}?`)) return;
    await api('DELETE', `/api/scans/${id}`);
    location.hash = '#/scans';
  });
  $('#email')?.addEventListener('click', () => openDialog(`
    <h2>Email this report</h2>
    <label class="f">Recipients <input type="text" name="recipients" placeholder="Empty = default recipients"></label>
    <div class="dialog-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Send</button></div>`,
  async (data) => { const r = await api('POST', `/api/scans/${id}/email`, data); toast(`Sent to ${r.sentTo.join(', ')}`); scanDetail(id); }));
  if (active) pollTimer = setInterval(async () => { clearInterval(pollTimer); await refreshStatus(); scanDetail(id); }, 2000);
}

// ---- repositories -----------------------------------------------------------------------------------
async function repos() {
  const list = await api('GET', '/api/repos');
  view.innerHTML = `
    <div class="page-head"><div><h1>Repositories</h1><div class="sub">Remote repos are cloned into the data volume and fetched before each scan.</div></div><button class="btn primary" id="add">Add repository</button></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Source</th><th>Main branch</th><th>Last synced</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((r) => `<tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td class="small">${r.source === 'remote' ? `${esc(r.url)}${r.hasToken ? ' ' + badge('token', 'info') : ''}` : `<code>${esc(r.local_path)}</code> ${badge('local')}`}</td>
        <td class="small">${esc(r.main_branch || 'auto')}</td>
        <td class="small">${when(r.last_synced_at)}</td>
        <td>${r.enabled ? badge('enabled', 'on') : badge('disabled')}${r.last_error ? `<div class="small del" title="${esc(r.last_error)}">${esc(r.last_error.slice(0, 80))}</div>` : ''}</td>
        <td class="num"><button class="btn small" data-edit="${r.id}">Edit</button> <button class="btn small danger" data-del="${r.id}">Delete</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty"><h2>No repositories yet</h2><p>Add a GitHub, GitLab or Bitbucket https URL, or a path to a repository on this machine.</p></div>'}</div>`;
  $('#add').onclick = () => repoDialog();
  $$('[data-edit]').forEach((b) => { b.onclick = () => repoDialog(list.find((r) => r.id === Number(b.dataset.edit))); });
  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const r = list.find((x) => x.id === Number(b.dataset.del));
      if (!confirm(`Remove ${r.name}? Its local clone is deleted too; past scans are kept.`)) return;
      await api('DELETE', `/api/repos/${r.id}`);
      repos();
    };
  });
}

function repoDialog(r = { source: 'remote', enabled: 1 }) {
  openDialog(`
    <h2>${r.id ? 'Edit' : 'Add'} repository</h2>
    <div style="display:grid;gap:14px">
      <div class="seg" id="src"><button type="button" data-v="remote">Remote URL</button><button type="button" data-v="local">Local path</button></div>
      <input type="hidden" name="source" value="${esc(r.source)}">
      <label class="f" data-for="remote">Clone URL <input type="url" name="url" value="${esc(r.url || '')}" placeholder="https://github.com/acme/api.git">
        <span class="hint">HTTPS only. Every branch is fetched, so unmerged work is counted.</span></label>
      <label class="f" data-for="remote">Access token <input type="password" name="token" autocomplete="new-password" placeholder="${r.hasToken ? 'Stored. Leave empty to keep it.' : 'Only for private repositories'}">
        <span class="hint">GitHub/GitLab personal access token with read access, or <code>username:app-password</code> for Bitbucket. Stored encrypted.</span></label>
      ${r.hasToken ? '<label class="check" data-for="remote"><input type="checkbox" name="clearToken">Remove stored token</label>' : ''}
      <label class="f" data-for="local">Path <input type="text" name="local_path" value="${esc(r.local_path || '')}" placeholder="/repos/my-project">
        <span class="hint">In Docker, mount your folder (e.g. <code>./repos:/repos:ro</code>) and use the container path.</span></label>
      <div class="fields">
        <label class="f">Display name <input type="text" name="name" value="${esc(r.name || '')}" placeholder="From the URL"></label>
        <label class="f">Main branch <input type="text" name="main_branch" value="${esc(r.main_branch || '')}" placeholder="auto-detect"></label>
      </div>
      <label class="check"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}>Include in scans</label>
      <div class="row"><button type="button" class="btn small" id="test">Test connection</button><span class="test-result" id="test-out"></span></div>
      <div class="dialog-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>`,
  async (data) => {
    await api(r.id ? 'PUT' : 'POST', r.id ? `/api/repos/${r.id}` : '/api/repos', data);
    toast('Repository saved');
    repos();
  },
  (form) => {
    const setSource = (v) => {
      form.elements.source.value = v;
      $$('#src button', form).forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      $$('[data-for]', form).forEach((el) => { el.hidden = el.dataset.for !== v; });
    };
    $$('#src button', form).forEach((b) => { b.onclick = () => setSource(b.dataset.v); });
    setSource(r.source);
    $('#test', form).onclick = (e) => busy(e.target, async () => {
      const out = $('#test-out', form);
      out.textContent = '';
      try {
        const res = await api('POST', '/api/repos/test', { ...formData(form), id: r.id });
        out.innerHTML = `<span class="add">✓ ${esc(res.message)}</span>`;
      } catch (err) { out.innerHTML = `<span class="del">✗ ${esc(err.message)}</span>`; }
    });
  });
}

// ---- schedules --------------------------------------------------------------------------------------
const CRON_PRESETS = [
  ['0 9 * * *', 'Every day at 09:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 9 * * 1', 'Every Monday at 09:00'],
  ['0 17 * * 5', 'Every Friday at 17:00'],
  ['0 9 1 * *', '1st of every month at 09:00'],
  ['0 */6 * * *', 'Every 6 hours'],
];
const describeCron = (c) => CRON_PRESETS.find(([v]) => v === c)?.[1] || c;

async function schedules() {
  const [list, repoList] = await Promise.all([api('GET', '/api/schedules'), api('GET', '/api/repos')]);
  const repoName = Object.fromEntries(repoList.map((r) => [r.id, r.name]));
  view.innerHTML = `
    <div class="page-head"><div><h1>Schedules</h1><div class="sub">Periodic scans that write an AI summary and email the report.</div></div><button class="btn primary" id="add">New schedule</button></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>When</th><th>Repositories</th><th>Window</th><th>Delivery</th><th>Last run</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td><strong>${esc(s.name)}</strong> ${s.enabled ? '' : badge('paused')}</td>
        <td class="small">${esc(describeCron(s.cron))}<div class="muted"><code>${esc(s.cron)}</code>${s.timezone ? ` ${esc(s.timezone)}` : ''}</div></td>
        <td class="small">${s.repo_ids.length ? esc(s.repo_ids.map((i) => repoName[i] || `#${i}`).join(', ')) : 'All enabled'}</td>
        <td class="small">${esc(s.since || 'full history')}</td>
        <td class="small">${s.send_email ? `Email ${esc(s.recipients || '(default recipients)')}` : 'No email'}${s.ai_summary ? '<div class="muted">+ AI summary</div>' : ''}</td>
        <td class="small">${when(s.last_run_at)}</td>
        <td class="num"><button class="btn small" data-run="${s.id}">Run now</button> <button class="btn small" data-edit="${s.id}">Edit</button> <button class="btn small danger" data-del="${s.id}">Delete</button></td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="empty"><h2>No schedules</h2><p>Example: every Monday at 09:00, scan the last 7 days and email the team a summary.</p></div>'}</div>`;
  $('#add').onclick = () => scheduleDialog(undefined, repoList);
  $$('[data-edit]').forEach((b) => { b.onclick = () => scheduleDialog(list.find((s) => s.id === Number(b.dataset.edit)), repoList); });
  $$('[data-run]').forEach((b) => {
    b.onclick = () => busy(b, async () => { const { scanId } = await api('POST', `/api/schedules/${b.dataset.run}/run`); location.hash = `#/scans/${scanId}`; });
  });
  $$('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this schedule? Its past scans are kept.')) return;
      await api('DELETE', `/api/schedules/${b.dataset.del}`);
      schedules();
    };
  });
}

function scheduleDialog(s, repoList) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  s = s || { name: 'Weekly team report', cron: '0 9 * * 1', timezone: tz, repo_ids: [], since: '7 days ago', options: { noBots: true }, send_email: 1, ai_summary: status.aiConfigured ? 1 : 0, enabled: 1 };
  const preset = CRON_PRESETS.some(([v]) => v === s.cron) ? s.cron : 'custom';
  openDialog(`
    <h2>${s.id ? 'Edit' : 'New'} schedule</h2>
    <div style="display:grid;gap:14px">
      <label class="f">Name <input type="text" name="name" value="${esc(s.name)}" required></label>
      <div class="fields">
        <label class="f">Frequency <select id="preset">${CRON_PRESETS.map(([v, l]) => `<option value="${v}" ${v === preset ? 'selected' : ''}>${l}</option>`).join('')}<option value="custom" ${preset === 'custom' ? 'selected' : ''}>Custom cron…</option></select></label>
        <label class="f">Cron expression <input type="text" name="cron" value="${esc(s.cron)}" required><span class="hint">minute hour day month weekday</span></label>
      </div>
      <div class="fields">
        <label class="f">Time zone <input type="text" name="timezone" value="${esc(s.timezone || '')}" placeholder="${esc(tz)}"></label>
        <label class="f">Look-back window <input type="text" name="since" value="${esc(s.since || '')}" placeholder="7 days ago"><span class="hint">Empty = full history</span></label>
      </div>
      <div><div class="small muted" style="margin-bottom:6px">Repositories (none selected = all enabled)</div>
        <div class="checks">${repoList.map((r) => `<label class="check"><input type="checkbox" name="repo_ids" data-multi="1" value="${r.id}" ${s.repo_ids.includes(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('') || '<span class="muted small">No repositories yet.</span>'}</div></div>
      <div class="fields">
        <label class="f">Only email domains <input type="text" name="domains" value="${esc((s.options.domains || []).join(', '))}" placeholder="acme.com"></label>
        <label class="f">Exclude files <input type="text" name="excludes" value="${esc((s.options.excludes || []).join(', '))}" placeholder="docs/**, *.sql"></label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="noBots" ${s.options.noBots ? 'checked' : ''}>Ignore bots</label>
        <label class="check"><input type="checkbox" name="mainOnly" ${s.options.mainOnly ? 'checked' : ''}>Main branch only</label>
        <label class="check"><input type="checkbox" name="blame" ${s.options.blame ? 'checked' : ''}>Code ownership (slower)</label>
      </div>
      <div class="checks">
        <label class="check"><input type="checkbox" name="send_email" ${s.send_email ? 'checked' : ''}>Email the report</label>
        <label class="check"><input type="checkbox" name="ai_summary" ${s.ai_summary ? 'checked' : ''}>Include AI summary</label>
        <label class="check"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}>Enabled</label>
      </div>
      <label class="f">Recipients <input type="text" name="recipients" value="${esc(s.recipients || '')}" placeholder="Empty = default recipients from Settings"></label>
      <div class="dialog-actions"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save</button></div>
    </div>`,
  async (data) => {
    data.repo_ids = (data.repo_ids || []).map(Number);
    await api(s.id ? 'PUT' : 'POST', s.id ? `/api/schedules/${s.id}` : '/api/schedules', data);
    toast('Schedule saved');
    schedules();
  },
  (form) => {
    $('#preset', form).onchange = (e) => { if (e.target.value !== 'custom') form.elements.cron.value = e.target.value; };
  });
}

// ---- settings ---------------------------------------------------------------------------------------
async function settings() {
  const s = await api('GET', '/api/settings');
  view.innerHTML = `
    <div class="page-head"><div><h1>Settings</h1><div class="sub">Secrets are stored encrypted in the SQLite database.</div></div></div>
    <form class="stack" id="settings">
      <div class="card"><h2>Email (Gmail)</h2>
        <p class="small muted" style="margin-top:-6px">Gmail needs an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">app password</a> (Google account → Security → 2-Step Verification → App passwords). Your normal password will not work.</p>
        <div class="fields">
          <label class="f">Gmail address <input type="email" name="smtp_user" value="${esc(s.smtp_user)}" placeholder="you@gmail.com"></label>
          <label class="f">App password <input type="password" name="smtp_password" value="${esc(s.smtp_password)}" autocomplete="new-password" placeholder="16 characters"></label>
          <label class="f">From <input type="text" name="mail_from" value="${esc(s.mail_from)}" placeholder='Git Insights <you@gmail.com>'></label>
          <label class="f">Default recipients <input type="text" name="default_recipients" value="${esc(s.default_recipients)}" placeholder="lead@acme.com, cto@acme.com"></label>
          <label class="f">SMTP host <input type="text" name="smtp_host" value="${esc(s.smtp_host)}"></label>
          <label class="f">SMTP port <input type="text" name="smtp_port" value="${esc(s.smtp_port)}"><span class="hint">465 (SSL) or 587 (STARTTLS)</span></label>
        </div>
        <div class="row" style="margin-top:12px"><input type="email" id="test-to" placeholder="Send test to…" style="max-width:260px"><button type="button" class="btn" id="test-mail">Send test email</button></div>
      </div>
      <div class="card"><h2>AI agent (Claude)</h2>
        <p class="small muted" style="margin-top:-6px">Powers the assistant and the report summaries. Get a key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>. The agent only sees report data from this app (numbers, names, emails, commit subjects), not source code.</p>
        <div class="fields">
          <label class="f">Anthropic API key <input type="password" name="anthropic_api_key" value="${esc(s.anthropic_api_key)}" autocomplete="new-password" placeholder="sk-ant-…"></label>
          <label class="f">Model <select name="ai_model">
            ${[['claude-opus-5-5', 'Claude Opus 5.5 (recommended)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster, cheaper)'], ['claude-fable-5-1', 'Claude Fable 5.1 (most capable)']]
    .map(([v, l]) => `<option value="${v}" ${s.ai_model === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
          <label class="f">Effort <select name="ai_effort">${['low', 'medium', 'high', 'xhigh'].map((v) => `<option ${s.ai_effort === v ? 'selected' : ''}>${v}</option>`).join('')}</select>
            <span class="hint">Higher effort gives more thorough answers but is slower and costs more.</span></label>
        </div>
      </div>
      <div class="card"><h2>General</h2>
        <label class="f">Public app URL <input type="url" name="app_url" value="${esc(s.app_url)}" placeholder="http://reports.internal:3000"><span class="hint">Used for links in emails.</span></label>
      </div>
      <div><button type="submit" class="btn primary">Save settings</button></div>
    </form>`;
  $('#settings').onsubmit = (e) => {
    e.preventDefault();
    busy($('button[type=submit]', e.target), async () => {
      await api('PUT', '/api/settings', formData(e.target));
      toast('Settings saved');
      await refreshStatus();
      settings();
    });
  };
  $('#test-mail').onclick = (e) => busy(e.target, async () => {
    await api('PUT', '/api/settings', formData($('#settings')));
    const r = await api('POST', '/api/settings/test-email', { to: $('#test-to').value });
    toast(`Test email sent to ${r.sentTo.join(', ')}`);
    refreshStatus();
  });
}

// ---- assistant --------------------------------------------------------------------------------------
const SUGGESTIONS = [
  'Give me an overview of the latest scan',
  'Who has the most unmerged work, and on which branches?',
  'What changed compared with the previous scan?',
  'Which files are risky because only one person knows them?',
  'Summarize what each developer worked on in the last 7 days',
  'Are there stale branches we should clean up?',
];
let currentConv = null;

async function assistant(convId) {
  currentConv = convId ? Number(convId) : null;
  const convs = await api('GET', '/api/conversations');
  view.innerHTML = `
    <div class="page-head"><div><h1>Assistant</h1><div class="sub">Ask anything about your repositories, developers and scans.</div></div>
      <a class="btn" href="#/assistant">New chat</a></div>
    <div class="chat">
      <div class="card convs">${convs.map((c) => `<a href="#/assistant/${c.id}" class="${c.id === currentConv ? 'active' : ''}"><span title="${esc(c.title)}">${esc(c.title || 'Untitled')}</span><button class="btn small danger" data-del="${c.id}" title="Delete">×</button></a>`).join('') || '<div class="small muted" style="padding:8px">No conversations yet.</div>'}</div>
      <div class="card chat-main">
        <div class="msgs" id="msgs"></div>
        <form class="composer" id="composer">
          <textarea name="q" rows="1" placeholder="${status.aiConfigured ? 'Ask about commits, developers, branches, trends…' : 'Add an Anthropic API key in Settings first'}" ${status.aiConfigured ? '' : 'disabled'}></textarea>
          <button class="btn primary" type="submit" ${status.aiConfigured ? '' : 'disabled'}>Send</button>
        </form>
      </div>
    </div>`;
  const msgs = $('#msgs');
  const add = (role, html) => { msgs.insertAdjacentHTML('beforeend', `<div class="msg ${role}">${html}</div>`); msgs.scrollTop = msgs.scrollHeight; return msgs.lastElementChild; };
  const toolLine = (name, input) => `${esc(name)}(${esc(Object.entries(input || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', '))})`;

  if (currentConv) {
    const c = await api('GET', `/api/conversations/${currentConv}`);
    for (const m of c.transcript) {
      if (m.role === 'user') add('user', esc(m.text));
      else if (m.role === 'tool') add('tool', toolLine(m.name, m.input));
      else add('assistant', md(m.text));
    }
  } else {
    msgs.innerHTML = `<div class="empty"><h2>What would you like to know?</h2><p>The agent reads your stored scans with tools and can start new scans.</p>
      <div class="suggestions">${SUGGESTIONS.map((q) => `<button type="button">${esc(q)}</button>`).join('')}</div></div>`;
    $$('.suggestions button', msgs).forEach((b) => { b.onclick = () => { $('#composer').elements.q.value = b.textContent; $('#composer').requestSubmit(); }; });
  }

  $$('[data-del]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      await api('DELETE', `/api/conversations/${b.dataset.del}`);
      if (Number(b.dataset.del) === currentConv) location.hash = '#/assistant'; else assistant(currentConv);
    };
  });

  const form = $('#composer');
  const ta = form.elements.q;
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = ta.value.trim();
    if (!q) return;
    ta.value = '';
    $('.empty', msgs)?.remove();
    add('user', esc(q));
    const thinking = add('assistant', '<span class="muted typing">Thinking</span>');
    $('button', form).disabled = true;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: q, conversationId: currentConv }) });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.*)$/m.exec(chunk)?.[1];
          const data = JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] || '{}');
          if (event === 'tool') msgs.insertBefore(Object.assign(document.createElement('div'), { className: 'msg tool', innerHTML: toolLine(data.name, data.input) }), thinking);
          else if (event === 'text') thinking.innerHTML = md(data.text);
          else if (event === 'error') { thinking.innerHTML = `<span class="del">${esc(data.error)}</span>`; }
          else if (event === 'done') {
            thinking.innerHTML = md(data.answer || '(no answer)');
            if (!currentConv) { currentConv = data.conversationId; history.replaceState(null, '', `#/assistant/${currentConv}`); }
          }
          msgs.scrollTop = msgs.scrollHeight;
        }
      }
    } catch (err) {
      thinking.innerHTML = `<span class="del">${esc(err.message)}</span>`;
    } finally {
      $('button', form).disabled = false;
      ta.focus();
    }
  };
  ta.focus();
}

router();
