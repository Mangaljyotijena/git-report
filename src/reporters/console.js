'use strict';

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = paint(1);
const dim = paint(2);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const cyan = paint(36);

const ANSI = /\x1b\[[0-9;]*m/g;
const width = (s) => String(s).replace(ANSI, '').length;
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function table(headers, rows, align) {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i]))));
  const cell = (v, i) => {
    const pad = ' '.repeat(widths[i] - width(v));
    return align[i] === 'r' ? pad + v : v + pad;
  };
  const lines = [
    '  ' + headers.map((h, i) => bold(cell(h, i))).join('  '),
    '  ' + widths.map((w) => dim('─'.repeat(w))).join('  '),
    ...rows.map((r) => '  ' + r.map(cell).join('  ')),
  ];
  return lines.join('\n');
}

function bar(share, size = 16) {
  const filled = Math.round((share / 100) * size);
  return cyan('█'.repeat(filled)) + dim('░'.repeat(size - filled)) + ' ' + share.toFixed(1).padStart(5) + '%';
}

function sparkline(values) {
  const ticks = '▁▂▃▄▅▆▇█';
  const max = Math.max(...values, 1);
  return values.map((v) => (v ? ticks[Math.min(7, Math.floor((v / max) * 7.999))] : ' ')).join('');
}

function heading(text) {
  return '\n' + bold(cyan(text)) + '\n';
}

