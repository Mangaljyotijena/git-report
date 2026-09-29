'use strict';

// Smart agent: a deterministic, no-LLM question answering layer over the stored scan reports.
// It parses the question, picks a fixed intent, runs the same shared data tools the Claude agent
// uses (server/tools.js) and renders markdown with a "no AI used" provenance footer.

const { db, getSettings } = require('./db');
const { TOOL_BY_NAME, resolveScan } = require('./tools');
const { WEEKDAYS } = require('../src/analyze');

// ---- formatting ------------------------------------------------------------------------------
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

// A section is { headline?, bullets?, table?, notes? }.
function renderAnswer(sections, provenance) {
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

// ---- question parsing --------------------------------------------------------------------------
const normalize = (s) => String(s || '').toLowerCase().replace(/[^\w\s#./-]+/g, ' ').replace(/\s+/g, ' ').trim();
const UNIT_MS = { day: 864e5, week: 6048e5, month: 26298e5, year: 315576e5 };

function extractWindow(nq) {
  let m;
  if ((m = /\b(?:last|past|previous|over the last|in the last|during the last)\s+(\d{1,3})\s+(day|week|month|year)s?\b/.exec(nq))) {
    const n = Math.min(Number(m[1]), 3650);
    const since = new Date(Date.now() - n * UNIT_MS[m[2]]).toISOString().slice(0, 10);
    return { since, until: null, label: `the last ${n} ${m[2]}${n > 1 ? 's' : ''}` };
  }
  if ((m = /\b(?:last|past|previous)\s+(day|week|month|year)\b/.exec(nq))) {
    const since = new Date(Date.now() - UNIT_MS[m[1]]).toISOString().slice(0, 10);
    return { since, until: null, label: `the last ${m[1]}` };
  }
  if (/\bthis week\b/.test(nq)) {
    const d = new Date();
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 864e5);
    return { since: monday.toISOString().slice(0, 10), until: null, label: 'this week' };
  }
  if (/\bthis month\b/.test(nq)) return { since: `${new Date().toISOString().slice(0, 7)}-01`, until: null, label: 'this month' };
  if (/\blast month\b/.test(nq)) {
    const d = new Date();
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
    return { since: first.toISOString().slice(0, 10), until: last.toISOString().slice(0, 10), label: 'last month' };
  }
  if (/\btoday\b/.test(nq)) { const t = new Date().toISOString().slice(0, 10); return { since: t, until: t, label: 'today' }; }
  if (/\byesterday\b/.test(nq)) { const t = new Date(Date.now() - 864e5).toISOString().slice(0, 10); return { since: t, until: t, label: 'yesterday' }; }
  if ((m = /\b(?:from|since)\s+(\d{4}-\d{2}-\d{2})(?:\s+(?:to|until|-|through)\s+(\d{4}-\d{2}-\d{2}))?\b/.exec(nq))) {
    return { since: m[1], until: m[2] || null, label: m[2] ? `${m[1]} → ${m[2]}` : `since ${m[1]}` };
  }
  if ((m = /\b(?:until|till|before)\s+(\d{4}-\d{2}-\d{2})\b/.exec(nq))) return { since: null, until: m[1], label: `until ${m[1]}` };
  return null;
}

function extractTopN(nq) {
  const m = /\b(?:top|first|best)\s+(\d{1,2})\b/.exec(nq) || /\b(\d{1,2})\s+(?:top|most)\b/.exec(nq);
  return m ? Math.min(Number(m[1]), 50) : 0;
}

function extractMetric(nq) {
  if (/\b(?:lines|churn|changes|code|size|volume)\b/.test(nq) && /\b(?:most|top|largest|biggest)\b/.test(nq)) return 'churn';
  if (/\bcommits?\b/.test(nq) && /\b(?:most|top|many|count)\b/.test(nq)) return 'commits';
  if (/\bactive days|streak|consistency\b/.test(nq)) return 'activeDays';
  if (/\brecent|latest|lately|newest|most recently\b/.test(nq)) return 'recency';
  if (/\badditions|lines added\b/.test(nq)) return 'additions';
  return 'churn';
}

const TYPE_WORDS = {
  features: 'feat', feature: 'feat', feats: 'feat', feat: 'feat',
  fixes: 'fix', fix: 'fix', refactorings: 'refactor', refactor: 'refactor',
  docs: 'docs', doc: 'docs', documentation: 'docs',
  tests: 'test', test: 'test', testing: 'test',
  chores: 'chore', chore: 'chore', styles: 'style', style: 'style',
  perfs: 'perf', perf: 'perf', builds: 'build', build: 'build',
  reverts: 'revert', revert: 'revert', merges: 'merge', merge: 'merge', cis: 'ci', ci: 'ci',
};

function extractType(nq) {
  const m = /\b([a-z]+)\s+commits?\b/.exec(nq) || /\bcommits?\s+(?:of|with|about|tagged)\s+([a-z]+)\b/.exec(nq);
  if (!m) return null;
  return TYPE_WORDS[m[1]] || TYPE_WORDS[m[1].replace(/s$/, '')] || null;
}

const extractPhrase = (q) => (/["“']([^"”']{2,60})["”']/.exec(String(q)) || [])[1] || null;

function extractScanRef(nq) {
  let m = /\bscan\s*#(\d{1,6})\b/.exec(nq);
  if (m) return Number(m[1]);
  m = /\b(?:in|of|for|about|from)\s+scan\s+#?(\d{1,6})\b/.exec(nq);
  return m ? Number(m[1]) : null;
}

const STOP = new Set(['will', 'just', 'very', 'more', 'most', 'some', 'code', 'team', 'work', 'line', 'lines', 'file', 'files',
  'scan', 'scans', 'data', 'have', 'been', 'that', 'this', 'they', 'them', 'than', 'then', 'with', 'from', 'into', 'over',
  'last', 'next', 'good', 'recent', 'branch', 'branches', 'commit', 'commits', 'their', 'there', 'where', 'when', 'what',
  'whom', 'your', 'yours', 'about', 'after', 'before', 'between', 'during', 'under', 'again', 'also', 'only', 'same',
  'such', 'each', 'other', 'being', 'doing', 'having', 'make', 'made', 'know', 'owns', 'left', 'much', 'many', 'like',
  'give', 'gets', 'take', 'help', 'list', 'show', 'tell', 'people', 'person', 'dev', 'devs', 'developer', 'developers',
  'engineer', 'engineers', 'who', 'which', 'how', 'why', 'all', 'any', 'every', 'stats', 'report', 'reports']);

const nameRe = (name) => new RegExp(`(?<![\w])${escRe(name)}(?![\w])`, 'i');

function findDeveloper(report, text) {
  const t = String(text || '');
  if (!t.trim()) return { match: null, candidates: [] };
  const devs = report.developers;
  const email = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/.exec(t)?.[0];
  if (email) {
    const d = devs.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (d) return { match: d, candidates: [] };
  }
  const exact = devs.find((x) => x.name.toLowerCase() === t.trim().toLowerCase());
  if (exact) return { match: exact, candidates: [] };
  const whole = devs.filter((x) => x.name.length >= 2 && nameRe(x.name).test(t)).sort((a, b) => b.name.length - a.name.length);
  if (whole.length) {
    if (whole.filter((x) => x.name.length === whole[0].name.length).length === 1) return { match: whole[0], candidates: [] };
    return { match: null, candidates: whole.slice(0, 5) };
  }
  const tokens = t.toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [];
  const hits = devs.filter((x) => x.name.toLowerCase().split(/\s+/).some((w) => !STOP.has(w) && tokens.includes(w)));
  if (hits.length === 1) return { match: hits[0], candidates: [] };
  if (hits.length > 1) return { match: null, candidates: hits.slice(0, 5) };
  return { match: null, candidates: [] };
}

const isFollowUp = (nq) => /\b(and|also|what about|his|her|their|them|those|these|same|too)\b/.test(nq);

function priorUserText(messages) {
  const prior = messages.slice(0, -1)
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('Tool-call limit'));
  return prior.length ? prior[prior.length - 1] : null;
}

// ---- window aggregates (same commit log the search tool reads) ---------------------------------
function windowRows(report, win) {
  const meta = new Map(report.developers.map((d) => [d.email, d]));
  const by = new Map();
  for (const c of report.commitLog) {
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

// ---- tool calls ---------------------------------------------------------------------------------
function makeCaller(onEvent, toolBlocks) {
  return (name, input = {}) => {
    if (onEvent) onEvent({ type: 'tool', name, input });
    toolBlocks.push({ type: 'tool_use', id: `smart-${toolBlocks.length + 1}`, name, input });
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool.run(input);
  };
}

// ---- intent scoring helper ------------------------------------------------------------------------
const hit = (nq, ...pairs) => {
  let best = 0;
  for (const [re, weight] of pairs) if (re.test(nq)) best = Math.max(best, weight);
  return best;
};

// ---- answer sections ------------------------------------------------------------------------------
function windowSection(c) {
  const rows = sortRows(windowRows(c.report, c.slots.win), c.slots.metric);
  const totals = rows.reduce((t, r) => ({ commits: t.commits + r.commits, additions: t.additions + r.additions, deletions: t.deletions + r.deletions }), { commits: 0, additions: 0, deletions: 0 });
  const label = c.slots.win.label;
  if (!rows.length) return { headline: `No commits in ${label}.`, bullets: ['Try a wider window, or ask about the whole scan.'] };
  const top = rows[0];
  const multi = rows.filter((r) => r.activeDays > 1).length;
  return {
    headline: `In ${label}: ${num(totals.commits)} commits, +${num(totals.additions)}/-${num(totals.deletions)} lines from ${num(rows.length)} developer${rows.length === 1 ? '' : 's'}.`,
    bullets: [
      `${top.name} contributed the most: ${num(top.commits)} commits, ${lines(top)} (${pctOf(top.shareOfChurn)} of the lines in this window).`,
      `${num(multi)} developer${multi === 1 ? '' : 's'} committed on more than one distinct day.`,
      `Main areas: ${[...rows.reduce((m, r) => { for (const [d, n] of r.dirsSorted.slice(0, 3)) m.set(d, (m.get(d) || 0) + n); return m; }, new Map()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([d, n]) => `\`${d}\` (${n})`).join(', ') || '—'}.`,
    ],
    table: devTable(rows, 10),
    notes: [ACTIVITY_CAVEAT],
  };
}

function topDevelopersSection(c) {
  const { slots, report, call } = c;
  const limit = slots.topN || 10;
  let rows;
  if (slots.win) {
    rows = sortRows(windowRows(report, slots.win), slots.metric);
  } else {
    const out = call('get_developers', { scan_id: c.scan.id, sort_by: slots.metric === 'recency' ? 'daysSinceLastCommit' : slots.metric, limit: 50, include_bots: false });
    rows = out.developers;
  }
  rows = sortRows(rows, slots.metric);
  if (!rows.length) return { headline: 'No developers matched.', bullets: ['The scan contains no non-bot developers.'] };
  const metricName = { churn: 'changed lines', commits: 'commits', additions: 'lines added', activeDays: 'active days', recency: 'most recent activity' }[slots.metric] || 'changed lines';
  return {
    headline: `Top ${Math.min(limit, rows.length)} developers by ${metricName}${slots.win ? ` (${slots.win.label})` : ''}.`,
    table: devTable(rows, limit),
    notes: [ACTIVITY_CAVEAT, `Share is the percentage of changed lines${slots.win ? ' in this window' : ' in this scan'}.`],
  };
}

function developerProfileSection(c) {
  const { slots, call } = c;
  const dev = slots.dev;
  const out = call('get_developers', { scan_id: c.scan.id, filter: dev.name, detail: true, limit: 5, include_bots: true });
  const d = out.developers.find((x) => x.email === dev.email) || out.developers[0];
  if (!d) return { headline: `No data for ${dev.name} in this scan.` };
  const types = Object.entries(d.commitTypes || {}).slice(0, 4).map(([k, v]) => `${k} (${v.count})`);
  const months = (d.monthly || []).filter((m) => m.commits).slice(-6);
  const recent = months[months.length - 1];
  const prev = months[months.length - 2];
  const trend = recent && prev ? (recent.commits === prev.commits ? 'flat' : recent.commits > prev.commits ? `up (${recent.commits} vs ${prev.commits} in ${recent.month})` : `down (${recent.commits} vs ${prev.commits} in ${recent.month})`) : null;
  return {
    headline: `${d.name} · ${d.email}`,
    bullets: [
      `${num(d.commits)} commits (${num(d.merges)} merges), ${lines(d)} — ${pctOf(d.shareOfChurn)} of all changed lines, ${pctOf(d.shareOfCommits)} of commits.`,
      `Active ${d.firstCommit || '?'} → ${d.lastCommit || '?'} · ${num(d.activeDays)} active days · longest streak ${num(d.longestStreakDays)} days · last commit ${ago(d.lastCommit)}.`,
      `Unmerged work: ${num(d.unmerged ? d.unmerged.commits : 0)} commit(s), ${num(d.unmerged && d.unmerged.additions)} additions.`,
      `Large commits (1000+ lines): ${num(d.largeCommits)} · after-hours ${pctOf(d.afterHoursShare)} · weekends ${pctOf(d.weekendShare)}.`,
      `Top areas: ${(d.topDirectories || []).slice(0, 4).map((x) => `\`${x.directory}\``).join(', ') || '—'} · languages: ${(d.topLanguages || []).slice(0, 4).map((x) => x.language).join(', ') || '—'}.`,
      `Repositories: ${(d.repos || []).slice(0, 4).map((x) => `${x.name} (${num(x.commits)})`).join(', ') || '—'}.`,
      ...(types.length ? [`Commit types: ${types.join(', ')}.`] : []),
      ...(trend ? [`Monthly activity is ${trend}.`] : []),
      ...(d.aliases && (d.aliases.names.length || d.aliases.emails.length) ? [`Merged identities: ${(d.aliases.names || []).concat(d.aliases.emails || []).join(', ')}.`] : []),
    ],
    table: months.length ? { head: ['Month', 'Commits', 'Lines'], rows: months.map((m) => [m.month, num(m.commits), `${num(m.additions)}/${num(m.deletions)}`]) } : null,
    notes: [ACTIVITY_CAVEAT],
  };
}

function branchesSection(c, which) {
  const { scan, call, report } = c;
  const stale = which === 'stale';
  const out = call('get_branches', stale
    ? { scan_id: scan.id, stale_only: true, limit: 30 }
    : { scan_id: scan.id, status: 'unmerged', limit: 30 });
  const rows = out.branches;
  const S = report.summary;
  if (!rows.length) {
    return stale
      ? { headline: 'No stale branches in this scan.', bullets: ['Nothing has been sitting unmerged beyond the stale threshold.'] }
      : { headline: 'Everything is merged.', bullets: ['This scan found 0 unmerged branches and 0 unmerged commits.'] };
  }
  const topDevs = report.developers
    .filter((d) => !d.isBot && d.unmerged && d.unmerged.commits)
    .sort((a, b) => b.unmerged.churn - a.unmerged.churn)
    .slice(0, 5);
  const authors = [...new Set(rows.flatMap((b) => (b.developers || []).map((d) => d.name)))].slice(0, 5);
  return {
    headline: stale
      ? `${num(S.staleBranches)} stale branch${S.staleBranches === 1 ? '' : 'es'} (unmerged and idle).`
      : `${num(S.unmergedCommits)} commits across ${num(S.unmergedBranches)} unmerged branches (${num(S.unmergedAdditions)}/${num(S.unmergedDeletions)} lines).`,
    bullets: [
      `${authors.length} developer${authors.length === 1 ? '' : 's'} with open branches: ${authors.join(', ') || '—'}.`,
      ...(topDevs.length ? [`Most work not in the main branch: ${topDevs.map((d) => `${d.name} (${num(d.unmerged.commits)})`).join(', ')}.`] : []),
    ],
    table: {
      head: ['Branch', 'Repo', 'Ahead', 'Idle', 'Who'],
      rows: rows.slice(0, 15).map((b) => [`\`${b.name}\``, b.repo, num(b.aheadCommits), b.daysIdle == null ? '—' : `${b.daysIdle}d`, (b.developers || []).slice(0, 3).map((d) => d.name).join(', ') || '—']),
    },
    notes: [stale ? 'Stale = unmerged and idle beyond the stale threshold (default 30 days).' : 'Unmerged = commits that are not on the main branch yet.'],
  };
}

