'use strict';

// Windowed aggregates over the same commit log the search tool reads, plus the tool caller that
// streams `{type:'tool'}` events into the SSE response.

const { TOOL_BY_NAME } = require('../tools');
const { num, lines, pctOf } = require('./format');

function windowRows(report, win) {
  const meta = new Map((report.developers || []).map((d) => [d.email, d]));
  const by = new Map();
  for (const c of report.commitLog || []) {
    const d0 = String(c.date).slice(0, 10);
    if (win && win.since && d0 < win.since) continue;
    if (win && win.until && d0 > win.until) continue;
    if (meta.get(c.email)?.isBot) continue;
    let r = by.get(c.email);
    if (!r) {
      r = { email: c.email, name: c.author, commits: 0, merges: 0, additions: 0, deletions: 0, churn: 0, days: new Set(), types: {}, files: new Map(), subjects: [] };
      by.set(c.email, r);
    }
    r.commits++;
    if (c.merge) r.merges++;
    r.additions += c.additions || 0;
    r.deletions += c.deletions || 0;
    r.days.add(d0);
    if (c.type) r.types[c.type] = (r.types[c.type] || 0) + 1;
    for (const f of c.files || []) {
      const p = typeof f === 'string' ? f : f && f.path;
      if (!p) continue;
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '.';
      r.files.set(dir, (r.files.get(dir) || 0) + 1);
    }
    if (r.subjects.length < 2) r.subjects.push({ date: d0, subject: c.subject });
  }
  const rows = [...by.values()];
  const total = rows.reduce((s, r) => { r.churn = r.additions + r.deletions; return s + r.churn; }, 0) || 1;
  for (const r of rows) {
    r.activeDays = r.days.size;
    r.shareOfChurn = Math.round((r.churn / total) * 10000) / 100;
    r.lastCommit = [...r.days].sort().pop();
    r.typesSorted = Object.entries(r.types).sort((a, b) => b[1] - a[1]);
    r.dirsSorted = [...r.files.entries()].sort((a, b) => b[1] - a[1]);
  }
  return rows;
}

function sortRows(rows, metric) {
  const cmp = {
    churn: (a, b) => b.churn - a.churn,
    commits: (a, b) => b.commits - a.commits,
    additions: (a, b) => b.additions - a.additions,
    activeDays: (a, b) => b.activeDays - a.activeDays,
    recency: (a, b) => String(b.lastCommit || '').localeCompare(String(a.lastCommit || '')),
  }[metric] || ((a, b) => b.churn - a.churn);
  return rows.slice().sort(cmp);
}

const devTable = (rows, limit = 10) => ({
  head: ['#', 'Developer', 'Commits', 'Lines', 'Share', 'Active days', 'Last commit'],
  rows: rows.slice(0, limit).map((d, i) => [i + 1, d.name, num(d.commits), lines(d), pctOf(d.shareOfChurn), num(d.activeDays), d.lastCommit || '—']),
});

function makeCaller(onEvent, toolBlocks) {
  return (name, input = {}) => {
    if (onEvent) onEvent({ type: 'tool', name, input });
    toolBlocks.push({ type: 'tool_use', id: `smart-${toolBlocks.length + 1}`, name, input });
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool.run(input);
  };
}

module.exports = { windowRows, sortRows, devTable, makeCaller };