function renderConsole(report, opts) {
  const { summary: s, meta } = report;
  const out = [];
  const top = opts.top;

  out.push('\n' + bold(meta.title));
  const f = meta.filters;
  const filters = [
    f.since && `since ${f.since}`, f.until && `until ${f.until}`, f.branch && `branch ${f.branch}`,
    f.authors.length && `author ~ ${f.authors.join('|')}`, f.domains.length && `domain ${f.domains.join('|')}`,
    !f.bots && 'no bots',
  ].filter(Boolean);
  out.push(dim(`${s.firstCommit || '-'} → ${s.lastCommit || '-'} (${fmt(s.spanDays)} days)${filters.length ? '  ·  ' + filters.join(', ') : ''}`));

  out.push(heading('Summary'));
  const kv = [
    ['Repositories', fmt(s.repositories)], ['Developers', fmt(s.developers)],
    ['Commits', `${fmt(s.commits)} ${dim(`(+${fmt(s.merges)} merges)`)}`],
    ['Lines added', green('+' + fmt(s.additions))], ['Lines deleted', red('-' + fmt(s.deletions))],
    ['Net lines', fmt(s.net)], ['Files touched', fmt(s.filesTouched)], ['Bus factor', fmt(s.busFactor)],
    ['Active last 30 / 90 days', `${s.activeLast30Days} / ${s.activeLast90Days}`],
    ['Not merged to main', s.unmergedCommits ? yellow(`${fmt(s.unmergedCommits)} commits · +${fmt(s.unmergedAdditions)}/-${fmt(s.unmergedDeletions)} · ${s.unmergedBranches} branches`) : green('nothing pending')],
  ];
  if (s.ownedLines !== null) kv.push(['Lines at HEAD (blamed)', fmt(s.ownedLines)]);
  for (const [k, v] of kv) out.push('  ' + dim(k.padEnd(26)) + v);

  if (report.insights.length) {
    out.push(heading('Insights'));
    const icon = { warn: yellow('!'), good: green('✓'), info: cyan('•') };
    for (const i of report.insights) out.push(`  ${icon[i.level]} ${i.text}`);
  }

  if (report.developers.length) {
    const showOwn = s.ownedLines !== null;
    out.push(heading(`Developers (${report.developers.length}${report.developers.length > top ? `, top ${top}` : ''}, ranked by lines changed)`));
    out.push(table(
      ['#', 'Developer', 'Email', 'Commits', 'Added', 'Deleted', 'Net', 'Files', 'Days', 'Last', 'Unmerged', ...(showOwn ? ['Owns'] : []), 'Share of changes'],
      report.developers.slice(0, top).map((d) => [
        String(d.rank),
        trunc(d.name, 24) + (d.aliases.emails.length ? dim(` +${d.aliases.emails.length}`) : '') + (d.isBot ? dim(' bot') : ''),
        dim(trunc(d.email, 32)),
        fmt(d.commits) + (d.coAuthoredCommits ? dim(` +${d.coAuthoredCommits}co`) : ''),
        green('+' + fmt(d.additions)), red('-' + fmt(d.deletions)), fmt(d.net),
        fmt(d.filesTouched), fmt(d.activeDays), d.lastCommit || '-',
        d.unmerged.commits ? yellow(`${fmt(d.unmerged.commits)} on ${new Set(d.branches.map((b) => b.name)).size} br`) : dim('-'),
        ...(showOwn ? [`${d.ownership.share}%`] : []),
        bar(d.shareOfChurn),
      ]),
      ['r', 'l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'r', ...(showOwn ? ['r'] : []), 'l'],
    ));
    out.push(dim('  Totals include every branch. "Unmerged" = commits that are not on the main branch yet; "co" = co-authored commits.'));
    if (report.developers.some((d) => d.aliases.emails.length)) {
      out.push(dim('  +N = developer committed under N additional email(s); merged by name. Use --no-merge-identities to split.'));
    }
  }

  if (report.domains.length > 1) {
    out.push(heading('By email domain'));
    out.push(table(
      ['Domain', 'Developers', 'Commits', 'Added', 'Deleted', 'Share of changes'],
      report.domains.slice(0, top).map((d) => [d.domain, fmt(d.developers), fmt(d.commits), green('+' + fmt(d.additions)), red('-' + fmt(d.deletions)), bar(d.shareOfChurn)]),
      ['l', 'r', 'r', 'r', 'r', 'l'],
    ));
  }

  const pending = report.branches.filter((b) => b.status === 'unmerged' || b.status === 'unpushed');
  if (pending.length) {
    out.push(heading(`Unmerged branches (${pending.length})`));
    out.push(table(
      ['Branch', 'Status', 'Ahead', 'Added', 'Deleted', 'Last commit', 'Developers'],
      pending.slice(0, top).map((b) => [
        trunc((report.repositories.length > 1 ? b.repo + ':' : '') + b.name, 44) + dim(b.local && !b.remote ? ' (local only)' : ''),
        b.status === 'unpushed' ? red('unpushed') : b.stale ? yellow(`stale ${b.daysIdle}d`) : 'open',
        fmt(b.aheadCommits), green('+' + fmt(b.additions)), red('-' + fmt(b.deletions)), b.lastCommit || '-',
        trunc(b.developers.map((d) => `${d.name} (${d.commits})`).join(', ') || '-', 48),
      ]),
      ['l', 'l', 'r', 'r', 'r', 'l', 'l'],
    ));
  }

  if (report.repositories.length > 1) {
    out.push(heading('Repositories'));
    out.push(table(
      ['Repository', 'Main', 'Commits', 'Devs', 'Added', 'Deleted', 'Unmerged br', 'Bus factor', 'Top developer', 'Last commit'],
      report.repositories.slice().sort((a, b) => b.churn - a.churn).map((r) => [
        r.name + (r.shallow ? yellow(' shallow') : '') + (r.uncommitted ? yellow(' dirty') : ''), dim(r.mainBranch || '-'),
        fmt(r.commits), fmt(r.developers), green('+' + fmt(r.additions)), red('-' + fmt(r.deletions)),
        fmt(r.unmergedBranches), String(r.busFactor), trunc(r.topDeveloper || '-', 22), r.lastCommit || '-',
      ]),
      ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'l', 'l'],
    ));
  }

  if (report.timeline.length > 1) {
    const recent = report.timeline.slice(-24);
    out.push(heading(`Monthly activity (last ${recent.length} months)`));
    out.push(`  ${dim('commits')}  ${sparkline(recent.map((m) => m.commits))}  ${dim(recent[0].month + ' → ' + recent[recent.length - 1].month)}`);
    out.push(`  ${dim('lines  ')}  ${sparkline(recent.map((m) => m.additions + m.deletions))}`);
  }

  if (report.hotspots.length) {
    out.push(heading(`Hotspot files (top ${Math.min(10, report.hotspots.length)})`));
    out.push(table(
      ['File', 'Commits', 'Lines changed', 'Devs', 'Main author'],
      report.hotspots.slice(0, 10).map((h) => [
        trunc((report.repositories.length > 1 ? h.repo + ':' : '') + h.path, 60), fmt(h.commits), fmt(h.churn), fmt(h.authors),
        `${trunc(h.topAuthor, 20)} ${dim(`(${h.topAuthorShare}%)`)}`,
      ]),
      ['l', 'r', 'r', 'r', 'l'],
    ));
  }

  return out.join('\n') + '\n';
}

module.exports = { renderConsole };
