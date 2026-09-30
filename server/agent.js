'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { db, getSettings } = require('./db');
const { TOOLS, TOOL_DEFS, TOOL_BY_NAME } = require('./tools');
const smart = require('./smart');

const MAX_TOOL_ROUNDS = 12;

function client() {
  const { anthropic_api_key: apiKey } = getSettings({ reveal: true });
  if (!apiKey) throw new Error('No Anthropic API key configured. Add one in Settings (or set ANTHROPIC_API_KEY).');
  return new Anthropic({ apiKey });
}

function aiConfigured() {
  return !!getSettings({ reveal: true }).anthropic_api_key;
}

// ---- agent mode -----------------------------------------------------------------------------------
// agent_mode = 'auto' | 'smart' | 'claude'. 'auto' uses Claude when a key exists, otherwise the
// deterministic Smart agent. A request can override the stored setting (the UI switch sends its own mode).
function resolveChatMode(requested) {
  const mode = requested === 'smart' || requested === 'claude' ? requested : (getSettings().agent_mode || 'auto');
  if (mode === 'auto') return aiConfigured() ? 'claude' : 'smart';
  return mode;
}

// Summaries also run in the background (scheduler/email), so a missing key falls back to Smart
// instead of failing the summary.
function resolveSummaryMode() {
  const mode = getSettings().agent_mode || 'auto';
  if (mode === 'smart') return 'smart';
  return aiConfigured() ? 'claude' : 'smart';
}

// ---- conversation history hygiene --------------------------------------------------------------
const HISTORY_LIMIT = 40;

// Keep recent turns only: costs and latency grow with raw length, and the Smart agent only ever
// reads the last couple of turns for follow-up context.
function trimHistory(messages) {
  if (!Array.isArray(messages) || messages.length <= HISTORY_LIMIT) return messages;
  let cut = messages.length - HISTORY_LIMIT;
  // Never start mid tool-loop: the first kept message must be a plain user question.
  while (cut < messages.length && !(messages[cut].role === 'user' && typeof messages[cut].content === 'string')) cut++;
  return messages.slice(cut);
}

