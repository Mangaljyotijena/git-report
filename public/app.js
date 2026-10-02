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
const stat = (label, value, mod = '') => `<div class="stat${mod ? ` ${mod}` : ''}"><div class="v">${value}</div><div class="l">${esc(label)}</div></div>`;
const plusMinus = (a, d) => `<span class="add">+${fmt(a)}</span> <span class="del">−${fmt(d)}</span>`;
const initials = (name) => {
  const parts = String(name || '').trim().split(/[\s._-]+/).filter(Boolean);
  return esc(((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase());
};

// ---- status & router --------------------------------------------------------------------------------
let status = {};
async function refreshStatus() {
  try {
    status = await api('GET', '/api/status');
    $('#side-status').innerHTML = `
      <div><span class="dot ${status.emailConfigured ? 'ok' : 'bad'}"></span>Email ${status.emailConfigured ? 'ready' : 'not set up'}</div>
      <div><span class="dot ${status.aiConfigured ? 'ok' : 'bad'}"></span>Claude ${status.aiConfigured ? 'ready' : 'not set up'}</div>
      <div><span class="dot ${status.running ? 'busy' : ''}"></span>${status.running ? `${status.running} scan(s) running` : 'Idle'}</div>`;
  } catch (_) { /* offline */ }
}

const routes = {
  '': dashboard, activity, assistant, scans, repos, schedules, settings,
};
let pollTimer;
async function router() {
  clearInterval(pollTimer);
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  view.className = 'view'; // views opt back into layout modifiers (e.g. chat-page)
  $$('[data-route]').forEach((a) => {
    const on = a.dataset.route === (name || 'dashboard');
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
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
      ${stat('commits', fmt(s.commits), 'i-git')}${stat('developers', fmt(s.developers), 'i-users')}${stat('lines changed', plusMinus(s.additions, s.deletions), 'i-code')}
      ${stat('active last 30 days', fmt(s.activeLast30Days), 'i-clock')}${stat('unmerged commits', fmt(s.unmergedCommits), 'i-branch')}${stat('stale branches', fmt(s.staleBranches), 'i-alert')}${stat('bus factor', fmt(s.busFactor), 'i-shield')}
    </div>
    <div class="grid two">
      <div class="card">
        <div class="row"><h2 class="grow">Summary</h2><button class="btn small" id="gen">${scan.ai_summary ? 'Regenerate' : 'Generate'}${status.aiConfigured ? ' AI summary' : ' summary'}</button><a class="btn small" href="#/assistant">Ask a question</a></div>
        <div id="ai">${scan.ai_summary ? md(scan.ai_summary) : '<p class="muted">No summary for this scan yet.</p>'}</div>
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
      <thead><tr><th class="hide-sm">#</th><th>Developer</th><th class="num">Commits</th><th class="num">Lines</th><th>Share</th><th class="num">Unmerged</th><th class="num hide-sm">Active days</th><th class="num hide-sm">Last commit</th></tr></thead>
      <tbody>${devs.slice(0, 25).map((d) => `<tr><td class="muted hide-sm">${d.rank}</td><td><div class="who"><span class="avatar">${initials(d.name)}</span><div class="who-t"><div class="nm">${esc(d.name)}</div><div class="small muted">${esc(d.email)}</div></div></div></td>
        <td class="num">${fmt(d.commits)}</td><td class="num">${plusMinus(d.additions, d.deletions)}</td>
        <td><div class="share" title="${d.shareOfChurn}% of changed lines"><span style="width:${(d.churn / maxChurn) * 100}%"></span></div></td>
        <td class="num">${d.unmerged.commits ? fmt(d.unmerged.commits) : '<span class="muted">0</span>'}</td><td class="num hide-sm">${fmt(d.activeDays)}</td><td class="num hide-sm">${esc(d.lastCommit)}</td></tr>`).join('')}</tbody>
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

// ---- recent activity --------------------------------------------------------------------------------
const WINDOWS = [
  [1, 'Last 24 hours'], [2, 'Last 48 hours'], [3, 'Last 3 days'],
  [7, 'Last 7 days'], [15, 'Last 15 days'], [30, 'Last 30 days'],
];
const LOG_CAP = 50; // commits shown per developer before the "show more" button
const COMMIT_STATUS = { unmerged: ['not merged', 'warn'], unpushed: ['unpushed', 'bad'], merged: ['merged', 'good'], main: ['on main', 'info'] };
const at = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const ago = (iso) => {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
// A branch row can mix states, e.g. two commits merged today and one still open.
const branchBadges = (b) => ['unmerged', 'unpushed', 'merged', 'main']
  .filter((k) => b[k]).map((k) => badge(COMMIT_STATUS[k][0], COMMIT_STATUS[k][1])).join(' ');
const actPref = (k, d) => { try { return localStorage.getItem(`gi-act-${k}`) ?? d; } catch (_) { return d; } };
const actSave = (k, v) => { try { localStorage.setItem(`gi-act-${k}`, v); } catch (_) { /* private mode */ } };

async function activity() {
  const repoList = await api('GET', '/api/repos');
  if (!repoList.length) {
    view.innerHTML = '<div class="card empty"><h2>No repositories yet</h2><p>Add a repository to see what developers pushed recently.</p><a class="btn primary" href="#/repos">Add a repository</a></div>';
    return;
  }
  const savedDays = Number(actPref('days', 0));
  const legacyDays = Math.round(Number(actPref('hours', 24)) / 24); // windows used to be stored in hours
  const days = WINDOWS.some(([d]) => d === savedDays) ? savedDays
    : WINDOWS.some(([d]) => d === legacyDays) ? legacyDays : 1;
  const repoId = actPref('repo', '');
  view.innerHTML = `
    <div class="page-head">
      <div><h1>Recent activity</h1><div class="sub">Commits pushed to any branch, per developer, with lines added and removed.</div></div>
      <div class="row">
        <select id="days" aria-label="Time window">${WINDOWS.map(([d, l]) => `<option value="${d}" ${d === days ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="repo" aria-label="Repository"><option value="">All enabled repositories</option>${repoList.map((r) => `<option value="${r.id}" ${String(r.id) === repoId ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
        <button class="btn primary" id="refresh">Refresh</button>
      </div>
    </div>
    <div id="act"></div>`;

  let token = 0;
  let painted = false; // a previous successful render is on screen
  const load = async () => {
    const mine = ++token;
    const btn = $('#refresh');
    btn.disabled = true;
    // A refresh keeps the report on screen and dims it; only the very first paint shows the spinner.
    if (painted) $('#act').classList.add('is-loading');
    else $('#act').innerHTML = `<div class="card empty"><p class="muted typing">Fetching every branch of the last ${esc($('#days').value)} day${$('#days').value === '1' ? '' : 's'}</p></div>`;
    try {
      const q = new URLSearchParams({ days: $('#days').value });
      if ($('#repo').value) q.set('repo_ids', $('#repo').value);
      const a = await api('GET', `/api/activity?${q}`);
      if (mine !== token || !$('#act')) return; // a newer request, or the user navigated away
      $('#act').classList.remove('is-loading');
      $('#act').innerHTML = renderActivity(a);
      painted = true;
      wireActivity(a);
    } catch (err) {
      if (mine !== token || !$('#act')) return;
      $('#act').classList.remove('is-loading');
      if (painted) toast(err.message, true); // the last good report stays on screen
      else $('#act').innerHTML = `<div class="card empty"><h2>Could not load activity</h2><p>${esc(err.message)}</p></div>`;
    } finally {
      if (mine === token && $('#refresh')) $('#refresh').disabled = false;
    }
  };
  $('#days').onchange = (e) => { actSave('days', e.target.value); load(); };
  $('#repo').onchange = (e) => { actSave('repo', e.target.value); load(); };
  $('#refresh').onclick = load;
  load();
}

// ---- rendering the report ---------------------------------------------------------------------------
const ACT_SORTS = [
  ['name', 'Developer', ''], ['commits', 'Commits', 'num'], ['lines', 'Lines', 'num'],
  ['files', 'Files', 'num hide-sm'], ['branches', 'Branches', 'num hide-sm'], ['last', 'Last', 'num'],
];
const wireLogButtons = (root = document) => $$('.log-more-btn', root).forEach((b) => {
  b.onclick = () => { b.closest('details').querySelector('.log-more').hidden = false; b.remove(); };
});

function commitRow(c, multiRepo) {
  return `<tr>
          <td class="small nowrap">${esc(at(c.date))}</td>
          <td>${esc(c.subject)}${c.merge ? ` ${badge('merge', 'info')}` : ''}${c.rewritten ? ` <span class="small muted" title="Authored before this window, then rebased or cherry-picked in it">(rewritten)</span>` : ''}
            <div class="small muted"><code>${esc(c.hash.slice(0, 8))}</code> ${badge(...COMMIT_STATUS[c.status])} ${c.branches.map(esc).join(', ')}${multiRepo ? ` · ${esc(c.repo)}` : ''}</div></td>
          <td class="num">${c.merge ? '<span class="muted small">merge</span>' : `${plusMinus(c.additions, c.deletions)}<div class="small muted">${fmt(c.files)} file${c.files === 1 ? '' : 's'}</div>`}</td></tr>`;
}

function devDetailBody(a, d, sub) {
  const multiRepo = a.repositories.length > 1;
  const shown = d.log.slice(0, LOG_CAP);
  const rest = d.log.slice(LOG_CAP);
  const files = d.topFiles || [];
  const churn = d.additions + d.deletions;
  const pct = Math.round((churn / Math.max(1, a.totals.additions + a.totals.deletions)) * 100);
  return `
      <div class="dev-head">
        <div class="who"><span class="avatar">${initials(d.name)}</span><div class="who-t"><div class="nm">${esc(d.name)}</div>
          <div class="small muted dev-mail">${esc([d.email, ...d.otherEmails].join(' · '))}</div>
          <div class="small act-pos">${esc(sub)}</div></div></div>
        <div class="dev-nums">
          <div><strong>${plusMinus(d.additions, d.deletions)}</strong><span>lines</span></div>
          <div><strong>${fmt(d.commits)}</strong><span>commits</span></div>
          ${d.merges ? `<div><strong>${fmt(d.merges)}</strong><span>merges</span></div>` : ''}
          <div><strong>${fmt(d.files)}</strong><span>files</span></div>
          <div><strong>${fmt(d.branches.length)}</strong><span>${d.branches.length === 1 ? 'branch' : 'branches'}</span></div>
          <div><strong>${ago(d.lastAt)}</strong><span>last commit</span></div>
          <div><strong>${ago(d.firstAt)}</strong><span>first commit</span></div>
        </div>
      </div>
      <div class="dev-share">
        <div class="share" title="${pct}% of the lines changed in this window"><span style="width:${Math.max(pct, 1)}%"></span></div>
        <span class="small muted">${pct}% of all lines changed in this window</span>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Branch</th><th>Status</th><th class="num">Commits</th><th class="num">Lines</th><th class="num">Last</th></tr></thead>
        <tbody>${d.branches.map((b) => `<tr><td><code>${esc(b.branch)}</code>${multiRepo ? `<div class="small muted">${esc(b.repo)}</div>` : ''}</td>
          <td>${branchBadges(b)}</td>
          <td class="num">${fmt(b.commits)}${b.merges ? `<div class="small muted">+${fmt(b.merges)} merge${b.merges > 1 ? 's' : ''}</div>` : ''}</td>
          <td class="num">${plusMinus(b.additions, b.deletions)}</td><td class="num small">${ago(b.lastAt)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${files.length ? `<details class="commit-list"><summary>Top ${files.length} changed file${files.length === 1 ? '' : 's'}</summary><div class="table-wrap"><table>
        <thead><tr><th>File</th><th class="num">Commits</th><th class="num">Lines</th></tr></thead>
        <tbody>${files.map((f) => `<tr><td><code>${esc(f.path)}</code>${multiRepo ? `<div class="small muted">${esc(f.repo)}</div>` : ''}</td>
          <td class="num">${fmt(f.commits)}</td><td class="num">${plusMinus(f.additions, f.deletions)}</td></tr>`).join('')}</tbody>
      </table></div></details>` : ''}
      <details class="commit-list"><summary>${fmt(d.log.length)} commit${d.log.length === 1 ? '' : 's'}</summary>
        <div class="table-wrap"><table><tbody>${shown.map((c) => commitRow(c, multiRepo)).join('')}</tbody>${rest.length ? `<tbody class="log-more" hidden>${rest.map((c) => commitRow(c, multiRepo)).join('')}</tbody>` : ''}</table></div>
        ${rest.length ? `<button type="button" class="btn small log-more-btn">Show ${fmt(rest.length)} more</button>` : ''}
      </details>`;
}

function activityFootnote(t) {
  return 'A commit on several branches is listed under each of them but counted once in the totals. The window uses the commit date, so work rebased or cherry-picked in it is included and marked “rewritten”.'
    + (t.duplicatesSkipped ? ` ${fmt(t.duplicatesSkipped)} duplicate cop${t.duplicatesSkipped === 1 ? 'y' : 'ies'} of the same change counted once.` : '')
    + (t.excludedLines ? ` ${fmt(t.excludedLines)} lines in lock files and build output not counted.` : '')
    + (t.botCommits ? ` ${fmt(t.botCommits)} bot commit${t.botCommits === 1 ? '' : 's'} hidden.` : '');
}

function renderActivity(a) {
  const t = a.totals;
  const multiRepo = a.repositories.length > 1;
  const span = `${new Date(a.since).toLocaleString()} → now`;
  const warnings = a.warnings.length ? `<div class="card"><h2>Warnings</h2><ul class="insights">${a.warnings.map((w) => `<li>${badge('warn', 'warn')}<span>${esc(w)}</span></li>`).join('')}</ul></div>` : '';
  if (!a.developers.length) {
    return `${warnings}<div class="card empty"><h2>Nothing pushed in this window</h2><p>No commits on any branch since ${esc(new Date(a.since).toLocaleString())}.</p></div>`;
  }
  return `
    <div class="sub act-window">${esc(span)} · ${fmt(t.repos)} of ${fmt(a.repositories.length)} repositories active · updated ${esc(new Date(a.generatedAt).toLocaleTimeString())}</div>
    <div class="grid stats">
      ${stat('developers', fmt(t.developers), 'i-users')}${stat('commits', fmt(t.commits), 'i-git')}${stat('lines changed', plusMinus(t.additions, t.deletions), 'i-code')}
      ${stat('files changed', fmt(t.files), 'i-code')}${stat('branches', fmt(t.branches), 'i-branch')}${stat('merges', fmt(t.merges), 'i-git')}${stat('not merged yet', fmt(t.unmergedCommits), 'i-alert')}
    </div>
    ${warnings}
    <div id="dev-pane" class="dev-pane">${devListPane()}</div>
    <div class="card"><h2>Branches <span class="muted small">everyone's work per branch</span></h2><div class="table-wrap"><table>
      <thead><tr><th>Branch</th><th>Status</th><th>Developers</th><th class="num">Commits</th><th class="num">Lines</th><th class="num">Last</th></tr></thead>
      <tbody>${a.branches.map((b) => `<tr><td><code>${esc(b.branch)}</code>${multiRepo ? `<div class="small muted">${esc(b.repo)}</div>` : ''}</td><td>${branchBadges(b)}</td>
        <td class="small">${esc(b.developers.join(', '))}</td><td class="num">${fmt(b.commits)}</td><td class="num">${plusMinus(b.additions, b.deletions)}</td><td class="num small">${ago(b.lastAt)}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <p class="small muted">${esc(activityFootnote(t))}</p>`;
}

function devListPane() {
  return `
    <div class="row act-tools">
      <h2 class="grow">Developers</h2>
      <span class="small muted" id="dev-count" aria-live="polite"></span>
      <input type="search" id="dev-search" placeholder="Filter by name or email" aria-label="Filter developers">
      <div class="row act-export">
        <button type="button" class="btn small" id="act-png" aria-label="Export the developer list as a PNG image">Export PNG</button>
        <button type="button" class="btn small" id="act-pdf" aria-label="Export the developer list as a PDF document">Export PDF</button>
      </div>
    </div>
    <div class="card dev-list-card">
      <div class="table-wrap"><table>
        <thead><tr>
          ${ACT_SORTS.map(([k, label, cls]) => `<th class="${cls}" aria-sort="none"><button type="button" class="th-sort" data-sort="${k}">${label}<span class="sort-ind" aria-hidden="true">↕</span></button></th>`).join('')}
          <th class="hide-sm">Share</th><th></th>
        </tr></thead>
        <tbody id="dev-rows"></tbody>
      </table></div>
      <p class="small muted dev-list-empty" id="dev-empty" hidden></p>
    </div>
    <p class="small muted act-hint">Select a developer to see their branches, code changes and commits in this window.</p>`;
}

function devRow(a, i) {
  const d = a.developers[i];
  const pct = Math.round(((d.additions + d.deletions) / Math.max(1, a.totals.additions + a.totals.deletions)) * 100);
  return `<tr class="dev-row" data-i="${i}">
      <td><div class="who"><span class="avatar">${initials(d.name)}</span><div class="who-t">
        <button type="button" class="nm dev-open">${esc(d.name)}</button>
        <div class="small muted dev-mail">${esc(d.email)}</div></div></div></td>
      <td class="num">${fmt(d.commits)}</td>
      <td class="num">${plusMinus(d.additions, d.deletions)}</td>
      <td class="num hide-sm">${fmt(d.files)}</td>
      <td class="num hide-sm">${fmt(d.branches.length)}</td>
      <td class="num small nowrap">${ago(d.lastAt)}</td>
      <td class="hide-sm"><div class="share" title="${pct}% of the lines changed in this window"><span style="width:${Math.max(pct, 1)}%"></span></div></td>
      <td class="chev"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 5l7 7-7 7"/></svg></td>
    </tr>`;
}

function devDetailPane(a, i, order) {
  const d = a.developers[i];
  const pos = order.indexOf(i);
  const windowLabel = a.hours >= 24 ? `${a.hours / 24}-day window` : `${a.hours}-hour window`;
  const sub = `${fmt(pos + 1)} of ${fmt(order.length)} developers · ${windowLabel}`;
  return `
    <div class="row dev-nav">
      <button type="button" class="btn small" id="dev-back"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7"/></svg>Developers</button>
      <span class="grow"></span>
      <div class="row dev-pager">
        <button type="button" class="btn small" id="dev-prev"${pos <= 0 ? ' disabled' : ''}>‹ Previous</button>
        <button type="button" class="btn small" id="dev-next"${pos >= order.length - 1 ? ' disabled' : ''}>Next ›</button>
      </div>
    </div>
    <div class="card dev-detail">${devDetailBody(a, d, sub)}</div>`;
}

// The pane swaps between the developer list and one developer's detail without touching the router.
function wireActivity(a) {
  const pane = $('#dev-pane');
  if (!pane || !a.developers.length) return;
  let sortKey = 'lines';
  let sortDir = -1; // busiest first
  let filter = '';
  let openIdx = null;
  let lastIdx = 0;
  let savedScroll = 0;

  const searchable = (d) => `${d.name} ${d.email} ${d.otherEmails.join(' ')}`.toLowerCase();
  const value = (d, k) => (k === 'name' ? d.name.toLowerCase()
    : k === 'commits' ? d.commits
      : k === 'lines' ? d.additions + d.deletions
        : k === 'files' ? d.files
          : k === 'branches' ? d.branches.length
            : Date.parse(d.lastAt) || 0);
  const order = () => a.developers
    .map((d, i) => ({ d, i }))
    .filter(({ d }) => !filter || searchable(d).includes(filter))
    .sort((x, y) => ((value(x.d, sortKey) < value(y.d, sortKey) ? -1 : value(x.d, sortKey) > value(y.d, sortKey) ? 1 : 0) * sortDir
      || (y.d.additions + y.d.deletions) - (x.d.additions + x.d.deletions)))
    .map(({ i }) => i);

  const paint = () => {
    const rows = order();
    const body = $('#dev-rows');
    if (body) body.innerHTML = rows.map((i) => devRow(a, i)).join('');
    const count = $('#dev-count');
    if (count) count.textContent = rows.length === a.developers.length
      ? `${fmt(rows.length)} developer${rows.length === 1 ? '' : 's'}`
      : `${fmt(rows.length)} of ${fmt(a.developers.length)} developers`;
    const empty = $('#dev-empty');
    if (empty) {
      empty.hidden = rows.length > 0;
      if (!rows.length) empty.innerHTML = `No developer matches “${esc(($('#dev-search') || {}).value || '')}”. <button type="button" class="btn small" id="dev-clear">Clear filter</button>`;
    }
    const clear = $('#dev-clear');
    if (clear) clear.onclick = () => {
      $('#dev-search').value = '';
      filter = '';
      paint();
      $('#dev-search').focus();
    };
    $$('.th-sort', pane).forEach((b) => {
      const on = b.dataset.sort === sortKey;
      const th = b.closest('th');
      th.setAttribute('aria-sort', on ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
      th.classList.toggle('sorted', on);
      $('.sort-ind', b).textContent = on ? (sortDir > 0 ? '↑' : '↓') : '↕';
    });
  };

  // The export shows exactly what the list shows: the current sort and filter.
  const exportModel = () => {
    const idxs = order();
    const shown = idxs.map((i) => a.developers[i]);
    const sum = (f) => shown.reduce((n, d) => n + f(d), 0);
    const commits = sum((d) => d.commits);
    const adds = sum((d) => d.additions);
    const dels = sum((d) => d.deletions);
    const win = WINDOWS.find(([d]) => String(d) === $('#days').value);
    const repo = $('#repo');
    const scope = repo.value
      ? (repo.selectedOptions && repo.selectedOptions[0] ? String(repo.selectedOptions[0].textContent) : 'One repository')
      : 'All enabled repositories';
    const sort = ACT_SORTS.find(([k]) => k === sortKey);
    const search = $('#dev-search');
    const churn = Math.max(1, a.totals.additions + a.totals.deletions);
    return {
      title: 'Recent activity — developers',
      context: [
        `${win ? win[1] : `${a.hours / 24}-day window`} · ${scope} · generated ${new Date(a.generatedAt).toLocaleString()}`,
        `${fmt(shown.length)} of ${fmt(a.developers.length)} developers shown`
          + (filter && search ? ` · filter “${search.value}”` : '')
          + ` · sorted by ${sort ? sort[1].toLowerCase() : 'lines'} ${sortDir > 0 ? 'ascending' : 'descending'}`,
      ],
      totalsLine: `${fmt(commits)} commits · +${fmt(adds)} −${fmt(dels)} lines · ${fmt(shown.length)} developer${shown.length === 1 ? '' : 's'}`,
      columns: [
        { label: 'Developer', align: 'left', w: 500 },
        { label: 'Commits', align: 'right', w: 130 },
        { label: 'Lines', align: 'right', w: 180 },
        { label: 'Files', align: 'right', w: 110 },
        { label: 'Branches', align: 'right', w: 140 },
        { label: 'Last', align: 'right', w: 180 },
        { label: 'Share', align: 'right', w: 288 },
      ],
      rows: shown.map((d) => {
        const pct = Math.round(((d.additions + d.deletions) / churn) * 100);
        return {
          cells: [
            { text: d.name, sub: [d.email, ...d.otherEmails].join(' · ') },
            { text: fmt(d.commits) },
            { parts: [{ text: `+${fmt(d.additions)}`, color: 'add' }, { text: ` −${fmt(d.deletions)}`, color: 'del' }] },
            { text: fmt(d.files) },
            { text: fmt(d.branches.length) },
            { text: ago(d.lastAt) },
            { bar: pct, text: `${pct}%` },
          ],
        };
      }),
      totals: [
        { text: 'Total' }, { text: fmt(commits) },
        { parts: [{ text: `+${fmt(adds)}`, color: 'add' }, { text: ` −${fmt(dels)}`, color: 'del' }] },
        { text: '—' }, { text: '—' }, { text: '' }, { text: '' },
      ],
      footnote: activityFootnote(a.totals),
    };
  };

  const exportList = (btn, kind) => busy(btn, async () => {
    const stamp = `${$('#days').value}d-${new Date().toISOString().slice(0, 10)}`;
    const name = await exportActivityList(exportModel(), kind, { filename: `activity-${stamp}.${kind}` });
    toast(`Saved ${name}`);
  });

  const wireList = () => {
    const search = $('#dev-search');
    if (search) {
      search.oninput = () => { filter = search.value.trim().toLowerCase(); paint(); };
      search.onkeydown = (e) => {
        if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; filter = ''; paint(); }
      };
    }
    $$('.th-sort', pane).forEach((b) => {
      const go = () => {
        if (b.dataset.sort === sortKey) sortDir = -sortDir;
        else { sortKey = b.dataset.sort; sortDir = sortKey === 'name' ? 1 : -1; }
        paint();
      };
      b.onclick = go;
      b.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    });
    const body = $('#dev-rows');
    if (body) body.onclick = (e) => {
      const tr = e.target.closest('tr[data-i]');
      if (tr) openDetail(Number(tr.dataset.i));
    };
    const pngBtn = $('#act-png');
    const pdfBtn = $('#act-pdf');
    if (pngBtn) pngBtn.onclick = () => exportList(pngBtn, 'png');
    if (pdfBtn) pdfBtn.onclick = () => exportList(pdfBtn, 'pdf');
  };

  const openDetail = (i) => {
    if (!a.developers[i]) return;
    if (openIdx === null) savedScroll = window.scrollY || 0;
    lastIdx = i;
    openIdx = i;
    pane.innerHTML = devDetailPane(a, i, order());
    wireLogButtons();
    const back = $('#dev-back');
    back.onclick = closeDetail;
    back.focus({ preventScroll: true });
    $('#dev-prev').onclick = () => step(-1);
    $('#dev-next').onclick = () => step(1);
    pane.onkeydown = (e) => { if (e.key === 'Escape') closeDetail(); };
    pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const step = (delta) => {
    const rows = order();
    const next = rows[rows.indexOf(openIdx) + delta];
    if (next !== undefined) openDetail(next);
  };

  const closeDetail = () => {
    openIdx = null;
    pane.onkeydown = null;
    pane.innerHTML = devListPane();
    wireList();
    paint();
    if (window.scrollTo) window.scrollTo({ top: savedScroll, behavior: 'smooth' });
    const row = $(`tr[data-i="${lastIdx}"] .dev-open`, pane);
    if (row) row.focus({ preventScroll: true });
  };

  wireList();
  paint();
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
        <label class="check"><input type="checkbox" name="aiSummary" checked>Include summary</label>
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
      <thead><tr><th>#</th><th>Status</th><th>Trigger</th><th>Started</th><th class="hide-sm">Filters</th><th class="num">Commits</th><th class="num">Devs</th><th class="hide-sm">Email</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td><a href="#/scans/${s.id}">#${s.id}</a></td><td>${badge(s.status)}</td>
        <td>${esc(s.trigger)}${s.schedule_id ? `<div class="small muted">${esc(schedName[s.schedule_id] || 'deleted schedule')}</div>` : ''}</td>
        <td class="small">${when(s.started_at || s.created_at)}</td>
        <td class="small muted hide-sm">${esc(s.params.since ? `since ${s.params.since}` : 'full history')}</td>
        <td class="num">${fmt(s.summary?.summary.commits)}</td><td class="num">${fmt(s.summary?.summary.developers)}</td>
        <td class="small muted hide-sm">${esc(s.email_status || '')}</td>
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
          <button class="btn" id="gen">${s.ai_summary ? 'Regenerate' : 'Generate'}${status.aiConfigured ? ' AI summary' : ' summary'}</button>` : ''}
        ${active ? '' : '<button class="btn danger" id="del">Delete</button>'}
      </div>
    </div>
    ${s.error ? `<div class="card"><strong class="del">Error:</strong> ${esc(s.error)}</div>` : ''}
    ${sum ? `<div class="grid stats">${stat('commits', fmt(sum.commits), 'i-git')}${stat('developers', fmt(sum.developers), 'i-users')}${stat('lines changed', plusMinus(sum.additions, sum.deletions), 'i-code')}${stat('unmerged commits', fmt(sum.unmergedCommits), 'i-branch')}${stat('bus factor', fmt(sum.busFactor), 'i-shield')}</div>` : ''}
    ${s.ai_summary ? `<div class="card"><h2>Summary</h2>${md(s.ai_summary)}</div>` : ''}
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
      <thead><tr><th>Name</th><th class="hide-sm">Source</th><th class="hide-sm">Main branch</th><th>Last synced</th><th>Status</th><th></th></tr></thead>
      <tbody>${list.map((r) => `<tr>
        <td><strong>${esc(r.name)}</strong></td>
        <td class="small hide-sm">${r.source === 'remote' ? `${esc(r.url)}${r.hasToken ? ' ' + badge('token', 'info') : ''}` : `<code>${esc(r.local_path)}</code> ${badge('local')}`}</td>
        <td class="small hide-sm">${esc(r.main_branch || 'auto')}</td>
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
    <div class="page-head"><div><h1>Schedules</h1><div class="sub">Periodic scans that write a summary and email the report.</div></div><button class="btn primary" id="add">New schedule</button></div>
    <div class="card">${list.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>When</th><th class="hide-sm">Repositories</th><th class="hide-sm">Window</th><th>Delivery</th><th>Last run</th><th></th></tr></thead>
      <tbody>${list.map((s) => `<tr>
        <td><strong>${esc(s.name)}</strong> ${s.enabled ? '' : badge('paused')}</td>
        <td class="small">${esc(describeCron(s.cron))}<div class="muted"><code>${esc(s.cron)}</code>${s.timezone ? ` ${esc(s.timezone)}` : ''}</div></td>
        <td class="small hide-sm">${s.repo_ids.length ? esc(s.repo_ids.map((i) => repoName[i] || `#${i}`).join(', ')) : 'All enabled'}</td>
        <td class="small hide-sm">${esc(s.since || 'full history')}</td>
        <td class="small">${s.send_email ? `Email ${esc(s.recipients || '(default recipients)')}` : 'No email'}${s.ai_summary ? '<div class="muted">+ summary</div>' : ''}</td>
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
  s = s || { name: 'Weekly team report', cron: '0 9 * * 1', timezone: tz, repo_ids: [], since: '7 days ago', options: { noBots: true }, send_email: 1, ai_summary: 1, enabled: 1 };
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
        <label class="check"><input type="checkbox" name="ai_summary" ${s.ai_summary ? 'checked' : ''}>Include summary</label>
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
        <p class="small muted" style="margin-top:-6px">Used by the assistant when its mode is Claude or Auto (with a key), and for AI summaries. Get a key at <a href="https://console.anthropic.com/" target="_blank" rel="noopener">console.anthropic.com</a>. The agent only sees report data from this app (numbers, names, emails, commit subjects), not source code. Without a key the app falls back to the deterministic Smart mode.</p>
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
        <label class="f">Public app URL <input type="url" name="app_url" value="${esc(s.app_url)}" placeholder="http://reports.internal:3030"><span class="hint">Used for links in emails.</span></label>
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

// Starter questions come from the server's capability registry; the static list is the fallback.
const starters = () => (status.suggestions && status.suggestions.length ? status.suggestions : SUGGESTIONS).slice(0, 6);

const agentMode = () => status.agentMode || 'auto';
const agentAvailable = () => agentMode() !== 'claude' || status.aiConfigured;
const composerPlaceholder = () => (agentMode() === 'claude' && !status.aiConfigured)
  ? 'Add an Anthropic API key in Settings first'
  : 'Ask about commits, developers, branches, trends…';
const thinkingLabel = () => (agentMode() === 'claude' && status.aiConfigured ? 'Thinking' : 'Checking scans');

async function assistant(convId) {
  currentConv = convId ? Number(convId) : null;
  view.classList.add('chat-page');
  const convs = await api('GET', '/api/conversations');
  view.innerHTML = `
    <div class="page-head"><div><h1>Assistant</h1><div class="sub">Ask anything about your repositories, developers and scans.</div></div>
      <div class="row"><div class="seg" id="mode-seg" title="Answer engine: Smart is deterministic (no AI), Claude needs an API key, Auto picks Claude when a key exists">
        ${[['auto', 'Auto'], ['smart', 'Smart'], ['claude', 'Claude']].map(([v, l]) => `<button type="button" data-mode="${v}" class="${agentMode() === v ? 'on' : ''}">${l}</button>`).join('')}
      </div><a class="btn" href="#/assistant">New chat</a></div></div>
    <div class="chat">
      <div class="card convs"><div class="convs-title">Conversations</div>${convs.map((c) => `<a href="#/assistant/${c.id}" class="${c.id === currentConv ? 'active' : ''}"><span title="${esc(c.title)}">${esc(c.title || 'Untitled')}</span><button class="btn small danger" data-del="${c.id}" title="Delete">×</button></a>`).join('') || '<div class="convs-empty">No conversations yet.<br>Ask the assistant anything to start one.</div>'}</div>
      <div class="card chat-main">
        <div class="msgs" id="msgs"></div>
        <form class="composer" id="composer">
          <textarea name="q" rows="1" placeholder="${composerPlaceholder()}" ${agentAvailable() ? '' : 'disabled'}></textarea>
          <button class="btn primary" type="submit" ${agentAvailable() ? '' : 'disabled'} aria-label="Send message">
            <span>Send</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12h14M13 6.5 18.5 12 13 17.5"/></svg>
          </button>
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
      <div class="suggestions">${starters().map((q) => `<button type="button">${esc(q)}</button>`).join('')}</div></div>`;
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
  // The composer grows with the message up to a cap, then scrolls internally.
  const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 150)}px`; };
  ta.addEventListener('input', grow);
  grow();
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  $$('#mode-seg button').forEach((b) => {
    b.onclick = async () => {
      await api('PUT', '/api/settings', { agent_mode: b.dataset.mode });
      status.agentMode = b.dataset.mode;
      $$('#mode-seg button').forEach((x) => x.classList.toggle('on', x === b));
      ta.placeholder = composerPlaceholder();
      ta.disabled = !agentAvailable();
      $('button', form).disabled = !agentAvailable();
      if (b.dataset.mode === 'claude' && !status.aiConfigured) toast('Claude needs an Anthropic API key — add one in Settings');
    };
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = ta.value.trim();
    if (!q || !agentAvailable()) return;
    ta.value = '';
    grow();
    $('.empty', msgs)?.remove();
    add('user', esc(q));
    const thinking = add('assistant', `<span class="muted typing">${thinkingLabel()}</span>`);
    $('button', form).disabled = true;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: q, conversationId: currentConv, mode: agentMode() }) });
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
      $('button', form).disabled = !agentAvailable();
      ta.focus();
    }
  };
  ta.focus();
}

router();
