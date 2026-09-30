'use strict';

// Smart agent entry point: a deterministic, no-LLM conversation layer over the stored scan reports.
// Pipeline: parse the question → resolve the scan → pick intents (with dialogue memory) → render,
// falling back to small talk, the knowledge base or nearest-match suggestions when nothing fits.

const { db } = require('../db');
const { resolveScan } = require('../tools');
const { WEEKDAYS } = require('../../src/analyze');
const knowledge = require('../knowledge');
const { num, pctOf, lines, renderAnswer, provenance, APP_PROVENANCE, ACTIVITY_CAVEAT } = require('./format');
const { makeCaller } = require('./aggregate');
const { INTENTS, NO_SCAN_INTENTS, nearestMatches, FOLLOWUPS } = require('./intents');
const converse = require('./converse');
const {
  normalize, canonicalize, extractScanRef, extractWindow, extractTopN, extractMetric, extractType,
  extractPhrase, findDeveloper, isFollowUp, isEllipsis, priorUserText,
} = require('./parse');
const { pendingReply, carrySlots, remember } = require('./state');
const SEC = require('./sections');

const MIN_SCORE = 2;

const emptyReport = () => ({
  developers: [], summary: {}, commitLog: [], meta: {}, branches: [], silos: [], heatmap: [],
  insights: [], repositories: [], languages: [], hotspots: [], timeline: [],
});

// ---- scan catalogue (relative references: "the previous scan", "the March scan", "scan #3") -------
let catalogCache = { key: null, rows: [] };
function scanCatalog() {
  const rows = db.prepare("SELECT id, finished_at, summary FROM scans WHERE status = 'done' ORDER BY id").all();
  const key = rows.length ? `${rows.length}:${rows[rows.length - 1].id}` : '0';
  if (catalogCache.key !== key) {
    catalogCache = {
      key,
      rows: rows.map((r) => {
        let head = null;
        try { head = r.summary ? JSON.parse(r.summary).summary : null; } catch (_) { head = null; }
        return {
          id: r.id,
          finished: String(r.finished_at || '').slice(0, 10),
          first: head && head.firstCommit ? String(head.firstCommit).slice(0, 10) : null,
          last: head && head.lastCommit ? String(head.lastCommit).slice(0, 10) : null,
        };
      }),
    };
  }
  return catalogCache.rows;
}

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

// Turns a scan reference into a concrete scan id (undefined = newest finished scan).
function resolveRef(ref) {
  if (!ref || ref.kind === 'latest') return undefined;
  const rows = scanCatalog();
  if (ref.kind === 'id') return ref.id;
  if (ref.kind === 'ordinal') {
    const row = rows[ref.n - 1];
    if (!row) throw new Error(`There ${rows.length === 1 ? 'is only 1 scan' : `are only ${rows.length} scans`} — #${ref.n} does not exist.`);
    return row.id;
  }
  if (ref.kind === 'previous') {
    const row = rows[rows.length - 1 - (ref.back || 1)];
    if (!row) throw new Error('There is no earlier finished scan.');
    return row.id;
  }
  if (ref.kind === 'date') {
    let row = rows.find((r) => r.first && r.last && r.first <= ref.date && ref.date <= r.last);
    if (!row) {
      const t = Date.parse(ref.date);
      row = rows.slice().sort((a, b) => Math.abs(Date.parse(a.finished) - t) - Math.abs(Date.parse(b.finished) - t))[0];
    }
    if (!row) throw new Error(`No scan covers ${ref.date}.`);
    return row.id;
  }
  if (ref.kind === 'month') {
    const mm = MONTHS[ref.month];
    const row = rows.find((r) => (r.first || '').slice(5, 7) === mm || (r.last || '').slice(5, 7) === mm)
      || rows.find((r) => r.first && r.last && (r.first || '').slice(5, 7) <= mm && (r.last || '').slice(5, 7) >= mm);
    if (!row) throw new Error(`No scan covers ${ref.month}.`);
    return row.id;
  }
  return undefined;
}

