'use strict';

// Data access tools shared by the Claude agent loop (agent.js) and the no-LLM smart agent (smart.js).
// Every tool is a pure read of stored scans, except start_scan which queues a scan.
const { db, loadReport } = require('./db');

function resolveScan(scanId) {
  const row = scanId
    ? db.prepare("SELECT id, created_at, finished_at, schedule_id, trigger, params FROM scans WHERE id = ? AND status = 'done'").get(scanId)
    : db.prepare("SELECT id, created_at, finished_at, schedule_id, trigger, params FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT 1").get();
  if (!row) throw new Error(scanId ? `Scan ${scanId} not found or not finished.` : 'No finished scans yet.');
  const report = loadReport(row.id);
  if (!report) throw new Error(`Scan ${row.id} finished but its report is not available (it may have been pruned).`);
  return { scan: { ...row, params: JSON.parse(row.params) }, report };
}

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
const matches = (text, needle) => !needle || String(text || '').toLowerCase().includes(String(needle).toLowerCase());
const DEV_FIELDS = ['rank', 'name', 'email', 'isBot', 'commits', 'merges', 'additions', 'deletions', 'net', 'churn', 'filesTouched',
  'shareOfCommits', 'shareOfChurn', 'activeDays', 'longestStreakDays', 'firstCommit', 'lastCommit', 'daysSinceLastCommit',
  'avgChurnPerCommit', 'medianChurnPerCommit', 'largeCommits', 'afterHoursShare', 'weekendShare', 'mergedShare', 'coAuthoredCommits'];