function codeHealthSection(c, kind) {
  const { scan, call, report } = c;
  const out = call('get_code_health', { scan_id: scan.id, limit: 15 });
  if (kind === 'hotspots') {
    if (!out.hotspots.length) return { headline: 'No file activity in this scan.' };
    const solo = out.hotspots.filter((f) => f.authors <= 2).length;
    return {
      headline: `Top ${Math.min(10, out.hotspots.length)} most-changed files.`,
      bullets: [
        `\`${out.hotspots[0].path}\` leads with ${num(out.hotspots[0].commits)} commits and ${num(out.hotspots[0].churn)} changed lines across ${num(out.hotspots[0].authors)} developers.`,
        `${num(solo)} of the top files were changed by 2 developers or fewer.`,
      ],
      table: {
        head: ['File', 'Repo', 'Commits', 'Lines', 'Devs', 'Most from'],
        rows: out.hotspots.slice(0, 10).map((f) => [`\`${f.path}\``, f.repo, num(f.commits), num(f.churn), num(f.authors), `${f.topAuthor} (${f.topAuthorShare}%)`]),
      },
      notes: ['Churn = lines added + deleted; generated and vendored files are excluded by your scan filters.'],
    };
  }
  if (!out.silos.length) return { headline: 'No knowledge silos detected.', bullets: ['No file with 4+ commits is 90%+ written by a single developer.'] };
  return {
    headline: `${num(out.silos.length)} files are 90%+ owned by one developer.`,
    bullets: [
      `${out.silos[0].path} is ${out.silos[0].topAuthorShare}% ${out.silos[0].topAuthor} (${num(out.silos[0].commits)} commits, ${num(out.silos[0].churn)} lines).`,
      `Bus factor for the whole scan is ${report.summary.busFactor}.`,
    ],
    table: {
      head: ['File', 'Owner', 'Share', 'Commits', 'Lines', 'Last changed'],
      rows: out.silos.slice(0, 10).map((f) => [`\`${f.path}\``, f.topAuthor, `${f.topAuthorShare}%`, num(f.commits), num(f.churn), f.lastChanged || '—']),
    },
    notes: ['Only files with at least 4 commits are considered.'],
  };
}

