'use strict';

// Smart agent conversation test: builds a throwaway repo with three developers and two scans, then
// checks the conversational layer (small talk, knowledge base), dialogue memory, clarifications,
// cross-scan references and the shared conversation-history fixes in server/agent.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-report-chat-'));
const out = path.join(dir, '_out');
const repo = path.join(dir, 'demo');
process.env.DATA_DIR = path.join(dir, 'data');
fs.mkdirSync(repo, { recursive: true });

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
const aliceJ = { name: 'Alice Johnson', email: 'alicej@acme.com' };
const bob = { name: 'Bob Jones', email: 'bob@acme.com' };

git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Local User']);
git(['config', 'user.email', 'local@acme.com']);
write('src/app.js', 10); commit(alice, 'feat: initial app', '2025-01-06T10:00:00+00:00');
write('src/crash.js', 4); commit(aliceJ, 'fix: crash on startup', '2025-01-07T10:00:00+00:00');
write('package-lock.json', 500); commit(bob, 'chore: lock', '2025-01-08T11:00:00+00:00');
git(['checkout', '-q', '-b', 'feature/open']);
write('src/open.js', 20); commit(bob, 'feat: wip open feature', '2025-01-11T11:00:00+00:00');
git(['checkout', '-q', 'main']);

execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'git-report.js'), repo, '-f', 'json', '-o', out, '-q'], { encoding: 'utf8' });
const report = JSON.parse(fs.readFileSync(path.join(out, 'git-report.json'), 'utf8'));

const { db, packReport, saveSettings, getSettings } = require('../server/db');
const smart = require('../server/smart');
const agent = require('../server/agent');
const knowledge = require('../server/knowledge');

async function ask(question, messages = [{ role: 'user', content: question }], state = {}) {
  const events = [];
  const res = await smart.run(question, messages, { onEvent: (e) => events.push(e), state });
  const blocks = messages[messages.length - 1].content;
  return { text: blocks[blocks.length - 1].text, blocks, events, messages, state, res };
}

