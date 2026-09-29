'use strict';

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const RS = '\x1e'; // record separator between commits
const US = '\x1f'; // unit separator between header fields
const GS = '\x1d'; // separator between multiple co-author trailers
const LOG_FORMAT = '--pretty=format:%x1e%H%x1f%aN%x1f%aE%x1f%aI%x1f%P%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1f%s';
const GIT_BASE = ['-c', 'core.quotepath=off', '-c', 'log.showSignature=false', '-c', 'diff.renameLimit=10000'];

const BINARY_EXT = /\.(png|jpe?g|gif|bmp|ico|webp|avif|tiff?|psd|pdf|zip|gz|tgz|rar|7z|jar|war|exe|dll|so|dylib|bin|class|o|a|woff2?|ttf|otf|eot|mp[34]|mov|avi|wav|ogg|webm|sqlite|db|xlsx?|docx?|pptx?)$/i;
const MAIN_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop', 'origin/trunk', 'trunk'];

function git(args, cwd, maxBuffer = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_BASE, ...args], { cwd, maxBuffer, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').trim();
        const e = new Error(`git ${args[0]} failed in ${cwd}: ${msg}`);
        e.stderr = msg;
        return reject(e);
      }
      resolve(stdout);
    });
  });
}

const tryGit = (args, cwd) => git(args, cwd).then((s) => s.trim(), () => null);

async function pool(items, size, fn) {
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
}

// Never leak tokens embedded in remote URLs (https://user:token@host/...) into shared reports.
function sanitizeRemote(url) {
  return url.replace(/^(\w+:\/\/)[^@/]+@/, '$1');
}

async function resolveRepo(dir) {
  if (!fs.existsSync(dir)) throw new Error(`Path does not exist: ${dir}`);
  const top = path.resolve((await git(['rev-parse', '--show-toplevel'], dir)).trim());
  const remote = await tryGit(['config', '--get', 'remote.origin.url'], top);
  const branch = await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], top);
  const hasCommits = (await tryGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], top)) !== null;
  return {
    name: path.basename(top),
    path: top,
    remote: remote ? sanitizeRemote(remote) : null,
    branch: branch === 'HEAD' ? '(detached)' : branch,
    hasCommits,
    shallow: (await tryGit(['rev-parse', '--is-shallow-repository'], top)) === 'true',
  };
}

async function fetchAll(repo) {
  await git(['fetch', '--all', '--prune', '--quiet'], repo.path);
}

function findRepos(root, depth) {
  const found = [];
  const skip = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.venv', 'venv']);
  (function walk(dir, level) {
    if (fs.existsSync(path.join(dir, '.git'))) { found.push(dir); return; }
    if (level >= depth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.isDirectory() && !skip.has(e.name) && !e.name.startsWith('.')) walk(path.join(dir, e.name), level + 1);
    }
  })(root, 0);
  return found;
}