// ---- planning --------------------------------------------------------------------------------------
function planFor(nq, raw, prior, state, report) {
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
  carrySlots(slots, nq, raw, prior, state, report);

  const probe = { nq, slots };
  let intent = null;
  let score = 0;
  for (const it of INTENTS) {
    const s = it.score(probe);
    if (s > score) { score = s; intent = it; }
  }
  // When a name is ambiguous we answer with a numbered clarification, but remember which analysis
  // was actually wanted so the picked option can be used for it right away.
  let intentBeforeAmbiguous = null;
  if (intent && intent.name === 'ambiguous') {
    const withDev = { nq, slots: { ...slots, dev: slots.candidates[0] || null } };
    let best = 0;
    for (const it of INTENTS) {
      if (it.name === 'ambiguous') continue;
      const s = it.score(withDev);
      if (s > best) { best = s; intentBeforeAmbiguous = it.name; }
    }
  }
  return { nq, raw, slots, intent, score, intentBeforeAmbiguous };
}

const splitParts = (nq) => nq.split(/\s+(?:,|;|&|and also|then|also|and)\s+/).map((p) => p.trim()).filter((p) => p.length >= 3);

function planAll(nq, raw, prior, state, report) {
  const full = planFor(nq, raw, prior, state, report);
  if (full.intent && full.intent.name === 'ambiguous') return [full];
  const parts = splitParts(nq);
  if (parts.length >= 2) {
    const sub = parts.map((p) => planFor(p, p, prior, state, report));
    const names = sub.map((p) => p.intent && p.intent.name);
    if (sub.every((p, i) => p.score >= MIN_SCORE && names[i]) && new Set(names).size === names.length) return sub;
  }
  return [full];
}

// A numbered/name reply to a clarification becomes a plan with the resolved developer.
function planPicked(nq, raw, prior, state, report, picked) {
  const slots = {
    win: null, topN: 0, metric: 'churn', type: null, phrase: null,
    dev: { name: picked.name, email: picked.email }, candidates: [],
  };
  carrySlots(slots, nq, raw, prior, state, report);
  const name = state.clarifyIntent && state.clarifyIntent !== 'ambiguous' ? state.clarifyIntent : 'developer_profile';
  const intent = INTENTS.find((i) => i.name === name) || INTENTS.find((i) => i.name === 'developer_profile');
  return { nq, raw, slots, intent, score: 5 };
}

function pickFollowUps(names, state, asked) {
  const askedNorm = normalize(asked);
  const out = [];
  for (const n of names) {
    for (const f of FOLLOWUPS[n] || FOLLOWUPS.default) {
      if (!out.includes(f) && normalize(f) !== askedNorm) out.push(f);
    }
  }
  if (state && state.dev && out.length < 3) {
    const q = `how active is ${state.dev.name}?`;
    if (!out.includes(q) && normalize(q) !== askedNorm) out.push(q);
  }
  if (!out.length) out.push(...FOLLOWUPS.default.slice(0, 3));
  return out.slice(0, 3);
}