(async () => {
  // ---- conversational topics work with no data at all ----------------------------------------------
  const hi = await ask('hello');
  assert.ok(hi.text.includes('Git Insights assistant'), 'greeting answers conversationally');
  assert.ok(!hi.text.includes('no AI used'), 'small talk carries no scan provenance');

  const hi2 = await ask('hey there', [{ role: 'user', content: 'hello' }, { role: 'assistant', content: [{ type: 'text', text: hi.text }] }], hi.state);
  assert.ok(/again/i.test(hi2.text), 'a repeated greeting is remembered');

  const math = await ask('what is 12 * 7');
  assert.ok(math.text.includes('84'), 'arithmetic is evaluated');

  const pct = await ask('what is 20% of 150');
  assert.ok(pct.text.includes('30'), 'percentages are evaluated');

  const joke = await ask('tell me a joke');
  assert.ok(joke.text.length > 20 && !joke.text.includes('could not'), 'joke is a real reply');

  const who = await ask('who are you?');
  assert.ok(/deterministic|no AI model involved/i.test(who.text), 'identity explains the deterministic brain');

  const thanks = await ask('thanks a lot');
  assert.ok(thanks.text.includes('Any time'), 'thanks are acknowledged');

  const mathBad = await ask('what is 10 divided by 0');
  assert.ok(!mathBad.text.includes('Infinity'), 'division by zero does not print Infinity');

  // ---- knowledge base: "how does X work" questions -------------------------------------------------
  const churn = await ask('what is churn?');
  assert.ok(churn.text.includes('lines added'), 'churn article explains the metric');
  assert.ok(churn.text.includes('no AI used'), 'knowledge answers are marked as not AI');

  const conflict = await ask('when do i get a merge conflict?');
  assert.ok(conflict.text.includes('same lines'), 'git knowledge answers general git questions');

  const privacy = await ask('do you upload my source code anywhere?');
  assert.ok(/not stored|stays|your own instance/i.test(privacy.text), 'privacy question answered from the knowledge base');

  assert.ok(knowledge.lookup('how does rebase work'), 'knowledge lookup finds git topics');

  // ---- store two finished scans --------------------------------------------------------------------
  db.prepare('INSERT INTO repos (name, source, local_path, main_branch, enabled) VALUES (?, ?, ?, ?, 1)')
    .run('demo', 'local', repo, 'main');
  const insertScan = (r, finished) => Number(db.prepare(`INSERT INTO scans (trigger, status, repo_ids, params, started_at, finished_at, summary, report_gz)
    VALUES ('manual', 'done', '[]', '{}', ?, ?, ?, ?)`)
    .run(finished, finished, JSON.stringify({ meta: r.meta, summary: r.summary, insights: r.insights }), packReport(r)).lastInsertRowid);
  const now = new Date().toISOString();
  const scan1 = insertScan(report, now);

  const report2 = JSON.parse(JSON.stringify(report));
  report2.summary.commits += 5;
  report2.summary.additions += 100;
  report2.summary.churn += 100;
  report2.summary.firstCommit = '2025-02-01';
  report2.summary.lastCommit = '2025-02-28';
  const scan2 = insertScan(report2, new Date(Date.now() + 1000).toISOString());

  // ---- dialogue memory ------------------------------------------------------------------------------
  const top = await ask('top 2 developers by commits');
  assert.ok(top.text.includes('Top 2 developers'), 'top-N question answered');
  const win = await ask('and last month?', [{ role: 'user', content: 'top 2 developers by commits' }, { role: 'assistant', content: [{ type: 'text', text: top.text }] }], top.state);
  assert.ok(/the last month/.test(win.text), 'ellipsis question inherits the previous intent and applies the new window');

  const prof = await ask('alice smith');
  assert.ok(prof.text.includes('alice@acme.com'), 'full name resolves to a profile');
  const him = await ask('what about him?', [{ role: 'user', content: 'alice smith' }, { role: 'assistant', content: [{ type: 'text', text: prof.text }] }], prof.state);
  assert.ok(him.text.includes('alice@acme.com'), 'pronoun follow-up keeps the developer in scope');

  const fuzzy = await ask('alce smth');
  assert.ok(fuzzy.text.includes('alice@acme.com'), 'typos still resolve the developer');

  // ---- ambiguous name → numbered clarification → picked option -------------------------------------
  const amb = await ask('alice');
  assert.ok(/which one\?/.test(amb.text), 'two candidates trigger a clarification question');
  assert.ok(amb.text.includes('1. Alice Smith'), 'clarification lists numbered options');
  const pick = await ask('1', [{ role: 'user', content: 'alice' }, { role: 'assistant', content: [{ type: 'text', text: amb.text }] }], amb.state);
  assert.ok(pick.text.includes('alice@acme.com'), 'a numbered reply resolves the clarification');

  // ---- multi-part questions -------------------------------------------------------------------------
  const multi = await ask('stale branches and hotspots');
  assert.ok(multi.text.includes('stale branch'), 'first half of a two-part question is answered');
  assert.ok(multi.text.includes('most-changed files'), 'second half of a two-part question is answered');

  // ---- cross-scan knowledge -------------------------------------------------------------------------
  const cmp = await ask('what changed compared with the previous scan?');
  assert.ok(/Scan #\d+ → scan #\d+/.test(cmp.text), 'two scans compare against each other');

  const inOne = await ask('give me an overview in scan #1');
  assert.ok(inOne.text.includes(`scan #${scan1}`), 'an explicit scan id is honoured');
  assert.ok(!inOne.text.includes(`scan #${scan2} ·`), 'the other scan is not used by mistake');

  const oldest = await ask('overview of the oldest scan');
  assert.ok(oldest.text.includes(`scan #${scan1}`), 'the oldest scan resolves by ordinal');

  const history = await ask('when did we first touch app');
  assert.ok(/First seen/.test(history.text), 'cross-scan history search finds the first occurrence');
  assert.ok(history.events.some((e) => e.type === 'tool' && e.name === 'search_history'), 'the history tool was used');

  // ---- fallback: friendly, with nearest-match suggestions -------------------------------------------
  const fb = await ask('zzz qqq wobble');
  assert.ok(fb.text.includes("don't have a report for that one yet"), 'gibberish falls back politely');
  assert.ok(fb.text.includes('joke'), 'fallback advertises the chat abilities');

  // ---- follow-up suggestions are offered ------------------------------------------------------------
  const ov = await ask('overview of the latest scan');
  assert.ok(ov.text.includes('You could ask next'), 'answers end with follow-up suggestions');
  assert.ok(ov.res.suggestions.length > 0, 'suggestions are returned to the caller');
  assert.ok(ov.text.includes(`scan #${scan2}`), 'the latest scan is the default');

  // ---- capability registry feeds the UI -------------------------------------------------------------
  const starters = smart.starterSuggestions(8);
  assert.ok(Array.isArray(starters) && starters.length >= 6, 'starter suggestions are served');
  assert.ok(starters.some((s) => /overview/i.test(s)), 'starter suggestions cover the overview');

  // ---- shared history fixes (both modes) --------------------------------------------------------------
  const messy = [
    { role: 'user', content: 'question one' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'smart-1', name: 'get_overview', input: {} }, { type: 'text', text: 'answer one' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'smart-1', content: '{}' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'smart-2', name: 'get_branches', input: {} }, { type: 'text', text: 'answer two' }] },
    { role: 'user', content: 'question two' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer three' }] },
  ];
  const clean = agent.sanitizeForClaude(messy);
  assert.ok(!JSON.stringify(clean).includes('tool_use'), 'smart tool blocks are stripped before a Claude call');
  assert.ok(!JSON.stringify(clean).includes('tool_result'), 'tool results are dropped with their calls');
  assert.strictEqual(clean.filter((m) => m.role === 'user').length, 2, 'both real questions survive');
  assert.strictEqual(clean[0].role, 'user', 'history starts with a user message');

  const long = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const trimmed = agent.trimHistory(long);
  assert.ok(trimmed.length <= 40, 'history is capped');
  assert.strictEqual(trimmed[0].role, 'user', 'trimmed history still starts with a user message');

  // ---- chat entry point persists dialogue state -------------------------------------------------------
  const conv = await agent.chat(null, 'alice smith', () => {});
  assert.strictEqual(conv.mode, 'smart', 'auto mode uses the smart agent without a key');
  const conv2 = await agent.chat(conv.conversationId, 'what about him?', () => {});
  assert.ok(conv2.answer.includes('alice@acme.com'), 'dialogue state is persisted across chat turns');
  const row = db.prepare('SELECT state FROM conversations WHERE id = ?').get(conv.conversationId);
  const state = JSON.parse(row.state);
  assert.strictEqual(state.dev && state.dev.email, 'alice@acme.com', 'dialogue state stores the developer in scope');

  // ---- a failed Claude turn must not leave a dangling question -------------------------------------
  saveSettings({ agent_mode: 'claude' });
  const before = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(conv.conversationId).messages;
  await assert.rejects(() => agent.chat(conv.conversationId, 'a question that will fail', () => {}), /No Anthropic API key/, 'claude mode without a key fails clearly');
  const after = db.prepare('SELECT messages FROM conversations WHERE id = ?').get(conv.conversationId).messages;
  assert.strictEqual(after, before, 'a failed turn rolls the conversation back');
  saveSettings({ agent_mode: 'auto' });

  assert.strictEqual(getSettings().agent_mode, 'auto', 'mode restored');

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('smart chat test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