function busFactorSection(c) {
  const { report, call } = c;
  const ov = call('get_overview', { scan_id: c.scan.id });
  const S = ov.summary;
  const half = S.churn / 2;
  let acc = 0;
  const core = [];
  for (const d of report.developers) {
    if (acc >= half) break;
    core.push(d);
    acc += d.churn;
  }
  const silos = report.silos.length;
  const inactive = report.developers.filter((d) => !d.isBot && (d.daysSinceLastCommit ?? 0) > 90).length;
  return {
    headline: `Bus factor is ${S.busFactor}: ${S.busFactor === 1 ? 'one developer' : `${S.busFactor} developers`} wrote half of all changed lines.`,
    bullets: [
      `${num(S.developers - inactive)} of ${num(S.developers)} developers committed in the last 90 days (${num(inactive)} inactive).`,
      `${num(silos)} file${silos === 1 ? '' : 's'} are 90%+ single-owner (knowledge silos).`,
      `Top contributor: ${report.developers[0] ? `${report.developers[0].name} (${pctOf(report.developers[0].shareOfChurn)} of all changed lines)` : '—'}.`,
      `${num(S.activeLast30Days)} developer${S.activeLast30Days === 1 ? '' : 's'} active in the last 30 days.`,
    ],
    table: { head: ['Developer', 'Lines', 'Share', 'Last commit'], rows: core.slice(0, 8).map((d) => [d.name, num(d.churn), pctOf(d.shareOfChurn), d.lastCommit || '—']) },
    notes: ['Bus factor = the fewest developers who together account for half of all changed lines.', ACTIVITY_CAVEAT],
  };
}

function trendSection(c) {
  const { scan, call, slots } = c;
  const out = call('get_code_health', { scan_id: scan.id, limit: 5 });
  let tl = out.timeline;
  if (slots.win && slots.win.since) tl = tl.filter((m) => m.month >= slots.win.since.slice(0, 7));
  if (slots.win && slots.win.until) tl = tl.filter((m) => m.month <= slots.win.until.slice(0, 7));
  if (!tl.length) return { headline: 'No monthly activity in that window.', bullets: ['Widen the date range or check the scan filters.'] };
  const last = tl[tl.length - 1];
  const prev = tl.length > 1 ? tl[tl.length - 2] : null;
  const peak = tl.slice().sort((a, b) => b.commits - a.commits)[0];
  const delta = prev && prev.commits ? Math.round(((last.commits - prev.commits) / prev.commits) * 100) : null;
  const tot = tl.reduce((s, m) => ({ commits: s.commits + m.commits, additions: s.additions + m.additions, deletions: s.deletions + m.deletions }), { commits: 0, additions: 0, deletions: 0 });
  return {
    headline: `${num(tl.length)} months in view: ${tl[0].month} → ${last.month}.`,
    bullets: [
      `${last.month}: ${num(last.commits)} commits, ${lines(last)} from ${num(last.developers)} developers${delta == null ? '' : ` (${signed(delta)}% vs ${prev.month})`}.`,
      `Busiest month: ${peak.month} with ${num(peak.commits)} commits and ${num(peak.developers)} developers.`,
      `Total in view: ${num(tot.commits)} commits, ${lines(tot)}.`,
    ],
    table: { head: ['Month', 'Commits', 'Lines', 'Devs'], rows: tl.slice(-12).map((m) => [m.month, num(m.commits), signed(m.additions - m.deletions), num(m.developers)]) },
    notes: ['Monthly buckets use author-local commit dates.'],
  };
}