// ---- entry point -----------------------------------------------------------------------------------
async function run(question, messages, { onEvent = () => {}, state } = {}) {
  const q = String(question || '').slice(0, 2000);
  const nq = canonicalize(normalize(q));
  const st = state || {};
  st.turn = (st.turn || 0) + 1;
  const toolBlocks = [];
  const call = makeCaller(onEvent, toolBlocks);
  const prior = priorUserText(messages);

  // Which scan are we talking about? Explicit wording wins, otherwise dialogue memory on a follow-up.
  const follow = isFollowUp(nq) || isEllipsis(nq);
  let scanRef = extractScanRef(nq);
  if (!scanRef && follow && st.scanId) scanRef = { kind: 'id', id: st.scanId };

  let scan = null;
  let report = null;
  let scanError = null;
  const loadScan = (ref) => {
    try {
      ({ scan, report } = resolveScan(resolveRef(ref)));
      scanError = null;
    } catch (err) {
      scanError = err;
      scan = null;
      report = emptyReport();
    }
  };
  loadScan(scanRef);

  // A numbered reply to an earlier clarification short-circuits normal planning.
  const picked = pendingReply(nq, q, st);
  const plans = picked && picked.email
    ? [planPicked(nq, q, prior, st, report, picked)]
    : planAll(nq, q, prior, st, report);

  // "What changed since the previous scan" always compares against the newest scan.
  if (plans.length === 1 && plans[0].intent && plans[0].intent.name === 'compare' && scanRef && scanRef.kind === 'previous') {
    loadScan(null);
  }

  const ctx = { q, nq, scan, report, call, state: st };
  const sections = [];
  let prov = null;
  let followUps;
  let noData = false;
  const hasDataIntent = plans.some((p) => p.intent && p.score >= MIN_SCORE);

  if (hasDataIntent) {
    const kinds = plans.map((p) => (p.intent ? p.intent.name : 'fallback'));
    if (scanError) {
      if (kinds.every((k) => NO_SCAN_INTENTS.has(k))) {
        for (const p of plans) sections.push(p.intent.run({ ...ctx, slots: p.slots }));
        prov = kinds.every((k) => k === 'help') ? null : APP_PROVENANCE;
      } else {
        sections.push(SEC.noScanSection(scanError));
        noData = true;
      }
    } else {
      for (const p of plans) {
        try {
          sections.push(p.intent.run({ ...ctx, slots: p.slots, nq: p.nq }));
        } catch (err) {
          sections.push({ headline: 'That query failed.', bullets: [err.message] });
        }
      }
      if (kinds.every((k) => k === 'help')) prov = null;
      else if (kinds.every((k) => k === 'help' || k === 'app_status')) prov = APP_PROVENANCE;
      else {
        const win = plans.find((p) => p.slots.win);
        prov = provenance(scan, report, win ? win.slots.win.label : null);
      }
    }
    // Without any finished scans the only useful next steps are making one (or learning the app).
    followUps = noData
      ? ['run a scan', 'what can you do?', 'how many scans do we have?']
      : pickFollowUps(plans.map((p) => p.intent && p.intent.name), st, q);
  } else {
    // Not a report question: try conversation, then the knowledge base, then nearest-match help.
    const chat = converse.match(nq, q, st);
    if (chat) {
      sections.push(SEC.chatSection(chat.section));
      followUps = pickFollowUps(['help'], st, q);
    } else {
      const article = knowledge.lookup(q) || knowledge.lookup(nq);
      if (article) {
        sections.push(SEC.knowledgeSection(article));
        prov = '*Curated knowledge article · no AI used.*';
        followUps = pickFollowUps(['overview'], st, q);
      } else {
        const suggestions = [...nearestMatches(nq), ...knowledge.suggest(nq)].filter(Boolean).slice(0, 3);
        sections.push(SEC.fallbackSection({ scan, report }, suggestions));
        followUps = suggestions.length ? [] : pickFollowUps(['help'], st, q);
      }
    }
  }

  const first = plans[0] || {};
  remember(st, {
    slots: first.slots,
    intent: first.intent && first.intent.name,
    scanId: scan ? scan.id : st.scanId,
  });
  if (first.intentBeforeAmbiguous) st.clarifyIntent = first.intentBeforeAmbiguous;

  const md = renderAnswer(sections, prov, followUps);
  messages.push({ role: 'assistant', content: [...toolBlocks, { type: 'text', text: md }] });
  if (onEvent) onEvent({ type: 'text', text: md });
  return { answer: md, suggestions: followUps };
}

