'use strict';

// End-to-end test: builds a throwaway repo covering the tricky cases, runs the CLI, checks numbers.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-report-test-'));
const out = path.join(dir, '_out');
const repo = path.join(dir, 'demo');
fs.mkdirSync(repo);

function git(args, who) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(dir, 'nocfg') };
  if (who) {
    Object.assign(env, {
      GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email,
      GIT_AUTHOR_DATE: who.date, GIT_COMMITTER_DATE: who.date,
    });
  }
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf8' }).trim();
}
const write = (file, lines) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n');
};
const commit = (who, msg, date) => { git(['add', '-A']); git(['commit', '-q', '-m', msg], { ...who, date }); };

const alice = { name: 'Alice Smith', email: 'alice@acme.com' };
const aliceHome = { name: 'Alice Smith', email: 'alice.smith@gmail.com' };
const bob = { name: 'Bob Jones', email: 'bob@acme.com' };
const carol = { name: 'Carol White', email: 'carol@contractor.io' };

git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Local User']);
git(['config', 'user.email', 'local@acme.com']);

write('src/app.js', 10); commit(alice, 'feat: initial app', '2025-01-06T10:00:00+05:30');     // +10
write('src/util.js', 5); commit(aliceHome, 'add util', '2025-01-07T22:00:00+05:30');          // +5, second email
write('package-lock.json', 500); commit(bob, 'chore: lock', '2025-01-08T11:00:00+00:00');     // excluded

// Bob: feature merged with a real merge commit
git(['checkout', '-q', '-b', 'feature/merged']);
write('src/merged.js', 7); commit(bob, 'feat: merged feature', '2025-01-09T11:00:00+00:00');   // +7
git(['checkout', '-q', 'main']);
git(['merge', '-q', '--no-ff', 'feature/merged', '-m', 'Merge feature/merged'], { ...bob, date: '2025-01-10T11:00:00+00:00' });

// Bob: work that is never merged
git(['checkout', '-q', '-b', 'feature/open']);
write('src/open.js', 20); commit(bob, 'feat: wip open feature', '2025-01-11T11:00:00+00:00');  // +20 unmerged
git(['checkout', '-q', 'main']);

// Carol: commit on a branch, then cherry-picked onto main (same patch, two hashes)
git(['checkout', '-q', '-b', 'hotfix']);
write('src/fix.js', 3); commit(carol, 'fix: crash', '2025-01-12T09:00:00+00:00');              // +3, once
const pick = git(['rev-parse', 'HEAD']);
git(['checkout', '-q', 'main']);
git(['cherry-pick', pick], { ...carol, date: '2025-01-13T09:00:00+00:00' });

// Rename + co-author trailer
git(['mv', 'src/util.js', 'src/helpers.js']);
fs.appendFileSync(path.join(repo, 'src/helpers.js'), 'extra\n');
git(['add', '-A']);
git(['commit', '-q', '-m', 'refactor: rename util\n\nCo-authored-by: Bob Jones <bob@acme.com>'], { ...alice, date: '2025-01-14T10:00:00+05:30' }); // +1

// Uncommitted work
fs.appendFileSync(path.join(repo, 'src/app.js'), 'pending\n');

execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'git-report.js'), repo, '-f', 'json,csv,html', '-o', out, '-q'], { encoding: 'utf8' });
const r = JSON.parse(fs.readFileSync(path.join(out, 'git-report.json'), 'utf8'));
const dev = (name) => r.developers.find((d) => d.name === name);

assert.strictEqual(r.developers.length, 3, 'three people (Alice merged across two emails)');
assert.deepStrictEqual(dev('Alice Smith').aliases.emails, ['alice.smith@gmail.com']);
assert.strictEqual(dev('Alice Smith').commits, 3);
assert.strictEqual(dev('Alice Smith').additions, 16, 'rename counted as +1, not a full rewrite');
assert.strictEqual(dev('Bob Jones').commits, 3, 'lock + merged feature + unmerged feature');
assert.strictEqual(dev('Bob Jones').merges, 1);
assert.strictEqual(dev('Bob Jones').additions, 27, 'lock file excluded; unmerged work included');
assert.strictEqual(dev('Bob Jones').unmerged.commits, 1);
assert.strictEqual(dev('Bob Jones').unmerged.additions, 20);
assert.strictEqual(dev('Bob Jones').branches[0].name, 'feature/open');
assert.strictEqual(dev('Bob Jones').coAuthoredCommits, 1);
assert.strictEqual(dev('Carol White').commits, 1, 'cherry-picked copy counted once');
assert.strictEqual(dev('Carol White').additions, 3);
assert.strictEqual(dev('Carol White').unmerged.commits, 0);
assert.strictEqual(r.summary.duplicatesSkipped, 1);
assert.strictEqual(r.summary.unmergedBranches, 1);
assert.ok(r.summary.excludedLines >= 500);
assert.ok(r.repositories[0].uncommitted && r.repositories[0].uncommitted.files === 1, 'uncommitted change detected');
assert.strictEqual(r.repositories[0].mainBranch, 'main');
assert.deepStrictEqual(r.domains.map((d) => d.domain).sort(), ['acme.com', 'contractor.io'], 'grouped by primary email domain');
// Execute the dashboard's script against a stub DOM to catch runtime errors in the page.
{
  const vm = require('vm');
  const html = fs.readFileSync(path.join(out, 'git-report.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const els = {};
  const el = () => ({ innerHTML: '', textContent: '', style: {}, querySelectorAll: () => [] });
  const window = {};
  const ctx = vm.createContext({ window, document: { getElementById: (id) => (els[id] = els[id] || el()) }, Date, Number, String, Math, Object });
  scripts.forEach((s) => vm.runInContext(s, ctx));
  assert.ok(els.devs.innerHTML.includes('Bob Jones'), 'developer table rendered');
  assert.ok(els.branches.innerHTML.includes('feature/open'), 'unmerged branch table rendered');
  assert.ok(els.timeline.innerHTML.includes('<svg'), 'timeline rendered');
}
assert.ok(fs.readFileSync(path.join(out, 'branches.csv'), 'utf8').includes('feature/open'));

// --main-only drops unmerged work
execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'git-report.js'), repo, '--main-only', '-f', 'json', '-o', out, '-q']);
const m = JSON.parse(fs.readFileSync(path.join(out, 'git-report.json'), 'utf8'));
assert.strictEqual(m.developers.find((d) => d.name === 'Bob Jones').additions, 7);

// author filter
execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'git-report.js'), repo, '-a', 'carol@', '-f', 'json', '-o', out, '-q']);
const c = JSON.parse(fs.readFileSync(path.join(out, 'git-report.json'), 'utf8'));
assert.deepStrictEqual(c.developers.map((d) => d.name), ['Carol White']);

fs.rmSync(dir, { recursive: true, force: true });
console.log('smoke test passed');