function compareSection(c) {
  const { scan, call } = c;
  const r = call('compare_scans', { newer_scan_id: scan.id });
  if (r.error) return { headline: 'Nothing to compare yet.', bullets: [r.error] };
  const order = ['commits', 'developers', 'additions', 'deletions', 'churn', 'unmergedCommits', 'staleBranches', 'busFactor', 'filesTouched'];
  const rows = order.filter((k) => r.summary[k]).map((k) => [
    k.replace(/([A-Z])/g, ' $1').toLowerCase(), num(r.summary[k].before), num(r.summary[k].after), signed(r.summary[k].change),
  ]);
  const movers = (r.developerChanges || []).filter((d) => Math.abs(d.churnChange) > 0).slice(0, 4);
  const gone = r.developersNoLongerPresent || [];
  const sameFilters = JSON.stringify(r.older.filters) === JSON.stringify(r.newer.filters);
  return {
    headline: `Scan #${r.older.id} → scan #${r.newer.id}.`,
    bullets: [
      ...movers.map((d) => `${d.name}: ${signed(d.commitsChange)} commits, ${signed(d.churnChange)} lines${d.new ? ' (new in this scan)' : ''}.`),
      ...(gone.length ? [`No longer present: ${gone.join(', ')}.`] : []),
    ],
    table: { head: ['Metric', `Scan #${r.older.id}`, `Scan #${r.newer.id}`, 'Change'], rows },
    notes: [
      sameFilters ? 'Both scans used the same filters.' : 'The two scans used different filters or repositories — treat the delta with care.',
      ACTIVITY_CAVEAT,
    ],
  };
}

function commitSearchSection(c) {
  const { scan, call, slots, report } = c;
  const input = { scan_id: scan.id, limit: 15 };
  if (slots.dev) input.author = slots.dev.name;
  if (slots.win && slots.win.since) input.since = slots.win.since;
  if (slots.win && slots.win.until) input.until = slots.win.until;
  if (slots.type) input.type = slots.type;
  if (slots.phrase) input.text = slots.phrase;
  const r = call('search_commits', input);
  const who = slots.dev ? ` by ${slots.dev.name}` : '';
  const where = slots.win ? ` in ${slots.win.label}` : '';
  if (!r.total) {
    return {
      headline: `No commits matched${who}${where}.`,
      bullets: ['Try a different author, date range or commit type.', `This scan holds ${num(report.commitLog.length)} commits in total.`],
    };
  }
  const byAuthor = {};
  for (const cm of r.commits) byAuthor[cm.author] = (byAuthor[cm.author] || 0) + 1;
  const topAuthors = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return {
    headline: `${num(r.total)} commit${r.total === 1 ? '' : 's'}${who}${where}${slots.type ? ` of type \`${slots.type}\`` : ''}${slots.phrase ? ` matching "${slots.phrase}"` : ''}.`,
    bullets: [
      `Lines: +${num(r.additions)}/-${num(r.deletions)}.`,
      ...topAuthors.map(([a, n]) => `${a}: ${num(n)} commit${n === 1 ? '' : 's'} of the matches.`),
    ],
    table: {
      head: ['Date', 'Author', 'Type', 'Subject', 'Lines'],
      rows: r.commits.slice(0, 15).map((cm) => [String(cm.date).slice(0, 10), cm.author, cm.type || '—', cm.subject, `${num(cm.additions)}/${num(cm.deletions)}`]),
    },
    notes: [`Showing the ${Math.min(15, r.commits.length)} newest of ${num(r.total)} matching commits.`],
  };
}

function repositoriesSection(c) {
  const { scan, call } = c;
  const ov = call('get_overview', { scan_id: scan.id });
  const configured = call('list_repositories', {});
  const rows = ov.repositories.slice().sort((a, b) => b.commits - a.commits);
  const broken = configured.filter((r) => r.last_error);
  const disabled = configured.filter((r) => !r.enabled);
  return {
    headline: `${num(ov.summary.repositories)} repositor${ov.summary.repositories === 1 ? 'y' : 'ies'} in scan #${scan.id}, ${num(configured.length)} configured in the app.`,
    bullets: [
      ...rows.slice(0, 3).map((r) => `${r.name}: ${num(r.commits)} commits, ${num(r.developers)} developers, bus factor ${r.busFactor}${r.unmergedBranches ? `, ${num(r.unmergedBranches)} unmerged branch(es)` : ''}.`),
      ...(broken.length ? [`Sync errors: ${broken.map((r) => `${r.name} (${r.last_error})`).join(', ')}.`] : []),
      ...(disabled.length ? [`Disabled (not scanned): ${disabled.map((r) => r.name).join(', ')}.`] : []),
    ],
    table: {
      head: ['Repo', 'Commits', 'Lines', 'Devs', 'Unmerged br.', 'Bus factor', 'Last commit'],
      rows: rows.map((r) => [r.name, num(r.commits), lines(r), num(r.developers), num(r.unmergedBranches), num(r.busFactor), r.lastCommit || '—']),
    },
  };
}

function languagesSection(c) {
  const ov = c.call('get_overview', { scan_id: c.scan.id });
  if (!ov.languages.length) return { headline: 'No language data in this scan.' };
  return {
    headline: `${num(ov.languages.length)} language${ov.languages.length === 1 ? '' : 's'} by changed lines.`,
    bullets: [
      `${ov.languages[0].language} accounts for ${pctOf(ov.languages[0].share)} of all churn.`,
      `Top 3: ${ov.languages.slice(0, 3).map((l) => `${l.language} ${pctOf(l.share)}`).join(', ')}.`,
    ],
    table: { head: ['Language', 'Lines', 'Share'], rows: ov.languages.slice(0, 10).map((l) => [l.language, num(l.churn), pctOf(l.share)]) },
  };
}

function patternsSection(c) {
  const out = c.call('get_code_health', { scan_id: c.scan.id, limit: 5 });
  const hm = out.heatmap && out.heatmap.length === 7 ? out.heatmap : c.report.heatmap;
  const dayTotals = hm.map((r) => r.reduce((s, v) => s + v, 0));
  const hourTotals = Array.from({ length: 24 }, (_, h) => hm.reduce((s, r) => s + r[h], 0));
  const total = c.report.summary.commits || 1;
  const busiestDay = dayTotals.indexOf(Math.max(...dayTotals));
  const busiestHour = hourTotals.indexOf(Math.max(...hourTotals));
  const weekend = (dayTotals[0] + dayTotals[6]) / total;
  const offHours = (hourTotals.slice(0, 7).reduce((s, v) => s + v, 0) + hourTotals.slice(20).reduce((s, v) => s + v, 0)) / total;
  return {
    headline: `Busiest day: ${WEEKDAYS[busiestDay]}; busiest hour: ${String(busiestHour).padStart(2, '0')}:00 (author local time).`,
    bullets: [
      `${Math.round(weekend * 100)}% of commits land on weekends.`,
      `${Math.round(offHours * 100)}% of commits happen between 20:00 and 07:00.`,
      `${String(busiestHour).padStart(2, '0')}:00 is the single busiest hour with ${num(Math.max(...hourTotals))} commits.`,
    ],
    table: { head: ['Day', 'Commits', 'Share'], rows: dayTotals.map((v, i) => [WEEKDAYS[i], num(v), `${Math.round((v / total) * 100)}%`]) },
    notes: ['Hours are the author-local time of each commit.'],
  };
}

