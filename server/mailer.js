'use strict';

const nodemailer = require('nodemailer');
const { getSettings } = require('./db');
const { renderHtml } = require('../src/reporters/html');
const { renderMarkdown } = require('../public/markdown');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : esc(n ?? '—'));

function transport() {
  const s = getSettings({ reveal: true });
  if (!s.smtp_user || !s.smtp_password) throw new Error('Email is not configured. Add your Gmail address and app password in Settings.');
  const port = Number(s.smtp_port) || 465;
  return {
    settings: s,
    transporter: nodemailer.createTransport({
      host: s.smtp_host || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: s.smtp_user, pass: s.smtp_password },
    }),
  };
}

function recipientsFor(list) {
  const s = getSettings();
  return String(list || s.default_recipients || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}

async function sendTestEmail(to) {
  const { settings, transporter } = transport();
  await transporter.verify();
  const rcpt = recipientsFor(to);
  if (!rcpt.length) throw new Error('No recipient. Enter one or set default recipients.');
  await transporter.sendMail({
    from: settings.mail_from || settings.smtp_user,
    to: rcpt.join(', '),
    subject: 'Git Insights: test email',
    text: 'Email delivery from Git Insights works.',
  });
  return rcpt;
}

function reportEmailHtml({ scanId, report, aiSummary, scheduleName, appUrl }) {
  const s = report.summary;
  const stat = (label, value) => `<td style="padding:10px 14px;border:1px solid #e4e7ec;border-radius:8px;text-align:center"><div style="font-size:20px;font-weight:600">${value}</div><div style="font-size:12px;color:#667085">${label}</div></td>`;
  const devs = report.developers.filter((d) => !d.isBot).slice(0, 10);
  const unmerged = report.branches.filter((b) => b.status === 'unmerged' || b.status === 'unpushed').slice(0, 10);
  const levelColor = { warn: '#b7791f', good: '#1a9e5c', info: '#3b6fd8' };
  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330">
<div style="max-width:720px;margin:0 auto;padding:24px 16px">
  <h1 style="font-size:20px;margin:0 0 4px">${esc(report.meta.title)}</h1>
  <div style="color:#667085;font-size:13px">${scheduleName ? `${esc(scheduleName)} · ` : ''}Scan #${scanId} · ${esc(s.firstCommit || '')} → ${esc(s.lastCommit || '')}${report.meta.filters.since ? ` · since ${esc(report.meta.filters.since)}` : ''}</div>
  <table style="border-collapse:separate;border-spacing:6px;margin:16px -6px;width:calc(100% + 12px)"><tr>
    ${stat('commits', fmt(s.commits))}${stat('developers', fmt(s.developers))}${stat('lines +/−', `<span style="color:#1a9e5c">+${fmt(s.additions)}</span> <span style="color:#d6453d">−${fmt(s.deletions)}</span>`)}${stat('unmerged commits', fmt(s.unmergedCommits))}${stat('bus factor', fmt(s.busFactor))}
  </tr></table>
  ${aiSummary ? `<div style="background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:4px 18px;margin-bottom:16px"><div style="font-size:12px;color:#667085;margin-top:12px">${/no AI used/.test(aiSummary) ? 'Summary' : 'AI summary'}</div>${renderMarkdown(aiSummary)}</div>` : ''}
  <div style="background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:14px 18px;margin-bottom:16px">
    <h2 style="font-size:15px;margin:0 0 8px">Insights</h2>
    <ul style="padding-left:18px;margin:0">${report.insights.map((i) => `<li style="margin:4px 0"><span style="color:${levelColor[i.level] || '#667085'};font-weight:600">${esc(i.level)}</span> ${esc(i.text)}</li>`).join('')}</ul>
  </div>
  <div style="background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:14px 18px;margin-bottom:16px">
    <h2 style="font-size:15px;margin:0 0 8px">Top developers</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="color:#667085;text-align:left"><th style="padding:4px">Developer</th><th style="padding:4px;text-align:right">Commits</th><th style="padding:4px;text-align:right">+ / −</th><th style="padding:4px;text-align:right">Unmerged</th><th style="padding:4px;text-align:right">Last commit</th></tr>
      ${devs.map((d) => `<tr style="border-top:1px solid #e4e7ec"><td style="padding:4px">${esc(d.name)}<div style="color:#667085;font-size:11px">${esc(d.email)}</div></td><td style="padding:4px;text-align:right">${fmt(d.commits)}</td><td style="padding:4px;text-align:right"><span style="color:#1a9e5c">+${fmt(d.additions)}</span> <span style="color:#d6453d">−${fmt(d.deletions)}</span></td><td style="padding:4px;text-align:right">${fmt(d.unmerged.commits)}</td><td style="padding:4px;text-align:right">${esc(d.lastCommit)}</td></tr>`).join('')}
    </table>
  </div>
  ${unmerged.length ? `<div style="background:#fff;border:1px solid #e4e7ec;border-radius:10px;padding:14px 18px;margin-bottom:16px">
    <h2 style="font-size:15px;margin:0 0 8px">Work not merged yet</h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <tr style="color:#667085;text-align:left"><th style="padding:4px">Branch</th><th style="padding:4px">Repo</th><th style="padding:4px;text-align:right">Ahead</th><th style="padding:4px;text-align:right">Idle days</th></tr>
      ${unmerged.map((b) => `<tr style="border-top:1px solid #e4e7ec"><td style="padding:4px">${esc(b.name)}${b.stale ? ' <span style="color:#b7791f">(stale)</span>' : ''}${b.status === 'unpushed' ? ' <span style="color:#d6453d">(unpushed)</span>' : ''}</td><td style="padding:4px">${esc(b.repo)}</td><td style="padding:4px;text-align:right">${fmt(b.aheadCommits)}</td><td style="padding:4px;text-align:right">${fmt(b.daysIdle)}</td></tr>`).join('')}
    </table>
  </div>` : ''}
  <p style="color:#667085;font-size:12px">The full interactive report is attached (git-report.html).${appUrl ? ` Open the app: <a href="${esc(appUrl)}/#/scans/${scanId}">${esc(appUrl)}</a>` : ''}</p>
</div></body></html>`;
}

async function sendReportEmail({ scanId, report, aiSummary, recipients, scheduleName }) {
  const { settings, transporter } = transport();
  const rcpt = recipientsFor(recipients);
  if (!rcpt.length) throw new Error('No email recipients configured.');
  const s = report.summary;
  await transporter.sendMail({
    from: settings.mail_from || settings.smtp_user,
    to: rcpt.join(', '),
    subject: `${report.meta.title}: ${fmt(s.commits)} commits, ${fmt(s.developers)} developers${s.unmergedCommits ? `, ${fmt(s.unmergedCommits)} unmerged` : ''}`,
    html: reportEmailHtml({ scanId, report, aiSummary, scheduleName, appUrl: settings.app_url?.replace(/\/$/, '') }),
    attachments: [{ filename: 'git-report.html', content: renderHtml(report), contentType: 'text/html' }],
  });
  return rcpt;
}

module.exports = { sendTestEmail, sendReportEmail };
