'use strict';

// UI test for the Activity page: day windows (7/15/30), the `days` query parameter,
// the per-developer code-change details and the capped commit list.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8').replace(/\nrouter\(\);\s*$/, '\n');

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 864e5).toISOString();
const commit = (i) => ({
  hash: `deadbeef${String(i).padStart(2, '0')}`, repo: 'demo', date: iso(i % 30), subject: `commit ${i}`,
  additions: 3, deletions: 1, files: 1, merge: false, status: 'unmerged', branches: ['feature/x'], rewritten: false,
});
const payload = {
  generatedAt: new Date().toISOString(), since: iso(30), hours: 720,
  totals: {
    developers: 1, commits: 60, merges: 0, additions: 180, deletions: 60, files: 5, branches: 1,
    unmergedCommits: 60, repos: 1, duplicatesSkipped: 0, excludedLines: 0, botCommits: 0,
  },
  repositories: [{ name: 'demo', mainBranch: 'main', commits: 60, shallow: false }],
  warnings: [],
  branches: [{
    repo: 'demo', branch: 'feature/x', commits: 60, merges: 0, additions: 180, deletions: 60,
    main: 0, merged: 0, unmerged: 60, unpushed: 0, lastAt: iso(0), developers: ['Ada Lovelace'],
  }],
  developers: [{
    name: 'Ada Lovelace', email: 'ada@acme.com', otherEmails: ['ada@gmail.com'], isBot: false,
    commits: 60, merges: 0, additions: 180, deletions: 60, files: 5,
    repos: ['demo'], firstAt: iso(30), lastAt: iso(0),
    branches: [{
      repo: 'demo', branch: 'feature/x', commits: 60, merges: 0, additions: 180, deletions: 60,
      main: 0, merged: 0, unmerged: 60, unpushed: 0, lastAt: iso(0),
    }],
    topFiles: [{ repo: 'demo', path: 'src/app.js', additions: 60, deletions: 20, commits: 12, churn: 80 }],
    log: Array.from({ length: 60 }, (_, i) => commit(i)),
  }],
};

const elements = new Map();
const el = (extra = {}) => ({ value: '', disabled: false, innerHTML: '', hidden: false, onchange: null, onclick: null, oninput: null, className: '', textContent: '', ...extra });
const getEl = (sel) => { if (!elements.has(sel)) elements.set(sel, el()); return elements.get(sel); };
const moreBody = { hidden: true };
const moreBtn = {
  removed: false,
  closest: () => ({ querySelector: (s) => (assert.strictEqual(s, '.log-more'), moreBody) }),
  remove() { this.removed = true; },
};
const requests = [];
const store = new Map();

const ctx = vm.createContext({
  console,
  Date, Math, Number, String, Object, Array, JSON, Intl, URLSearchParams, TextDecoder,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  location: { hash: '#/activity', replaceState() {} },
  history: { replaceState() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  window: { addEventListener() {}, renderMarkdown: (t) => t },
  document: {
    querySelector: (sel) => getEl(sel),
    querySelectorAll: (sel) => (sel === '.log-more-btn' ? [moreBtn] : []),
    createElement: () => el(),
  },
  fetch: async (url) => {
    requests.push(String(url));
    const body = String(url).includes('/api/repos') ? [{ id: 1, name: 'demo' }] : payload;
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => body, text: async () => '' };
  },
});
vm.runInContext(src, ctx, { filename: 'public/app.js' });

const flush = () => new Promise((r) => setTimeout(r, 20));

(async () => {
  // The <select> really does hold the selected value; the stub starts where the markup puts it.
  elements.set('#days', el({ value: '1' }));

  // -- the page asks for the selected window in days -------------------------------------------------
  await ctx.activity();
  await flush();
  const head = getEl('#view').innerHTML;
  for (const label of ['Last 7 days', 'Last 15 days', 'Last 30 days']) {
    assert.ok(head.includes(`>${label}</option>`), `${label} offered as a window`);
  }
  assert.ok(requests.some((u) => u.includes('/api/activity?days=1')), 'default window sent as days=1: ' + requests.join(' '));

  // -- switching to 30 days reloads with days=30 ----------------------------------------------------
  const before = requests.length;
  getEl('#days').value = '30';
  getEl('#days').onchange({ target: { value: '30' } });
  await flush();
  assert.ok(requests.slice(before).some((u) => u.includes('days=30')), '30-day window requested as days=30');
  assert.strictEqual(store.get('gi-act-days'), '30', 'the chosen window is remembered');

  // -- rendered output: code changes, branches, capped commit list -----------------------------------
  const html = getEl('#act').innerHTML;
  assert.ok(html.includes('Top 1 changed file'), 'code-change details rendered');
  assert.ok(html.includes('src/app.js'), 'the changed file is listed');
  assert.ok(html.includes('feature/x'), 'per-branch breakdown rendered');
  assert.ok(html.includes('Show 10 more'), 'commit list capped at 50 with a button for the rest');
  assert.ok(html.includes('<tbody class="log-more" hidden>'), 'the remaining commits are in a hidden section');
  const hidden = /<tbody class="log-more" hidden>([\s\S]*?)<\/tbody>/.exec(html);
  assert.ok(hidden, 'hidden section found');
  assert.strictEqual((hidden[1].match(/<tr>/g) || []).length, 10, 'only the overflow sits in the hidden section');
  assert.strictEqual((html.match(/deadbeef/g) || []).length, 60, 'every commit of the window is rendered');

  // -- the button reveals the rest -------------------------------------------------------------------
  assert.ok(!moreBtn.removed, 'the button was wired up');
  moreBtn.onclick();
  assert.strictEqual(moreBody.hidden, false, 'hidden commits revealed');
  assert.ok(moreBtn.removed, 'the button removes itself');

  console.log('activity UI test passed');
})().catch((err) => { console.error(err); process.exit(1); });
