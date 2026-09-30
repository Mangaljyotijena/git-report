'use strict';

// Smart agent test: builds a throwaway repo, stores one finished scan, then checks the
// deterministic assistant (server/smart.js) and the mode dispatch in server/agent.js.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-report-smart-'));
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
const bob = { name: 'Bob Jones', email: 'bob@acme.com' };

git(['init', '-q', '-b', 'main']);
git(['config', 'user.name', 'Local User']);
git(['config', 'user.email', 'local@acme.com']);
write('src/app.js', 10); commit(alice, 'feat: initial app', '2025-01-06T10:00:00+00:00');
write('src/crash.js', 4); commit(alice, 'fix: crash on startup', '2025-01-07T10:00:00+00:00');
write('package-lock.json', 500); commit(bob, 'chore: lock', '2025-01-08T11:00:00+00:00');
git(['checkout', '-q', '-b', 'feature/open']);
write('src/open.js', 20); commit(bob, 'feat: wip open feature', '2025-01-11T11:00:00+00:00');
git(['checkout', '-q', 'main']);

execFileSync(process.execPath, [path.join(__dirname, '..', 'bin', 'git-report.js'), repo, '-f', 'json', '-o', out, '-q'], { encoding: 'utf8' });
const report = JSON.parse(fs.readFileSync(path.join(out, 'git-report.json'), 'utf8'));

const { db, packReport, saveSettings } = require('../server/db');
const smart = require('../server/smart');
const agent = require('../server/agent');

async function ask(question, messages = [{ role: 'user', content: question }]) {
  const events = [];
  await smart.run(question, messages, { onEvent: (e) => events.push(e) });
  const blocks = messages[messages.length - 1].content;
  return { text: blocks[blocks.length - 1].text, blocks, events, messages };
}

