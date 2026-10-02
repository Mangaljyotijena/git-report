'use strict';

// UI test for the Activity page: day windows (7/15/30) and the `days` query parameter,
// the developer list (sorting, filtering, share bars) and the detail pane opened from a row
// (per-developer code changes, branches and the capped commit list), plus refresh and errors.
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
    developers: 2, commits: 65, merges: 0, additions: 190, deletions: 65, files: 6, branches: 2,
    unmergedCommits: 65, repos: 1, duplicatesSkipped: 0, excludedLines: 0, botCommits: 0,
  },
  repositories: [{ name: 'demo', mainBranch: 'main', commits: 65, shallow: false }],
  warnings: [],
  branches: [
    {
      repo: 'demo', branch: 'feature/x', commits: 60, merges: 0, additions: 180, deletions: 60,
      main: 0, merged: 0, unmerged: 60, unpushed: 0, lastAt: iso(0), developers: ['Ada Lovelace'],
    },
    {
      repo: 'demo', branch: 'main', commits: 5, merges: 0, additions: 10, deletions: 5,
      main: 5, merged: 0, unmerged: 0, unpushed: 0, lastAt: iso(1), developers: ['Bob Builder'],
    },
  ],
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
  }, {
    name: 'Bob Builder', email: 'bob@acme.com', otherEmails: [], isBot: false,
    commits: 5, merges: 0, additions: 10, deletions: 5, files: 1,
    repos: ['demo'], firstAt: iso(20), lastAt: iso(1),
    branches: [{
      repo: 'demo', branch: 'main', commits: 5, merges: 0, additions: 10, deletions: 5,
      main: 5, merged: 0, unmerged: 0, unpushed: 0, lastAt: iso(1),
    }],
    topFiles: [{ repo: 'demo', path: 'README.md', additions: 4, deletions: 1, commits: 2, churn: 5 }],
    log: Array.from({ length: 5 }, (_, i) => ({
      ...commit(i), hash: `b0b0b0b${i}`, status: 'main', branches: ['main'], subject: `readme ${i}`,
    })),
  }],
};

const mkEl = (extra = {}) => ({
  value: '', disabled: false, innerHTML: '', hidden: false, textContent: '', className: '',
  onchange: null, onclick: null, oninput: null, onkeydown: null,
  attrs: {},
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  focus() { this.focused = true; },
  scrollIntoView() {},
  setAttribute(k, v) { this.attrs[k] = v; },
  getAttribute(k) { return this.attrs[k]; },
  querySelector: () => null,
  querySelectorAll: () => [],
  closest: () => null,
  remove() {},
  ...extra,
});

const elements = new Map();
const getEl = (sel) => { if (!elements.has(sel)) elements.set(sel, mkEl()); return elements.get(sel); };

const actClasses = new Set();
elements.set('#act', mkEl({
  classList: {
    add: (c) => actClasses.add(c),
    remove: (c) => actClasses.delete(c),
    toggle: (c, on) => (on ? actClasses.add(c) : actClasses.delete(c)),
    contains: (c) => actClasses.has(c),
  },
}));
elements.set('#toast', mkEl({ hidden: true }));

const moreBody = { hidden: true };
const moreBtn = {
  removed: false,
  closest: () => ({ querySelector: (s) => (assert.strictEqual(s, '.log-more'), moreBody) }),
  remove() { this.removed = true; },
};

const thSorts = ['name', 'commits', 'lines', 'files', 'branches', 'last'].map((key) => {
  const ind = { textContent: '' };
  const th = mkEl();
  return { dataset: { sort: key }, onclick: null, onkeydown: null, _th: th, _ind: ind, closest: (s) => (s === 'th' ? th : null), querySelector: (s) => (s === '.sort-ind' ? ind : null) };
});
let focusedSel = null;
const devTabs = ['overview', 'repos', 'branches', 'files', 'commits'].map((k) => mkEl({ dataset: { tab: k } }));
const devPanels = ['overview', 'repos', 'branches', 'files', 'commits'].map((k) => mkEl({ dataset: { panel: k } }));
const paneEl = mkEl({
  querySelector: (sel) => { focusedSel = sel; return mkEl(); },
  querySelectorAll: (sel) => (sel === '.th-sort' ? thSorts
    : sel === '.dev-tab' ? devTabs
      : sel === '.dev-panel' ? devPanels : []),
});
elements.set('#dev-pane', paneEl);

const requests = [];
const exported = [];
const store = new Map();
const scrolled = [];
let holdNext = false;
let release = null;
let failNext = false;

