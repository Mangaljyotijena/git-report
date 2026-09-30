'use strict';

// Conversational layer: the topics a person brings up that are not report questions — greetings,
// small talk, jokes, arithmetic, the time, quick decisions and feelings. Deterministic replies,
// chosen by pattern, so the assistant can hold a normal conversation without a model.

const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs.',
  'A SQL query walks into a bar, approaches two tables and asks: “Can I join you?”',
  'Why did the developer go broke? He used up all his cache.',
  'There are 10 kinds of people: those who understand binary, and those who don’t.',
  'I would tell you a UDP joke, but you might not get it.',
  'Git blame: the only tool that tells you exactly who to be angry at.',
  'Why do Java developers wear glasses? Because they don’t C#.',
  'Real developers count from 0. Everyone else starts at 1 and wonders why it broke.',
  '“It works on my machine.” — the four most expensive words in software.',
  'My code doesn’t work. I don’t know why. My code works. I still don’t know why.',
];

// ---- arithmetic ------------------------------------------------------------------------------------
// Restricted recursive-descent evaluator: digits, + - * / % ^ and parentheses only.
function calc(expr) {
  let i = 0;
  const skip = () => { while (i < expr.length && expr[i] === ' ') i++; };
  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      skip();
      const op = expr[i];
      if (op === '+' || op === '-') { i++; const r = parseTerm(); v = op === '+' ? v + r : v - r; } else break;
    }
    return v;
  }
  function parseTerm() {
    let v = parseFactor();
    for (;;) {
      skip();
      const op = expr[i];
      if (op === '*' || op === '/') { i++; const r = parseFactor(); v = op === '*' ? v * r : v / r; }
      else if (op === '%') { i++; const r = parseFactor(); v = v % r; }
      else break;
    }
    return v;
  }
  function parseFactor() {
    skip();
    let v;
    if (expr[i] === '(') { i++; v = parseExpr(); skip(); if (expr[i] !== ')') throw new Error('unbalanced'); i++; }
    else if (expr[i] === '-') { i++; v = -parseFactor(); }
    else if (expr[i] === '+') { i++; v = parseFactor(); }
    else {
      const m = /^\d+(?:\.\d+)?/.exec(expr.slice(i));
      if (!m) throw new Error('not a number');
      v = Number(m[0]);
      i += m[0].length;
    }
    skip();
    if (expr[i] === '^') { i++; v = Math.pow(v, parseFactor()); }
    return v;
  }
  const out = parseExpr();
  skip();
  if (i !== expr.length) throw new Error('trailing');
  if (!Number.isFinite(out)) throw new Error('not finite');
  return out;
}

