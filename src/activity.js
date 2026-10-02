'use strict';

const { spawn } = require('child_process');
const { parseArgs, buildExcluder } = require('./args');
const { git, resolveRepo, streamLog, detectMainRef, displayBranch, pool, US } = require('./git');
const { buildIdentityResolver, normEmail, BOT_RE } = require('./analyze');

const HOUR_MS = 3600000;
const MAX_WINDOW_DAYS = 31; // beyond this a full scan (not a live window) is the right tool
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const inc = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const topKey = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

// A window request from the UI or the API: "days=15" (preferred) or "hours=360" -> hours, 1..31 days.
function activityHours(days, hours) {
  const d = days === undefined || days === null || days === '' ? NaN : Number(days);
  if (Number.isFinite(d)) return Math.min(Math.max(Math.round(d), 1), MAX_WINDOW_DAYS) * 24;
  return Math.min(Math.max(Number(hours) || 24, 1), MAX_WINDOW_DAYS * 24);
}

// Merge commit subjects that name the branch they brought in.
const MERGE_SUBJECTS = [
  /^Merge pull request #\d+ from [^/\s]+\/(\S+)/i, // GitHub
  /^Merged in (\S+?)(?: \(pull request #\d+\))?$/i, // Bitbucket
  /^Merge (?:remote-tracking )?branch '(?:origin\/)?([^']+)'/i, // git, GitLab
];
function branchFromSubject(subject) {
  for (const re of MERGE_SUBJECTS) {
    const m = re.exec(subject || '');
    if (m) return m[1];
  }
  return null;
}

// Every local and remote branch (local "main" and "origin/main" are one branch), with the
// window's commits that each one contains: Map sha -> Set(branch names).
async function branchMembership(repo, since) {
  const raw = await git(['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes'], repo.path);
  const branches = new Map();
  for (const line of raw.split('\n')) {
    const [ref, sha] = line.split('\t');
    if (!ref || !sha || ref.endsWith('/HEAD')) continue;
    const name = displayBranch(ref);
    const b = branches.get(name) || branches.set(name, { name, refs: [], tips: new Set() }).get(name);
    b.refs.push(ref);
    b.tips.add(sha);
  }
  const containing = new Map();
  await pool([...branches.values()], 6, async (b) => {
    for (const sha of lines(await git(['rev-list', `--since=${since}`, ...b.refs, '--'], repo.path))) {
      (containing.get(sha) || containing.set(sha, new Set()).get(sha)).add(b.name);
    }
  });
  return { branches, containing };
}

// Commits that reached main through a merge in the window: Map sha -> branch they came from.
// The branch is read from the merge subject, else from a branch whose tip is the merged parent.
async function mergedVia(repo, mainRef, since, branches) {
  const out = await git(['log', '--first-parent', '--merges', `--since=${since}`, '--format=%H%x1f%P%x1f%s', mainRef, '--'], repo.path);
  const via = new Map();
  for (const line of lines(out)) {
    const [, parents, subject] = line.split(US);
    const [first, ...others] = parents.split(' ');
    for (const p of others) {
      const name = branchFromSubject(subject) || [...branches.values()].find((b) => b.tips.has(p))?.name || '(merged branch)';
      for (const sha of lines(await git(['rev-list', `--since=${since}`, p, `^${first}`, '--'], repo.path))) {
        if (!via.has(sha)) via.set(sha, name);
      }
    }
  }
  return via;
}

// Rebased or cherry-picked copies (same patch, different hash) are counted once: the copy on
// main wins, else the oldest. Uses `git patch-id`, so it only matches identical patches.
function duplicatePatches(repo, commits, mainSet) {
  if (commits.length < 2) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const show = spawn('git', ['log', '--no-walk=unsorted', '--stdin', '-p', '--no-color', '--format=commit %H'], { cwd: repo.path, windowsHide: true });
    const pid = spawn('git', ['patch-id', '--stable'], { cwd: repo.path, windowsHide: true });
    let out = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    show.on('error', () => done(new Set()));
    pid.on('error', () => done(new Set()));
    pid.stdin.on('error', () => {});
    show.stdout.pipe(pid.stdin);
    show.stdin.end(commits.map((c) => c.hash).join('\n') + '\n');
    pid.stdout.setEncoding('utf8');
    pid.stdout.on('data', (d) => { out += d; });
    pid.on('close', (code) => {
      if (code !== 0) return done(new Set());
      const date = new Map(commits.map((c) => [c.hash, c.date]));
      const groups = new Map();
      for (const line of lines(out)) {
        const [id, sha] = line.split(' ');
        if (id && sha) (groups.get(id) || groups.set(id, []).get(id)).push(sha);
      }
      const dupes = new Set();
      for (const shas of groups.values()) {
        if (shas.length < 2) continue;
        const keep = shas.find((s) => mainSet.has(s)) || shas.slice().sort((a, b) => (date.get(a) < date.get(b) ? -1 : 1))[0];
        for (const s of shas) if (s !== keep) dupes.add(s);
      }
      done(dupes);
    });
  });
}

