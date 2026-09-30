'use strict';

// Answer sections: one renderer per kind of report answer, plus the conversational ones
// (clarification, knowledge article, chat reply, nearest-match fallback).

const { getSettings, db } = require('../db');
const { WEEKDAYS } = require('../../src/analyze');
const { num, signed, pctOf, lines, ago, ACTIVITY_CAVEAT, APP_PROVENANCE } = require('./format');
const { windowRows, sortRows, devTable } = require('./aggregate');

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
  const out = which === 'all'
    ? call('get_branches', { scan_id: scan.id, limit: 30 })
    : call('get_branches', stale
      ? { scan_id: scan.id, stale_only: true, limit: 30 }
      : { scan_id: scan.id, status: 'unmerged', limit: 30 });
  const rows = out.branches;
  const S = report.summary;
  if (!rows.length) {
    return stale
      ? { headline: 'No stale branches in this scan.', bullets: ['Nothing has been sitting unmerged beyond the stale threshold.'] }
      : { headline: 'Everything is merged.', bullets: ['This scan found 0 unmerged branches and 0 unmerged commits.'] };
  }
  if (which === 'all') {
    const byStatus = rows.reduce((m, b) => m.set(b.status, (m.get(b.status) || 0) + 1), new Map());
    return {
      headline: `${num(rows.length)} branches in scan #${scan.id}: ${[...byStatus.entries()].map(([k, v]) => `${num(v)} ${k}`).join(', ')}.`,
      bullets: [
        `${num(S.unmergedCommits)} commits are not in the main branch yet across ${num(S.unmergedBranches)} branch(es).`,
        `${num(S.staleBranches)} branch(es) are stale (unmerged and idle beyond the threshold).`,
      ],
      table: {
        head: ['Branch', 'Repo', 'Status', 'Ahead', 'Idle', 'Who'],
        rows: rows.slice(0, 15).map((b) => [`\`${b.name}\``, b.repo, b.status, num(b.aheadCommits), b.daysIdle == null ? '—' : `${b.daysIdle}d`, (b.developers || []).slice(0, 3).map((d) => d.name).join(', ') || '—']),
      },
      notes: ['Branch status: main, merged, unmerged (not in main yet) or unpushed (local only).'],
    };
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
  if (r.error) return { headline: 'Nothing to compare yet.', bullets: [r.error, 'Run another scan later and the difference will show up here.'] };
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
  const limit = slots.topN || 15;
  const input = { scan_id: scan.id, limit };
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
      bullets: ['Try a different author, date range or commit type.', `This scan holds ${num((report.commitLog || []).length)} commits in total.`],
      notes: ['Nothing to show here — rephrase with a name, a date range or a commit type (feat, fix, docs…).'],
    };
  }
  const rows = r.commits.slice(0, limit);
  const byAuthor = {};
  for (const cm of rows) byAuthor[cm.author] = (byAuthor[cm.author] || 0) + 1;
  const topAuthors = Object.entries(byAuthor).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const suffix = `${who}${where}${slots.type ? ` of type \`${slots.type}\`` : ''}${slots.phrase ? ` matching "${slots.phrase}"` : ''}`;
  const headline = slots.topN && r.total > rows.length
    ? `${num(rows.length)} newest of ${num(r.total)} commits${suffix}.`
    : `${num(r.total)} commit${r.total === 1 ? '' : 's'}${suffix}.`;
  return {
    headline,
    bullets: [
      `Lines: +${num(r.additions)}/-${num(r.deletions)}.`,
      ...topAuthors.map(([a, n]) => `${a}: ${num(n)} commit${n === 1 ? '' : 's'} of the matches.`),
    ],
    table: {
      head: ['Date', 'Author', 'Type', 'Subject', 'Lines'],
      rows: rows.map((cm) => [String(cm.date).slice(0, 10), cm.author, cm.type || '—', cm.subject, `${num(cm.additions)}/${num(cm.deletions)}`]),
    },
    notes: [`Showing the ${num(rows.length)} newest of ${num(r.total)} matching commits.`],
  };
}

// Cross-scan history search: "when did we first touch X", "have we ever …".
function historySection(c) {
  const { slots, call } = c;
  const input = { scan_count: 8, limit: slots.topN || 20 };
  if (slots.dev) input.author = slots.dev.name;
  if (slots.win && slots.win.since) input.since = slots.win.since;
  if (slots.win && slots.win.until) input.until = slots.win.until;
  if (slots.type) input.type = slots.type;
  if (slots.phrase) input.text = slots.phrase;
  const r = call('search_history', input);
  const scans = r.scans_searched.length;
  if (!r.total) {
    return {
      headline: `No matching commits in the last ${scans} scans.`,
      bullets: ['Try a wider time range, a different author, or a simpler phrase.'],
      notes: [`Searched the ${scans} newest finished scans.`],
    };
  }
  const newest = r.commits[0];
  const oldest = r.oldest;
  const who = slots.dev ? ` by ${slots.dev.name}` : '';
  const where = slots.win ? ` in ${slots.win.label}` : '';
  const what = slots.phrase ? ` matching "${slots.phrase}"` : '';
  return {
    headline: `${num(r.total)} matching commit${r.total === 1 ? '' : 's'}${who}${what}${where} across ${scans} scans.`,
    bullets: [
      `First seen ${String(oldest.date).slice(0, 10)}: ${oldest.author} — “${oldest.subject}” (scan #${oldest.scan_id}).`,
      `Most recent ${String(newest.date).slice(0, 10)}: ${newest.author} — “${newest.subject}” (scan #${newest.scan_id}).`,
      `Lines across all matches: +${num(r.additions)}/-${num(r.deletions)}.`,
    ],
    table: {
      head: ['Date', 'Author', 'Subject', 'Scan'],
      rows: r.commits.slice(0, 12).map((cm) => [String(cm.date).slice(0, 10), cm.author, cm.subject, `#${cm.scan_id}`]),
    },
    notes: [`Searched the ${scans} newest finished scans; first-match order is by commit date.`],
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

