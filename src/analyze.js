'use strict';

const path = require('path');
const { US } = require('./git');

const DAY_MS = 86400000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const GENERIC_NAMES = new Set(['root', 'admin', 'administrator', 'user', 'unknown', 'ubuntu', 'github', 'gitlab', 'developer', 'jenkins', 'build', 'runner', 'localhost', 'default']);
const GH_NOREPLY = /^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/;
const BOT_RE = /\[bot\]|^(dependabot|renovate|github-actions|greenkeeper|snyk-bot|semantic-release-bot|codecov|pre-commit-ci|allcontributors)\b/i;
const LARGE_COMMIT = 1000;

const LANGUAGES = {
  '.js': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript', '.jsx': 'JavaScript (JSX)',
  '.ts': 'TypeScript', '.tsx': 'TypeScript (TSX)', '.py': 'Python', '.java': 'Java', '.kt': 'Kotlin',
  '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.c': 'C', '.h': 'C/C++ header',
  '.cpp': 'C++', '.cc': 'C++', '.hpp': 'C++', '.swift': 'Swift', '.m': 'Objective-C', '.scala': 'Scala',
  '.dart': 'Dart', '.vue': 'Vue', '.svelte': 'Svelte', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
  '.less': 'Less', '.sql': 'SQL', '.sh': 'Shell', '.ps1': 'PowerShell', '.json': 'JSON', '.yml': 'YAML',
  '.yaml': 'YAML', '.xml': 'XML', '.md': 'Markdown', '.tf': 'Terraform', '.gradle': 'Gradle', '.r': 'R',
};

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:/;
const CONVENTIONAL_TYPES = {
  feat: 'feature', feature: 'feature', fix: 'fix', bugfix: 'fix', hotfix: 'fix', docs: 'docs', doc: 'docs',
  test: 'test', tests: 'test', refactor: 'refactor', perf: 'perf', chore: 'chore', build: 'chore',
  ci: 'chore', style: 'style', revert: 'revert',
};

function classifyCommit(subject) {
  const m = CONVENTIONAL.exec(subject);
  if (m && CONVENTIONAL_TYPES[m[1].toLowerCase()]) return CONVENTIONAL_TYPES[m[1].toLowerCase()];
  if (/^revert/i.test(subject)) return 'revert';
  if (/\b(fix(e[sd])?|bugs?|hotfix|patch|crash|error|issue)\b/i.test(subject)) return 'fix';
  if (/\b(refactor\w*|clean ?up|restructur\w*|renam\w*|simplif\w*)\b/i.test(subject)) return 'refactor';
  if (/\b(tests?|specs?|coverage)\b/i.test(subject)) return 'test';
  if (/\b(docs?|readme|documentation)\b/i.test(subject)) return 'docs';
  if (/\b(add(s|ed)?|feat(ure)?s?|implement\w*|new|introduc\w*|support|creat\w*)\b/i.test(subject)) return 'feature';
  if (/\b(bump\w*|upgrad\w*|dependenc\w*|deps|version|release|chore|config\w*)\b/i.test(subject)) return 'chore';
  return 'other';
}

class DisjointSet {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root);
    while (this.parent.get(x) !== root) { const n = this.parent.get(x); this.parent.set(x, root); x = n; }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const normEmail = (e) => (e || '').trim().toLowerCase() || '(no email)';
const normName = (n) => (n || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);
const topKey = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const topList = (map, n, keyName) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
  .map(([k, v]) => ({ [keyName]: k, churn: v }));
const pct = (part, total) => (total ? Math.round((part / total) * 10000) / 100 : 0);
const round1 = (v) => Math.round(v * 10) / 10;
const domainOf = (email) => (email.includes('@') ? email.split('@').pop() : '(none)');