/**
 * Work pushed to any branch in the last `hours`, per developer and per branch.
 * Every commit gets a status:
 *  - main:      committed straight to the main branch
 *  - merged:    reached main in the window through a merge; `branches` names the merged branch
 *  - unmerged:  only on side branches; `branches` lists all of them
 *  - unpushed:  on a local main that is ahead of origin
 * The window is by commit (committer) date, so work rebased or cherry-picked in the window counts;
 * those commits are flagged `rewritten` when their author date is older.
 * Every developer carries `topFiles` (their biggest code changes in the window) alongside the
 * per-branch rows, so a 7/15/30-day window shows what changed as well as where.
 */
async function collectActivity({ repos: inputs, hours = 24, bots = false, excludes = [], now = Date.now(), log = () => {} }) {
  const sinceTs = now - hours * HOUR_MS;
  const since = new Date(sinceTs).toISOString();
  const opts = parseArgs(['-q']);
  opts.excludes = excludes;
  const isExcluded = buildExcluder(opts);

  const commits = [];
  const repositories = [];
  const warnings = [];
  let duplicatesSkipped = 0;

  for (const input of inputs) {
    let repo;
    try {
      repo = await resolveRepo(input.dir);
    } catch (err) {
      warnings.push(`${input.name}: ${(err.stderr || err.message).split('\n')[0]}`);
      continue;
    }
    repo.name = input.name || repo.name;
    if (!repo.hasCommits) {
      repositories.push({ name: repo.name, mainBranch: null, commits: 0 });
      continue;
    }

    let mainRef;
    try {
      mainRef = await detectMainRef(repo, input.main || null);
    } catch (err) {
      warnings.push(`${repo.name}: ${err.message}; using the detected main branch`);
      mainRef = await detectMainRef(repo, null);
    }
    const list = [];
    await streamLog(repo, { branches: [], mainOnly: false, all: false, since }, (c) => list.push(c));

    const { branches, containing } = await branchMembership(repo, since);
    const mainSet = new Set(mainRef ? lines(await git(['rev-list', `--since=${since}`, mainRef, '--'], repo.path)) : []);
    const mainFull = mainRef ? (await git(['rev-parse', '--symbolic-full-name', mainRef], repo.path)).trim() : '';
    const mainName = mainFull ? displayBranch(mainFull) : mainRef;
    const via = mainRef ? await mergedVia(repo, mainRef, since, branches) : new Map();
    const dupes = await duplicatePatches(repo, list.filter((c) => c.parents < 2), mainSet);

    let kept = 0;
    for (const c of list) {
      if (dupes.has(c.hash)) { duplicatesSkipped++; continue; }
      c.repo = repo.name;
      if (mainSet.has(c.hash)) {
        c.status = via.has(c.hash) ? 'merged' : 'main';
        c.branches = [via.get(c.hash) || mainName];
      } else {
        const names = [...(containing.get(c.hash) || [])].sort();
        const side = names.filter((n) => n !== mainName);
        c.status = side.length ? 'unmerged' : 'unpushed';
        c.branches = side.length ? side : names.length ? names : ['(unknown)'];
      }
      commits.push(c);
      kept++;
    }
    repositories.push({ name: repo.name, mainBranch: mainName, commits: kept, shallow: repo.shallow });
    log(`[${repo.name}] ${kept} commits in the last ${hours}h`);
  }

  // ---- identities (same merging rules as full scans) ---------------------------------------------
  for (const c of commits) c.email = normEmail(c.email);
  const idOf = buildIdentityResolver(commits, true);
  const idents = new Map();
  for (const c of commits) {
    c.id = idOf(c.email);
    const x = idents.get(c.id) || idents.set(c.id, { names: new Map(), emails: new Map() }).get(c.id);
    inc(x.names, c.name);
    inc(x.emails, c.email);
  }
  for (const x of idents.values()) {
    x.isBot = [...x.names.keys(), ...x.emails.keys()].some((s) => BOT_RE.test(s));
  }

  // ---- aggregate -------------------------------------------------------------------------------
  const people = new Map();
  const branchRows = new Map();
  const newBranchRow = (repo, branch) => ({
    repo, branch, commits: 0, merges: 0, additions: 0, deletions: 0,
    main: 0, merged: 0, unmerged: 0, unpushed: 0, lastAt: null,
  });
  const addTo = (row, c, add, del) => {
    if (c.parents > 1) row.merges++; else row.commits++;
    row.additions += add;
    row.deletions += del;
    row[c.status]++;
    if (!row.lastAt || c.date > row.lastAt) row.lastAt = c.date;
  };
  let excludedLines = 0;
  let botCommits = 0;

  for (const c of commits) {
    const ident = idents.get(c.id);
    if (ident.isBot && !bots) { botCommits++; continue; }
    let p = people.get(c.id);
    if (!p) {
      p = {
        name: topKey(ident.names), email: topKey(ident.emails),
        otherEmails: [...ident.emails.keys()].filter((e) => e !== topKey(ident.emails)).sort(),
        isBot: ident.isBot, commits: 0, merges: 0, additions: 0, deletions: 0,
        files: new Set(), fileChurn: new Map(), repos: new Set(), branches: new Map(), log: [], firstAt: null, lastAt: null,
      };
      people.set(c.id, p);
    }

    let add = 0;
    let del = 0;
    let fileCount = 0;
    for (const f of c.files) {
      if (isExcluded(f.path)) { excludedLines += f.add + f.del; continue; }
      add += f.add;
      del += f.del;
      fileCount++;
      const key = c.repo + '\0' + f.path;
      p.files.add(key);
      const churn = p.fileChurn.get(key) || p.fileChurn.set(key, { additions: 0, deletions: 0, commits: 0 }).get(key);
      churn.additions += f.add;
      churn.deletions += f.del;
      churn.commits++;
    }

    if (c.parents > 1) p.merges++; else p.commits++;
    p.additions += add;
    p.deletions += del;
    p.repos.add(c.repo);
    if (!p.firstAt || c.date < p.firstAt) p.firstAt = c.date;
    if (!p.lastAt || c.date > p.lastAt) p.lastAt = c.date;

    for (const b of c.branches) {
      const key = c.repo + '\0' + b;
      addTo(p.branches.get(key) || p.branches.set(key, newBranchRow(c.repo, b)).get(key), c, add, del);
      const row = branchRows.get(key) || branchRows.set(key, { ...newBranchRow(c.repo, b), developers: new Set() }).get(key);
      addTo(row, c, add, del);
      row.developers.add(p.name);
    }

    p.log.push({
      hash: c.hash.slice(0, 10), repo: c.repo, date: c.date, subject: c.subject,
      additions: add, deletions: del, files: fileCount, merge: c.parents > 1,
      status: c.status, branches: c.branches, rewritten: Date.parse(c.date) < sinceTs,
    });
  }

  const byChurn = (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions) || b.commits - a.commits;
  const developers = [...people.values()].map((p) => {
    const { fileChurn, ...rest } = p;
    const topFiles = [...fileChurn.entries()].map(([key, v]) => {
      const at = key.indexOf('\0');
      return { repo: key.slice(0, at), path: key.slice(at + 1), ...v, churn: v.additions + v.deletions };
    }).sort(byChurn).slice(0, 12);
    return {
      ...rest,
      topFiles,
      files: p.files.size,
      repos: [...p.repos].sort(),
      branches: [...p.branches.values()].sort(byChurn),
      log: p.log.sort((a, b) => (a.date < b.date ? 1 : -1)),
    };
  }).sort(byChurn);
  const branchList = [...branchRows.values()].map((b) => ({ ...b, developers: [...b.developers].sort() })).sort(byChurn);
  const sum = (key) => developers.reduce((s, d) => s + d[key], 0);

  return {
    generatedAt: new Date(now).toISOString(),
    since,
    hours,
    totals: {
      developers: developers.length,
      commits: sum('commits'),
      merges: sum('merges'),
      additions: sum('additions'),
      deletions: sum('deletions'),
      files: sum('files'),
      branches: branchList.length,
      unmergedCommits: developers.reduce((s, d) => s + d.log.filter((c) => !c.merge && (c.status === 'unmerged' || c.status === 'unpushed')).length, 0),
      repos: repositories.filter((r) => r.commits).length,
      duplicatesSkipped,
      excludedLines,
      botCommits,
    },
    developers,
    branches: branchList,
    repositories,
    warnings,
  };
}

module.exports = { collectActivity, branchFromSubject, activityHours, MAX_WINDOW_DAYS };