// ---- conversational sections ------------------------------------------------------------------------

// A clarification asks instead of guessing; the picked option is stored in the dialogue state and
// resolved when the user replies with a number or a name.
function clarifySection(c, question, options) {
  const opts = (options || []).slice(0, 6);
  if (c.state) c.state.pending = { kind: 'developer', options: opts.map((o) => ({ name: o.name, email: o.email })) };
  return {
    headline: question,
    bullets: opts.map((o, i) => `${i + 1}. ${o.name} (${o.email}) — ${num(o.commits)} commits, last commit ${o.lastCommit || 'never'}`),
    notes: ['Reply with the number, the full name or the email address.'],
  };
}

// Existing two-name comparison keeps working, but now through the numbered clarification.
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
  const enriched = cands.map((o) => ({ commits: o.commits ?? 0, lastCommit: o.lastCommit || '—', name: o.name, email: o.email }));
  return clarifySection(c, 'Several developers match that name — which one?', enriched);
}

function knowledgeSection(article) {
  return {
    headline: article.title,
    bullets: article.body,
    notes: article.note ? [article.note] : undefined,
  };
}

function chatSection(reply) {
  return {
    headline: reply.headline,
    bullets: reply.bullets,
    notes: reply.notes,
  };
}

// Nearest-match fallback: instead of a canned "I cannot do that", offer the closest real
// questions, mention what else this assistant can do, and keep the current headline visible.
function fallbackSection(c, suggestions) {
  const tips = suggestions && suggestions.length
    ? [`Did you mean: ${suggestions.map((s) => `"${s}"`).join(' · ')}`]
    : ['Try: "overview of the latest scan" · "top 5 developers by commits" · "unmerged branches" · "hotspot files" · "what changed since the previous scan" · "run a scan".'];
  const bullets = [
    ...tips,
    'I can also chat: ask me a joke, do some math ("what is 12 * 7"), check the time, or ask how something in git works.',
  ];
  if (c.scan) {
    const S = c.report.summary;
    bullets.push(`Current headline anyway: ${num(S.commits)} commits, ${num(S.developers)} developers, ${num(S.unmergedCommits)} unmerged commits, bus factor ${S.busFactor}.`);
  }
  return {
    headline: "I don't have a report for that one yet.",
    bullets,
    notes: ['Switch the assistant to Claude (in the header) for open-ended questions — that needs an API key in Settings.'],
  };
}

module.exports = {
  windowSection, topDevelopersSection, developerProfileSection, branchesSection, codeHealthSection,
  busFactorSection, trendSection, compareSection, commitSearchSection, historySection, repositoriesSection,
  languagesSection, patternsSection, peopleSection, overviewSection, startScanSection, appStatusSection,
  noScanSection, ambiguousSection, clarifySection, knowledgeSection, chatSection, fallbackSection,
  APP_PROVENANCE,
};
