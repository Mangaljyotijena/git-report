'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, encrypt, getSettings, saveSettings, loadReport } = require('./db');
const { queueScan, testRepo, repoDir, recentActivity } = require('./scanner');
const scheduler = require('./scheduler');
const agent = require('./agent');
const { sendTestEmail, sendReportEmail } = require('./mailer');
const { renderHtml } = require('../src/reporters/html');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Optional HTTP basic auth: set ADMIN_PASSWORD (and optionally ADMIN_USER).
if (process.env.ADMIN_PASSWORD) {
  const expected = Buffer.from(`${process.env.ADMIN_USER || 'admin'}:${process.env.ADMIN_PASSWORD}`);
  app.use((req, res, next) => {
    const given = Buffer.from(Buffer.from((req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString());
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Git Insights"').status(401).send('Authentication required');
  });
}

app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((err) => {
  res.status(err.status || 400).json({ error: err.message });
});
const fail = (status, message) => Object.assign(new Error(message), { status });
const id = (req) => Number(req.params.id);
const bool = (v) => (v ? 1 : 0);

// ---- status ---------------------------------------------------------------------------------------
app.get('/api/status', wrap((req, res) => {
  const s = getSettings({ reveal: true });
  res.json({
    aiConfigured: !!s.anthropic_api_key,
    emailConfigured: !!(s.smtp_user && s.smtp_password),
    agentMode: s.agent_mode || 'auto',
    repos: db.prepare('SELECT COUNT(*) AS n FROM repos').get().n,
    schedules: db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1').get().n,
    scans: db.prepare("SELECT COUNT(*) AS n FROM scans WHERE status = 'done'").get().n,
    running: db.prepare("SELECT COUNT(*) AS n FROM scans WHERE status IN ('queued', 'running')").get().n,
  });
}));

// ---- repositories ---------------------------------------------------------------------------------
const publicRepo = ({ token_enc: tokenEnc, ...r }) => ({ ...r, hasToken: !!tokenEnc });

function repoInput(body, existing = {}) {
  const source = body.source || existing.source || 'remote';
  const r = {
    name: String(body.name ?? existing.name ?? '').trim(),
    source,
    url: source === 'remote' ? String(body.url ?? existing.url ?? '').trim() : null,
    local_path: source === 'local' ? String(body.local_path ?? existing.local_path ?? '').trim() : null,
    main_branch: String(body.main_branch ?? existing.main_branch ?? '').trim() || null,
    enabled: body.enabled === undefined ? (existing.enabled ?? 1) : bool(body.enabled),
  };
  if (source === 'remote') {
    if (!/^https?:\/\//i.test(r.url)) throw fail(400, 'Use an https:// clone URL (SSH URLs are not supported in the container).');
    if (/\/\/[^/]*@/.test(r.url)) throw fail(400, 'Do not put credentials in the URL. Use the access token field.');
  } else if (!r.local_path) {
    throw fail(400, 'Local path is required.');
  }
  if (!r.name) r.name = (r.url || r.local_path).replace(/\.git$/, '').split(/[\\/]/).filter(Boolean).pop();
  return r;
}

app.get('/api/repos', wrap((req, res) => res.json(db.prepare('SELECT * FROM repos ORDER BY name').all().map(publicRepo))));

app.post('/api/repos', wrap((req, res) => {
  const r = repoInput(req.body);
  const { lastInsertRowid } = db.prepare(`INSERT INTO repos (name, source, url, local_path, token_enc, main_branch, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(r.name, r.source, r.url, r.local_path, encrypt(req.body.token), r.main_branch, r.enabled);
  res.json(publicRepo(db.prepare('SELECT * FROM repos WHERE id = ?').get(Number(lastInsertRowid))));
}));

app.put('/api/repos/:id', wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM repos WHERE id = ?').get(id(req));
  if (!existing) throw fail(404, 'Repository not found');
  const r = repoInput(req.body, existing);
  const token = req.body.clearToken ? null : req.body.token ? encrypt(req.body.token) : existing.token_enc;
  const moved = r.url !== existing.url;
  db.prepare('UPDATE repos SET name = ?, source = ?, url = ?, local_path = ?, token_enc = ?, main_branch = ?, enabled = ? WHERE id = ?')
    .run(r.name, r.source, r.url, r.local_path, token, r.main_branch, r.enabled, existing.id);
  if (moved && existing.source === 'remote') require('fs').rmSync(repoDir(existing), { recursive: true, force: true });
  res.json(publicRepo(db.prepare('SELECT * FROM repos WHERE id = ?').get(existing.id)));
}));

app.delete('/api/repos/:id', wrap((req, res) => {
  const existing = db.prepare('SELECT * FROM repos WHERE id = ?').get(id(req));
  if (!existing) throw fail(404, 'Repository not found');
  db.prepare('DELETE FROM repos WHERE id = ?').run(existing.id);
  if (existing.source === 'remote') require('fs').rmSync(repoDir(existing), { recursive: true, force: true });
  res.json({ ok: true });
}));

// Test a connection before or after saving (token may be new or stored).
app.post('/api/repos/test', wrap(async (req, res) => {
  const stored = req.body.id ? db.prepare('SELECT * FROM repos WHERE id = ?').get(Number(req.body.id)) : null;
  const r = repoInput(req.body, stored || {});
  res.json({ message: await testRepo({ ...r, token: req.body.token || null, token_enc: stored?.token_enc }) });
}));

// ---- schedules ------------------------------------------------------------------------------------
function scheduleInput(b) {
  const s = {
    name: String(b.name || '').trim() || 'Scheduled report',
    cron: String(b.cron || '').trim(),
    timezone: String(b.timezone || '').trim() || null,
    repo_ids: JSON.stringify((b.repo_ids || []).map(Number)),
    since: String(b.since || '').trim() || null,
    options: JSON.stringify({
      noBots: !!b.noBots, blame: !!b.blame, mainOnly: !!b.mainOnly,
      domains: String(b.domains || '').split(',').map((x) => x.trim()).filter(Boolean),
      excludes: String(b.excludes || '').split(',').map((x) => x.trim()).filter(Boolean),
    }),
    recipients: String(b.recipients || '').trim() || null,
    send_email: bool(b.send_email),
    ai_summary: bool(b.ai_summary),
    enabled: b.enabled === undefined ? 1 : bool(b.enabled),
  };
  if (!scheduler.validate(s.cron)) throw fail(400, `Invalid cron expression: "${s.cron}"`);
  if (s.timezone) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); } catch (_) { throw fail(400, `Unknown time zone: ${s.timezone}`); }
  }
  return s;
}
const publicSchedule = (s) => ({ ...s, repo_ids: JSON.parse(s.repo_ids), options: JSON.parse(s.options) });

app.get('/api/schedules', wrap((req, res) => res.json(db.prepare('SELECT * FROM schedules ORDER BY name').all().map(publicSchedule))));

app.post('/api/schedules', wrap((req, res) => {
  const s = scheduleInput(req.body);
  const { lastInsertRowid } = db.prepare(`INSERT INTO schedules (name, cron, timezone, repo_ids, since, options, recipients, send_email, ai_summary, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.name, s.cron, s.timezone, s.repo_ids, s.since, s.options, s.recipients, s.send_email, s.ai_summary, s.enabled);
  scheduler.reload();
  res.json(publicSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(lastInsertRowid))));
}));

app.put('/api/schedules/:id', wrap((req, res) => {
  const s = scheduleInput(req.body);
  const r = db.prepare(`UPDATE schedules SET name = ?, cron = ?, timezone = ?, repo_ids = ?, since = ?, options = ?, recipients = ?, send_email = ?, ai_summary = ?, enabled = ?
    WHERE id = ?`).run(s.name, s.cron, s.timezone, s.repo_ids, s.since, s.options, s.recipients, s.send_email, s.ai_summary, s.enabled, id(req));
  if (!r.changes) throw fail(404, 'Schedule not found');
  scheduler.reload();
  res.json(publicSchedule(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id(req))));
}));

app.delete('/api/schedules/:id', wrap((req, res) => {
  db.prepare('DELETE FROM schedules WHERE id = ?').run(id(req));
  scheduler.reload();
  res.json({ ok: true });
}));

app.post('/api/schedules/:id/run', wrap((req, res) => res.json({ scanId: scheduler.runSchedule(id(req), 'manual') })));

// ---- scans ----------------------------------------------------------------------------------------
const SCAN_COLS = 'id, schedule_id, trigger, status, repo_ids, params, started_at, finished_at, error, summary, ai_summary, email_status, created_at';
const publicScan = (s) => ({
  ...s, repo_ids: JSON.parse(s.repo_ids), params: JSON.parse(s.params), summary: s.summary ? JSON.parse(s.summary) : null,
});

app.get('/api/scans', wrap((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json(db.prepare(`SELECT ${SCAN_COLS} FROM scans ORDER BY id DESC LIMIT ?`).all(limit).map(publicScan));
}));

app.post('/api/scans', wrap((req, res) => {
  const b = req.body;
  const scanId = queueScan({
    repoIds: (b.repo_ids || []).map(Number),
    params: {
      since: b.since || null, until: b.until || null, noBots: !!b.noBots, blame: !!b.blame, mainOnly: !!b.mainOnly,
      sendEmail: !!b.sendEmail, recipients: b.recipients || null, aiSummary: !!b.aiSummary,
    },
    trigger: 'manual',
  });
  res.json({ scanId });
}));

app.get('/api/scans/:id', wrap((req, res) => {
  const s = db.prepare(`SELECT ${SCAN_COLS}, log FROM scans WHERE id = ?`).get(id(req));
  if (!s) throw fail(404, 'Scan not found');
  res.json(publicScan(s));
}));

// Full report data for the dashboard (the commit log is large, so only the newest 500 commits).
app.get('/api/scans/:id/report', wrap((req, res) => {
  const report = loadReport(id(req));
  if (!report) throw fail(404, 'Report not available');
  const { commitLog, ...rest } = report;
  res.json({ ...rest, recentCommits: commitLog.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 500), totalCommitLog: commitLog.length });
}));

