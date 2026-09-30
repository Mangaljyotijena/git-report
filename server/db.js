'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'git-report.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('remote', 'local')),
  url          TEXT,            -- remote clone URL (no credentials)
  local_path   TEXT,            -- for source = 'local'
  token_enc    TEXT,            -- encrypted access token for private remotes
  main_branch  TEXT,            -- optional override
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_synced_at TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  cron         TEXT NOT NULL,
  timezone     TEXT,
  repo_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON array; empty = all enabled repos
  since        TEXT,                         -- e.g. "30 days ago"
  options      TEXT NOT NULL DEFAULT '{}',   -- JSON: { noBots, blame, mainOnly, domains, excludes }
  recipients   TEXT,                         -- comma separated; empty = settings default
  send_email   INTEGER NOT NULL DEFAULT 1,
  ai_summary   INTEGER NOT NULL DEFAULT 1,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id  INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  trigger      TEXT NOT NULL,                -- manual | schedule | agent
  status       TEXT NOT NULL,                -- queued | running | done | failed
  repo_ids     TEXT NOT NULL DEFAULT '[]',
  params       TEXT NOT NULL DEFAULT '{}',
  started_at   TEXT,
  finished_at  TEXT,
  log          TEXT NOT NULL DEFAULT '',
  error        TEXT,
  summary      TEXT,                         -- JSON: { meta, summary, insights }
  ai_summary   TEXT,                         -- markdown written by the agent
  email_status TEXT,
  report_gz    BLOB,                         -- gzip(JSON report)
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT,
  messages   TEXT NOT NULL DEFAULT '[]',     -- Claude API message history (append-only)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Dialogue state for the Smart agent (last intent, developer, window, scan, pending clarification).
if (!db.prepare('PRAGMA table_info(conversations)').all().some((c) => c.name === 'state')) {
  db.exec("ALTER TABLE conversations ADD COLUMN state TEXT NOT NULL DEFAULT '{}'");
}

// ---- secrets at rest -----------------------------------------------------------------------------
// Tokens and passwords are AES-256-GCM encrypted with APP_SECRET (or a generated key file).
function loadKey() {
  if (process.env.APP_SECRET) return crypto.createHash('sha256').update(process.env.APP_SECRET).digest();
  const file = path.join(DATA_DIR, '.secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest();
}
const KEY = loadKey();

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(value) {
  if (!value) return null;
  try {
    const [iv, tag, enc] = value.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (_) {
    return null; // key changed; the user has to re-enter the secret
  }
}

// ---- settings ------------------------------------------------------------------------------------
const SECRET_SETTINGS = new Set(['smtp_password', 'anthropic_api_key']);
const SETTING_DEFAULTS = {
  smtp_host: 'smtp.gmail.com',
  smtp_port: '465',
  smtp_user: '',
  smtp_password: '',
  mail_from: '',
  default_recipients: '',
  anthropic_api_key: '',
  ai_model: 'claude-opus-5-5',
  ai_effort: 'medium',
  agent_mode: 'auto', // 'auto' (Claude when a key exists, otherwise Smart), 'smart' or 'claude'
  app_url: '',
};

function getSettings({ reveal = false } = {}) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = SECRET_SETTINGS.has(r.key) ? decrypt(r.value) || '' : r.value;
  if (!reveal) {
    for (const k of SECRET_SETTINGS) out[k] = out[k] ? '••••••••' : '';
  }
  // Environment variables act as fallbacks, useful for Docker.
  if (!out.anthropic_api_key && process.env.ANTHROPIC_API_KEY) out.anthropic_api_key = reveal ? process.env.ANTHROPIC_API_KEY : '(from environment)';
  return out;
}

function saveSettings(patch) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    if (SECRET_SETTINGS.has(k)) {
      if (v === '••••••••' || v === '(from environment)') continue; // unchanged mask
      stmt.run(k, encrypt(v));
    } else {
      stmt.run(k, v === null || v === undefined ? '' : String(v));
    }
  }
}

// ---- report blobs --------------------------------------------------------------------------------
const packReport = (report) => zlib.gzipSync(Buffer.from(JSON.stringify(report), 'utf8'));

const reportCache = new Map(); // scan id -> parsed report (small LRU)
function loadReport(scanId) {
  if (reportCache.has(scanId)) return reportCache.get(scanId);
  const row = db.prepare('SELECT report_gz FROM scans WHERE id = ?').get(scanId);
  if (!row || !row.report_gz) return null;
  const report = JSON.parse(zlib.gunzipSync(Buffer.from(row.report_gz)).toString('utf8'));
  reportCache.set(scanId, report);
  if (reportCache.size > 8) reportCache.delete(reportCache.keys().next().value);
  return report;
}

module.exports = { db, DATA_DIR, encrypt, decrypt, getSettings, saveSettings, packReport, loadReport };
