'use strict';

// Shared markdown formatting for every deterministic answer.

const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—');
const signed = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${n > 0 ? '+' : ''}${num(n)}` : '—');
const pctOf = (n) => (typeof n === 'number' && Number.isFinite(n) ? `${Math.round(n * 10) / 10}%` : '—');
const lines = (o) => `+${num(o.additions)}/-${num(o.deletions)}`;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cell = (v) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function ago(d) {
  const t = Date.parse(d);
  if (!Number.isFinite(t)) return '—';
  const days = Math.round((Date.now() - t) / 864e5);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 45) return `${days} days ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

function renderTable(t) {
  if (!t || !t.rows || !t.rows.length) return '';
  return [
    `| ${t.head.join(' | ')} |`,
    `| ${t.head.map(() => '---').join(' | ')} |`,
    ...t.rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
  ].join('\n');
}

// A section is { headline?, bullets?, table?, notes? }. The answer contract is:
// headline = the direct answer, bullets = supporting numbers, notes = caveats, then
// follow-up suggestions, then provenance — in that order.
function renderAnswer(sections, provenance, followUps = []) {
  const blocks = [];
  for (const s of sections) {
    if (!s) continue;
    const b = [];
    if (s.headline) b.push(`**${s.headline}**`);
    if (s.bullets && s.bullets.length) b.push(s.bullets.map((x) => `- ${x}`).join('\n'));
    const t = renderTable(s.table);
    if (t) b.push(t);
    if (s.notes && s.notes.length) b.push(s.notes.map((n) => `*${n}*`).join('\n\n'));
    if (b.length) blocks.push(b.join('\n\n'));
  }
  if (followUps && followUps.length) {
    blocks.push(`**You could ask next:** ${followUps.map((f) => `"${f}"`).join(' · ')}`);
  }
  if (provenance) blocks.push(provenance);
  return blocks.join('\n\n');
}

function provenance(scan, report, extra) {
  const f = (report && report.meta && report.meta.filters) || {};
  const S = report && report.summary;
  const bits = [`scan #${scan.id}`];
  if (S && (S.firstCommit || S.lastCommit)) bits.push(`${S.firstCommit || '?'} → ${S.lastCommit || '?'}`);
  if (f.since) bits.push(`since ${f.since}`);
  if (f.until) bits.push(`until ${f.until}`);
  if (f.bots === false) bits.push('bots excluded');
  if (extra) bits.push(extra);
  bits.push('no AI used');
  return `*${bits.join(' · ')}*`;
}

const APP_PROVENANCE = '*Computed from app state · no AI used.*';
const ACTIVITY_CAVEAT = 'Line counts measure activity, not value or productivity.';

module.exports = {
  num, signed, pctOf, lines, escRe, cell, ago, renderTable, renderAnswer,
  provenance, APP_PROVENANCE, ACTIVITY_CAVEAT,
};
