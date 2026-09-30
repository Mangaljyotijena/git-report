'use strict';

// Recent-activity test: a throwaway repo with work on several branches inside and outside the window.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { collectActivity, branchFromSubject } = require('../src/activity');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-activity-test-'));
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
const write = (file, n) => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n');
};
const now = Date.now();
const ago = (h) => new Date(now - h * 3600000).toISOString();
const commit = (who, msg, h) => { git(['add', '-A']); git(['commit', '-q', '-m', msg], { ...who, date: ago(h) }); };

const alice = { name: 'Alice Smith', email: 'alice@acme.com' };
const aliceHome = { name: 'Alice Smith', email: 'alice.smith@gmail.com' };
const bob = { name: 'Bob Jones', email: 'bob@acme.com' };
const carol = { name: 'Carol White', email: 'carol@acme.com' };
const dave = { name: 'Dave Brown', email: 'dave@acme.com' };
const bot = { name: 'dependabot[bot]', email: 'bot@github.com' };

git(['init', '-q', '-b', 'main']);
write('src/old.js', 50); commit(alice, 'old work', 72);                                   // outside the window
write('src/app.js', 5); commit(alice, 'feat: app', 10);                                    // main, +5
write('src/home.js', 2); commit(aliceHome, 'from home', 9);                                // main, +2, same person
write('package-lock.json', 300); commit(alice, 'chore: lock', 8);                          // excluded file

// Bob: feature/login merged with a merge commit, feature/api still open
git(['checkout', '-q', '-b', 'feature/login']);
write('src/login.js', 10); commit(bob, 'feat: login form', 7);                             // merged, +10
write('src/login.js', 13); commit(bob, 'feat: validation', 6);                             // merged, +3
git(['checkout', '-q', 'main']);
git(['merge', '-q', '--no-ff', 'feature/login', '-m', "Merge branch 'feature/login'"], { ...bob, date: ago(5) });
git(['checkout', '-q', '-b', 'feature/api']);
write('src/api.js', 20); commit(bob, 'feat: api client', 4);                               // unmerged, +20
git(['checkout', '-q', 'main']);

// Carol: fix on hotfix, cherry-picked onto main (counted once, as main)
git(['checkout', '-q', '-b', 'hotfix']);
write('src/fix.js', 3); commit(carol, 'fix: crash', 3);
const pick = git(['rev-parse', 'HEAD']);
git(['checkout', '-q', 'main']);
git(['cherry-pick', pick], { ...carol, date: ago(2) });

// Dave: stacked branches, a commit on feature/a is also on feature/b
git(['checkout', '-q', '-b', 'feature/a']);
write('src/a.js', 4); commit(dave, 'feat: a', 2);
git(['checkout', '-q', '-b', 'feature/b']);
write('src/b.js', 6); commit(dave, 'feat: b', 1);
git(['checkout', '-q', 'main']);

// A merge with a custom message: the branch is found from its tip instead
git(['checkout', '-q', '-b', 'topic']);
write('src/topic.js', 8); commit(dave, 'feat: topic', 1.5);
git(['checkout', '-q', 'main']);
git(['merge', '-q', '--no-ff', 'topic', '-m', 'Integrate the topic work'], { ...dave, date: ago(1.4) });

// A bot on its own branch
git(['checkout', '-q', '-b', 'deps']);
write('deps.txt', 1); commit(bot, 'bump deps', 1);
git(['checkout', '-q', 'main']);

(async () => {
  const r = await collectActivity({ repos: [{ dir: repo, name: 'demo' }], hours: 24, now });
  const dev = (name) => r.developers.find((d) => d.name === name);
  const row = (d, branch) => dev(d).branches.find((b) => b.branch === branch);

  assert.deepStrictEqual(r.developers.map((d) => d.name).sort(), ['Alice Smith', 'Bob Jones', 'Carol White', 'Dave Brown'], 'bot dropped, Alice merged');
  assert.strictEqual(r.totals.botCommits, 1);

  assert.strictEqual(dev('Alice Smith').commits, 3, 'old commit outside the window');
  assert.strictEqual(dev('Alice Smith').additions, 7, 'lock file excluded');
  assert.deepStrictEqual(dev('Alice Smith').otherEmails, ['alice.smith@gmail.com']);
  assert.strictEqual(row('Alice Smith', 'main').main, 3);

  assert.strictEqual(dev('Bob Jones').commits, 3);
  assert.strictEqual(dev('Bob Jones').merges, 1);
  assert.strictEqual(dev('Bob Jones').additions, 33);
  assert.strictEqual(row('Bob Jones', 'feature/login').merged, 2, 'merged commits keep their branch name');
  assert.strictEqual(row('Bob Jones', 'feature/login').additions, 13);
  assert.strictEqual(row('Bob Jones', 'feature/api').unmerged, 1);
  assert.strictEqual(row('Bob Jones', 'feature/api').additions, 20);
  assert.strictEqual(row('Bob Jones', 'main').merges, 1, 'merge commit is on main');

  assert.strictEqual(dev('Carol White').commits, 1, 'cherry-picked copy counted once');
  assert.strictEqual(dev('Carol White').log[0].status, 'main');
  assert.strictEqual(r.totals.duplicatesSkipped, 1);

  assert.deepStrictEqual(dev('Dave Brown').log.find((c) => c.subject === 'feat: a').branches, ['feature/a', 'feature/b']);
  assert.strictEqual(dev('Dave Brown').commits, 3, 'a commit on two branches is counted once per developer');
  assert.strictEqual(row('Dave Brown', 'topic').merged, 1, 'merged branch found from its tip');
  assert.strictEqual(r.totals.unmergedCommits, 3, 'feature/api + feature/a + feature/b');

  assert.strictEqual(r.totals.additions, 7 + 33 + 3 + 10 + 8);
  assert.ok(r.branches.some((b) => b.branch === 'feature/login' && b.developers.includes('Bob Jones')));
  assert.strictEqual(r.repositories[0].mainBranch, 'main');

  // A shorter window drops older work.
  const short = await collectActivity({ repos: [{ dir: repo, name: 'demo' }], hours: 3.5, now });
  assert.deepStrictEqual(short.developers.map((d) => d.name).sort(), ['Carol White', 'Dave Brown']);

  assert.strictEqual(branchFromSubject('Merge pull request #12 from acme/feature/x-y'), 'feature/x-y');
  assert.strictEqual(branchFromSubject('Merged in bugfix/abc (pull request #7)'), 'bugfix/abc');
  assert.strictEqual(branchFromSubject("Merge branch 'feat/z' into 'main'"), 'feat/z');
  assert.strictEqual(branchFromSubject("Merge remote-tracking branch 'origin/dev'"), 'dev');
  assert.strictEqual(branchFromSubject('fix: things'), null);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('activity test passed');
})().catch((err) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
