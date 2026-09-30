'use strict';

// Question parsing: normalization, slot extraction (window/top-N/metric/type/phrase/scan),
// developer resolution with fuzzy matching, and follow-up/ellipsis detection.

const { escRe } = require('./format');

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
  if (/\b(?:this|last|current) quarter\b/.test(nq)) {
    const now = new Date();
    const q = Math.floor(now.getUTCMonth() / 3);
    const first = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0));
    const isCurrent = /\b(?:this|current)\b/.test(nq);
    return {
      since: first.toISOString().slice(0, 10),
      until: isCurrent ? null : last.toISOString().slice(0, 10),
      label: isCurrent ? 'this quarter' : 'last quarter',
    };
  }
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
  const m = /\b(?:top|first|best|last|recent|latest|next)\s+(\d{1,2})\b/.exec(nq) || /\b(\d{1,2})\s+(?:top|most)\b/.exec(nq);
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

const extractPhrase = (q) => (/["“']([^"”']{2,60})["”']/.exec(String(q)) || [])[1]
  || (/\b(?:about|mentioning)\s+([a-z0-9][\w .#/-]{1,40})/i.exec(String(q)) || [])[1] || null;

// Scan references: explicit ids, ordinals and dates, plus relative wording.
function extractScanRef(nq) {
  let m;
  if ((m = /\bscan\s*#(\d{1,6})\b/.exec(nq))) return { kind: 'id', id: Number(m[1]) };
  if ((m = /\b(?:in|of|for|about|from)\s+scan\s+#?(\d{1,6})\b/.exec(nq))) return { kind: 'id', id: Number(m[1]) };
  if ((m = /\b(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)\s+scan\b/.exec(nq))) return { kind: 'ordinal', n: Number(m[1]) };
  if ((m = /\b(?:the\s+)?(first|second|third)\s+scan\b/.exec(nq))) {
    return { kind: 'ordinal', n: { first: 1, second: 2, third: 3 }[m[1]] };
  }
  if (/\b(?:oldest|earliest)\s+scan\b/.test(nq)) return { kind: 'ordinal', n: 1 };
  if (/\b(?:latest|newest|most recent|last|current)\s+scan\b/.test(nq)) return { kind: 'latest' };
  if (/\b(?:scan before last|second to last|previous but one)\b/.test(nq)) return { kind: 'previous', back: 2 };
  if (/\b(?:previous|prior)\s+scan\b/.test(nq)) return { kind: 'previous', back: 1 };
  if ((m = /\bscan\s+(?:from|on|at)\s+(\d{4}-\d{2}-\d{2})\b/.exec(nq))) return { kind: 'date', date: m[1] };
  if ((m = /\bscan\s+(?:from|on|in)\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/.exec(nq))) {
    return { kind: 'month', month: m[1] };
  }
  return null;
}

const STOP = new Set(['will', 'just', 'very', 'more', 'most', 'some', 'code', 'team', 'work', 'line', 'lines', 'file', 'files',
  'scan', 'scans', 'data', 'have', 'been', 'that', 'this', 'they', 'them', 'than', 'then', 'with', 'from', 'into', 'over',
  'last', 'next', 'good', 'recent', 'branch', 'branches', 'commit', 'commits', 'their', 'there', 'where', 'when', 'what',
  'whom', 'your', 'yours', 'about', 'after', 'before', 'between', 'during', 'under', 'again', 'also', 'only', 'same',
  'such', 'each', 'other', 'being', 'doing', 'having', 'make', 'made', 'know', 'owns', 'left', 'much', 'many', 'like',
  'give', 'gets', 'take', 'help', 'list', 'show', 'tell', 'people', 'person', 'dev', 'devs', 'developer', 'developers',
  'engineer', 'engineers', 'who', 'which', 'how', 'why', 'all', 'any', 'every', 'stats', 'report', 'reports']);

const nameRe = (name) => new RegExp(`(?<![\w])${escRe(name)}(?![\w])`, 'i');

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m + n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const fuzzyDistance = (token, word) => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0);

function findDeveloper(report, text) {
  const t = String(text || '');
  if (!t.trim()) return { match: null, candidates: [] };
  const devs = report.developers || [];
  if (!devs.length) return { match: null, candidates: [] };
  const email = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/.exec(t)?.[0];
  if (email) {
    const d = devs.find((x) => x.email.toLowerCase() === email.toLowerCase())
      || devs.find((x) => (x.aliases?.emails || []).some((e) => e.toLowerCase() === email.toLowerCase()));
    if (d) return { match: d, candidates: [] };
    const local = email.split('@')[0].toLowerCase();
    const byLocal = devs.filter((x) => x.email.split('@')[0].toLowerCase() === local);
    if (byLocal.length === 1) return { match: byLocal[0], candidates: [] };
  }
  const exact = devs.find((x) => x.name.toLowerCase() === t.trim().toLowerCase());
  if (exact) return { match: exact, candidates: [] };
  const whole = devs.filter((x) => x.name.length >= 2 && nameRe(x.name).test(t)).sort((a, b) => b.name.length - a.name.length);
  if (whole.length) {
    if (whole.filter((x) => x.name.length === whole[0].name.length).length === 1) return { match: whole[0], candidates: [] };
    return { match: null, candidates: whole.slice(0, 5) };
  }
  const tokens = t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const hits = devs.filter((x) => x.name.toLowerCase().split(/\s+/).some((w) => !STOP.has(w) && tokens.includes(w)));
  if (hits.length === 1) return { match: hits[0], candidates: [] };
  if (hits.length > 1) return { match: null, candidates: hits.slice(0, 5) };

  // Fuzzy pass: tolerate typos ("alce" -> Alice) and partial surnames ("asmith" -> Alice Smith).
  const fuzzy = new Map();
  for (const d of devs) {
    const words = [...d.name.toLowerCase().split(/\s+/), d.email.split('@')[0].toLowerCase()]
      .filter((w) => w.length >= 4 && !STOP.has(w));
    for (const token of tokens) {
      if (token.length < 4) continue;
      for (const w of words) {
        if (token === w || levenshtein(token, w) <= fuzzyDistance(token, w)) {
          if (!fuzzy.has(d.email)) fuzzy.set(d.email, d);
          break;
        }
      }
    }
  }
  if (fuzzy.size === 1) return { match: [...fuzzy.values()][0], candidates: [] };
  if (fuzzy.size > 1) return { match: null, candidates: [...fuzzy.values()].slice(0, 5) };
  return { match: null, candidates: [] };
}

const FOLLOW_RE = /\b(and|also|what about|his|her|their|them|those|these|same|too|again|either)\b/;
const isFollowUp = (nq) => FOLLOW_RE.test(nq) || /^(?:him|her|them|it|that|those|same|too|again|and)\b/.test(nq);
const PRONOUN_RE = /\b(?:him|her|them|his|her|their|it|itself|herself|himself|themselves|they|she|he)\b/;

// An ellipsis is a short follow-up that carries no question words of its own:
// "and last month?", "what about Bob?", "him?", "same but weekly".
function isEllipsis(nq) {
  if (nq.length > 80) return false;
  if (FOLLOW_RE.test(nq) || PRONOUN_RE.test(nq)) return true;
  return nq.split(' ').length <= 4 && !/\b(?:what|which|who|how|when|where|why|show|list|give|find|compare|run|start|top|overview)\b/.test(nq);
}

function priorUserText(messages) {
  const prior = messages.slice(0, -1)
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('Tool-call limit'));
  return prior.length ? prior[prior.length - 1].content : null;
}

// ---- phrasing normalization -----------------------------------------------------------------------
// Synonyms and common misspellings are folded into the vocabulary the intent scorers understand,
// so "who is killing it" scores like "most active" and "buss factor" like "bus factor".
const CANONICAL = [
  [/\b(?:killing|crushing|nailing|smashing) it\b|\bslaying\b|\bknocking it out\b/g, 'most active'],
  [/\b(?:quit|resigned|no longer works here|left the (?:company|team|project))\b/g, 'inactive'],
  [/\bbuss? (?:factor|truck|test)\b/g, 'bus factor'],
  [/\btruck ?factor\b/g, 'bus factor'],
  [/\bhot ?spots?\b/g, 'hotspots'],
  [/\bknowlege silos?\b|\bknowledge silo\b/g, 'knowledge silos'],
  [/\bunmerge(?:d|s)?\b/g, 'unmerged'],
  [/\bbranche?s?\b/g, 'branches'],
  [/\bwhat'?s new\b|\bany news\b|\bwhat happened\b/g, 'what changed'],
  [/\bline counts\b|\bloc\b|\blines of code\b/g, 'lines'],
  [/\bwho'?s the best\b|\bstar (?:performer|developer)\b/g, 'top developer'],
  [/\bdocs?\b/g, 'docs'],
];

function canonicalize(nq) {
  let out = nq;
  for (const [re, to] of CANONICAL) out = out.replace(re, to);
  // Token-level typo correction against the intent vocabulary (only when the correct word is absent).
  const vocab = ['hotspots', 'silos', 'unmerged', 'stale', 'overview', 'summaries', 'languages',
    'repositories', 'inactive', 'schedules', 'busiest', 'weekends', 'churn', 'compare', 'trends',
    'branches', 'developers', 'bus factor', 'patterns', 'trend', 'repos'];
  for (const word of vocab) {
    if (out.includes(word)) continue;
    const re = new RegExp(`\\b([a-z]{${Math.max(4, word.length - 2)},${word.length + 1}})\\b`, 'g');
    out = out.replace(re, (m, tok) => (tok !== word && levenshtein(tok, word) <= 1 ? word : m));
  }
  return out;
}

module.exports = {
  normalize, canonicalize, extractWindow, extractTopN, extractMetric, extractType, extractPhrase,
  extractScanRef, findDeveloper, levenshtein, isFollowUp, isEllipsis, priorUserText,
  STOP, TYPE_WORDS, UNIT_MS, PRONOUN_RE,
};