const TOOLS = [
  {
    name: 'list_repositories',
    description: 'List the git repositories configured in the app, with sync status and last error.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => db.prepare('SELECT id, name, source, url, local_path, main_branch, enabled, last_synced_at, last_error FROM repos ORDER BY name').all(),
  },
  {
    name: 'list_scans',
    description: 'List recent scans (newest first) with their status, trigger, filters and headline numbers. Use to find scan ids for other tools or for comparisons over time.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max rows, default 20' }, schedule_id: { type: 'integer' } },
      additionalProperties: false,
    },
    run: ({ limit = 20, schedule_id: sid }) => {
      const rows = sid
        ? db.prepare('SELECT id, schedule_id, trigger, status, params, created_at, finished_at, error, summary FROM scans WHERE schedule_id = ? ORDER BY id DESC LIMIT ?').all(sid, limit)
        : db.prepare('SELECT id, schedule_id, trigger, status, params, created_at, finished_at, error, summary FROM scans ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map((r) => {
        const s = r.summary ? JSON.parse(r.summary).summary : null;
        return {
          id: r.id, schedule_id: r.schedule_id, trigger: r.trigger, status: r.status, filters: JSON.parse(r.params),
          created_at: r.created_at, finished_at: r.finished_at, error: r.error,
          headline: s && pick(s, ['repositories', 'developers', 'commits', 'additions', 'deletions', 'firstCommit', 'lastCommit', 'unmergedCommits', 'staleBranches', 'busFactor']),
        };
      });
    },
  },
  {
    name: 'list_schedules',
    description: 'List the periodic scan schedules (cron, repositories, filters, email recipients).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => db.prepare('SELECT id, name, cron, timezone, repo_ids, since, options, recipients, send_email, ai_summary, enabled, last_run_at FROM schedules').all()
      .map((s) => ({ ...s, repo_ids: JSON.parse(s.repo_ids), options: JSON.parse(s.options) })),
  },
  {
    name: 'get_overview',
    description: 'Summary totals, auto-generated insights, per-repository stats, email domains and languages for one scan (latest finished scan when scan_id is omitted).',
    input_schema: { type: 'object', properties: { scan_id: { type: 'integer' } }, additionalProperties: false },
    run: ({ scan_id: id }) => {
      const { scan, report } = resolveScan(id);
      return { scan, meta: report.meta, summary: report.summary, insights: report.insights, repositories: report.repositories, domains: report.domains, languages: report.languages };
    },
  },
  {
    name: 'get_developers',
    description: 'Per-developer contribution metrics for a scan. Optionally filter by name/email text, sort and limit. Set detail=true (best with a name filter) for branches, repos, languages, directories, commit types and monthly activity.',
    input_schema: {
      type: 'object',
      properties: {
        scan_id: { type: 'integer' },
        filter: { type: 'string', description: 'Substring of name or email' },
        sort_by: { type: 'string', enum: ['churn', 'commits', 'additions', 'deletions', 'activeDays', 'daysSinceLastCommit', 'largeCommits', 'afterHoursShare'] },
        limit: { type: 'integer', description: 'Default 25' },
        include_bots: { type: 'boolean' },
        detail: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    run: ({ scan_id: id, filter, sort_by: sortBy, limit = 25, include_bots: bots = false, detail = false }) => {
      const { scan, report } = resolveScan(id);
      let devs = report.developers.filter((d) => (bots || !d.isBot) && (matches(d.name, filter) || matches(d.email, filter)));
      if (sortBy) devs = devs.slice().sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));
      return {
        scan_id: scan.id,
        total: devs.length,
        developers: devs.slice(0, limit).map((d) => (detail
          ? { ...pick(d, DEV_FIELDS), aliases: d.aliases, unmerged: d.unmerged, branches: d.branches.slice(0, 15), repos: d.repos, topLanguages: d.topLanguages, topDirectories: d.topDirectories, commitTypes: d.commitTypes, monthly: d.monthly.filter((m) => m.commits), ownership: d.ownership }
          : { ...pick(d, DEV_FIELDS), unmergedCommits: d.unmerged.commits })),
      };
    },
  },
  {
    name: 'get_branches',
    description: 'Branches with status (main | merged | unmerged | unpushed), ahead commits, idle days, stale flag and contributing developers.',
    input_schema: {
      type: 'object',
      properties: {
        scan_id: { type: 'integer' },
        status: { type: 'string', enum: ['main', 'merged', 'unmerged', 'unpushed'] },
        repo: { type: 'string' },
        stale_only: { type: 'boolean' },
        limit: { type: 'integer', description: 'Default 50' },
      },
      additionalProperties: false,
    },
    run: ({ scan_id: id, status, repo, stale_only: staleOnly, limit = 50 }) => {
      const { scan, report } = resolveScan(id);
      const rows = report.branches.filter((b) => (!status || b.status === status) && matches(b.repo, repo) && (!staleOnly || b.stale));
      return { scan_id: scan.id, total: rows.length, branches: rows.slice(0, limit) };
    },
  },
  {
    name: 'get_code_health',
    description: 'Hotspot files (most changed), knowledge silos (files 90%+ written by one person), monthly timeline and weekday x hour commit heatmap (rows Sun..Sat, columns hour 0..23).',
    input_schema: { type: 'object', properties: { scan_id: { type: 'integer' }, limit: { type: 'integer' } }, additionalProperties: false },
    run: ({ scan_id: id, limit = 25 }) => {
      const { scan, report } = resolveScan(id);
      return { scan_id: scan.id, hotspots: report.hotspots.slice(0, limit), silos: report.silos.slice(0, limit), timeline: report.timeline, heatmap: report.heatmap };
    },
  },
  {
    name: 'search_commits',
    description: 'Search the commit log of a scan. All filters are optional and combined with AND. Dates are YYYY-MM-DD. Returns newest first.',
    input_schema: {
      type: 'object',
      properties: {
        scan_id: { type: 'integer' },
        author: { type: 'string', description: 'Substring of author name or email' },
        repo: { type: 'string' },
        text: { type: 'string', description: 'Substring of the commit subject' },
        type: { type: 'string', description: 'Commit type, e.g. feat, fix, refactor, docs, test, chore, merge' },
        since: { type: 'string' },
        until: { type: 'string' },
        unmerged_only: { type: 'boolean' },
        limit: { type: 'integer', description: 'Default 50, max 300' },
      },
      additionalProperties: false,
    },
    run: ({ scan_id: id, author, repo, text, type, since, until, unmerged_only: unmergedOnly, limit = 50 }) => {
      const { scan, report } = resolveScan(id);
      const rows = report.commitLog.filter((c) => (matches(c.author, author) || matches(c.email, author))
        && matches(c.repo, repo) && matches(c.subject, text) && (!type || c.type === type)
        && (!since || c.date.slice(0, 10) >= since) && (!until || c.date.slice(0, 10) <= until)
        && (!unmergedOnly || !c.merged))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const totals = rows.reduce((t, c) => ({ additions: t.additions + c.additions, deletions: t.deletions + c.deletions }), { additions: 0, deletions: 0 });
      return {
        scan_id: scan.id, total: rows.length, ...totals,
        commits: rows.slice(0, Math.min(limit, 300)).map((c) => ({ ...c, hash: c.hash.slice(0, 10), branches: c.merged ? undefined : c.branches })),
      };
    },
  },
  {
    name: 'compare_scans',
    description: 'Compare two scans: change in summary totals and per-developer commits/churn. Useful for "what changed since last week". Defaults: newer = latest scan, older = the scan before it.',
    input_schema: { type: 'object', properties: { older_scan_id: { type: 'integer' }, newer_scan_id: { type: 'integer' } }, additionalProperties: false },
    run: ({ older_scan_id: olderId, newer_scan_id: newerId }) => {
      const newer = resolveScan(newerId);
      const prev = olderId || db.prepare("SELECT id FROM scans WHERE status = 'done' AND id < ? ORDER BY id DESC LIMIT 1").get(newer.scan.id)?.id;
      if (!prev) return { error: 'There is no earlier finished scan to compare with.' };
      const older = resolveScan(prev);
      const delta = {};
      for (const [k, v] of Object.entries(newer.report.summary)) {
        if (typeof v === 'number' && typeof older.report.summary[k] === 'number') delta[k] = { before: older.report.summary[k], after: v, change: v - older.report.summary[k] };
      }
      const before = new Map(older.report.developers.map((d) => [d.email, d]));
      const devs = newer.report.developers.map((d) => {
        const o = before.get(d.email);
        before.delete(d.email);
        return { name: d.name, email: d.email, commits: d.commits, commitsChange: d.commits - (o?.commits || 0), churnChange: d.churn - (o?.churn || 0), new: !o };
      }).filter((d) => d.commitsChange || d.churnChange).sort((a, b) => Math.abs(b.churnChange) - Math.abs(a.churnChange));
      return {
        older: { id: older.scan.id, at: older.scan.finished_at, filters: older.scan.params },
        newer: { id: newer.scan.id, at: newer.scan.finished_at, filters: newer.scan.params },
        note: 'Scans with different repositories or date filters are not directly comparable; check the filters.',
        summary: delta,
        developerChanges: devs.slice(0, 40),
        developersNoLongerPresent: [...before.values()].map((d) => d.name).slice(0, 20),
      };
    },
  },
  {
    name: 'search_history',
    description: 'Search commit logs across several recent scans at once — for questions that span time, such as when something was first touched or who worked on a topic over months. Filters are optional and combined with AND; results are newest first and tagged with scan_id.',
    input_schema: {
      type: 'object',
      properties: {
        scan_count: { type: 'integer', description: 'How many recent scans to search, default 5, max 12' },
        author: { type: 'string', description: 'Substring of author name or email' },
        repo: { type: 'string' },
        text: { type: 'string', description: 'Substring of the commit subject' },
        type: { type: 'string', description: 'Commit type, e.g. feat, fix, docs' },
        since: { type: 'string' },
        until: { type: 'string' },
        limit: { type: 'integer', description: 'Default 50, max 200' },
      },
      additionalProperties: false,
    },
    run: ({ scan_count: scanCount = 5, author, repo, text, type, since, until, limit = 50 }) => {
      const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
      const ids = db.prepare("SELECT id FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT ?")
        .all(Math.min(Math.max(Number(scanCount) || 5, 1), 12)).map((r) => r.id).reverse();
      let rows = [];
      for (const id of ids) {
        const report = loadReport(id);
        if (!report) continue;
        const hits = (report.commitLog || [])
          .filter((c) => (matches(c.author, author) || matches(c.email, author))
            && matches(c.repo, repo) && matches(c.subject, text) && (!type || c.type === type)
            && (!since || c.date.slice(0, 10) >= since) && (!until || c.date.slice(0, 10) <= until))
          .map((c) => ({ ...c, scan_id: id, hash: c.hash.slice(0, 10), branches: c.merged ? undefined : c.branches }));
        rows.push(...hits);
      }
      rows.sort((a, b) => (a.date < b.date ? 1 : -1));
      const totals = rows.reduce((t, c) => ({ additions: t.additions + c.additions, deletions: t.deletions + c.deletions }), { additions: 0, deletions: 0 });
      const oldest = rows.length ? rows[rows.length - 1] : null;
      return {
        scans_searched: ids, total: rows.length, ...totals,
        oldest: oldest && { date: oldest.date, author: oldest.author, subject: oldest.subject, repo: oldest.repo, scan_id: oldest.scan_id, hash: oldest.hash },
        commits: rows.slice(0, cap),
      };
    },
  },
  {
    name: 'get_recent_activity',
    description: 'Live git activity from the last N days (or hours) across repositories (fetches first unless fetch=false). Use for "what happened in the last 7/15/30 days" questions that need data newer than the last finished scan. Returns totals, per-developer totals with their top changed files, and per-branch summaries with lines added and removed.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Look-back window in days, e.g. 7, 15 or 30. Max 31. Ignored when hours is given.' },
        hours: { type: 'integer', description: 'Look-back window in hours, default 24, max 744' },
        repo_ids: { type: 'array', items: { type: 'integer' } },
        fetch: { type: 'boolean', description: 'Fetch remotes first, default true' },
      },
      additionalProperties: false,
    },
    run: async ({ hours, days, repo_ids: repoIds = [], fetch = true }) => {
      const { recentActivity } = require('./scanner');
      const { activityHours } = require('../src/activity');
      const r = await recentActivity({
        repoIds: repoIds.map(Number).filter(Boolean),
        hours: hours === undefined ? activityHours(days, null) : activityHours(null, hours),
        fetch: fetch !== false,
      });
      return {
        generatedAt: r.generatedAt, since: r.since, hours: r.hours, days: r.hours / 24, totals: r.totals, warnings: r.warnings,
        repositories: r.repositories,
        developers: (r.developers || []).slice(0, 25).map((d) => ({
          name: d.name, commits: d.commits, merges: d.merges, additions: d.additions, deletions: d.deletions,
          files: d.files, branches: d.branches, topFiles: d.topFiles,
          recent: (d.log || []).slice(0, 5).map((c) => ({ date: c.date, subject: c.subject, repo: c.repo, merge: c.merge })),
        })),
        branches: (r.branches || []).slice(0, 20).map((b) => ({
          name: b.name, repo: b.repo, commits: b.commits, additions: b.additions, deletions: b.deletions,
          status: b.status, developers: b.developers,
        })),
      };
    },
  },
  {
    name: 'start_scan',
    description: 'Queue a new scan (all enabled repositories unless repo_ids is given). It runs in the background; results appear in list_scans once finished. Only use when the user asks for fresh data.',
    input_schema: {
      type: 'object',
      properties: {
        repo_ids: { type: 'array', items: { type: 'integer' } },
        since: { type: 'string', description: 'e.g. "30 days ago" or 2025-01-01' },
        no_bots: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    run: ({ repo_ids: repoIds = [], since, no_bots: noBots = true }) => {
      const { queueScan } = require('./scanner');
      const id = queueScan({ repoIds, params: { since: since || null, noBots }, trigger: 'agent' });
      return { queued_scan_id: id, message: 'Scan queued. It usually takes seconds to a few minutes.' };
    },
  },
];

const TOOL_DEFS = TOOLS.map(({ run, ...def }) => def);
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

module.exports = { TOOLS, TOOL_DEFS, TOOL_BY_NAME, resolveScan, pick, matches, DEV_FIELDS };