app.get('/api/scans/:id/html', wrap((req, res) => {
  const report = loadReport(id(req));
  if (!report) throw fail(404, 'Report not available');
  res.type('html').send(renderHtml(report));
}));

app.post('/api/scans/:id/summary', wrap(async (req, res) => {
  if (!loadReport(id(req))) throw fail(404, 'Report not available');
  const text = await agent.summarizeScan(id(req));
  db.prepare('UPDATE scans SET ai_summary = ? WHERE id = ?').run(text, id(req));
  res.json({ ai_summary: text });
}));

app.post('/api/scans/:id/email', wrap(async (req, res) => {
  const report = loadReport(id(req));
  if (!report) throw fail(404, 'Report not available');
  const scan = db.prepare('SELECT ai_summary FROM scans WHERE id = ?').get(id(req));
  const rcpt = await sendReportEmail({ scanId: id(req), report, aiSummary: scan.ai_summary, recipients: req.body.recipients });
  db.prepare('UPDATE scans SET email_status = ? WHERE id = ?').run(`sent to ${rcpt.join(', ')}`, id(req));
  res.json({ sentTo: rcpt });
}));

app.delete('/api/scans/:id', wrap((req, res) => {
  db.prepare("DELETE FROM scans WHERE id = ? AND status NOT IN ('queued', 'running')").run(id(req));
  res.json({ ok: true });
}));

