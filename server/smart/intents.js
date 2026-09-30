'use strict';

// The capability registry: every question the deterministic agent understands, its example
// phrasings (used for help, suggestions and nearest-match), its scoring rules and its renderer.
// Help and fallback copy are generated from this table, so adding an intent updates all of them.

const S = require('./sections');
const { STOP } = require('./parse');

const hit = (nq, ...pairs) => {
  let best = 0;
  for (const [re, weight] of pairs) if (re.test(nq)) best = Math.max(best, weight);
  return best;
};

const INTENTS = [
  {
    name: 'help', category: 'meta', examples: ['what can you do?', 'help', 'what are your skills?'],
    score: (c) => hit(c.nq,
      [/\bwhat can you do\b/, 5],
      [/\b(?:capabilit\w*|how (?:do you|does this) work)\b/, 5],
      [/\bwhat are (?:your|the) (?:options|commands|skills)\b/, 5],
      [/\bhelp\b/, 3]),
    run: () => helpSection(),
  },

  {
    name: 'start_scan', category: 'actions', examples: ['run a scan', 'scan repo api', 'refresh the data'],
    score: (c) => hit(c.nq,
      [/\b(?:run|start|launch|trigger|kick off|execute|rerun|re-run)\w*\s+(?:a\s+|an\s+|the\s+|another\s+)?(?:fresh\s+|new\s+|full\s+|quick\s+)?(?:scan|rescan)\b/, 5],
      [/\brescans?\b|\bscan again\b|\bscan now\b/, 5],
      [/\brefresh (?:the )?(?:data|report|stats|numbers)\b/, 4],
      [/\bscan\b[^.?!]{0,60}\brepos?\b/, 4],
      [/^(?:please\s+)?scan\s+(?!#|\d)[a-z]/, 4]),
    run: (c) => S.startScanSection(c),
  },

  {
    name: 'ambiguous', category: 'people', examples: [],
    score: (c) => (!c.slots.dev && (c.slots.candidates || []).length > 1 ? 4 : 0),
    run: (c) => S.ambiguousSection(c),
  },

  {
    name: 'stale_branches', category: 'branches',
    examples: ['are there stale branches to clean up?', 'which branches should we delete?', 'old unused branches'],
    score: (c) => hit(c.nq,
      [/\bstale\b/, 5],
      [/\b(?:clean(?:\s?up)?|delete|prune|remove|purge)\b[^.?!]{0,40}\bbranches?\b/, 5],
      [/\b(?:old|idle|abandoned|dead|unused|rotting)\b[^.?!]{0,25}\bbranches?\b/, 4],
      [/\bbranches?\b[^.?!]{0,25}\b(?:cleanup|clean up|to clean)\b/, 4]),
    run: (c) => S.branchesSection(c, 'stale'),
  },

  {
    name: 'unmerged', category: 'branches',
    examples: ['which work is not merged yet?', 'unmerged branches', 'open work waiting to be merged'],
    score: (c) => hit(c.nq,
      [/\bunmerged\b|\bnot (?:yet )?merged\b|\bnever merged\b/, 5],
      [/\bwork not in\b|\bnot in (?:the )?main\b|\bahead of (?:the )?(?:main|master)\b/, 5],
      [/\bwhat (?:is|remains|still) (?:unmerged|open)\b/, 5],
      [/\bopen (?:work|branches|prs?)\b|\bpending (?:merge|work)\b|\bwip\b|\bneeds? merging\b/, 4]),
    run: (c) => S.branchesSection(c, 'unmerged'),
  },

  {
    name: 'branches', category: 'branches',
    examples: ['list all branches', 'show me the branches', 'branch status overview'],
    score: (c) => hit(c.nq,
      [/\bbranches?\b/, 3],
      [/\bbranch (?:status|list|overview)\b/, 5]),
    run: (c) => S.branchesSection(c, 'all'),
  },

  {
    name: 'hotspots', category: 'code health',
    examples: ['show the hotspot files', 'which files change the most', 'most frequently modified files'],
    score: (c) => hit(c.nq,
      [/\bhot ?spots?\b/, 5],
      [/\bmost changed\b|\bfrequently changed\b|\bchanged (?:the )?most\b/, 5],
      [/\bmost (?:touched|modified|edited)\b|\bwhere do we (?:change|edit|touch)\b/, 5],
      [/\b(?:risky|churny|unstable) files?\b|\bcode churn\b/, 4]),
    run: (c) => S.codeHealthSection(c, 'hotspots'),
  },

  {
    name: 'silos', category: 'code health',
    examples: ['knowledge silos', 'which files does only one person know?', 'files with a single owner'],
    score: (c) => hit(c.nq,
      [/\bsilos?\b/, 5],
      [/\bonly (?:one|a single|1) (?:person|developer|dev|engineer|author)\b/, 5],
      [/\bsingle (?:owner|author|maintainer)\b|\bone person (?:knows|owns|wrote|maintains)\b/, 5],
      [/\bknowledge (?:gap|concentration)\b|\bowned by (?:one|a single)\b/, 4]),
    run: (c) => S.codeHealthSection(c, 'silos'),
  },

  {
    name: 'bus_factor', category: 'code health',
    examples: ['what is the bus factor?', 'single point of failure', 'what if a key developer leaves?'],
    score: (c) => hit(c.nq,
      [/\bbus ?factor\b|\btruck ?factor\b/, 5],
      [/\bsingle point of (?:failure|risk)\b|\bkey person (?:risk)?\b/, 5],
      [/\bwhat if\b[^.?!]{0,30}\b(?:leaves|left|quits|goes)\b/, 5],
      [/\bknowledge concentrat/i, 4],
      [/\brisk\b/, 2]),
    run: (c) => S.busFactorSection(c),
  },

  {
    name: 'compare', category: 'analysis',
    examples: ['what changed compared with the previous scan?', 'compare this scan with the last one', 'delta since last week'],
    score: (c) => hit(c.nq,
      [/\bcompared? (?:with|to|against|versus)\b|\bcompare\b/, 6],
      [/\bversus\b|\bvs\.?\b/, 6],
      [/\bwhat changed\b|\bdiff(?:erence)? (?:since|with|vs|from)\b|\bdelta\b/, 6],
      [/\bsince (?:the )?last (?:scan|report|time)\b/, 5],
      [/\bprevious (?:scan|report)\b/, 5],
      [/\bchanges?\b[^.?!]{0,30}\b(?:over|between|from)\b/, 3]),
    run: (c) => S.compareSection(c),
  },

  {
    name: 'trend', category: 'analysis',
    examples: ['trend per month', 'is activity growing over time?', 'monthly timeline'],
    score: (c) => hit(c.nq,
      [/\btrends?\b|\bover time\b|\btimeline\b/, 5],
      [/\b(?:per|by|over) months?\b|\bmonth by month\b|\bmonthly\b/, 5],
      [/\bgrowing\b|\bdeclining\b|\bincreasing\b|\bdecreasing\b/, 4],
      [/\b(?:commits|activity|contributions)\b[^.?!]{0,40}\b(?:last|past|previous)\s+\d+\s+(?:months|years)\b/, 4],
      [/\bthis year\b|\blast year\b|\bquarter\b/, 3]),
    run: (c) => S.trendSection(c),
  },

  {
    name: 'window_activity', category: 'activity',
    examples: ['summarize what each developer worked on in the last 7 days', 'team activity this week', 'who did what last month'],
    score: (c) => {
      if (!c.slots.win || c.slots.dev) return 0;
      const specific = hit(c.nq,
        [/\b(?:each|every|all)\s+(?:developers?|people|devs|engineers)\b|\beveryone\b|\bby (?:developer|person|dev)\b|\bworked on\b|\bbreakdown\b|\bwho did what\b/, 5],
        [/\bcommits?\b|\bchanges\b|\bactivity\b|\bwork\b/, 3]);
      return Math.max(specific, 2);
    },
    run: (c) => S.windowSection(c),
  },

  {
    name: 'top_developers', category: 'people',
    examples: ['top 5 developers by commits', 'who committed the most?', 'most active people this month'],
    score: (c) => hit(c.nq,
      [/\btop\s+\d+\s+(?:developers|people|engineers|devs|contributors)\b/, 6],
      [/\b(?:most|top|fewest)\s+\d*\s*(?:commits|contributors?|active|churn|lines|changes|additions)\b/, 5],
      [/\bwho\s+(?:committed|contributed|wrote|made|does)\s+(?:the\s+)?(?:most|least)\b/, 5],
      [/\b(?:leaderboard|ranking|rankings|standings)\b/, 5],
      [/\bmost active\b/, 5],
      [/\bwho (?:is|are) the (?:top|best|biggest|highest)\b/, 4],
      [/\bhow many commits did (?:each|everyone|they|the team)\b/, 4]),
    run: (c) => S.topDevelopersSection(c),
  },

  {
    name: 'history_search', category: 'activity',
    examples: ['when did we first touch the payments module?', 'have we ever reverted that?', 'search the whole history for hotfix'],
    score: (c) => hit(c.nq,
      [/\b(?:ever|historically|in (?:the )?(?:whole |entire )?history|across (?:all )?scans|the whole history|all scans|since the beginning|first (?:time|touch|introduced|added|written|created))\b/, 6],
      [/\bfirst (?:commit|change|edit|appeared)\b/, 5]),
    run: (c) => S.historySection(c),
  },

  {
    name: 'commit_search', category: 'activity',
    examples: ['find feat commits by Alice', 'commits about crash', 'last 10 commits'],
    score: (c) => Math.max(hit(c.nq,
      [/\b(?:find|search|show|list|recent|latest|newest|last)\s+(?:the\s+)?(?:commits?|merges?|patches)\b/, 6],
      [/\bcommits?\b[^.?!]{0,40}\b(?:about|mentioning|for|with|tagged)\b/, 5],
      [/\bwhat (?:did|has)\b[^.?!]{0,60}\bcommit(?:s|ted)?\b/, 6],
      [/\bwhen (?:did|has|was)\b[^.?!]{0,60}\bcommit(?:s|ted)?\b/, 6],
      [/\b(?:merge|feat|feature|fix|refactor|docs|test|chore|perf|ci) commits?\b/, 5],
      [/\bcommit (?:subjects?|messages?|types?|log|history|search|list)\b/, 5],
      [/\bcommits?\b/, 3],
      [/\bcommit\b/, 2]), (c.slots.win && /\bcommits?\b/.test(c.nq)) ? 4 : 0),
    run: (c) => S.commitSearchSection(c),
  },

  {
    name: 'developer_profile', category: 'people',
    examples: ['what is Alice working on?', 'alice', 'how active is Bob Jones?'],
    score: (c) => {
      if (!c.slots.dev) return 0;
      const s = hit(c.nq,
        [/\b(?:working on|profile|contributions?|breakdown|activity|tenure|streaks?|share|percentage|languages|directories|stats)\b/, 5],
        [/\bhow (?:active|productive|consistent|often|much|many)\b/, 5],
        [/\b(?:his|her|their)\b/, 4],
        [/\babout\b/, 3],
        [/\bwho is\b|\bwho was\b/, 3]);
      return Math.max(s, c.nq.length <= 40 ? 3 : 0);
    },
    run: (c) => S.developerProfileSection(c),
  },

  {
    name: 'repositories', category: 'analysis',
    examples: ['which repositories were scanned?', 'per repository breakdown', 'repos in this scan'],
    score: (c) => hit(c.nq,
      [/\bper repo\b|\bby repo\b|\bwhich repos?\b/, 6],
      [/\brepositories\b/, 4],
      [/\brepos?\b/, 4]),
    run: (c) => S.repositoriesSection(c),
  },

  {
    name: 'languages', category: 'analysis',
    examples: ['which languages are in the code?', 'language breakdown', 'tech stack by churn'],
    score: (c) => hit(c.nq,
      [/\blanguages?\b/, 5],
      [/\bwhere is the (?:code|lines|churn)\b/, 5],
      [/\btech stack\b/, 5],
      [/\bfile types?\b/, 4]),
    run: (c) => S.languagesSection(c),
  },

  {
    name: 'patterns', category: 'activity',
    examples: ['when is the team most active?', 'do we work on weekends?', 'busiest day and hour'],
    score: (c) => hit(c.nq,
      [/\b(?:work|working) (?:hours|patterns?|habits?|times?)\b/, 6],
      [/\bbusiest\b/, 5],
      [/\bweekends?\b|\bsaturdays?\b|\bsundays?\b/, 5],
      [/\bafter hours\b|\bovernight\b|\bat night\b|\blate at night\b/, 5],
      [/\b(?:monday|tuesday|wednesday|thursday|friday)\b/, 5],
      [/\bwhat time\b|\bhours\b/, 4],
      [/\bwhen\b[^.?!]{0,40}\b(?:active|busiest|team|everyone|people)\b/, (c.slots.dev || /\bcommit/.test(c.nq)) ? 0 : 6],
      [/\bwhen (?:do|does|did|are|is|was)\b[^.?!]{0,50}\b(?:we|team|people|everyone|work|active|activity|busy|busiest|commits?|push|ship|deploy|release|typically|usually|most|often)\b/, (c.slots.dev || /\bcommit/.test(c.nq)) ? 0 : 4]),
    run: (c) => S.patternsSection(c),
  },

  {
    name: 'people', category: 'people',
    examples: ['who is inactive?', 'who joined recently?', 'newcomers on the team'],
    score: (c) => hit(c.nq,
      [/\binactive\b|\bdormant\b|\bstopped (?:committing|working|contributing)\b|\bno longer (?:committing|active|working)\b|\bhasn'?t committed\b|\bwho left\b|\bleft the (?:team|company|project)\b/, 5],
      [/\bnewcomers?\b|\bjoined\b|\bonboard\w*\b|\bwho (?:is|are) new\b|\bnew (?:developers?|people|team members?)\b/, 5]),
    run: (c) => S.peopleSection(c),
  },

  {
    name: 'app_status', category: 'meta',
    examples: ['how many scans do we have?', 'is the email configured?', 'status of the app'],
    score: (c) => hit(c.nq,
      [/\bhow many scans\b/, 6],
      [/\bscan status\b|\bscan finished\b|\bwhen did (?:the )?scan\b|\blast scan\b/, 5],
      [/\bnext (?:schedule|run)\b|\bschedules?\b/, 4],
      [/\bis (?:email|smtp|ai|the (?:api )?key) (?:configured|set up|working|ready)\b/, 6],
      [/\bstatus (?:of|for) (?:the )?(?:app|system|scan|email|ai)\b/, 6],
      [/\bwhat data do you have\b/, 6],
      [/\bhow many repos\b/, 5]),
    run: (c) => S.appStatusSection(c),
  },

  {
    name: 'overview', category: 'analysis',
    examples: ['give me an overview of the latest scan', 'how are things going?', 'recap of the scan'],
    score: (c) => hit(c.nq,
      [/\boverviews?\b/, 6],
      [/\bsummaries\b|\bsummary\b/, 5],
      [/\bhow (?:are|is) (?:things|it going|the (?:team|project|repo|codebase))\b/, 6],
      [/\brecap\b|\bdigest\b/, 6],
      [/\bhealth\b/, 4],
      [/\bstatus\b/, 3],
      [/\b(?:scan|report|stats|numbers)\b/, 2],
      [/\bwhat'?s going on\b/, 5],
      [/\btell me about (?:the )?(?:scan|report|data)\b/, 5]),
    run: (c) => S.overviewSection(c),
  },
];

const NO_SCAN_INTENTS = new Set(['help', 'start_scan', 'app_status']);

// Contextual next questions, offered at the end of every answer (registry-driven).
const FOLLOWUPS = {
  help: ['overview of the latest scan', 'run a scan'],
  start_scan: ['how many scans do we have?'],
  app_status: ['overview of the latest scan', 'are there stale branches?'],
  overview: ['unmerged branches', 'hotspot files', 'what changed compared with the previous scan?'],
  top_developers: ['who is inactive?', 'what is the bus factor?'],
  developer_profile: ['which work is not merged yet?', 'what is the bus factor?'],
  ambiguous: ['top 5 developers by commits'],
  stale_branches: ['which work is not merged yet?', 'knowledge silos'],
  unmerged: ['are there stale branches to clean up?', 'top 5 developers by commits'],
  hotspots: ['knowledge silos', 'what is the bus factor?'],
  silos: ['hotspot files', 'what is the bus factor?'],
  bus_factor: ['knowledge silos', 'hotspot files'],
  compare: ['overview of the latest scan', 'trend per month'],
  trend: ['overview of the latest scan', 'who is inactive?'],
  window_activity: ['top 5 developers by commits', 'when is the team most active?'],
  history_search: ['find feat commits by Alice', 'last 10 commits'],
  commit_search: ['who committed the most?', 'when is the team most active?'],
  repositories: ['which languages are in the code?', 'what changed compared with the previous scan?'],
  languages: ['which repositories were scanned?', 'hotspot files'],
  patterns: ['who is inactive?', 'top 5 developers by commits'],
  people: ['what is the bus factor?', 'knowledge silos'],
  default: ['overview of the latest scan', 'top 5 developers by commits', 'hotspot files'],
};

// Help is generated from the registry, grouped by category.
function helpSection() {
  const byCat = new Map();
  for (const it of INTENTS) {
    if (it.name === 'help' || !it.examples.length) continue;
    if (!byCat.has(it.category)) byCat.set(it.category, []);
    byCat.get(it.category).push(it.examples[0]);
  }
  const order = ['analysis', 'people', 'branches', 'code health', 'activity', 'actions', 'meta'];
  const bullets = order.filter((cat) => byCat.has(cat))
    .map((cat) => `${cat[0].toUpperCase() + cat.slice(1)}: ${byCat.get(cat).map((e) => `"${e}"`).join(' · ')}`);
  return {
    headline: 'I answer questions from your stored scan data — no AI model involved.',
    bullets,
    notes: [
      'I can also chat: greetings, jokes, math ("what is 12 * 7"), the time, and how git or this app works.',
      'Every number comes from a finished scan; scan answers end with a scan id and a "no AI used" footer.',
      'Switch the assistant to Claude for open-ended synthesis — that mode needs an API key in Settings.',
    ],
  };
}

const tokens = (s) => String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];

// Nearest-match over every example phrasing: powers "did you mean" in the fallback answer.
function nearestMatches(nq, limit = 3) {
  const asked = new Set(tokens(nq).filter((t) => !STOP.has(t) && t.length > 2));
  if (!asked.size) return [];
  const scored = [];
  for (const it of INTENTS) {
    for (const ex of it.examples) {
      const words = tokens(ex).filter((t) => !STOP.has(t));
      const overlap = words.filter((w) => asked.has(w)).length;
      if (!overlap) continue;
      scored.push({ ex, score: overlap / Math.sqrt(words.length) + (it.score({ nq, slots: {} }) >= 3 ? 0.5 : 0) });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.ex);
}

module.exports = { INTENTS, NO_SCAN_INTENTS, FOLLOWUPS, helpSection, nearestMatches, hit };