const ctx = vm.createContext({
  console,
  Date, Math, Number, String, Object, Array, JSON, Intl, URLSearchParams, TextDecoder,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  location: { hash: '#/activity', replaceState() {} },
  history: { replaceState() {} },
  sessionStorage: { getItem: () => null, setItem() {} },
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
  window: { addEventListener() {}, renderMarkdown: (t) => t, scrollY: 420, scrollTo: (o) => scrolled.push(o.top) },
  document: {
    querySelector: (sel) => getEl(sel),
    querySelectorAll: (sel) => (sel === '.log-more-btn' ? [moreBtn] : []),
    createElement: () => mkEl(),
  },
  fetch: async (url) => {
    requests.push(String(url));
    if (holdNext) { holdNext = false; await new Promise((r) => { release = r; }); }
    if (failNext) {
      failNext = false;
      return { ok: false, headers: { get: () => 'application/json' }, json: async () => ({ error: 'scanner exploded' }), text: async () => '' };
    }
    const body = String(url).includes('/api/repos') ? [{ id: 1, name: 'demo' }] : payload;
    return { ok: true, headers: { get: () => 'application/json' }, json: async () => body, text: async () => '' };
  },
  exportActivityList: async (model, kind, deps = {}) => {
    exported.push({ model, kind, filename: deps.filename });
    return deps.filename || `activity-export.${kind}`;
  },
});
vm.runInContext(src, ctx, { filename: 'public/app.js' });

const flush = () => new Promise((r) => setTimeout(r, 20));
const rowsHtml = () => getEl('#dev-rows').innerHTML;
const th = (k) => thSorts.find((b) => b.dataset.sort === k);
const clickRow = (i) => getEl('#dev-rows').onclick({ target: { closest: (sel) => (sel === 'tr[data-i]' ? { dataset: { i: String(i) } } : null) } });

