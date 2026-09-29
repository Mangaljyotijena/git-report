'use strict';

const fs = require('fs');
const path = require('path');

function cell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = String(v);
  // Spreadsheet formula injection guard: commit subjects and names are untrusted text.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, rows) {
  const lines = [columns.map((c) => cell(c[0])).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(c[1](r))).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8 names correctly
}

function writeCsv(report, dir) {
  const files = {
    'developers.csv': toCsv([
      ['rank', (d) => d.rank], ['name', (d) => d.name], ['email', (d) => d.email], ['domain', (d) => d.domain],
      ['other_emails', (d) => d.aliases.emails.join('; ')], ['bot', (d) => d.isBot],
      ['commits', (d) => d.commits], ['merges', (d) => d.merges], ['lines_added', (d) => d.additions],
      ['lines_deleted', (d) => d.deletions], ['net_lines', (d) => d.net], ['lines_changed', (d) => d.churn],
      ['share_of_changes_pct', (d) => d.shareOfChurn], ['share_of_commits_pct', (d) => d.shareOfCommits],
      ['co_authored_commits', (d) => d.coAuthoredCommits],
      ['unmerged_commits', (d) => d.unmerged.commits], ['unmerged_lines_added', (d) => d.unmerged.additions],
      ['unmerged_lines_deleted', (d) => d.unmerged.deletions], ['merged_pct', (d) => d.mergedShare],
      ['unmerged_branches', (d) => [...new Set(d.branches.map((b) => b.name))].join('; ')],
      ['files_touched', (d) => d.filesTouched], ['active_days', (d) => d.activeDays],
      ['longest_streak_days', (d) => d.longestStreakDays], ['first_commit', (d) => d.firstCommit],
      ['last_commit', (d) => d.lastCommit], ['days_since_last_commit', (d) => d.daysSinceLastCommit],
      ['avg_lines_per_commit', (d) => d.avgChurnPerCommit], ['median_lines_per_commit', (d) => d.medianChurnPerCommit],
      ['large_commits', (d) => d.largeCommits], ['after_hours_pct', (d) => d.afterHoursShare],
      ['weekend_pct', (d) => d.weekendShare], ['repositories', (d) => d.repos.map((r) => r.name).join('; ')],
      ['top_languages', (d) => d.topLanguages.map((l) => l.language).join('; ')],
      ['owned_lines', (d) => d.ownership?.lines], ['owned_pct', (d) => d.ownership?.share],
    ], report.developers),

    'developer_monthly.csv': toCsv([
      ['name', (r) => r.name], ['email', (r) => r.email], ['month', (r) => r.month], ['commits', (r) => r.commits],
      ['lines_added', (r) => r.additions], ['lines_deleted', (r) => r.deletions],
    ], report.developers.flatMap((d) => d.monthly.filter((m) => m.commits || m.additions || m.deletions)
      .map((m) => ({ name: d.name, email: d.email, ...m })))),

    'developer_repos.csv': toCsv([
      ['name', (r) => r.name], ['email', (r) => r.email], ['repository', (r) => r.repo], ['commits', (r) => r.commits],
      ['lines_added', (r) => r.additions], ['lines_deleted', (r) => r.deletions],
    ], report.developers.flatMap((d) => d.repos.map((r) => ({ name: d.name, email: d.email, repo: r.name, commits: r.commits, additions: r.additions, deletions: r.deletions })))),

    'branches.csv': toCsv([
      ['repository', (b) => b.repo], ['branch', (b) => b.name], ['status', (b) => b.status], ['stale', (b) => b.stale],
      ['local', (b) => b.local], ['remote', (b) => b.remote], ['commits_ahead_of_main', (b) => b.aheadCommits],
      ['lines_added', (b) => b.additions], ['lines_deleted', (b) => b.deletions], ['last_commit', (b) => b.lastCommit],
      ['days_idle', (b) => b.daysIdle], ['developers', (b) => b.developers.map((d) => `${d.name} (${d.commits})`).join('; ')],
    ], report.branches),

    'domains.csv': toCsv([
      ['domain', (d) => d.domain], ['developers', (d) => d.developers], ['commits', (d) => d.commits],
      ['lines_added', (d) => d.additions], ['lines_deleted', (d) => d.deletions], ['share_of_changes_pct', (d) => d.shareOfChurn],
    ], report.domains),

    'files.csv': toCsv([
      ['repository', (f) => f.repo], ['path', (f) => f.path], ['commits', (f) => f.commits], ['lines_added', (f) => f.additions],
      ['lines_deleted', (f) => f.deletions], ['developers', (f) => f.authors], ['main_author', (f) => f.topAuthor],
      ['main_author_pct', (f) => f.topAuthorShare], ['last_changed', (f) => f.lastChanged],
    ], report.hotspots),

    'commits.csv': toCsv([
      ['repository', (c) => c.repo], ['hash', (c) => c.hash], ['date', (c) => c.date], ['author', (c) => c.author],
      ['email', (c) => c.email], ['co_authors', (c) => c.coAuthors], ['merge_commit', (c) => c.merge],
      ['merged_to_main', (c) => c.merged], ['unmerged_branches', (c) => c.branches],
      ['type', (c) => c.type], ['files', (c) => c.files],
      ['lines_added', (c) => c.additions], ['lines_deleted', (c) => c.deletions], ['subject', (c) => c.subject],
    ], report.commitLog),
  };

  return Object.entries(files).map(([name, content]) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content, 'utf8');
    return file;
  });
}

module.exports = { writeCsv, toCsv };
