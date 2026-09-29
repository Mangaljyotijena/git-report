'use strict';

const path = require('path');
const { buildExcluder } = require('./args');
const {
  resolveRepo, fetchAll, findRepos, streamLog, detectMainRef, analyzeBranches, workingTreeChanges, blameOwnership,
} = require('./git');
const { analyze } = require('./analyze');

// Discovers repositories, reads their history and returns the analysed report.
// Shared by the CLI and the web server.
async function collectReport(opts, log = () => {}) {
  const isExcluded = buildExcluder(opts);

  // ---- discover repositories -------------------------------------------------------------------
  const dirs = [...opts.repos];
  for (const dir of opts.scan) {
    const found = findRepos(path.resolve(dir), opts.scanDepth);
    log(`Found ${found.length} repositories under ${dir}`);
    dirs.push(...found);
  }
  if (!dirs.length) dirs.push(process.cwd());

  const repos = [];
  const seen = new Set();
  for (const dir of dirs) {
    try {
      const repo = await resolveRepo(path.resolve(dir));
      const key = repo.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      repos.push(repo);
    } catch (err) {
      const msg = err.stderr || err.message;
      if (/dubious ownership/i.test(msg)) {
        log(`skip: ${dir} is owned by another user. To trust it: git config --global --add safe.directory "${path.resolve(dir).replace(/\\/g, '/')}"`);
      } else {
        log(`skip: ${dir} is not a git repository (${msg.split('\n')[0]})`);
      }
    }
  }
  if (!repos.length) throw new Error('No git repositories found. Pass a repo path, or use --scan <dir>.');

  // Two repos with the same folder name (e.g. two "api" checkouts) need distinct labels.
  const names = new Map();
  for (const r of repos) {
    if (opts.repoLabels && opts.repoLabels[r.path.toLowerCase()]) r.name = opts.repoLabels[r.path.toLowerCase()];
    const n = (names.get(r.name) || 0) + 1;
    names.set(r.name, n);
    if (n > 1) r.name = `${r.name}-${n}`;
  }

  // ---- collect ---------------------------------------------------------------------------------
  const commits = [];
  const branchInfo = new Map();
  const blame = [];
  for (const repo of repos) {
    if (opts.fetch && repo.remote) {
      log(`[${repo.name}] fetching remotes…`);
      try { await fetchAll(repo); } catch (err) { log(`[${repo.name}] fetch failed, using local refs: ${err.stderr || err.message}`); }
    }
    if (!repo.hasCommits) {
      log(`[${repo.name}] no commits yet, skipped`);
      continue;
    }

    repo.mainRef = await detectMainRef(repo, opts.main);
    const repoOpts = { ...opts, mainRef: repo.mainRef };
    const t0 = Date.now();
    const count = await streamLog(repo, repoOpts, (c) => { c.repo = repo.name; commits.push(c); });
    log(`[${repo.name}] ${count.toLocaleString('en-US')} commits (${((Date.now() - t0) / 1000).toFixed(1)}s)${repo.shallow ? ' — shallow clone, history incomplete' : ''}`);

    // Branch classification only matters when side branches are in scope.
    if (!opts.mainOnly) {
      const b0 = Date.now();
      const info = await analyzeBranches(repo, repo.mainRef);
      branchInfo.set(repo.name, info);
      const unmerged = info.branches.filter((b) => b.status === 'unmerged').length;
      log(`[${repo.name}] main branch: ${repo.mainRef}; ${info.branches.length} branches, ${unmerged} unmerged (${((Date.now() - b0) / 1000).toFixed(1)}s)`);
    }

    repo.worktree = await workingTreeChanges(repo, isExcluded);

    if (opts.blame) {
      const ref = repo.mainRef || 'HEAD';
      log(`[${repo.name}] git blame at ${ref}…`);
      const res = await blameOwnership(repo, ref, isExcluded, opts.blameMaxFiles, (d, total) => log(`[${repo.name}]   blamed ${d}/${total} files`));
      if (res.filesSkipped) log(`[${repo.name}]   ${res.filesSkipped} files over --blame-max-files were not blamed`);
      blame.push({ repo: repo.name, ...res });
    }
  }

  return analyze({ commits, repos, opts, isExcluded, blame: opts.blame ? blame : null, branchInfo });
}

module.exports = { collectReport };