(async () => {
  // ---- empty state: friendly answers, no crashes -------------------------------------------------
  const empty = await ask('give me an overview');
  assert.ok(empty.text.includes('No finished scans yet'), 'empty state explains there are no scans');
  const help = await ask('what can you do?');
  assert.ok(help.text.includes('no AI model involved'), 'help works without scans');
  const status = await ask('how many scans do we have?');
  assert.ok(status.text.includes('finished scans'), 'app status works without scans');

  // ---- store the finished scan --------------------------------------------------------------------
  db.prepare('INSERT INTO repos (name, source, local_path, main_branch, enabled) VALUES (?, ?, ?, ?, 1)')
    .run('demo', 'local', repo, 'main');
  const now = new Date().toISOString();
  const scanId = Number(db.prepare(`INSERT INTO scans (trigger, status, repo_ids, params, started_at, finished_at, summary, report_gz)
    VALUES ('manual', 'done', '[]', '{}', ?, ?, ?, ?)`)
    .run(now, now, JSON.stringify({ meta: report.meta, summary: report.summary, insights: report.insights }), packReport(report)).lastInsertRowid);

  // ---- overview ------------------------------------------------------------------------------------
  const ov = await ask('give me an overview of the latest scan');
  assert.ok(/\*\*\d+ commits by \d+ developers/.test(ov.text), 'overview headline has numbers');
  assert.ok(ov.text.includes(`scan #${scanId}`), 'provenance names the scan');
  assert.ok(ov.text.includes('no AI used'), 'provenance says no AI used');
  assert.ok(ov.events.some((e) => e.type === 'tool' && e.name === 'get_overview'), 'tool event streamed');
  assert.strictEqual(ov.blocks[0].type, 'tool_use', 'tool block stored in the conversation');

  // ---- top developers ------------------------------------------------------------------------------
  const top = await ask('top 2 developers by commits');
  assert.ok(top.text.includes('Top 2 developers by commits'), 'top-N respected');
  assert.ok(top.text.includes('Alice Smith') && top.text.includes('Bob Jones'), 'table lists both developers');
  assert.ok(top.text.includes('| # |'), 'markdown table rendered');
  assert.ok(top.text.includes('activity, not value'), 'activity caveat included');

  // ---- branches ------------------------------------------------------------------------------------
  const unmerged = await ask('which work is not merged yet?');
  assert.ok(unmerged.text.includes('feature/open'), 'unmerged branch listed');
  const stale = await ask('are there stale branches to clean up?');
  assert.ok(stale.text.includes('feature/open'), 'stale branch listed');

  // ---- code health ---------------------------------------------------------------------------------
  const hot = await ask('show the hotspot files');
  assert.ok(/src\/(open|app|crash)\.js/.test(hot.text), 'hotspot file listed');
  const silo = await ask('knowledge silos');
  assert.ok(silo.text.includes('owned by one developer') || silo.text.includes('No knowledge silos'), 'silos answered');
  const bus = await ask('what is the bus factor?');
  assert.ok(/Bus factor is \d+/.test(bus.text), 'bus factor headline');

  // ---- developer profile + follow-up ----------------------------------------------------------------
  const prof = await ask('alice');
  assert.ok(prof.text.includes('alice@acme.com'), 'profile shows the developer');
  assert.ok(prof.text.includes('Top areas: `src`'), 'profile shows top areas');
  const follow = [];
  follow.push({ role: 'user', content: 'alice' });
  await smart.run('alice', follow, {});
  follow.push({ role: 'user', content: 'and her languages?' });
  await smart.run('and her languages?', follow, {});
  const followText = follow[follow.length - 1].content.at(-1).text;
  assert.ok(followText.includes('alice@acme.com'), 'follow-up keeps the developer from the previous turn');

  // ---- commit search with an explicit window --------------------------------------------------------
  const cs = await ask('commits from 2025-01-06 to 2025-01-07');
  assert.ok(/2 commits in 2025-01-06 → 2025-01-07/.test(cs.text), 'windowed commit search counts the two commits');
  assert.ok(cs.text.includes('Alice Smith'), 'windowed commit search names the author');
  assert.ok(cs.events.some((e) => e.type === 'tool' && e.name === 'search_commits'), 'search tool streamed');
  const last3 = await ask('last 3 commits');
  assert.ok(last3.text.includes('newest of 4 commits'), 'last N honored');
  const about = await ask('commits about crash');
  assert.ok(about.text.includes('matching "crash"') && /1 commit\b/.test(about.text), 'unquoted phrase search');

  // ---- compare with only one scan --------------------------------------------------------------------
  const cmp = await ask('what changed compared with the previous scan?');
  assert.ok(cmp.text.includes('Nothing to compare yet'), 'single-scan compare handled');

  // ---- repositories, languages, patterns, people -------------------------------------------------------
  assert.ok((await ask('which repositories were scanned?')).text.includes('demo'), 'repository listed');
  assert.ok((await ask('which languages are in the code?')).text.includes('Language'), 'language table');
  assert.ok((await ask('when is the team most active?')).text.includes('Busiest day'), 'heatmap answer');
  assert.ok((await ask('who is inactive?')).text.includes('inactive'), 'people answer');

  // ---- start scan (unknown repository, no queueing) ------------------------------------------------------
  const scanQ = await ask('scan repo does-not-exist');
  assert.ok(scanQ.text.includes('No repository matches'), 'unknown repository reported');
  assert.ok(scanQ.text.includes('demo'), 'known repositories listed');

  // ---- fallback ------------------------------------------------------------------------------------------
  const fb = await ask('zzz qqq wobble');
  assert.ok(fb.text.includes("don't have a report for that one yet"), 'gibberish falls back to a friendly reply');
  assert.ok(/joke|math/.test(fb.text), 'fallback mentions the chat abilities');

  // ---- conversation persistence (chat entry point) -------------------------------------------------------
  const events = [];
  const conv = await agent.chat(null, 'overview of the scan', (e) => events.push(e));
  assert.ok(conv.conversationId, 'conversation created');
  assert.strictEqual(conv.mode, 'smart', 'auto mode resolves to smart without an API key');
  assert.ok(conv.answer.includes('no AI used'), 'chat answer carries provenance');
  assert.ok(events.some((e) => e.type === 'tool') && events.some((e) => e.type === 'text'), 'tool and text events streamed');
  const transcript = agent.toTranscript(JSON.parse(db.prepare('SELECT messages FROM conversations WHERE id = ?').get(conv.conversationId).messages));
  assert.ok(transcript.some((m) => m.role === 'user'), 'transcript has the question');
  assert.ok(transcript.some((m) => m.role === 'tool'), 'transcript has the tool call');
  assert.ok(transcript.some((m) => m.role === 'assistant'), 'transcript has the answer');

  // ---- deterministic scan summary ----------------------------------------------------------------------
  const sum = smart.summarizeScan(scanId);
  assert.ok(sum.includes('Recommended actions'), 'summary has actions');
  assert.ok(sum.includes('Needs attention'), 'summary has attention items');
  assert.ok(sum.includes('no AI used'), 'summary is marked as computed');
  assert.ok(sum.includes(`scan #${scanId}`), 'summary provenance');
  assert.strictEqual(await agent.summarizeScan(scanId), sum, 'dispatcher picks the smart summary without a key');

  // ---- mode dispatch ------------------------------------------------------------------------------------
  assert.strictEqual(agent.resolveChatMode(), 'smart', 'auto + no key = smart');
  assert.strictEqual(agent.resolveSummaryMode(), 'smart', 'summary falls back to smart');
  saveSettings({ agent_mode: 'claude' });
  assert.strictEqual(agent.resolveChatMode(), 'claude', 'explicit claude mode wins');
  assert.strictEqual(agent.resolveSummaryMode(), 'smart', 'summary still falls back to smart without a key');
  await assert.rejects(() => agent.chat(null, 'overview', () => {}), /No Anthropic API key/, 'claude mode without a key fails clearly');
  saveSettings({ agent_mode: 'smart' });
  assert.strictEqual(await agent.summarizeScan(scanId), sum, 'explicit smart mode uses the deterministic summary');
  saveSettings({ agent_mode: 'auto' });

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('smart agent test passed');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