// Smart-mode turns store synthetic tool_use blocks without matching tool_result, and older Claude
// turns carry already-answered tool traffic. Replaying either to the API fails (400), so before a
// Claude call we flatten history to alternating user questions and text-only assistant answers.
function sanitizeForClaude(messages) {
  const flat = [];
  const push = (role, content) => {
    const last = flat[flat.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${content}`;
    else flat.push({ role, content });
  };
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'user') {
      if (typeof m.content === 'string') {
        if (m.content.startsWith('Tool-call limit')) continue;
        push('user', m.content);
      } else if (Array.isArray(m.content)) {
        // Tool results of an older loop: the text answer already follows them, so drop the traffic.
      }
      continue;
    }
    if (m.role !== 'assistant') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();
    if (text) push('assistant', text);
  }
  while (flat.length && flat[0].role !== 'user') flat.shift();
  return flat;
}

const SYSTEM_PROMPT = `You are the Git Insights agent inside a self-hosted app that scans git repositories and reports developer contributions and code health.

You answer questions from engineering managers and developers using the tools, which read the stored scan reports (commits, lines changed, branches, unmerged work, hotspots, knowledge silos, activity patterns). Always fetch data with tools before stating numbers; never invent figures. If data is missing, say what is missing and, if useful, offer to start a scan.

How to read the data:
- "churn" = lines added + deleted. Lock files, build output and vendored code are excluded by default.
- Branch status: main (the main branch), merged, unmerged (work not in main yet), unpushed (local only). "stale" = unmerged and idle beyond the stale threshold.
- Bus factor = the smallest number of developers who wrote half of all changes.
- Line counts measure activity, not value or productivity. When you compare people, add that context briefly and avoid ranking people as good or bad.

Style: lead with the answer, then the supporting numbers. Use short markdown: headings only for long answers, bullet lists and small tables where they help. Mention the scan id and its date range when it matters.`;

// ---- the agent loop --------------------------------------------------------------------------------
async function runAgent(rawMessages, { onEvent = () => {} } = {}) {
  const settings = getSettings({ reveal: true });
  const anthropic = client();
  const system = `${SYSTEM_PROMPT}\n\nToday is ${new Date().toISOString().slice(0, 10)}.`;
  const messages = sanitizeForClaude(rawMessages);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await anthropic.beta.messages.create({
      model: settings.ai_model || 'claude-opus-5-5',
      max_tokens: 16000,
      system,
      tools: TOOL_DEFS,
      messages,
      output_config: { effort: settings.ai_effort || 'medium' },
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    // Keep the full content (thinking, tool_use, fallback blocks) so history stays valid.
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'refusal') {
      onEvent({ type: 'text', text: 'The model declined to answer this request.' });
      return messages;
    }
    if (response.stop_reason !== 'tool_use') return messages;

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      onEvent({ type: 'tool', name: block.name, input: block.input });
      const tool = TOOL_BY_NAME.get(block.name);
      try {
        if (!tool) throw new Error(`Unknown tool ${block.name}`);
        const out = await tool.run(block.input || {});
        results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: err.message, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  messages.push({ role: 'user', content: 'Tool-call limit reached. Answer with what you have so far.' });
  const final = await anthropic.beta.messages.create({
    model: settings.ai_model || 'claude-opus-5-5', max_tokens: 8000, system, tools: TOOL_DEFS, tool_choice: { type: 'none' }, messages,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  messages.push({ role: 'assistant', content: final.content });
  return messages;
}

function lastAssistantText(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!last) return '';
  return (Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }])
    .filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
}

// Transcript for the UI: user questions, tool calls and assistant answers.
function toTranscript(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      if (typeof m.content === 'string') { if (!m.content.startsWith('Tool-call limit')) out.push({ role: 'user', text: m.content }); }
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'text' && b.text.trim()) out.push({ role: 'assistant', text: b.text });
      else if (b.type === 'tool_use') out.push({ role: 'tool', name: b.name, input: b.input });
    }
  }
  return out;
}

// One entry point for both agents: conversation persistence is identical, only the answering differs.
async function chat(conversationId, question, onEvent, { mode } = {}) {
  let conv = conversationId ? db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) : null;
  if (!conv) {
    const { lastInsertRowid } = db.prepare('INSERT INTO conversations (title) VALUES (?)').run(question.slice(0, 80));
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(lastInsertRowid));
  }
  const stored = trimHistory(JSON.parse(conv.messages));
  const storedState = safeState(conv.state);
  const messages = [...stored, { role: 'user', content: question }];
  const state = JSON.parse(JSON.stringify(storedState));
  const effective = resolveChatMode(mode);
  const save = (msgs, st) => db
    .prepare("UPDATE conversations SET messages = ?, state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(JSON.stringify(trimHistory(msgs)), JSON.stringify(st || {}), conv.id);
  try {
    if (effective === 'claude') {
      const out = await runAgent(messages, { onEvent });
      save(out, storedState);
      return { conversationId: conv.id, answer: lastAssistantText(out), mode: effective };
    }
    await smart.run(question, messages, { onEvent, state });
    save(messages, state);
    return { conversationId: conv.id, answer: lastAssistantText(messages), mode: effective };
  } catch (err) {
    // Never persist a user question that got no answer: the next turn would replay it unpaired.
    save(stored, storedState);
    throw err;
  }
}

function safeState(raw) {
  try {
    const s = JSON.parse(raw || '{}');
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}

// Executive summary for a finished scan, used in the email and on the report page.
async function summarizeScan(scanId) {
  if (resolveSummaryMode() === 'smart') return smart.summarizeScan(scanId);
  try {
    return await summarizeWithClaude(scanId);
  } catch (err) {
    if (/No Anthropic API key/.test(err.message)) return smart.summarizeScan(scanId);
    throw err;
  }
}

async function summarizeWithClaude(scanId) {
  const messages = [{
    role: 'user',
    content: `Scan ${scanId} just finished. Write a concise executive summary of it for an engineering-manager email (about 150-300 words). `
      + 'Use get_overview for this scan, and compare_scans with the previous scan when one exists. Cover: overall activity, who drove the work, '
      + 'unmerged/stale work that needs attention, code-health risks (bus factor, silos, hotspots), and changes vs. the previous scan. '
      + 'End with 2-4 concrete recommended actions. Output only the summary in markdown, starting with a one-line headline in bold.',
  }];
  const out = await runAgent(messages);
  return lastAssistantText(out);
}

module.exports = { chat, summarizeScan, toTranscript, aiConfigured, resolveChatMode, resolveSummaryMode, sanitizeForClaude, trimHistory, TOOLS };
