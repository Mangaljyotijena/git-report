'use strict';

// Per-conversation dialogue memory for the Smart agent: what was asked last, who was under
// discussion, which time window and scan were in scope, and any clarification we owe an answer to.

const { findDeveloper, isFollowUp, isEllipsis, extractWindow, normalize } = require('./parse');

const DEFAULT_STATE = () => ({
  v: 1,
  turn: 0,
  dev: null,          // { name, email } of the developer under discussion
  win: null,          // { since, until, label }
  metric: null,       // churn | commits | additions | activeDays | recency
  topN: 0,
  type: null,
  phrase: null,
  scanId: null,       // scan the user last referred to explicitly
  lastIntent: null,   // intent name answered on the previous turn
  pending: null,      // { kind: 'developer'|'scan', options: [...] } awaiting a numbered reply
  greetCount: 0,
  jokeCount: 0,
});

function normalizeState(raw) {
  let parsed = null;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw || '{}'); } catch (_) { parsed = null; }
  } else if (raw && typeof raw === 'object') parsed = raw;
  return { ...DEFAULT_STATE(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
}

const explicitRank = (nq) => /\btop\b|\bmost\b|\bfewest\b|\bleast\b|\bby\s+(?:commits?|lines?|churn|changes|additions|active days|commits)\b/.test(nq);

// A clarification reply is a bare option: "2", "Alice Smith", "alice@acme.com", "the second one".
function pendingReply(nq, raw, state) {
  if (!state.pending) return null;
  const opts = state.pending.options || [];
  if (!opts.length) { state.pending = null; return null; }
  const short = String(raw || '').trim().length <= 60;
  if (!short) { state.pending = null; return null; }
  const asNumber = Number(nq.replace(/[^0-9]/g, ''));
  if (nq.replace(/[^0-9]/g, '').length <= 2 && asNumber >= 1 && asNumber <= opts.length) {
    const chosen = opts[asNumber - 1];
    state.pending = null;
    return { ...chosen, index: asNumber };
  }
  const found = findDeveloper({ developers: opts.map((o) => ({ ...o, aliases: null })) }, raw);
  if (found.match) { state.pending = null; return found.match; }
  const byName = opts.find((o) => o.name && normalize(o.name) === nq);
  if (byName) { state.pending = null; return byName; }
  state.pending = null;
  return null;
}

// Slots resolved from this question win; otherwise the dialogue carries the previous topic over,
// but only when the message reads as a follow-up ("and last month?", "what about him?", "same").
function carrySlots(slots, nq, raw, prior, state, report) {
  const follow = isFollowUp(nq) || isEllipsis(nq);
  if (!follow) return slots;
  if (!slots.dev && !slots.candidates.length) {
    if (state.dev) slots.dev = state.dev;
    else if (prior) {
      const f2 = findDeveloper(report, prior);
      if (f2.match || f2.candidates.length) { slots.dev = f2.match; slots.candidates = f2.candidates; }
    }
  }
  if (!slots.win) {
    slots.win = state.win || (prior ? extractWindow(normalize(prior)) : null);
  }
  if (!explicitRank(nq)) {
    if (state.metric) slots.metric = state.metric;
    if (state.topN && !/\d/.test(nq)) slots.topN = state.topN;
    if (state.type) slots.type = state.type;
  }
  return slots;
}

function remember(state, { slots, intent, scanId }) {
  state.turn = (state.turn || 0) + 1;
  if (slots) {
    // Only a developer explicitly named in this question changes the person under discussion;
    // otherwise the previous one stays in scope for later follow-ups ("and her commits?").
    if (slots.dev) state.dev = { name: slots.dev.name, email: slots.dev.email };
    state.win = slots.win || null;
    state.metric = slots.metric || null;
    state.topN = slots.topN || 0;
    state.type = slots.type || null;
    state.phrase = slots.phrase || null;
  }
  if (scanId) state.scanId = scanId;
  if (intent) state.lastIntent = intent;
  return state;
}

module.exports = { DEFAULT_STATE, normalizeState, pendingReply, carrySlots, remember, explicitRank };