// People commit under several emails (work, personal, GitHub noreply). Emails are joined when
// they share the same full name, or a GitHub noreply login matches a name.
function buildIdentityResolver(observations, merge) {
  const dsu = new DisjointSet();
  for (const { name, email } of observations) {
    const e = 'e:' + email;
    dsu.find(e);
    if (!merge) continue;
    const n = normName(name);
    if (n.length >= 4 && !GENERIC_NAMES.has(n)) dsu.union(e, 'n:' + n);
    const gh = GH_NOREPLY.exec(email);
    if (gh) {
      const login = normName(gh[1]);
      if (login.length >= 3 && !GENERIC_NAMES.has(login)) dsu.union(e, 'n:' + login);
    }
  }
  return (email) => dsu.find('e:' + email);
}

function parseDate(iso) {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  // Hour/weekday in the author's own timezone, which is what "works late" actually means.
  return {
    ts,
    day: iso.slice(0, 10),
    month: iso.slice(0, 7),
    hour: parseInt(iso.slice(11, 13), 10) || 0,
    weekday: new Date(iso.slice(0, 10) + 'T00:00:00Z').getUTCDay(),
  };
}

function longestStreak(days) {
  let best = 0;
  let cur = 0;
  let prev = null;
  for (const d of [...days].sort()) {
    const t = Date.parse(d + 'T00:00:00Z');
    cur = prev !== null && t - prev === DAY_MS ? cur + 1 : 1;
    best = Math.max(best, cur);
    prev = t;
  }
  return best;
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function busFactor(churnValues) {
  const vals = churnValues.filter((v) => v > 0).sort((a, b) => b - a);
  const total = vals.reduce((s, v) => s + v, 0);
  if (!total) return 0;
  let cum = 0;
  for (let i = 0; i < vals.length; i++) {
    cum += vals[i];
    if (cum >= total / 2) return i + 1;
  }
  return vals.length;
}

function monthRange(first, last) {
  const out = [];
  if (!first || !last) return out;
  let [y, m] = first.split('-').map(Number);
  const [ly, lm] = last.split('-').map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

function langOf(file) {
  const ext = path.posix.extname(file).toLowerCase();
  if (!ext) return path.posix.basename(file);
  return LANGUAGES[ext] || ext;
}

function dirOf(file, repoPrefix) {
  const parts = file.split('/');
  parts.pop();
  const dir = parts.slice(0, 2).join('/') || '(root)';
  return repoPrefix ? `${repoPrefix}/${dir}` : dir;
}

function newAuthor(id) {
  return {
    id, commits: 0, merges: 0, additions: 0, deletions: 0, binaryChanges: 0, largeCommits: 0, coAuthored: 0,
    unmerged: { commits: 0, additions: 0, deletions: 0 }, branches: new Map(),
    files: new Set(), days: new Set(), months: new Map(), repos: new Map(),
    langs: new Map(), dirs: new Map(), types: new Map(),
    weekday: Array(7).fill(0), hour: Array(24).fill(0), sizes: [],
    first: Infinity, last: -Infinity, largest: null,
  };
}

function analyze({ commits, repos, opts, isExcluded, blame, branchInfo = new Map() }) {
  const now = (opts.until && Date.parse(opts.until)) || Date.now();
  const multiRepo = repos.length > 1;

  // ---- 1. identities ---------------------------------------------------------------------------
  const coAuthorObs = [];
  for (const c of commits) {
    c.email = normEmail(c.email);
    for (const ca of c.coAuthors || []) {
      ca.email = normEmail(ca.email);
      coAuthorObs.push(ca);
    }
  }
  const blameEntries = [];
  for (const b of blame || []) {
    for (const [key, lines] of b.owners) {
      const [name, email] = key.split(US);
      blameEntries.push({ repo: b.repo, name, email: normEmail(email), lines });
    }
  }
  const idOf = buildIdentityResolver([...commits, ...coAuthorObs, ...blameEntries], opts.mergeIdentities);

  const idents = new Map();
  const ident = (id) => {
    let x = idents.get(id);
    if (!x) { x = { names: new Map(), emails: new Map() }; idents.set(id, x); }
    return x;
  };
  for (const c of commits) {
    c.id = idOf(c.email);
    const x = ident(c.id);
    inc(x.names, c.name);
    inc(x.emails, c.email);
  }
  for (const o of [...coAuthorObs, ...blameEntries]) {
    o.id = idOf(o.email);
    const x = ident(o.id);
    inc(x.names, o.name, 0);
    inc(x.emails, o.email, 0);
  }
  for (const x of idents.values()) {
    x.name = topKey(x.names);
    x.email = topKey(x.emails);
    x.isBot = [...x.names.keys(), ...x.emails.keys()].some((s) => BOT_RE.test(s));
  }

  const allowed = (id) => {
    const x = idents.get(id);
    if (!opts.bots && x.isBot) return false;
    const hay = [...x.names.keys(), ...x.emails.keys()].map((s) => s.toLowerCase());
    if (opts.authors.length && !opts.authors.some((a) => hay.some((h) => h.includes(a)))) return false;
    if (opts.domains.length && ![...x.emails.keys()].some((e) => opts.domains.some((d) => domainOf(e) === d || domainOf(e).endsWith('.' + d)))) return false;
    return true;
  };

  // ---- 2. aggregate -----------------------------------------------------------------------------
  const authors = new Map();
  const months = new Map();
  const files = new Map();
  const langs = new Map();
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  const repoAgg = new Map(repos.map((r) => [r.name, { commits: 0, merges: 0, additions: 0, deletions: 0, authors: new Map(), first: Infinity, last: -Infinity }]));
  const branchAgg = new Map(); // repo\0branch -> { authors: Map id->commits, additions, deletions }
  const commitLog = [];
  const getAuthor = (id) => authors.get(id) || authors.set(id, newAuthor(id)).get(id);
  let excludedLines = 0;
  let skippedByFilter = 0;
  let duplicatesSkipped = 0;
  let coAuthoredCommits = 0;
  const unmergedTotals = { commits: 0, additions: 0, deletions: 0 };

  for (const c of commits) {
    const bi = branchInfo.get(c.repo);
    // Same patch already on main under another hash (rebase / cherry-pick): count only the main copy.
    if (bi && bi.duplicates.has(c.hash)) { duplicatesSkipped++; continue; }
    if (!allowed(c.id)) { skippedByFilter++; continue; }
    const t = parseDate(c.date);
    if (!t) continue;
    const a = getAuthor(c.id);
    const r = repoAgg.get(c.repo);
    const isMerge = c.parents > 1;
    const onBranches = bi ? bi.unmerged.get(c.hash) : null;

    let add = 0;
    let del = 0;
    let touched = 0;
    for (const f of c.files) {
      if (isExcluded(f.path)) { excludedLines += f.add + f.del; continue; }
      touched++;
      add += f.add;
      del += f.del;
      if (f.binary) a.binaryChanges++;
      const churn = f.add + f.del;
      const key = c.repo + '\0' + f.path;
      a.files.add(key);
      inc(a.langs, langOf(f.path), churn);
      inc(langs, langOf(f.path), churn);
      inc(a.dirs, dirOf(f.path, multiRepo && c.repo), churn);

      let fs = files.get(key);
      if (!fs) {
        fs = { repo: c.repo, path: f.path, commits: 0, additions: 0, deletions: 0, authors: new Map(), last: -Infinity };
        files.set(key, fs);
      }
      fs.commits++;
      fs.additions += f.add;
      fs.deletions += f.del;
      inc(fs.authors, c.id, churn || 1);
      fs.last = Math.max(fs.last, t.ts);
    }
    const churn = add + del;

    a.additions += add;
    a.deletions += del;
    a.days.add(t.day);
    a.first = Math.min(a.first, t.ts);
    a.last = Math.max(a.last, t.ts);

    const ra = r.authors.get(c.id) || r.authors.set(c.id, { commits: 0, additions: 0, deletions: 0 }).get(c.id);
    ra.additions += add;
    ra.deletions += del;
    r.additions += add;
    r.deletions += del;
    r.first = Math.min(r.first, t.ts);
    r.last = Math.max(r.last, t.ts);

    const ar = a.repos.get(c.repo) || a.repos.set(c.repo, { commits: 0, additions: 0, deletions: 0 }).get(c.repo);
    ar.additions += add;
    ar.deletions += del;

    const am = a.months.get(t.month) || a.months.set(t.month, { commits: 0, additions: 0, deletions: 0 }).get(t.month);
    am.additions += add;
    am.deletions += del;

    const gm = months.get(t.month) || months.set(t.month, { commits: 0, merges: 0, additions: 0, deletions: 0, authors: new Set() }).get(t.month);
    gm.additions += add;
    gm.deletions += del;
    gm.authors.add(c.id);

    if (isMerge) {
      a.merges++;
      r.merges++;
      gm.merges++;
    } else {
      a.commits++;
      ar.commits++;
      ra.commits++;
      am.commits++;
      gm.commits++;
      r.commits++;
      a.weekday[t.weekday]++;
      a.hour[t.hour]++;
      heatmap[t.weekday][t.hour]++;
      a.sizes.push(churn);
      inc(a.types, classifyCommit(c.subject));
      if (churn >= LARGE_COMMIT) a.largeCommits++;
      if (!a.largest || churn > a.largest.churn) {
        a.largest = { repo: c.repo, hash: c.hash.slice(0, 10), subject: c.subject, churn, date: t.day };
      }
    }

    if (onBranches) {
      a.unmerged.commits++;
      a.unmerged.additions += add;
      a.unmerged.deletions += del;
      unmergedTotals.commits++;
      unmergedTotals.additions += add;
      unmergedTotals.deletions += del;
      // A commit can sit on several unmerged branches (branch off a branch): each branch is
      // credited, but the developer's totals above only count it once.
      for (const b of onBranches) {
        const key = c.repo + '\0' + b;
        const ab = a.branches.get(key) || a.branches.set(key, { repo: c.repo, name: b, commits: 0, additions: 0, deletions: 0 }).get(key);
        ab.commits++;
        ab.additions += add;
        ab.deletions += del;
        const g = branchAgg.get(key) || branchAgg.set(key, { authors: new Map(), additions: 0, deletions: 0 }).get(key);
        inc(g.authors, c.id);
        g.additions += add;
        g.deletions += del;
      }
    }

    const coIds = new Set();
    for (const ca of c.coAuthors || []) {
      if (ca.id !== c.id && allowed(ca.id)) coIds.add(ca.id);
    }
    for (const id of coIds) {
      const co = getAuthor(id);
      co.coAuthored++;
      co.days.add(t.day);
      co.first = Math.min(co.first, t.ts);
      co.last = Math.max(co.last, t.ts);
    }
    if (coIds.size) coAuthoredCommits++;

    commitLog.push({
      repo: c.repo, hash: c.hash, date: c.date, author: idents.get(c.id).name, email: c.email,
      coAuthors: [...coIds].map((id) => idents.get(id).name).join('; '),
      merge: isMerge, merged: !onBranches, branches: onBranches ? [...onBranches].join('; ') : '',
      files: touched, additions: add, deletions: del, type: isMerge ? 'merge' : classifyCommit(c.subject), subject: c.subject,
    });
  }

  // ---- 3. ownership from blame ------------------------------------------------------------------
  const owned = new Map();
  let ownedTotal = 0;
  for (const b of blameEntries) {
    if (!allowed(b.id)) continue;
    inc(owned, b.id, b.lines);
    ownedTotal += b.lines;
  }

  // ---- 4. shape results -------------------------------------------------------------------------
  let totalCommits = 0;
  let totalMerges = 0;
  let totalAdd = 0;
  let totalDel = 0;
  for (const a of authors.values()) {
    totalCommits += a.commits;
    totalMerges += a.merges;
    totalAdd += a.additions;
    totalDel += a.deletions;
  }
  const totalChurn = totalAdd + totalDel;
  const day = (ts) => (Number.isFinite(ts) ? new Date(ts).toISOString().slice(0, 10) : null);
  const allMonths = [...months.keys()].sort();
  const monthKeys = monthRange(allMonths[0], allMonths[allMonths.length - 1]);

  const developers = [...authors.values()].map((a) => {
    const x = idents.get(a.id);
    const churn = a.additions + a.deletions;
    const typeTotal = [...a.types.values()].reduce((s, v) => s + v, 0);
    return {
      name: x.name,
      email: x.email,
      domain: domainOf(x.email),
      aliases: {
        names: [...x.names.keys()].filter((n) => n !== x.name),
        emails: [...x.emails.keys()].filter((e) => e !== x.email),
      },
      isBot: x.isBot,
      commits: a.commits,
      merges: a.merges,
      additions: a.additions,
      deletions: a.deletions,
      net: a.additions - a.deletions,
      churn,
      filesTouched: a.files.size,
      binaryChanges: a.binaryChanges,
      coAuthoredCommits: a.coAuthored,
      unmerged: { ...a.unmerged, churn: a.unmerged.additions + a.unmerged.deletions },
      mergedShare: pct(churn - a.unmerged.additions - a.unmerged.deletions, churn),
      branches: [...a.branches.values()].sort((p, q) => q.commits - p.commits),
      activeDays: a.days.size,
      longestStreakDays: longestStreak(a.days),
      firstCommit: day(a.first),
      lastCommit: day(a.last),
      daysSinceLastCommit: Number.isFinite(a.last) ? Math.max(0, Math.floor((now - a.last) / DAY_MS)) : null,
      tenureDays: Number.isFinite(a.first) ? Math.max(1, Math.round((a.last - a.first) / DAY_MS) + 1) : 0,
      avgChurnPerCommit: a.commits ? Math.round(churn / a.commits) : 0,
      medianChurnPerCommit: median(a.sizes),
      commitsPerActiveDay: a.days.size ? round1(a.commits / a.days.size) : 0,
      largeCommits: a.largeCommits,
      largestCommit: a.largest,
      shareOfCommits: pct(a.commits, totalCommits),
      shareOfChurn: pct(churn, totalChurn),
      afterHoursShare: pct(a.hour.slice(0, 7).reduce((s, v) => s + v, 0) + a.hour.slice(20).reduce((s, v) => s + v, 0), a.commits),
      weekendShare: pct(a.weekday[0] + a.weekday[6], a.commits),
      commitTypes: Object.fromEntries([...a.types.entries()].sort((p, q) => q[1] - p[1]).map(([k, v]) => [k, { count: v, share: pct(v, typeTotal) }])),
      repos: [...a.repos.entries()].map(([name, v]) => ({ name, ...v })).sort((p, q) => (q.additions + q.deletions) - (p.additions + p.deletions)),
      topLanguages: topList(a.langs, 6, 'language'),
      topDirectories: topList(a.dirs, 6, 'directory'),
      weekday: a.weekday,
      hour: a.hour,
      monthly: monthKeys.map((m) => ({ month: m, ...(a.months.get(m) || { commits: 0, additions: 0, deletions: 0 }) })),
      ownership: blame ? { lines: owned.get(a.id) || 0, share: pct(owned.get(a.id) || 0, ownedTotal) } : null,
    };
  }).sort((p, q) => q.churn - p.churn || q.commits - p.commits || q.coAuthoredCommits - p.coAuthoredCommits);
  developers.forEach((d, i) => { d.rank = i + 1; });

  const nameOf = (id) => idents.get(id)?.name || id;

  const domainMap = new Map();
  for (const d of developers) {
    const g = domainMap.get(d.domain) || domainMap.set(d.domain, { domain: d.domain, developers: 0, commits: 0, additions: 0, deletions: 0 }).get(d.domain);
    g.developers++;
    g.commits += d.commits;
    g.additions += d.additions;
    g.deletions += d.deletions;
  }
  const domains = [...domainMap.values()]
    .map((g) => ({ ...g, churn: g.additions + g.deletions, shareOfChurn: pct(g.additions + g.deletions, totalChurn) }))
    .sort((p, q) => q.churn - p.churn);

  const fileRows = [...files.values()].map((f) => {
    const [topId, topChurn] = [...f.authors.entries()].sort((p, q) => q[1] - p[1])[0];
    const authorChurn = [...f.authors.values()].reduce((s, v) => s + v, 0);
    return {
      repo: f.repo, path: f.path, commits: f.commits, additions: f.additions, deletions: f.deletions,
      churn: f.additions + f.deletions, authors: f.authors.size,
      topAuthor: nameOf(topId), topAuthorShare: pct(topChurn, authorChurn), lastChanged: day(f.last),
    };
  });
  const hotspots = fileRows.slice().sort((p, q) => q.churn - p.churn || q.commits - p.commits).slice(0, 50);
  const silos = fileRows.filter((f) => f.commits >= 4 && f.topAuthorShare >= 90)
    .sort((p, q) => q.churn - p.churn).slice(0, 30);

  const filtered = opts.authors.length || opts.domains.length || !opts.bots;
  const branches = [];
  for (const r of repos) {
    const bi = branchInfo.get(r.name);
    if (!bi) continue;
    for (const b of bi.branches) {
      const g = branchAgg.get(r.name + '\0' + b.name);
      if (filtered && !g) continue;
      const idle = b.lastCommit ? Math.floor((now - Date.parse(b.lastCommit)) / DAY_MS) : null;
      branches.push({
        repo: r.name, ...b,
        additions: g ? g.additions : 0, deletions: g ? g.deletions : 0,
        daysIdle: idle,
        stale: b.status === 'unmerged' && idle !== null && idle > opts.staleDays,
        developers: g ? [...g.authors.entries()].sort((p, q) => q[1] - p[1]).map(([id, n]) => ({ name: nameOf(id), commits: n })) : [],
      });
    }
  }
  branches.sort((p, q) => ({ unpushed: 0, unmerged: 1, main: 2, merged: 3 }[p.status] - { unpushed: 0, unmerged: 1, main: 2, merged: 3 }[q.status]) || q.aheadCommits - p.aheadCommits);

  const repoRows = repos.map((r) => {
    const g = repoAgg.get(r.name);
    const rb = branches.filter((b) => b.repo === r.name);
    return {
      name: r.name, path: r.path, remote: r.remote,
      scope: opts.branches.length ? opts.branches.join(', ') : opts.mainOnly ? r.mainRef : opts.all ? 'all refs' : 'all branches',
      checkedOut: r.branch, mainBranch: r.mainRef || null, shallow: !!r.shallow,
      branchCount: rb.length, unmergedBranches: rb.filter((b) => b.status === 'unmerged').length,
      uncommitted: r.worktree || null,
      commits: g.commits, merges: g.merges, additions: g.additions, deletions: g.deletions,
      churn: g.additions + g.deletions, developers: g.authors.size,
      busFactor: busFactor([...g.authors.values()].map((v) => v.additions + v.deletions)),
      topDeveloper: g.authors.size ? nameOf([...g.authors.entries()].sort((p, q) => (q[1].additions + q[1].deletions) - (p[1].additions + p[1].deletions))[0][0]) : null,
      firstCommit: day(g.first), lastCommit: day(g.last),
    };
  });

  const timeline = monthKeys.map((m) => {
    const g = months.get(m);
    return { month: m, commits: g?.commits || 0, merges: g?.merges || 0, additions: g?.additions || 0, deletions: g?.deletions || 0, developers: g?.authors.size || 0 };
  });

  const firstTs = Math.min(...[...authors.values()].map((a) => a.first));
  const lastTs = Math.max(...[...authors.values()].map((a) => a.last));
  const summary = {
    repositories: repos.length,
    developers: developers.length,
    commits: totalCommits,
    merges: totalMerges,
    additions: totalAdd,
    deletions: totalDel,
    net: totalAdd - totalDel,
    churn: totalChurn,
    filesTouched: files.size,
    firstCommit: day(firstTs),
    lastCommit: day(lastTs),
    spanDays: Number.isFinite(firstTs) ? Math.round((lastTs - firstTs) / DAY_MS) + 1 : 0,
    busFactor: busFactor(developers.map((d) => d.churn)),
    activeLast30Days: developers.filter((d) => d.daysSinceLastCommit <= 30).length,
    activeLast90Days: developers.filter((d) => d.daysSinceLastCommit <= 90).length,
    unmergedCommits: unmergedTotals.commits,
    unmergedAdditions: unmergedTotals.additions,
    unmergedDeletions: unmergedTotals.deletions,
    unmergedBranches: branches.filter((b) => b.status === 'unmerged').length,
    staleBranches: branches.filter((b) => b.stale).length,
    duplicatesSkipped,
    coAuthoredCommits,
    excludedLines,
    ownedLines: blame ? ownedTotal : null,
  };

  return {
    meta: {
      title: opts.title || (repos.length === 1 ? `Git report: ${repos[0].name}` : `Git report: ${repos.length} repositories`),
      generatedAt: new Date().toISOString(),
      tool: 'git-contrib-report',
      filters: {
        since: opts.since, until: opts.until,
        branch: opts.branches.length ? opts.branches.join(', ') : opts.mainOnly ? 'main only' : opts.all ? 'all refs' : null,
        authors: opts.authors,
        domains: opts.domains, excludes: opts.excludes, defaultExcludes: opts.defaultExcludes, bots: opts.bots,
        mergeIdentities: opts.mergeIdentities,
      },
      mergedIdentities: developers.filter((d) => d.aliases.emails.length).length,
      commitsFilteredOut: skippedByFilter,
    },
    summary,
    insights: buildInsights({ summary, developers, heatmap, hotspots, silos, commitLog, branches, repositories: repoRows, opts }),
    developers,
    domains,
    repositories: repoRows,
    branches,
    timeline,
    heatmap,
    languages: topList(langs, 15, 'language').map((l) => ({ ...l, share: pct(l.churn, totalChurn) })),
    hotspots,
    silos,
    commitLog,
  };
}

function buildInsights({ summary, developers, heatmap, hotspots, silos, commitLog, branches, repositories, opts }) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  const fmt = (n) => n.toLocaleString('en-US');

  const shallow = repositories.filter((r) => r.shallow);
  if (shallow.length) add('warn', `Shallow clone (${shallow.map((r) => r.name).join(', ')}): history is incomplete, so older work is missing. Run "git fetch --unshallow".`);
  const dirty = repositories.filter((r) => r.uncommitted);
  for (const r of dirty) {
    const u = r.uncommitted;
    add('info', `${r.name} has uncommitted local changes (${u.files} file(s), +${fmt(u.additions)}/−${fmt(u.deletions)}${u.untrackedFiles ? `, ${u.untrackedFiles} untracked` : ''}) by ${u.user || u.email || 'the local user'}. These are not counted until committed.`);
  }
  if (!developers.length) {
    add('warn', 'No commits matched the selected repositories and filters.');
    return out;
  }
  const top = developers[0];
  add('info', `${top.name} is the top contributor with ${top.shareOfChurn}% of all changed lines (${fmt(top.churn)}) across ${fmt(top.commits)} commits.`);

  const byCommits = developers.slice().sort((a, b) => b.commits - a.commits)[0];
  if (byCommits !== top) add('info', `${byCommits.name} made the most commits (${fmt(byCommits.commits)}, ${byCommits.shareOfCommits}% of all).`);

  if (developers.length > 1) {
    const bf = summary.busFactor;
    add(bf <= 2 ? 'warn' : 'good', `Bus factor is ${bf}: ${bf === 1 ? 'one developer has' : `${bf} developers have`} written half of all changes${bf <= 2 ? ', so knowledge is concentrated' : ''}.`);
  }

  const inactive = developers.filter((d) => d.daysSinceLastCommit > 90 && !d.isBot);
  if (inactive.length) add('info', `${inactive.length} of ${developers.length} developers have not committed in the last 90 days.`);

  const newcomers = developers.filter((d) => d.firstCommit && (Date.now() - Date.parse(d.firstCommit)) / DAY_MS <= 90);
  if (newcomers.length && newcomers.length < developers.length) add('good', `${newcomers.length} developer(s) made their first commit in the last 90 days: ${newcomers.slice(0, 5).map((d) => d.name).join(', ')}.`);

  const wd = heatmap.map((row) => row.reduce((s, v) => s + v, 0));
  const hr = Array.from({ length: 24 }, (_, h) => heatmap.reduce((s, row) => s + row[h], 0));
  const busiestDay = wd.indexOf(Math.max(...wd));
  const busiestHour = hr.indexOf(Math.max(...hr));
  add('info', `Busiest day is ${WEEKDAYS[busiestDay]}; busiest hour is ${String(busiestHour).padStart(2, '0')}:00 (author local time).`);

  const total = summary.commits || 1;
  const offHours = (hr.slice(0, 7).reduce((s, v) => s + v, 0) + hr.slice(20).reduce((s, v) => s + v, 0)) / total;
  const weekend = (wd[0] + wd[6]) / total;
  if (offHours >= 0.25) add('warn', `${Math.round(offHours * 100)}% of commits happen between 20:00 and 07:00.`);
  if (weekend >= 0.15) add('warn', `${Math.round(weekend * 100)}% of commits are made on weekends.`);

  const nonMerge = commitLog.filter((c) => !c.merge);
  const fixes = nonMerge.filter((c) => c.type === 'fix').length;
  if (nonMerge.length >= 10) add(fixes / nonMerge.length > 0.4 ? 'warn' : 'info', `${Math.round((fixes / nonMerge.length) * 100)}% of commits look like bug fixes.`);

  const large = nonMerge.filter((c) => c.additions + c.deletions >= LARGE_COMMIT).length;
  if (large) add('info', `${large} commit(s) changed ${fmt(LARGE_COMMIT)}+ lines each. Large commits are harder to review.`);

  if (hotspots[0]) add('info', `Most changed file: ${hotspots[0].path} (${fmt(hotspots[0].churn)} lines over ${hotspots[0].commits} commits, ${hotspots[0].authors} developer(s)).`);
  if (silos.length) add('warn', `${silos.length} frequently changed file(s) are 90%+ written by a single developer (knowledge silos).`);
  if (summary.unmergedCommits) {
    const devs = developers.filter((d) => d.unmerged.commits).sort((a, b) => b.unmerged.churn - a.unmerged.churn);
    add('warn', `${fmt(summary.unmergedCommits)} commit(s) (+${fmt(summary.unmergedAdditions)}/−${fmt(summary.unmergedDeletions)} lines) by ${devs.length} developer(s) are not merged into the main branch yet. Most: ${devs.slice(0, 3).map((d) => `${d.name} (${d.unmerged.commits})`).join(', ')}.`);
  }
  const stale = branches.filter((b) => b.stale);
  if (stale.length) add('warn', `${stale.length} unmerged branch(es) have had no commits for ${opts.staleDays}+ days: ${stale.slice(0, 4).map((b) => b.name).join(', ')}${stale.length > 4 ? ', …' : ''}.`);
  const unpushed = branches.filter((b) => b.status === 'unpushed');
  for (const b of unpushed) add('warn', `Local ${b.name} in ${b.repo} has ${b.aheadCommits} commit(s) that are not on the remote main branch (unpushed).`);
  if (summary.duplicatesSkipped) add('info', `${fmt(summary.duplicatesSkipped)} rebased/cherry-picked copies of commits already on main were counted once, not twice.`);
  if (summary.coAuthoredCommits) add('info', `${fmt(summary.coAuthoredCommits)} commit(s) credit co-authors (Co-authored-by). Their lines stay with the committing author.`);
  if (summary.excludedLines) add('info', `${fmt(summary.excludedLines)} lines in lock files, build output and vendored code were excluded.`);
  return out;
}

module.exports = { analyze, classifyCommit, busFactor, longestStreak, buildIdentityResolver, normEmail, BOT_RE, WEEKDAYS };
