'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { db, DATA_DIR, decrypt, packReport } = require('./db');
const { parseArgs } = require('../src/args');
const { collectReport } = require('../src/collect');

const CLONE_DIR = path.join(DATA_DIR, 'repos');
fs.mkdirSync(CLONE_DIR, { recursive: true });

function run(args, cwd, secret) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      const scrub = (s) => (secret ? String(s).split(secret).join('***') : String(s));
      if (err) return reject(new Error(scrub((stderr || err.message).trim())));
      resolve(scrub(stdout));
    });
  });
}

// "ghp_xxx" -> x-access-token:ghp_xxx (GitHub/GitLab PATs); "user:app-password" is used as given.
function authUrl(url, token) {
  if (!token) return url;
  const u = new URL(url);
  const [user, pass] = token.includes(':') ? [token.slice(0, token.indexOf(':')), token.slice(token.indexOf(':') + 1)] : ['x-access-token', token];
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(pass);
  return u.toString();
}

function repoDir(repo) {
  return repo.source === 'local' ? path.resolve(repo.local_path) : path.join(CLONE_DIR, String(repo.id));
}

// Clone on first use, then fetch every branch. Local repos are read as they are.
async function syncRepo(repo, log) {
  const dir = repoDir(repo);
  if (repo.source === 'local') {
    if (!fs.existsSync(dir)) throw new Error(`Local path not found: ${dir}`);
    return dir;
  }
  const token = decrypt(repo.token_enc);
  const remote = authUrl(repo.url, token);
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    log(`[${repo.name}] cloning ${repo.url}…`);
    await run(['clone', '--no-single-branch', '--quiet', remote, dir], CLONE_DIR, token);
    await run(['remote', 'set-url', 'origin', repo.url], dir); // never keep the token on disk
  } else {
    log(`[${repo.name}] fetching…`);
    await run(['fetch', '--prune', '--quiet', remote, '+refs/heads/*:refs/remotes/origin/*'], dir, token);
  }
  return dir;
}

async function testRepo(repo) {
  if (repo.source === 'local') {
    await run(['rev-parse', '--show-toplevel'], path.resolve(repo.local_path));
    return 'Local repository found.';
  }
  const token = repo.token || decrypt(repo.token_enc);
  const out = await run(['ls-remote', '--heads', authUrl(repo.url, token)], DATA_DIR, token);
  return `Reachable, ${out.split('\n').filter(Boolean).length} branch(es).`;
}

// ---- scan queue: one scan at a time so git and the CPU are not overloaded --------------------------
let chain = Promise.resolve();
const listeners = new Set(); // (scanId) => void, notified after each scan
function onScanFinished(fn) { listeners.add(fn); }

function queueScan({ repoIds = [], params = {}, trigger = 'manual', scheduleId = null }) {
  const { lastInsertRowid } = db.prepare(`INSERT INTO scans (schedule_id, trigger, status, repo_ids, params)
    VALUES (?, ?, 'queued', ?, ?)`).run(scheduleId, trigger, JSON.stringify(repoIds), JSON.stringify(params));
  const id = Number(lastInsertRowid);
  chain = chain.then(() => executeScan(id)).catch(() => {});
  return id;
}

async function executeScan(id) {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
  const params = JSON.parse(scan.params);
  const lines = [];
  const log = (msg) => {
    lines.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    db.prepare('UPDATE scans SET log = ? WHERE id = ?').run(lines.join('\n'), id);
  };
  db.prepare("UPDATE scans SET status = 'running', started_at = datetime('now') WHERE id = ?").run(id);

  try {
    const ids = JSON.parse(scan.repo_ids);
    const repos = ids.length
      ? db.prepare(`SELECT * FROM repos WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : db.prepare('SELECT * FROM repos WHERE enabled = 1').all();
    if (!repos.length) throw new Error('No repositories configured. Add one on the Repositories page.');

    const dirs = [];
    const labels = {};
    for (const repo of repos) {
      try {
        const dir = await syncRepo(repo, log);
        dirs.push(dir);
        labels[path.resolve(dir).toLowerCase()] = repo.name;
        db.prepare("UPDATE repos SET last_synced_at = datetime('now'), last_error = NULL WHERE id = ?").run(repo.id);
      } catch (err) {
        log(`[${repo.name}] sync failed: ${err.message}`);
        db.prepare('UPDATE repos SET last_error = ? WHERE id = ?').run(err.message, repo.id);
      }
    }
    if (!dirs.length) throw new Error('No repository could be synced.');

    const opts = buildOpts(params, dirs, labels, repos);
    const report = await collectReport(opts, log);
    const overview = { meta: report.meta, summary: report.summary, insights: report.insights };
    db.prepare(`UPDATE scans SET status = 'done', finished_at = datetime('now'), summary = ?, report_gz = ? WHERE id = ?`)
      .run(JSON.stringify(overview), packReport(report), id);
    log(`Scan finished: ${report.summary.commits} commits by ${report.summary.developers} developers.`);
  } catch (err) {
    log(`Scan failed: ${err.message}`);
    db.prepare("UPDATE scans SET status = 'failed', finished_at = datetime('now'), error = ? WHERE id = ?").run(err.message, id);
  }
  for (const fn of listeners) {
    try { await fn(id, log); } catch (err) { log(`post-scan step failed: ${err.message}`); }
  }
}

function buildOpts(params, dirs, labels, repos) {
  const opts = parseArgs(['-q']);
  opts.repos = dirs;
  opts.repoLabels = labels;
  opts.since = params.since || null;
  opts.until = params.until || null;
  opts.bots = !params.noBots;
  opts.blame = !!params.blame;
  opts.mainOnly = !!params.mainOnly;
  opts.domains = (params.domains || []).map((d) => d.toLowerCase().replace(/^@/, ''));
  opts.authors = (params.authors || []).map((a) => a.toLowerCase());
  opts.excludes = params.excludes || [];
  if (params.staleDays) opts.staleDays = Number(params.staleDays);
  // A single-repo scan may carry a main-branch override.
  if (repos.length === 1 && repos[0].main_branch) opts.main = repos[0].main_branch;
  opts.title = params.title || null;
  return opts;
}

// Recover scans interrupted by a restart.
db.prepare("UPDATE scans SET status = 'failed', error = 'Interrupted by server restart' WHERE status IN ('queued', 'running')").run();

module.exports = { queueScan, onScanFinished, testRepo, syncRepo, repoDir };