// ---- recent activity ------------------------------------------------------------------------------
// Live view of the last N hours on every branch: fetches the repos, then reads only that window.
app.get('/api/activity', wrap(async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 31);
  const repoIds = String(req.query.repo_ids || '').split(',').map(Number).filter(Boolean);
  res.json(await recentActivity({ repoIds, hours, fetch: req.query.fetch !== '0', bots: req.query.bots === '1' }));
}));

// ---- settings -------------------------------------------------------------------------------------
app.get('/api/settings', wrap((req, res) => res.json(getSettings())));
app.put('/api/settings', wrap((req, res) => { saveSettings(req.body || {}); res.json(getSettings()); }));
app.post('/api/settings/test-email', wrap(async (req, res) => res.json({ sentTo: await sendTestEmail(req.body.to) })));

// ---- agent ----------------------------------------------------------------------------------------
app.get('/api/conversations', wrap((req, res) => res.json(db.prepare('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 50').all())));

app.get('/api/conversations/:id', wrap((req, res) => {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id(req));
  if (!c) throw fail(404, 'Conversation not found');
  res.json({ id: c.id, title: c.title, transcript: agent.toTranscript(JSON.parse(c.messages)) });
}));

app.delete('/api/conversations/:id', wrap((req, res) => {
  db.prepare('DELETE FROM conversations WHERE id = ?').run(id(req));
  res.json({ ok: true });
}));

// Server-sent events: tool calls stream as they happen, then the final answer.
app.post('/api/chat', async (req, res) => {
  const question = String(req.body.message || '').trim();
  if (!question) return res.status(400).json({ error: 'Message is empty' });
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const out = await agent.chat(
      req.body.conversationId ? Number(req.body.conversationId) : null,
      question,
      (e) => send(e.type, e),
      { mode: req.body.mode === 'smart' || req.body.mode === 'claude' || req.body.mode === 'auto' ? req.body.mode : undefined },
    );
    send('done', out);
  } catch (err) {
    send('error', { error: err.message });
  }
  res.end();
});

app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

const PORT = Number(process.env.PORT) || 3030;
scheduler.reload();
app.listen(PORT, () => console.log(`Git Insights running on http://localhost:${PORT}`));