function peopleSection(c) {
  const out = c.call('get_developers', { scan_id: c.scan.id, sort_by: 'daysSinceLastCommit', limit: 50, include_bots: false });
  const inactive = out.developers.filter((d) => (d.daysSinceLastCommit ?? 0) > 90);
  const newcomers = out.developers.filter((d) => d.firstCommit && (Date.now() - Date.parse(d.firstCommit)) / 864e5 <= 90);
  if (!inactive.length && !newcomers.length) {
    return { headline: 'No inactive or new developers detected.', bullets: [`${num(out.total)} developers, all active within the last 90 days.`] };
  }
  return {
    headline: `${num(inactive.length)} inactive (90+ days), ${num(newcomers.length)} newcomer${newcomers.length === 1 ? '' : 's'} (first commit within 90 days).`,
    bullets: [
      ...(inactive.length ? [`Inactive: ${inactive.slice(0, 6).map((d) => `${d.name} (last: ${d.lastCommit || 'never'})`).join(', ')}.`] : []),
      ...(newcomers.length ? [`Newcomers: ${newcomers.slice(0, 6).map((d) => `${d.name} (since ${d.firstCommit})`).join(', ')}.`] : []),
    ],
    table: inactive.length ? {
      head: ['Developer', 'Last commit', 'Days inactive', 'Commits', 'Lines'],
      rows: inactive.slice(0, 12).map((d) => [d.name, d.lastCommit || '—', num(d.daysSinceLastCommit), num(d.commits), lines(d)]),
    } : null,
    notes: [ACTIVITY_CAVEAT],
  };
}

function overviewSection(c) {
  const ov = c.call('get_overview', { scan_id: c.scan.id });
  const S = ov.summary;
  const top = c.report.developers.filter((d) => !d.isBot).slice(0, 5);
  const insights = ov.insights || [];
  const picked = insights.filter((i) => i.level === 'warn' || i.level === 'good').slice(0, 2)
    .concat(insights.filter((i) => i.level === 'info').slice(0, 2));
  return {
    headline: `${num(S.commits)} commits by ${num(S.developers)} developers across ${num(S.repositories)} repositories (${S.firstCommit} → ${S.lastCommit}), +${num(S.additions)}/-${num(S.deletions)} lines.`,
    bullets: [
      `Bus factor ${S.busFactor} · ${num(S.activeLast30Days)} active in the last 30 days · ${num(S.filesTouched)} files touched.`,
      `${num(S.unmergedCommits)} unmerged commits across ${num(S.unmergedBranches)} branches · ${num(S.staleBranches)} stale branches.`,
      ...picked.map((i) => i.text),
    ],
    table: top.length ? {
      head: ['#', 'Developer', 'Commits', 'Lines', 'Share'],
      rows: top.map((d) => [d.rank, d.name, num(d.commits), lines(d), pctOf(d.shareOfChurn)]),
    } : null,
    notes: [ACTIVITY_CAVEAT],
  };
}