function tryMath(raw) {
  let s = String(raw || '').toLowerCase().trim().replace(/[?=,]+$/, '').trim();
  s = s.replace(/^(?:what is|what's|whats|whats the value of|calculate|compute|how much is|solve|evaluate)\s+/, '').trim();
  if (!s) return null;
  const pct = /^(\d+(?:\.\d+)?)\s*(?:%|percent)\s+(?:of)\s+(\d+(?:\.\d+)?)$/.exec(s);
  if (pct) return round(Number(pct[1]) / 100 * Number(pct[2]));
  s = s
    .replace(/\bplus\b/g, '+')
    .replace(/\bminus\b/g, '-')
    .replace(/\b(?:times|multiplied by)\b/g, '*')
    .replace(/\bdivided by\b/g, '/')
    .replace(/\bpercent\b/g, '');
  if (!/^[\d\s+\-*/%^()]+$/.test(s)) return null;
  if (!/[+\-*/%^]/.test(s)) return null; // a bare number is not a question
  try {
    const v = calc(s.replace(/\s+/g, ' '));
    if (v === Infinity || Number.isNaN(v)) return null;
    return round(v);
  } catch (_) {
    return null;
  }
}
const round = (v) => Math.round(v * 1e6) / 1e6;

// ---- topic matchers ---------------------------------------------------------------------------------
const TOPICS = [
  {
    name: 'howareyou',
    test: (nq) => /^(?:how (?:are|r|s|is|was|do|have been|have you been) (?:you|u|it going|things going|things|it been)|hows it going|how do you do|you (?:ok|good|alright|fine)|whats up|whats new with you|how have you been|you (?:been|doing) (?:ok|good|well))\b/.test(nq),
    reply: () => ({
      headline: 'Doing well — all local, all deterministic.',
      bullets: ['I answer straight from your stored scans, so I am always fast and always reproducible.'],
      notes: ['Ask me for an overview, or just chat — I know jokes, basic math and a fair bit of git.'],
    }),
  },
  {
    name: 'identity',
    test: (nq) => /\b(?:who are you|what are you|what (?:is|s) your name|what should i call you|are you (?:an? )?(?:ai|a bot|bot|human|real|sentient|alive|chatgpt|claude)|you (?:an )?(?:ai|bot|human|alive)|tell me about yourself|introduce yourself|what do you call yourself)\b/.test(nq),
    reply: (state) => ({
      headline: `I'm the Git Insights assistant${state && state.turn ? '' : ' — nice to meet you'}.`,
      bullets: [
        'I read your stored git scans and answer questions about developers, branches, trends and code health.',
        'Most answers come from the Smart engine: a fixed, deterministic analysis — no AI model involved.',
        'I can also chat: greetings, jokes, arithmetic, the time, and how git or this app works.',
      ],
      notes: ['Switch me to Claude in the header if you want open-ended synthesis (needs an API key).'],
    }),
  },
  {
    name: 'joke',
    test: (nq) => /\b(?:tell (?:me )?(?:a |an |another )?joke|make me laugh|say something funny|something funny|humou?r me|jokes?)\b/.test(nq),
    reply: (state) => {
      const n = JOKES.length;
      const idx = state ? (state.jokeCount || 0) % n : 0;
      if (state) state.jokeCount = idx + 1;
      return { headline: JOKES[idx], notes: ['Ask for another one if you want a different joke.'] };
    },
  },
  {
    name: 'random',
    test: (nq) => /\b(?:flip a coin|heads or tails|roll (?:a |the )?(?:dice|die)|toss a coin|pick a number|random number)\b/.test(nq),
    reply: (state, nq) => {
      const seed = String((state && state.turn) || 0);
      if (/number/.test(nq)) {
        const m = /(?:between|from)\s+(\d{1,4})\s+(?:and|to)\s+(\d{1,4})/.exec(nq);
        const lo = m ? Number(m[1]) : 1;
        const hi = m ? Number(m[2]) : 100;
        const v = lo + (Math.abs(hash(seed)) % (Math.max(hi, lo) - lo + 1));
        return { headline: `Random number between ${lo} and ${hi}: **${v}**.` };
      }
      const flip = Math.abs(hash(seed)) % 2 === 0;
      if (/coin|tails|toss/.test(nq)) return { headline: flip ? '**Heads**.' : '**Tails**.' };
      const die = (Math.abs(hash(seed)) % 6) + 1;
      return { headline: `You rolled a **${die}**.` };
    },
  },
  {
    name: 'decide',
    test: (nq) => /^(?:should i|do you think i should|would you) .+? or .+\??$/.test(nq) && /\sor\s/.test(nq),
    reply: (state, nq) => {
      const m = /^(?:should i|do you think i should|would you)\s+(.+?)\s+or\s+(.+?)\s*\??$/.exec(nq);
      if (!m) return { headline: 'I would need two options to pick from.' };
      const a = m[1].trim();
      const b = m[2].trim();
      const pick = Math.abs(hash(`${state && state.turn}${a}${b}`)) % 2 === 0 ? a : b;
      return {
        headline: `I would go with **${pick}**.`,
        bullets: [`That was a coin flip — ${pick === a ? b : a} is a perfectly defensible choice too.`],
        notes: ['I do not have your code or context, so for a real call check the trade-offs first.'],
      };
    },
  },
  {
    name: 'weather',
    test: (nq) => /\b(?:what (?:is|s) the weather|hows the weather|will it rain|weather (?:today|tomorrow|this week))\b/.test(nq),
    reply: () => ({
      headline: 'No weather data here — I only read git.',
      bullets: ['Ask me instead: "when is the team most active?" — that is my kind of forecast.'],
    }),
  },
  {
    name: 'empathy',
    test: (nq) => /\b(?:i'?m|i am|im|feeling|feel) (?:tired|stressed|burnt ?out|burned ?out|exhausted|frustrated|overwhelmed|sad|down|annoyed|bored|lost|demotivated|sick)\b/.test(nq),
    reply: () => ({
      headline: 'That sounds rough — hope the day gets lighter.',
      bullets: ['If it helps, I can give you a quick read on where the pressure is: unmerged work, stale branches or a single hot file.'],
      notes: ['Try "what needs attention?" or "stale branches".'],
    }),
  },
  {
    name: 'compliment',
    test: (nq) => /\b(?:you (?:are|re|r) (?:great|awesome|amazing|helpful|the best|smart|brilliant|good|cool)|i (?:love|adore|really like) you|well done|nice work|good bot|good assistant)\b/.test(nq),
    reply: () => ({
      headline: 'Thanks — that is kind of you.',
      bullets: ['The credit really goes to the data: the scans do the work, I just read them back.'],
      notes: ['Anything you want me to dig into next?'],
    }),
  },
  {
    name: 'insult',
    test: (nq) => /\b(?:you (?:are|re|r) (?:useless|stupid|dumb|terrible|awful|slow|wrong|rubbish|useless)|i (?:hate|dislike) you|you suck|bad bot)\b/.test(nq),
    reply: () => ({
      headline: 'Fair enough — I am a narrow tool, not a mind reader.',
      bullets: ['I am deterministic on purpose: same question, same answer, no guessing.'],
      notes: ['For open-ended questions switch me to Claude in the header.'],
    }),
  },
  {
    name: 'thanks',
    test: (nq) => /^(?:thanks|thank you|thankyou|thx|ty|cheers|ta|appreciate (?:it|that|the help)|much appreciated|thanks a (?:lot|million|ton))\b/.test(nq),
    reply: () => ({
      headline: 'Any time.',
      notes: ['Ask another question whenever you are ready.'],
    }),
  },
  {
    name: 'farewell',
    test: (nq) => /^(?:bye|goodbye|see (?:ya|you)|later|cya|good night|goodnight|i (?:am|'m) (?:done|off|leaving)|that (?:is|s) (?:all|it|everything)|nothing else|im done)\b/.test(nq),
    reply: () => ({
      headline: 'See you — I will keep the scans warm.',
      notes: ['Your conversations are saved in the sidebar when you come back.'],
    }),
  },
  {
    name: 'greeting',
    test: (nq) => /^(?:hi|hey|hello|yo|howdy|hiya|heya|sup|greetings|good (?:morning|afternoon|evening)|morning|evening|hi there|hey there)\b/.test(nq),
    reply: (state) => {
      const again = state && state.greetCount;
      if (state) state.greetCount = (state.greetCount || 0) + 1;
      return {
        headline: `${again ? 'Hey again' : 'Hey!'} I am the Git Insights assistant.`,
        bullets: ['Ask me about scans, developers, branches, trends or code health — or just chat.'],
        notes: ['Try "what can you do?" for a list of example questions.'],
      };
    },
  },
];

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Returns { name, section } when a conversational topic matches. Callers gate this behind the
// data-intent score so real report questions always win.
function match(nq, raw, state) {
  const math = tryMath(raw);
  if (math !== null) {
    return { name: 'math', section: { headline: `${String(raw).replace(/[?=]+$/, '').trim()} = **${math}**`, notes: ['I evaluate arithmetic locally — nothing leaves this instance.'] } };
  }
  for (const t of TOPICS) {
    if (!t.test(nq)) continue;
    return { name: t.name, section: t.reply(state, nq) || {} };
  }
  return null;
}

module.exports = { match, tryMath, JOKES };