// "src/{old => new}/a.js" and "old.js => new.js" (rename notation from -M) -> new path
function normalizePath(p) {
  if (!p.includes(' => ')) return p;
  let out = p.replace(/\{([^{}]*) => ([^{}]*)\}/, (_, _from, to) => to);
  if (out.includes(' => ')) out = out.split(' => ').pop();
  return out.replace(/\/{2,}/g, '/').replace(/^\//, '');
}

function parseCoAuthors(raw) {
  if (!raw) return [];
  return raw.split(GS).map((s) => /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(s)).filter(Boolean)
    .map((m) => ({ name: m[1] || m[2], email: m[2] }));
}

function parseRecord(rec) {
  const nl = rec.indexOf('\n');
  const header = (nl === -1 ? rec : rec.slice(0, nl)).replace(/\r$/, '');
  const [hash, name, email, date, parents, coAuthors, ...subject] = header.split(US);
  const files = [];
  if (nl !== -1) {
    for (const raw of rec.slice(nl + 1).split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const binary = parts[0] === '-';
      files.push({
        path: normalizePath(parts.slice(2).join('\t')),
        add: binary ? 0 : parseInt(parts[0], 10) || 0,
        del: binary ? 0 : parseInt(parts[1], 10) || 0,
        binary,
      });
    }
  }
  return {
    hash, name: name || '(unknown)', email: email || '', date,
    parents: parents ? parents.trim().split(/\s+/).length : 0,
    coAuthors: parseCoAuthors(coAuthors),
    subject: subject.join(' '), files,
  };
}

// Which refs git log walks. Default: every local and remote-tracking branch, so work that was
// never merged still counts. Commits reachable from several branches are only listed once.
function refArgs(opts) {
  if (opts.branches.length) return opts.branches;
  if (opts.mainOnly) return [opts.mainRef];
  if (opts.all) return ['--exclude=refs/stash', '--all'];
  return ['--branches', '--remotes'];
}

// Streams `git log --numstat` so very large histories never have to fit in one buffer.
function streamLog(repo, opts, onCommit) {
  return new Promise((resolve, reject) => {
    const args = [...GIT_BASE, 'log', LOG_FORMAT, '--numstat', '-M', '--no-color', '--date-order'];
    if (opts.ignoreWhitespace) args.push('-w');
    args.push(...refArgs(opts));
    if (opts.since) args.push(`--since=${opts.since}`);
    if (opts.until) args.push(`--until=${opts.until}`);
    args.push('--');

    const child = spawn('git', args, { cwd: repo.path, windowsHide: true });
    let buf = '';
    let stderr = '';
    let count = 0;
    const emit = (rec) => {
      if (!rec.trim()) return;
      count++;
      onCommit(parseRecord(rec));
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const parts = buf.split(RS);
      buf = parts.pop();
      parts.forEach(emit);
    });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => reject(new Error(`Could not run git: ${err.message}`)));
    child.on('close', (code) => {
      emit(buf);
      if (code === 0) return resolve(count);
      if (/does not have any commits|bad default revision/i.test(stderr)) return resolve(0);
      reject(new Error(`git log failed in ${repo.path}: ${stderr.trim()}`));
    });
  });
}

async function refExists(repo, ref) {
  return (await tryGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo.path)) !== null;
}

// The branch that counts as "merged": origin's default branch, else a conventional name, else HEAD.
async function detectMainRef(repo, override) {
  if (override) {
    if (!(await refExists(repo, override))) throw new Error(`Main branch "${override}" not found in ${repo.name}`);
    return override;
  }
  const sym = await tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo.path);
  if (sym) return sym.replace(/^refs\/remotes\//, '');
  for (const c of MAIN_CANDIDATES) if (await refExists(repo, c)) return c;
  return repo.hasCommits ? 'HEAD' : null;
}

const displayBranch = (fullRef) => fullRef.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '');

/**
 * Classifies every branch against the main branch.
 *  - unmerged: Map hash -> Set(branch names) for commits that exist only on side branches
 *  - duplicates: commits whose patch already landed on main via rebase / cherry-pick
 *    (same change, different hash). They are skipped so lines are not counted twice.
 *  - branches: per-branch status for the report
 * Squash merges cannot be detected this way; their original branch commits stay "unmerged"
 * until the branch is deleted.
 */
