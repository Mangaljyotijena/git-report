'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSettings, loadReport } = require('./db');

const MAX_TOOL_ROUNDS = 12;

function client() {
  const { anthropic_api_key: apiKey } = getSettings({ reveal: true });
  if (!apiKey) throw new Error('No Anthropic API key configured. Add one in Settings (or set ANTHROPIC_API_KEY).');
  return new Anthropic({ apiKey });
}

function aiConfigured() {
  return !!getSettings({ reveal: true }).anthropic_api_key;
}

// ---- data access helpers used by the tools ---------------------------------------------------------
function resolveScan(scanId) {
  const row = scanId
    ? db.prepare("SELECT id, created_at, finished_at, schedule_id, trigger, params FROM scans WHERE id = ? AND status = 'done'").get(scanId)
    : db.prepare("SELECT id, created_at, finished_at, schedule_id, trigger, params FROM scans WHERE status = 'done' ORDER BY id DESC LIMIT 1").get();
  if (!row) throw new Error(scanId ? `Scan ${scanId} not found or not finished.` : 'No finished scans yet. Run a scan first.');
  const report = loadReport(row.id);
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

const SYSTEM_PROMPT = `You are the Git Insights agent inside a self-hosted app that scans git repositories and reports developer contributions and code health.

You answer questions from engineering managers and developers using the tools, which read the stored scan reports (commits, lines changed, branches, unmerged work, hotspots, knowledge silos, activity patterns). Always fetch data with tools before stating numbers; never invent figures. If data is missing, say what is missing and, if useful, offer to start a scan.

How to read the data:
- "churn" = lines added + deleted. Lock files, build output and vendored code are excluded by default.
- Branch status: main (the main branch), merged, unmerged (work not in main yet), unpushed (local only). "stale" = unmerged and idle beyond the stale threshold.
- Bus factor = the smallest number of developers who wrote half of all changes.
- Line counts measure activity, not value or productivity. When you compare people, add that context briefly and avoid ranking people as good or bad.

Style: lead with the answer, then the supporting numbers. Use short markdown: headings only for long answers, bullet lists and small tables where they help. Mention the scan id and its date range when it matters.`;

// ---- the agent loop --------------------------------------------------------------------------------
async function runAgent(messages, { onEvent = () => {} } = {}) {
  const settings = getSettings({ reveal: true });
  const anthropic = client();
  const system = `${SYSTEM_PROMPT}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.beta.messages.create({
      model: settings.ai_model || 'claude-opus-5-5',
      max_tokens: 16000,
      system,
      tools: TOOL_DEFS,
      messages,
      output_config: { effort: settings.ai_effort || 'medium' },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // Keep the full content (thinking, tool_use, fallback blocks) so history stays valid.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      onEvent({ type: 'text', text: 'The model declined to answer this request.' });
      return messages;
    }
    if (response.stop_reason !== 'tool_use') return messages;

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      onEvent({ type: 'tool', name: block.name, input: block.input });
      const tool = TOOL_BY_NAME.get(block.name);
      try {
        if (!tool) throw new Error(`Unknown tool ${block.name}`);
        const out = await tool.run(block.input || {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  messages.push({ role: 'user', content: 'Tool-call limit reached. Answer with what you have so far.' });
  const final = await anthropic.beta.messages.create({
    model: settings.ai_model || 'claude-opus-5-5', max_tokens: 8000, system, tools: TOOL_DEFS, tool_choice: { type: 'none' }, messages,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  messages.push({ role: 'assistant', content: final.content });
  return messages;
}

function lastAssistantText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) return '';
  return (Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }])
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

// Transcript for the UI: user questions, tool calls and assistant answers.
function toTranscript(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') { if (!m.content.startsWith('Tool-call limit')) out.push({ role: 'user', text: m.content }); }
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) out.push({ role: 'assistant', text: b.text });
      else if (b.type === 'tool_use') out.push({ role: 'tool', name: b.name, input: b.input });
    }
  }
  return out;
}

async function chat(conversationId, question, onEvent) {
  let conv = conversationId ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) : null;
  if (!conv) {
    const { lastInsertRowid } = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(question.slice(0, 80));
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(lastInsertRowid));
  }
  const messages = JSON.parse(conv.messages);
  messages.push({ role: 'user', content: question });
  try {
    await runAgent(messages, { onEvent });
  } finally {
    db.prepare("UPDATE conversations SET messages = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(messages), conv.id);
  }
  return { conversationId: conv.id, answer: lastAssistantText(messages) };
}

// Executive summary for a finished scan, used in the email and on the report page.
async function summarizeScan(scanId) {
  const messages = [{
    role: 'user',
    content: `Scan ${scanId} just finished. Write a concise executive summary of it for an engineering-manager email (about 150-300 words). `
      + 'Use get_overview for this scan, and compare_scans with the previous scan when one exists. Cover: overall activity, who drove the work, '
      + 'unmerged/stale work that needs attention, code-health risks (bus factor, silos, hotspots), and changes vs. the previous scan. '
      + 'End with 2-4 concrete recommended actions. Output only the summary in markdown, starting with a one-line headline in bold.',
  }];
  await runAgent(messages);
  return lastAssistantText(messages);
}

module.exports = { chat, summarizeScan, toTranscript, aiConfigured, TOOLS };