(async () => {
  // The <select> really does hold the selected value; the stub starts where the markup puts it.
  elements.set('#days', mkEl({ value: '1' }));

  // -- the page asks for the selected window in days -------------------------------------------------
  await ctx.activity();
  await flush();
  const head = getEl('#view').innerHTML;
  for (const label of ['Last 7 days', 'Last 15 days', 'Last 30 days', 'Last 90 days', 'Last 180 days', 'Last 365 days']) {
    assert.ok(head.includes(`>${label}</option>`), `${label} offered as a window`);
  }
  assert.ok(requests.some((u) => u.includes('/api/activity?days=1')), 'default window sent as days=1: ' + requests.join(' '));
  assert.ok(!actClasses.has('is-loading'), 'the first paint is a spinner, not a dim');

  // -- KPI cards stay on the page -------------------------------------------------------------------
  const html = getEl('#act').innerHTML;
  assert.ok(html.includes('<div class="grid stats">'), 'the KPI cards are kept');
  for (const label of ['developers', 'commits', 'lines changed', 'files changed', 'branches', 'merges', 'not merged yet']) {
    assert.ok(html.includes(`<div class="l">${label}</div>`), `KPI card kept: ${label}`);
  }
  assert.ok(html.includes('id="dev-pane"'), 'the developer pane holds the list');
  assert.ok(html.includes('id="dev-search"'), 'the filter box is on the page');
  for (const id of ['dev-rows', 'dev-count', 'dev-empty']) {
    assert.ok(html.includes(`id="${id}"`), `the wiring target #${id} is in the markup`);
  }
  assert.ok(html.includes('Branches'), 'the everyone-per-branch summary is still on the page');
  assert.ok(html.includes('counted once in the totals'), 'the footnote is kept');

  // -- the list is the default pane -----------------------------------------------------------------
  assert.ok(!html.includes('class="dev-row"'), 'no rows are inlined into the shell');
  assert.ok(rowsHtml().includes('Ada Lovelace') && rowsHtml().includes('Bob Builder'), 'both developers are listed');
  assert.ok(rowsHtml().includes('class="nm dev-open"'), 'the name is a real button');
  assert.ok(rowsHtml().includes('class="chev"'), 'each row shows a chevron');
  assert.strictEqual((rowsHtml().match(/class="share"/g) || []).length, 2, 'each row shows a share bar');
  assert.strictEqual((rowsHtml().match(/data-i="/g) || []).length, 2, 'rows carry their developer index');
  assert.ok(getEl('#dev-count').textContent.includes('2 developers'), 'the count is shown: ' + getEl('#dev-count').textContent);
  assert.deepStrictEqual([...html.matchAll(/data-sort="([a-z]+)"/g)].map((m) => m[1]),
    ['name', 'commits', 'lines', 'files', 'branches', 'last'], 'every sortable header is rendered');
  assert.ok(rowsHtml().indexOf('Ada Lovelace') < rowsHtml().indexOf('Bob Builder'), 'busiest developer first');

  // -- refreshing keeps the report on screen ---------------------------------------------------------
  const before = requests.length;
  holdNext = true;
  getEl('#days').value = '30';
  getEl('#days').onchange({ target: { value: '30' } });
  await flush();
  assert.ok(actClasses.has('is-loading'), 'the report is dimmed while it refreshes');
  assert.strictEqual(getEl('#act').innerHTML, html, 'the current report is not replaced by a spinner');
  release();
  await flush();
  assert.ok(!actClasses.has('is-loading'), 'the dim is removed once the data lands');
  assert.ok(requests.slice(before).some((u) => u.includes('days=30')), '30-day window requested as days=30');
  assert.strictEqual(store.get('gi-act-days'), '30', 'the chosen window is remembered');
  assert.strictEqual(getEl('#refresh').disabled, false, 'refresh is enabled again');

  // -- sorting ----------------------------------------------------------------------------------------
  th('name').onclick();
  assert.strictEqual(th('name')._th.getAttribute('aria-sort'), 'ascending', 'aria-sort flips on click');
  assert.ok(rowsHtml().indexOf('Ada Lovelace') < rowsHtml().indexOf('Bob Builder'), 'ascending order');
  th('name').onclick();
  assert.strictEqual(th('name')._th.getAttribute('aria-sort'), 'descending', 'the second click reverses it');
  assert.ok(rowsHtml().indexOf('Bob Builder') < rowsHtml().indexOf('Ada Lovelace'), 'descending order');
  th('name').onclick();

  // -- filtering ---------------------------------------------------------------------------------------
  const search = getEl('#dev-search');
  search.value = 'bob';
  search.oninput();
  assert.ok(rowsHtml().includes('Bob Builder') && !rowsHtml().includes('Ada Lovelace'), 'filtered to one developer');
  assert.ok(getEl('#dev-count').textContent.includes('1 of 2'), 'the count shows the filter: ' + getEl('#dev-count').textContent);
  search.value = 'nobody';
  search.oninput();
  assert.strictEqual(getEl('#dev-empty').hidden, false, 'an empty filter explains itself');
  assert.ok(getEl('#dev-empty').innerHTML.includes('Clear filter'), 'with a way out');
  getEl('#dev-clear').onclick();
  assert.strictEqual(getEl('#dev-empty').hidden, true, 'the empty state is gone');
  assert.strictEqual(search.value, '', 'the box was cleared');
  assert.ok(rowsHtml().includes('Ada Lovelace'), 'both developers are back');

  // -- exporting exactly what the list shows ------------------------------------------------------------
  assert.ok(typeof getEl('#act-png').onclick === 'function', 'the PNG button is wired');
  assert.ok(typeof getEl('#act-pdf').onclick === 'function', 'the PDF button is wired');
  const pngBtn = getEl('#act-png');
  const pdfBtn = getEl('#act-pdf');
  pngBtn.textContent = 'Export PNG';
  pngBtn.onclick();
  assert.strictEqual(pngBtn.disabled, true, 'the export disables its button while it works');
  assert.strictEqual(pngBtn.textContent, 'Working…', 'and says so');
  await flush();
  assert.strictEqual(pngBtn.disabled, false, 'the button comes back');
  assert.strictEqual(pngBtn.textContent, 'Export PNG', 'with its original label');
  assert.strictEqual(exported.length, 1, 'one export so far');
  assert.strictEqual(exported[0].kind, 'png', 'a PNG was requested');
  const day = new Date().toISOString().slice(0, 10);
  assert.strictEqual(exported[0].filename, `activity-30d-${day}.png`, 'named after the window');
  assert.strictEqual(getEl('#toast').textContent, `Saved activity-30d-${day}.png`, 'and reported: ' + getEl('#toast').textContent);
  const ex = exported[0].model;
  assert.strictEqual(ex.rows.length, 2, 'every developer on screen is exported');
  assert.strictEqual(ex.rows[0].cells[0].text, 'Ada Lovelace', 'in the order shown');
  assert.ok(ex.rows[0].cells[0].sub.includes('ada@acme.com'), 'with their e-mail');
  assert.strictEqual(ex.columns.length, 7, 'the same columns as the table');
  assert.ok(ex.totalsLine.startsWith('65 commits · +190 −65 lines'), ex.totalsLine);
  assert.ok(ex.context[0].startsWith('Last 30 days · All enabled repositories'), ex.context[0]);
  assert.ok(ex.context[1].includes('sorted by developer ascending'), ex.context[1]);
  assert.ok(ex.footnote.includes('counted once in the totals'), 'the footnote travels along');
  pdfBtn.onclick();
  await flush();
  assert.strictEqual(exported[1].kind, 'pdf', 'a PDF was requested');
  assert.strictEqual(getEl('#toast').textContent, `Saved activity-30d-${day}.pdf`, 'the PDF is reported too');

  // the filter travels with the export
  search.value = 'bob';
  search.oninput();
  pngBtn.onclick();
  await flush();
  assert.strictEqual(exported[2].model.rows.length, 1, 'the export follows the filter');
  assert.strictEqual(exported[2].model.rows[0].cells[0].text, 'Bob Builder', 'with only the filtered developer');
  assert.ok(exported[2].model.context[1].includes('filter “bob”'), exported[2].model.context[1]);
  search.value = '';
  search.oninput();
  assert.ok(rowsHtml().includes('Ada Lovelace'), 'the filter is cleared again');

  // -- opening a developer's detail --------------------------------------------------------------------
  clickRow(0);
  const detail = paneEl.innerHTML;
  assert.ok(detail.includes('card dev-detail'), 'the detail card is mounted');
  assert.ok(detail.includes('Ada Lovelace') && detail.includes('ada@acme.com'), 'the developer is shown');
  assert.ok(detail.includes('1 of 2 developers'), 'the position in the list: ' + (/(.of 2 developers)/.exec(detail) || [])[0]);
  assert.ok(detail.includes('30-day window'), 'the window is named');
  assert.ok(detail.includes('Top 1 changed file'), 'code-change details rendered');
  assert.ok(detail.includes('src/app.js'), 'the changed file is listed');
  assert.ok(detail.includes('feature/x'), 'per-branch breakdown rendered');
  assert.ok(detail.includes('% of all lines changed'), 'the share of the window is shown');
  assert.ok(detail.includes('id="dev-back"'), 'a way back to the list');
  assert.ok(detail.includes('id="dev-prev" disabled'), 'the first developer has no previous');
  assert.ok(!detail.includes('id="dev-next" disabled'), 'the next developer is reachable');
  assert.ok(detail.includes('Show 10 more'), 'commit list capped at 50 with a button for the rest');
  assert.ok(detail.includes('<tbody class="log-more" hidden>'), 'the remaining commits are in a hidden section');
  const hidden = /<tbody class="log-more" hidden>([\s\S]*?)<\/tbody>/.exec(detail);
  assert.ok(hidden, 'hidden section found');
  assert.strictEqual((hidden[1].match(/<tr>/g) || []).length, 10, 'only the overflow sits in the hidden section');
  assert.strictEqual((detail.match(/deadbeef/g) || []).length, 60, 'every commit of the window is rendered');

  // -- the detail is split into tabs --------------------------------------------------------------------
  assert.ok(detail.includes('role="tablist"'), 'the detail is a tab list');
  for (const [k, label] of [['overview', 'Overview'], ['repos', 'Repos'], ['branches', 'Branches'], ['files', 'Files'], ['commits', 'Commits']]) {
    assert.ok(detail.includes(`data-tab="${k}"`), `the ${label} tab`);
    assert.ok(detail.includes(`id="dev-panel-${k}" role="tabpanel"`), `the ${label} panel`);
  }
  assert.ok(detail.includes('data-tab="overview" aria-controls="dev-panel-overview" aria-selected="true" tabindex="0"'), 'Overview opens');
  assert.ok(detail.includes('aria-controls="dev-panel-commits" aria-selected="false" tabindex="-1"'), 'the other tabs wait their turn');
  assert.ok(detail.includes('data-panel="overview">'), 'the overview panel is visible');
  assert.ok(detail.includes('data-panel="repos" hidden'), 'the other panels start hidden');
  assert.ok(detail.includes('>Branches <span class="tab-n">1</span>'), 'the tab counts the branches');
  assert.ok(detail.includes('>Commits <span class="tab-n">60</span>'), 'and the commits');
  assert.ok(detail.includes('>Repos <span class="tab-n">1</span>'), 'and the repositories');
  assert.ok(detail.includes('<code>demo</code>'), 'the repository row is rendered');
  assert.ok(detail.includes('60 commits not merged'), 'with what is still open on it');

  // switching tabs
  devTabs.find((t) => t.dataset.tab === 'branches').onclick();
  assert.strictEqual(devTabs.find((t) => t.dataset.tab === 'branches').getAttribute('aria-selected'), 'true', 'Branches activates');
  assert.strictEqual(devTabs.find((t) => t.dataset.tab === 'overview').getAttribute('aria-selected'), 'false', 'Overview steps aside');
  assert.strictEqual(devPanels.find((p) => p.dataset.panel === 'branches').hidden, false, 'the branches panel shows');
  assert.strictEqual(devPanels.find((p) => p.dataset.panel === 'overview').hidden, true, 'the overview panel hides');
  devTabs.find((t) => t.dataset.tab === 'branches').onkeydown({ key: 'ArrowRight', preventDefault() { this.prevented = true; } });
  assert.strictEqual(devTabs.find((t) => t.dataset.tab === 'files').getAttribute('aria-selected'), 'true', 'ArrowRight moves to Files');
  assert.ok(devTabs.find((t) => t.dataset.tab === 'files').focused, 'and focuses it');
  devTabs.find((t) => t.dataset.tab === 'files').onkeydown({ key: 'End', preventDefault() {} });
  assert.strictEqual(devTabs.find((t) => t.dataset.tab === 'commits').getAttribute('aria-selected'), 'true', 'End jumps to Commits');

  // -- the button reveals the rest -----------------------------------------------------------------------
  assert.ok(!moreBtn.removed, 'the button was wired up when the detail mounted');
  moreBtn.onclick();
  assert.strictEqual(moreBody.hidden, false, 'hidden commits revealed');
  assert.ok(moreBtn.removed, 'the button removes itself');

  // -- previous / next move between developers -----------------------------------------------------------
  getEl('#dev-next').onclick();
  const bob = paneEl.innerHTML;
  assert.ok(bob.includes('Bob Builder'), 'the next developer is shown');
  assert.ok(bob.includes('2 of 2 developers'), 'the position moved');
  assert.strictEqual(devTabs.find((t) => t.dataset.tab === 'commits').getAttribute('aria-selected'), 'true', 'the open tab is kept while stepping');
  assert.strictEqual(devPanels.find((p) => p.dataset.panel === 'commits').hidden, false, 'with its panel showing');
  assert.ok(bob.includes('id="dev-next" disabled'), 'the last developer has no next');
  assert.ok(bob.includes('README.md'), "the developer's own changed files");
  assert.strictEqual((bob.match(/deadbeef/g) || []).length, 0, "not the previous developer's commits");
  getEl('#dev-prev').onclick();
  assert.ok(paneEl.innerHTML.includes('Ada Lovelace'), 'back to the previous developer');

  // -- Escape returns to the list --------------------------------------------------------------------------
  focusedSel = null;
  paneEl.onkeydown({ key: 'Escape' });
  assert.ok(paneEl.innerHTML.includes('id="dev-rows"'), 'the list is back');
  assert.ok(rowsHtml().includes('Ada Lovelace'), 'the rows are repainted');
  assert.strictEqual(focusedSel, 'tr[data-i="0"] .dev-open', 'focus returns to the developer that was open');
  assert.deepStrictEqual(scrolled, [420], 'the scroll position from before the detail is restored');

  // -- the back button does the same ---------------------------------------------------------------------
  clickRow(1);
  assert.ok(paneEl.innerHTML.includes('Bob Builder'), 'the detail opened again');
  focusedSel = null;
  getEl('#dev-back').onclick();
  assert.ok(paneEl.innerHTML.includes('id="dev-rows"'), 'the list is back');
  assert.strictEqual(focusedSel, 'tr[data-i="1"] .dev-open', 'focus returns to Bob');
  assert.deepStrictEqual(scrolled, [420, 420], 'the scroll position is restored again');

  // -- the export buttons survive the trip to the detail and back -----------------------------------------
  getEl('#act-png').onclick = null;
  getEl('#act-pdf').onclick = null;
  clickRow(1);
  assert.ok(paneEl.innerHTML.includes('Bob Builder'), 'the detail replaced the list and its buttons');
  getEl('#dev-back').onclick();
  assert.ok(typeof getEl('#act-png').onclick === 'function', 'the PNG button is wired again');
  assert.ok(typeof getEl('#act-pdf').onclick === 'function', 'the PDF button is wired again');

  // -- a failed refresh keeps the last good report ----------------------------------------------------------
  const kept = getEl('#act').innerHTML;
  failNext = true;
  getEl('#refresh').onclick();
  await flush();
  assert.strictEqual(getEl('#toast').hidden, false, 'the failure is reported');
  assert.strictEqual(getEl('#toast').textContent, 'scanner exploded', 'with the error message');
  assert.strictEqual(getEl('#act').innerHTML, kept, 'the last good report stays on screen');
  assert.strictEqual(getEl('#refresh').disabled, false, 'refresh is enabled again');

  console.log('activity UI test passed');
})().catch((err) => { console.error(err); process.exit(1); });