async function analyzeBranches(repo, mainRef) {
  const result = { mainRef, unmerged: new Map(), duplicates: new Set(), branches: [] };
  if (!mainRef) return result;

  const mainFull = await tryGit(['rev-parse', '--symbolic-full-name', mainRef], repo.path);
  const mainName = mainFull ? displayBranch(mainFull) : mainRef;
  const mainTip = await tryGit(['rev-parse', `${mainRef}^{commit}`], repo.path);
  const mainSet = new Set((await git(['rev-list', mainRef], repo.path)).split('\n').filter(Boolean));

  const raw = await git(['for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/heads', 'refs/remotes'], repo.path);
  const byName = new Map();
  for (const line of raw.split('\n')) {
    const [ref, sha, date] = line.split('\t');
    if (!ref || ref.endsWith('/HEAD') || sha === undefined) continue;
    const name = displayBranch(ref);
    const b = byName.get(name) || byName.set(name, { name, refs: [], local: false, remote: false, tips: new Set(), lastCommit: null }).get(name);
    b.refs.push(ref);
    b.tips.add(sha);
    if (ref.startsWith('refs/heads/')) b.local = true; else b.remote = true;
    if (!b.lastCommit || date > b.lastCommit) b.lastCommit = date;
  }

  await pool([...byName.values()], 6, async (b) => {
    const isMain = b.name === mainName;
    const pending = new Set();
    for (const ref of b.refs) {
      if (mainTip && b.tips.size === 1 && b.tips.has(mainTip)) break;
      const out = await tryGit(['cherry', mainRef, ref], repo.path);
      for (const line of (out || '').split('\n')) {
        const sha = line.slice(2).trim();
        if (!sha) continue;
        if (line[0] === '-') result.duplicates.add(sha);
        else if (line[0] === '+' && !mainSet.has(sha)) pending.add(sha);
      }
    }
    for (const sha of pending) {
      const set = result.unmerged.get(sha) || result.unmerged.set(sha, new Set()).get(sha);
      set.add(b.name);
    }
    let status;
    if (isMain) status = pending.size ? 'unpushed' : 'main';
    else status = pending.size ? 'unmerged' : 'merged';
    result.branches.push({
      name: b.name, local: b.local, remote: b.remote, status,
      aheadCommits: pending.size, lastCommit: b.lastCommit ? b.lastCommit.slice(0, 10) : null,
    });
  });
  result.branches.sort((a, b) => b.aheadCommits - a.aheadCommits || a.name.localeCompare(b.name));
  return result;
}

// Uncommitted work in the checkout: nobody but the local git user can own it.
async function workingTreeChanges(repo, isExcluded) {
  if (!repo.hasCommits) return null;
  const numstat = await tryGit(['diff', '--numstat', 'HEAD'], repo.path);
  const untracked = await tryGit(['ls-files', '--others', '--exclude-standard'], repo.path);
  let files = 0;
  let additions = 0;
  let deletions = 0;
  for (const line of (numstat || '').split('\n')) {
    const [a, d, ...p] = line.split('\t');
    if (!p.length || isExcluded(normalizePath(p.join('\t')))) continue;
    files++;
    additions += parseInt(a, 10) || 0;
    deletions += parseInt(d, 10) || 0;
  }
  const untrackedFiles = (untracked || '').split('\n').filter((f) => f && !isExcluded(f)).length;
  if (!files && !untrackedFiles) return null;
  return {
    files, additions, deletions, untrackedFiles,
    user: (await tryGit(['config', 'user.name'], repo.path)) || null,
    email: (await tryGit(['config', 'user.email'], repo.path)) || null,
  };
}

// Lines currently owned by each author at the given ref: Map "name\x1femail" -> lines.
async function blameOwnership(repo, ref, isExcluded, maxFiles, onProgress) {
  const all = (await git(['ls-tree', '-r', '-z', '--name-only', ref], repo.path)).split('\0')
    .filter((f) => f && !isExcluded(f) && !BINARY_EXT.test(f));
  const files = all.slice(0, maxFiles);
  const owners = new Map();
  let done = 0;

  await pool(files, 8, async (file) => {
    try {
      const out = await git(['blame', '--line-porcelain', '-w', ref, '--', file], repo.path);
      let name = '';
      for (const line of out.split('\n')) {
        if (line.startsWith('author ')) name = line.slice(7).trim();
        else if (line.startsWith('author-mail ')) {
          const email = line.slice(12).trim().replace(/^<|>$/g, '');
          const key = name + US + email;
          owners.set(key, (owners.get(key) || 0) + 1);
        }
      }
    } catch (_) { /* submodule, symlink, etc. */ }
    done++;
    if (onProgress && done % 100 === 0) onProgress(done, files.length);
  });
  return { owners, filesBlamed: files.length, filesSkipped: all.length - files.length };
}

module.exports = {
  git, resolveRepo, fetchAll, findRepos, streamLog, detectMainRef, analyzeBranches, workingTreeChanges,
  blameOwnership, normalizePath, parseRecord, sanitizeRemote, US,
};