// Executive summary for a finished scan: deterministic, used when Claude is not configured.
function summarizeScan(scanId) {
  const { scan, report } = resolveScan(scanId);
  const call = makeCaller(null, []);
  const sum = report.summary;
  const top = report.developers.filter((d) => !d.isBot).slice(0, 5);
  const cc = call('get_code_health', { scan_id: scan.id, limit: 5 });
  const staleRows = call('get_branches', { scan_id: scan.id, stale_only: true, limit: 10 }).branches;
  const dayTotals = cc.heatmap.map((r) => r.reduce((s, v) => s + v, 0));
  const busiestDay = WEEKDAYS[dayTotals.indexOf(Math.max(...dayTotals))];
  const peak = cc.timeline.slice().sort((a, b) => b.commits - a.commits)[0];
  const inactive = report.developers.filter((d) => !d.isBot && (d.daysSinceLastCommit ?? 0) > 90);

  const sections = [
    { headline: `Scan #${scan.id}: ${num(sum.commits)} commits by ${num(sum.developers)} developers across ${num(sum.repositories)} repositories (${sum.firstCommit} → ${sum.lastCommit}).` },
    {
      headline: 'Activity',
      bullets: [
        `${lines(sum)} lines changed across ${num(sum.filesTouched)} files · ${num(sum.activeLast30Days)} developers active in the last 30 days.`,
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
    `Bus factor ${sum.busFactor}${sum.busFactor <= 2 ? ' — knowledge is concentrated' : ''} · ${num(report.silos.length)} knowledge-silo file(s).`,
  ];
  if (sum.unmergedCommits) attention.push(`${num(sum.unmergedCommits)} commits across ${num(sum.unmergedBranches)} branches are not in the main branch yet (${num(sum.unmergedAdditions)}/${num(sum.unmergedDeletions)} lines).`);
  if (staleRows.length) attention.push(`Stale branches: ${staleRows.slice(0, 3).map((b) => `\`${b.name}\` (${b.daysIdle}d idle)`).join(', ')}.`);
  else attention.push('No stale branches.');
  if (inactive.length) attention.push(`${inactive.length} developer(s) have not committed in 90+ days: ${inactive.slice(0, 3).map((d) => d.name).join(', ')}.`);
  sections.push({ headline: 'Needs attention', bullets: attention });

  try {
    const cmp = SEC.compareSection({ scan, call });
    if (!cmp.headline.startsWith('Nothing')) sections.push(cmp);
  } catch (err) { /* comparison is optional */ }

  const actions = [];
  if (sum.staleBranches) actions.push(`Clean up ${num(sum.staleBranches)} stale branch(es): ${staleRows.slice(0, 3).map((b) => b.name).join(', ')}${sum.staleBranches > 3 ? ' …' : ''}.`);
  if (sum.unmergedCommits) actions.push(`Review and merge or close the ${num(sum.unmergedCommits)} unmerged commit(s).`);
  if (sum.busFactor <= 2 && top.length > 1) actions.push(`Pair on the hottest files with ${top.slice(0, 2).map((d) => d.name).join(' and ')} to raise the bus factor (currently ${sum.busFactor}).`);
  if (report.silos.length) actions.push(`Spread ownership of ${num(report.silos.length)} single-owner file(s): ${report.silos.slice(0, 2).map((f) => f.path).join(', ')}.`);
  if (inactive.length) actions.push(`Re-engage or backfill: ${inactive.slice(0, 2).map((d) => d.name).join(', ')} have not committed in 90+ days.`);
  if (!actions.length) actions.push('No urgent actions: nothing is stale or unmerged and knowledge is spread across the team.');
  sections.push({ headline: 'Recommended actions', bullets: actions.slice(0, 4) });

  return renderAnswer(sections, provenance(scan, report));
}

// Starter questions served to the UI, derived from the capability registry so they never drift.
function starterSuggestions(limit = 8) {
  const order = ['overview', 'top_developers', 'unmerged', 'stale_branches', 'hotspots', 'window_activity', 'compare', 'bus_factor', 'help', 'commit_search', 'languages', 'patterns'];
  const out = [];
  const seen = new Set();
  for (const name of order) {
    const it = INTENTS.find((i) => i.name === name);
    for (const ex of (it && it.examples) || []) {
      if (!seen.has(ex)) { seen.add(ex); out.push(ex); }
      break;
    }
  }
  for (const it of INTENTS) {
    if (out.length >= limit) break;
    for (const ex of it.examples) {
      if (!seen.has(ex)) { seen.add(ex); out.push(ex); }
    }
  }
  return out.slice(0, limit);
}

module.exports = { run, summarizeScan, scanCatalog, resolveRef, starterSuggestions };