function startScanSection(c) {
  const repos = c.call('list_repositories', {});
  if (!repos.length) {
    return { headline: 'No repositories configured yet.', bullets: ['Add a repository under Repositories first, then ask me to scan.'] };
  }
  const cleaned = c.nq.replace(/\b(?:now|again|please|fresh|new|full|run|start|launch|trigger|execute|rerun|re-run)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const m = /\bscan\s+(?:the\s+|my\s+|our\s+|all\s+)?(.+)$/.exec(cleaned);
  const tail = m ? m[1].replace(/\b(?:repo|repository|repositories|project|codebase|scan)\b/g, '').replace(/\s+/g, ' ').trim() : '';
  let repoIds = [];
  let scoped = '';
  if (tail && !/^(all|everything|every|enabled)$/.test(tail)) {
    const matches = repos.filter((r) => tail.includes(r.name.toLowerCase()) || r.name.toLowerCase().includes(tail));
    if (!matches.length) {
      return { headline: `No repository matches "${tail}".`, bullets: [`Configured repositories: ${repos.map((r) => r.name).join(', ')}.`] };
    }
    repoIds = matches.map((r) => r.id);
    scoped = ` (${matches.map((r) => r.name).join(', ')})`;
  }
  const out = c.call('start_scan', repoIds.length ? { repo_ids: repoIds } : {});
  return {
    headline: `Scan queued${scoped}.`,
    bullets: [out.message, `Queued as scan #${out.queued_scan_id} — it appears under Scans when finished.`],
    notes: ['Ask me for an overview once it is done.'],
  };
}

function appStatusSection() {
  const s = getSettings({ reveal: true });
  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM scans GROUP BY status').all();
  const by = Object.fromEntries(counts.map((x) => [x.status, x.n]));
  const last = db.prepare("SELECT id, finished_at, summary FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT 1").get();
  const running = db.prepare("SELECT id, status FROM scans WHERE status IN ('queued','running') ORDER BY id DESC").all();
  const repos = db.prepare('SELECT COUNT(*) AS n, SUM(enabled) AS e FROM repos').get();
  const repoErrors = db.prepare('SELECT name, last_error FROM repos WHERE last_error IS NOT NULL').all();
  const schedules = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1').get().n;
  const lastSched = db.prepare('SELECT name, last_run_at FROM schedules WHERE last_run_at IS NOT NULL ORDER BY last_run_at DESC LIMIT 1').get();
  const head = last && last.summary ? JSON.parse(last.summary).summary : null;
  const mode = s.agent_mode || 'auto';
  const effective = mode === 'smart' ? 'Smart agent' : mode === 'claude' ? (s.anthropic_api_key ? 'Claude' : 'Claude (no API key — will error)') : (s.anthropic_api_key ? 'Claude' : 'Smart agent');
  return {
    headline: `${num(by.done || 0)} finished scans · ${num(repos.n)} repositories · ${num(schedules)} enabled schedules.`,
    bullets: [
      last ? `Last finished scan: #${last.id} (${ago(last.finished_at)})${head ? ` — ${num(head.commits)} commits, ${num(head.developers)} developers.` : '.'}` : 'No finished scans yet.',
      running.length ? `Running now: ${running.map((r) => `#${r.id} (${r.status})`).join(', ')}.` : 'Nothing running.',
      `Repos: ${num(repos.e || 0)} enabled of ${num(repos.n)}${repoErrors.length ? ` · errors: ${repoErrors.map((r) => r.name).join(', ')}` : ''}.`,
      `Email: ${s.smtp_user && s.smtp_password ? 'configured' : 'not configured'} · Anthropic key: ${s.anthropic_api_key ? 'configured' : 'not set'} · assistant mode: ${mode} → answered by ${effective}.`,
      lastSched && lastSched.last_run_at ? `Last schedule run: ${lastSched.name} (${ago(lastSched.last_run_at)}).` : 'No schedule has run yet.',
    ],
    notes: ['Ask "run a scan" to start one, or open Scans for history.'],
  };
}

function helpSection() {
  return {
    headline: 'I answer questions from your stored scan data — no AI model involved.',
    bullets: [
      'Overview, trends, comparisons: "overview of the latest scan", "trend per month", "what changed since the last scan".',
      'People: "top 5 by commits", "what is Alice working on", "who is inactive", "each developer last 7 days".',
      'Code health: "hotspot files", "knowledge silos", "bus factor", "stale branches", "unmerged work".',
      'Breakdowns: repositories, languages, commit search ("find feat commits by Alice"), working-hours patterns.',
      'Actions: "run a scan" (or "scan repo api").',
    ],
    notes: [
      'Every number comes from a finished scan; scan answers end with a scan id and a "no AI used" footer.',
      'Switch the assistant to Claude for open-ended synthesis — that mode needs an API key in Settings.',
    ],
  };
}

function fallbackSection(c) {
  const base = {
    headline: 'I could not match that to a fixed report question.',
    bullets: [
      'Try: "overview of the latest scan" · "top 5 developers by commits" · "unmerged branches" · "hotspot files" · "what changed since the previous scan" · "run a scan".',
      'I am the deterministic Smart agent: a fixed set of report analyses, no free-form reasoning.',
    ],
    notes: ['Switch the assistant to Claude (in the header) for open-ended questions — that needs an API key in Settings.'],
  };
  if (!c.scan) return base;
  const S = c.report.summary;
  return {
    ...base,
    bullets: [...base.bullets, `Current headline anyway: ${num(S.commits)} commits, ${num(S.developers)} developers, ${num(S.unmergedCommits)} unmerged commits, bus factor ${S.busFactor}.`],
  };
}

function ambiguousSection(c) {
  const cands = c.slots.candidates || [];
  if (cands.length === 2 && cands.every((x) => c.nq.includes(x.name.toLowerCase()))) {
    const out = c.call('get_developers', { scan_id: c.scan.id, limit: 50, include_bots: false });
    const rows = out.developers.filter((d) => cands.some((x) => x.email === d.email));
    return {
      headline: `Comparing ${cands.map((x) => x.name).join(' and ')}.`,
      table: {
        head: ['Developer', 'Commits', 'Lines', 'Share', 'Active days', 'Last commit'],
        rows: rows.map((d) => [d.name, num(d.commits), lines(d), pctOf(d.shareOfChurn), num(d.activeDays), d.lastCommit || '—']),
      },
      notes: [ACTIVITY_CAVEAT, 'Ask about one of them by full name for a full profile.'],
    };
  }
  return {
    headline: 'Several developers match that name — which one?',
    bullets: cands.map((x) => `${x.name} (${x.email}) — ${num(x.commits)} commits, last commit ${x.lastCommit || 'never'}.`),
    notes: ['Re-ask with the full name or the email address.'],
  };
}

// ---- intents --------------------------------------------------------------------------------------
const INTENTS = [
  { name: 'help', score: (c) => hit(c.nq,
      [/\bwhat can you do\b/, 5],
      [/\b(?:capabilit\w*|how (?:do you|does this) work|who are you)\b/, 5],
      [/\bare you (?:an? )?(?:ai|llm|model|bot|human)\b/, 5],
      [/\bwhat are (?:your|the) (?:options|commands|skills)\b/, 5],
      [/\bhelp\b/, 3]), run: helpSection },

  { name: 'start_scan', score: (c) => hit(c.nq,
      [/\b(?:run|start|launch|trigger|kick off|execute|rerun|re-run)\w*\s+(?:a\s+|an\s+|the\s+|another\s+)?(?:fresh\s+|new\s+|full\s+|quick\s+)?(?:scan|rescan)\b/, 5],
      [/\brescans?\b|\bscan again\b|\bscan now\b/, 5],
      [/\brefresh (?:the )?(?:data|report|stats|numbers)\b/, 4],
      [/\bscan\b[^.?!]{0,60}\brepos?\b/, 4],
      [/^(?:please\s+)?scan\s+(?!#|\d)[a-z]/, 4]), run: startScanSection },

  { name: 'ambiguous', score: (c) => (!c.slots.dev && (c.slots.candidates || []).length > 1 ? 4 : 0), run: ambiguousSection },

  { name: 'stale_branches', score: (c) => hit(c.nq,
      [/\bstale\b/, 5],
      [/\b(?:clean(?:\s?up)?|delete|prune|remove|purge)\b[^.?!]{0,40}\bbranches?\b/, 5],
      [/\b(?:old|idle|abandoned|dead|unused|rotting)\b[^.?!]{0,25}\bbranches?\b/, 4],
      [/\bbranches?\b[^.?!]{0,25}\b(?:cleanup|clean up|to clean)\b/, 4]), run: (c) => branchesSection(c, 'stale') },

  { name: 'unmerged', score: (c) => hit(c.nq,
      [/\bunmerged\b|\bnot (?:yet )?merged\b|\bnever merged\b/, 5],
      [/\bwork not in\b|\bnot in (?:the )?main\b|\bahead of (?:the )?(?:main|master)\b/, 5],
      [/\bwhat (?:is|remains|still) (?:unmerged|open)\b/, 5],
      [/\bopen (?:work|branches|prs?)\b|\bpending (?:merge|work)\b|\bwip\b|\bneeds? merging\b/, 4]), run: (c) => branchesSection(c, 'unmerged') },

  { name: 'hotspots', score: (c) => hit(c.nq,
      [/\bhot ?spots?\b/, 5],
      [/\bmost changed\b|\bfrequently changed\b|\bchanged (?:the )?most\b/, 5],
      [/\bmost (?:touched|modified|edited)\b|\bwhere do we (?:change|edit|touch)\b/, 5],
      [/\b(?:risky|churny|unstable) files?\b|\bcode churn\b/, 4]), run: (c) => codeHealthSection(c, 'hotspots') },

  { name: 'silos', score: (c) => hit(c.nq,
      [/\bsilos?\b/, 5],
      [/\bonly (?:one|a single|1) (?:person|developer|dev|engineer|author)\b/, 5],
      [/\bsingle (?:owner|author|maintainer)\b|\bone person (?:knows|owns|wrote|maintains)\b/, 5],
      [/\bknowledge (?:gap|concentration)\b|\bowned by (?:one|a single)\b/, 4]), run: (c) => codeHealthSection(c, 'silos') },

  { name: 'bus_factor', score: (c) => hit(c.nq,
      [/\bbus ?factor\b|\btruck ?factor\b/, 5],
      [/\bsingle point of (?:failure|risk)\b|\bkey person (?:risk)?\b/, 5],
      [/\bwhat if\b[^.?!]{0,30}\b(?:leaves|left|quits|goes)\b/, 5],
      [/\bknowledge concentrat/i, 4],
      [/\brisk\b/, 2]), run: busFactorSection },

  { name: 'compare', score: (c) => hit(c.nq,
      [/\bcompared? (?:with|to|against|versus)\b|\bcompare\b/, 6],
      [/\bversus\b|\bvs\.?\b/, 6],
      [/\bwhat changed\b|\bdiff(?:erence)? (?:since|with|vs|from)\b|\bdelta\b/, 6],
      [/\bsince (?:the )?last (?:scan|report|time)\b/, 5],
      [/\bprevious (?:scan|report)\b/, 5],
      [/\bchanges?\b[^.?!]{0,30}\b(?:over|between|from)\b/, 3]), run: compareSection },

  { name: 'trend', score: (c) => hit(c.nq,
      [/\btrends?\b|\bover time\b|\btimeline\b/, 5],
      [/\b(?:per|by|over) months?\b|\bmonth by month\b|\bmonthly\b/, 5],
      [/\bgrowing\b|\bdeclining\b|\bincreasing\b|\bdecreasing\b/, 4],
      [/\b(?:commits|activity|contributions)\b[^.?!]{0,40}\b(?:last|past|previous)\s+\d+\s+(?:months|years)\b/, 4],
      [/\bthis year\b|\blast year\b|\bquarter\b/, 3]), run: trendSection },

  { name: 'window_activity', score: (c) => {
    if (!c.slots.win || c.slots.dev) return 0;
    const specific = hit(c.nq,
      [/\b(?:each|every|all)\s+(?:developers?|people|devs|engineers)\b|\beveryone\b|\bby (?:developer|person|dev)\b|\bworked on\b|\bbreakdown\b|\bwho did what\b/, 5],
      [/\bcommits?\b|\bchanges\b|\bactivity\b|\bwork\b/, 3]);
    return Math.max(specific, 2);
  }, run: windowSection },

  { name: 'top_developers', score: (c) => hit(c.nq,
      [/\btop\s+\d+\s+(?:developers|people|engineers|devs|contributors)\b/, 6],
      [/\b(?:most|top|fewest)\s+\d*\s*(?:commits|contributors?|active|churn|lines|changes|additions)\b/, 5],
      [/\bwho\s+(?:committed|contributed|wrote|made|does)\s+(?:the\s+)?(?:most|least)\b/, 5],
      [/\b(?:leaderboard|ranking|rankings|standings)\b/, 5],
      [/\bmost active\b/, 5],
      [/\bwho (?:is|are) the (?:top|best|biggest|highest)\b/, 4],
      [/\bhow many commits did (?:each|everyone|they|the team)\b/, 4]), run: topDevelopersSection },

  { name: 'commit_search', score: (c) => Math.max(hit(c.nq,
      [/\b(?:find|search|show|list|recent|latest|newest|last)\s+(?:the\s+)?(?:commits?|merges?|patches)\b/, 6],
      [/\bcommits?\b[^.?!]{0,40}\b(?:about|mentioning|for|with|tagged)\b/, 5],
      [/\bwhat (?:did|has)\b[^.?!]{0,60}\bcommit(?:s|ted)?\b/, 6],
      [/\bwhen (?:did|has|was)\b[^.?!]{0,60}\bcommit(?:s|ted)?\b/, 6],
      [/\b(?:merge|feat|feature|fix|refactor|docs|test|chore|perf|ci) commits?\b/, 5],
      [/\bcommit (?:subjects?|messages?|types?|log|history|search|list)\b/, 5],
      [/\bcommits?\b/, 3],
      [/\bcommit\b/, 2]), (c.slots.win && /\bcommits?\b/.test(c.nq)) ? 4 : 0), run: commitSearchSection },

  { name: 'developer_profile', score: (c) => {
    if (!c.slots.dev) return 0;
    const s = hit(c.nq,
      [/\b(?:working on|profile|contributions?|breakdown|activity|tenure|streaks?|share|percentage|languages|directories|stats)\b/, 5],
      [/\bhow (?:active|productive|consistent|often|much|many)\b/, 5],
      [/\b(?:his|her|their)\b/, 4],
      [/\babout\b/, 3],
      [/\bwho is\b|\bwho was\b/, 3]);
    return Math.max(s, c.nq.length <= 40 ? 3 : 0);
  }, run: developerProfileSection },

  { name: 'repositories', score: (c) => hit(c.nq,
      [/\bper repo\b|\bby repo\b|\bwhich repos?\b/, 6],
      [/\brepositories\b/, 4],
      [/\brepos?\b/, 4]), run: repositoriesSection },

  { name: 'languages', score: (c) => hit(c.nq,
      [/\blanguages?\b/, 5],
      [/\bwhere is the (?:code|lines|churn)\b/, 5],
      [/\btech stack\b/, 5],
      [/\bfile types?\b/, 4]), run: languagesSection },

  { name: 'patterns', score: (c) => hit(c.nq,
      [/\b(?:work|working) (?:hours|patterns?|habits?|times?)\b/, 6],
      [/\bbusiest\b/, 5],
      [/\bweekends?\b|\bsaturdays?\b|\bsundays?\b/, 5],
      [/\bafter hours\b|\bovernight\b|\bat night\b|\blate at night\b/, 5],
      [/\b(?:monday|tuesday|wednesday|thursday|friday)\b/, 5],
    [/\bwhat time\b|\bhours\b/, 4],
    [/\bwhen\b[^.?!]{0,40}\b(?:active|busiest|team|everyone|people)\b/, (c.slots.dev || /\bcommit/.test(c.nq)) ? 0 : 6],
    [/\bwhen (?:do|does|did|are|is|was)\b/, (c.slots.dev || /\bcommit/.test(c.nq)) ? 0 : 4]), run: patternsSection },

  { name: 'people', score: (c) => hit(c.nq,
      [/\binactive\b|\bdormant\b|\bstopped (?:committing|working|contributing)\b|\bno longer (?:committing|active|working)\b|\bhasn'?t committed\b|\bwho left\b|\bleft the (?:team|company|project)\b/, 5],
      [/\bnewcomers?\b|\bjoined\b|\bonboard\w*\b|\bwho (?:is|are) new\b|\bnew (?:developers?|people|team members?)\b/, 5]), run: peopleSection },

  { name: 'app_status', score: (c) => hit(c.nq,
      [/\bhow many scans\b/, 6],
      [/\bscan status\b|\bscan finished\b|\bwhen did (?:the )?scan\b|\blast scan\b/, 5],
      [/\bnext (?:schedule|run)\b|\bschedules?\b/, 4],
      [/\bis (?:email|smtp|ai|the (?:api )?key) (?:configured|set up|working|ready)\b/, 6],
      [/\bstatus (?:of|for) (?:the )?(?:app|system|scan|email|ai)\b/, 6],
      [/\bwhat data do you have\b/, 6],
      [/\bhow many repos\b/, 5]), run: appStatusSection },

  { name: 'overview', score: (c) => hit(c.nq,
      [/\boverviews?\b/, 6],
      [/\bsummaries\b|\bsummary\b/, 5],
      [/\bhow (?:are|is) (?:things|it going|the (?:team|project|repo|codebase))\b/, 6],
      [/\brecap\b|\bdigest\b/, 6],
      [/\bhealth\b/, 4],
      [/\bstatus\b/, 3],
      [/\b(?:scan|report|stats|numbers)\b/, 2],
      [/\bwhat'?s going on\b/, 5],
      [/\btell me about (?:the )?(?:scan|report|data)\b/, 5]), run: overviewSection },
];

const NO_SCAN_INTENTS = new Set(['help', 'start_scan', 'app_status']);

function noScanSection(err) {
  const notFound = /not found/.test(err.message);
  return {
    headline: notFound ? 'That scan is not available.' : 'No finished scans yet.',
    bullets: notFound
      ? [err.message, 'Ask about the latest scan instead, or check the list under Scans.']
      : [err.message, 'Run a scan first: press "Run scan" on the dashboard, or ask me to "run a scan".',
        'Then ask for an overview, top developers, unmerged branches or hotspots.'],
    notes: ['I only answer from finished scans.'],
  };
}

function planFor(nq, raw, prior, report) {
  const slots = {
    win: extractWindow(nq),
    topN: extractTopN(nq),
    metric: extractMetric(nq),
    type: extractType(nq),
    phrase: extractPhrase(raw),
    dev: null,
    candidates: [],
  };
  const found = findDeveloper(report, raw);
  slots.dev = found.match;
  slots.candidates = found.candidates;
  if (!slots.dev && !slots.candidates.length && prior && isFollowUp(nq)) {
    const f2 = findDeveloper(report, prior);
    if (f2.match || f2.candidates.length) {
      slots.dev = f2.match;
      slots.candidates = f2.candidates;
    }
  }
  if (!slots.win && prior && isFollowUp(nq)) slots.win = extractWindow(normalize(prior));
  const probe = { nq, slots };
  let intent = null;
  let score = 0;
  for (const it of INTENTS) {
    const s = it.score(probe);
    if (s > score) { score = s; intent = it; }
  }
  return { nq, raw, slots, intent, score };
}

function finish(messages, onEvent, toolBlocks, md) {
  messages.push({ role: 'assistant', content: [...toolBlocks, { type: 'text', text: md }] });
  if (onEvent) onEvent({ type: 'text', text: md });
  return md;
}

// ---- entry points ---------------------------------------------------------------------------------
async function run(question, messages, { onEvent = () => {} } = {}) {
  const q = String(question || '').slice(0, 2000);
  const nq = normalize(q);
  const toolBlocks = [];
  const call = makeCaller(onEvent, toolBlocks);
  const prior = priorUserText(messages);

  let scan = null;
  let report = null;
  let scanError = null;
  try {
    ({ scan, report } = resolveScan(extractScanRef(nq)));
  } catch (err) {
    scanError = err;
    report = { developers: [], summary: {}, commitLog: [], meta: {}, branches: [], silos: [], heatmap: [], insights: [] };
  }

  // "X and Y" questions are split into two intents when both halves score on their own.
  let plans = [];
  const parts = nq.split(/\s+(?:and|&)\s+/).map((p) => p.trim()).filter((p) => p.length >= 3);
  if (parts.length === 2) {
    const a = planFor(parts[0], parts[0], prior, report);
    const b = planFor(parts[1], parts[1], prior, report);
    if (a.score >= 2 && b.score >= 2 && a.intent && b.intent && a.intent !== b.intent) plans = [a, b];
  }
  if (!plans.length) plans = [planFor(nq, q, prior, report)];

  const sections = [];
  if (scanError) {
    const p = plans[0];
    if (p.intent && NO_SCAN_INTENTS.has(p.intent.name)) {
      sections.push(p.intent.run({ q, nq, scan: null, report, slots: p.slots, call }));
    } else {
      sections.push(noScanSection(scanError));
    }
    const prov = p.intent && p.intent.name === 'app_status' ? APP_PROVENANCE : null;
    return finish(messages, onEvent, toolBlocks, renderAnswer(sections, prov));
  }

  for (const p of plans) {
    const ctx = { q: p.raw, nq: p.nq, scan, report, slots: p.slots, call };
    try {
      sections.push(p.intent ? p.intent.run(ctx) : fallbackSection(ctx));
    } catch (err) {
      sections.push({ headline: 'That query failed.', bullets: [err.message] });
    }
  }

  const kinds = plans.map((p) => (p.intent ? p.intent.name : 'fallback'));
  let prov = null;
  if (kinds.every((k) => k === 'help')) prov = null;
  else if (kinds.every((k) => k === 'help' || k === 'app_status')) prov = APP_PROVENANCE;
  else {
    const win = plans.find((p) => p.slots.win);
    prov = provenance(scan, report, win ? win.slots.win.label : null);
  }
  return finish(messages, onEvent, toolBlocks, renderAnswer(sections, prov));
}

// Executive summary for a finished scan: deterministic, used when Claude is not configured.
function summarizeScan(scanId) {
  const { scan, report } = resolveScan(scanId);
  const call = makeCaller(null, []);
  const S = report.summary;
  const top = report.developers.filter((d) => !d.isBot).slice(0, 5);
  const cc = call('get_code_health', { scan_id: scan.id, limit: 5 });
  const staleRows = call('get_branches', { scan_id: scan.id, stale_only: true, limit: 10 }).branches;
  const dayTotals = cc.heatmap.map((r) => r.reduce((s, v) => s + v, 0));
  const busiestDay = WEEKDAYS[dayTotals.indexOf(Math.max(...dayTotals))];
  const peak = cc.timeline.slice().sort((a, b) => b.commits - a.commits)[0];
  const inactive = report.developers.filter((d) => !d.isBot && (d.daysSinceLastCommit ?? 0) > 90);

  const sections = [
    { headline: `Scan #${scan.id}: ${num(S.commits)} commits by ${num(S.developers)} developers across ${num(S.repositories)} repositories (${S.firstCommit} → ${S.lastCommit}).` },
    {
      headline: 'Activity',
      bullets: [
        `${lines(S)} lines changed across ${num(S.filesTouched)} files · ${num(S.activeLast30Days)} developers active in the last 30 days.`,
        `Busiest day: ${busiestDay} · busiest month: ${peak ? `${peak.month} (${num(peak.commits)} commits)` : '—'}.`,
      ],
    },
    {
      headline: 'Who drove the work',
      table: top.length ? { head: ['Developer', 'Commits', 'Lines', 'Share'], rows: top.map((d) => [d.name, num(d.commits), lines(d), pctOf(d.shareOfChurn)]) } : null,
      notes: [ACTIVITY_CAVEAT],
    },
  ];

  const attention = [
    `Bus factor ${S.busFactor}${S.busFactor <= 2 ? ' — knowledge is concentrated' : ''} · ${num(report.silos.length)} knowledge-silo file(s).`,
  ];
  if (S.unmergedCommits) attention.push(`${num(S.unmergedCommits)} commits across ${num(S.unmergedBranches)} branches are not in the main branch yet (${num(S.unmergedAdditions)}/${num(S.unmergedDeletions)} lines).`);
  if (staleRows.length) attention.push(`Stale branches: ${staleRows.slice(0, 3).map((b) => `\`${b.name}\` (${b.daysIdle}d idle)`).join(', ')}.`);
  else attention.push('No stale branches.');
  if (inactive.length) attention.push(`${inactive.length} developer(s) have not committed in 90+ days: ${inactive.slice(0, 3).map((d) => d.name).join(', ')}.`);
  sections.push({ headline: 'Needs attention', bullets: attention });

  try {
    const cmp = compareSection({ scan, call });
    if (!cmp.headline.startsWith('Nothing')) sections.push(cmp);
  } catch (err) { /* comparison is optional */ }

  const actions = [];
  if (S.staleBranches) actions.push(`Clean up ${num(S.staleBranches)} stale branch(es): ${staleRows.slice(0, 3).map((b) => b.name).join(', ')}${S.staleBranches > 3 ? ' …' : ''}.`);
  if (S.unmergedCommits) actions.push(`Review and merge or close the ${num(S.unmergedCommits)} unmerged commit(s).`);
  if (S.busFactor <= 2 && top.length > 1) actions.push(`Pair on the hottest files with ${top.slice(0, 2).map((d) => d.name).join(' and ')} to raise the bus factor (currently ${S.busFactor}).`);
  if (report.silos.length) actions.push(`Spread ownership of ${num(report.silos.length)} single-owner file(s): ${report.silos.slice(0, 2).map((f) => f.path).join(', ')}.`);
  if (inactive.length) actions.push(`Re-engage or backfill: ${inactive.slice(0, 2).map((d) => d.name).join(', ')} have not committed in 90+ days.`);
  if (!actions.length) actions.push('No urgent actions: nothing is stale or unmerged and knowledge is spread across the team.');
  sections.push({ headline: 'Recommended actions', bullets: actions.slice(0, 4) });

  return renderAnswer(sections, provenance(scan, report));
}

module.exports = { run, summarizeScan };
