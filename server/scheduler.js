'use strict';

const cron = require('node-cron');
const { db, loadReport } = require('./db');
const { queueScan, onScanFinished } = require('./scanner');
const { summarizeScan, aiConfigured } = require('./agent');
const { sendReportEmail } = require('./mailer');

const tasks = new Map(); // schedule id -> cron task

function paramsOf(schedule) {
  return { since: schedule.since || null, ...JSON.parse(schedule.options || '{}') };
}

function runSchedule(scheduleId, trigger = 'schedule') {
  const s = db.prepare('SELECT * FROM schedules WHERE id = ?').get(scheduleId);
  if (!s) throw new Error('Schedule not found');
  db.prepare("UPDATE schedules SET last_run_at = datetime('now') WHERE id = ?").run(s.id);
  return queueScan({ repoIds: JSON.parse(s.repo_ids), params: { ...paramsOf(s), title: s.name }, trigger, scheduleId: s.id });
}

function reload() {
  for (const t of tasks.values()) t.stop();
  tasks.clear();
  for (const s of db.prepare('SELECT * FROM schedules WHERE enabled = 1').all()) {
    if (!cron.validate(s.cron)) {
      console.warn(`Schedule "${s.name}" has an invalid cron expression: ${s.cron}`);
      continue;
    }
    const task = cron.schedule(s.cron, () => {
      try { runSchedule(s.id); } catch (err) { console.error(`Schedule ${s.id} failed to start:`, err.message); }
    }, s.timezone ? { timezone: s.timezone } : {});
    tasks.set(s.id, task);
  }
  console.log(`Scheduler: ${tasks.size} active schedule(s)`);
}

// After every scan: AI summary (optional) and email (for scheduled scans or when asked).
onScanFinished(async (scanId, log) => {
  const scan = db.prepare('SELECT * FROM scans WHERE id = ?').get(scanId);
  const schedule = scan.schedule_id ? db.prepare('SELECT * FROM schedules WHERE id = ?').get(scan.schedule_id) : null;
  const params = JSON.parse(scan.params);
  if (scan.status !== 'done') {
    if (schedule && schedule.send_email) db.prepare('UPDATE scans SET email_status = ? WHERE id = ?').run('skipped: scan failed', scanId);
    return;
  }
  const wantsSummary = schedule ? !!schedule.ai_summary : !!params.aiSummary;
  let aiSummary = null;
  if (wantsSummary && aiConfigured()) {
    try {
      log('Writing AI summary…');
      aiSummary = await summarizeScan(scanId);
      db.prepare('UPDATE scans SET ai_summary = ? WHERE id = ?').run(aiSummary, scanId);
    } catch (err) {
      log(`AI summary failed: ${err.message}`);
    }
  }
  const wantsEmail = schedule ? !!schedule.send_email : !!params.sendEmail;
  if (!wantsEmail) return;
  try {
    const rcpt = await sendReportEmail({
      scanId, report: loadReport(scanId), aiSummary,
      recipients: schedule?.recipients || params.recipients, scheduleName: schedule?.name,
    });
    db.prepare('UPDATE scans SET email_status = ? WHERE id = ?').run(`sent to ${rcpt.join(', ')}`, scanId);
    log(`Email sent to ${rcpt.join(', ')}`);
  } catch (err) {
    db.prepare('UPDATE scans SET email_status = ? WHERE id = ?').run(`failed: ${err.message}`, scanId);
    log(`Email failed: ${err.message}`);
  }
});

module.exports = { reload, runSchedule, validate: (expr) => cron.validate(expr) };
