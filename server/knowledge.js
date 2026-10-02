'use strict';

// The assistant's knowledge base: short, curated articles about what the reports measure, how the
// app works, and the git/development topics people ask about in passing. Looked up by keyword
// scoring — no model, no embeddings — so answers are fast, stable and offline.

const { levenshtein } = require('./smart/parse');

const ARTICLES = [
  // ---- what the numbers mean ----------------------------------------------------------------------
  {
    id: 'churn', title: 'What "churn" means in these reports',
    keywords: ['churn', 'lines', 'changed', 'additions', 'deletions', 'loc', 'lines of code', 'volume', 'size'],
    body: [
      'Churn = lines added + lines deleted in the commits of a scan.',
      'It measures activity, not value or productivity: a big refactor can churn thousands of lines without adding risk.',
      'Lock files, build output and vendored code are excluded by default — change that under scan filters.',
      'Per-developer "share" is that developer\'s share of the total churn in the same scan.',
    ],
    note: 'Ask "top 5 developers by lines" or "hotspot files" to see churn in action.',
  },
  {
    id: 'bus-factor', title: 'Bus factor',
    keywords: ['bus', 'factor', 'truck', 'key person', 'single point', 'failure', 'risk', 'concentration', 'leaves'],
    body: [
      'Bus factor = the smallest number of developers who together wrote half of all changed lines.',
      'A bus factor of 1 means one person holds half the code knowledge — the classic single point of failure.',
      'It is computed per scan, so it moves as people join, leave and spread work around.',
      'Raise it by pairing on hot files, reviewing each other\'s areas and rotating ownership.',
    ],
    note: 'Ask "what is the bus factor?" or "which files does only one person know?"',
  },
  {
    id: 'knowledge-silos', title: 'Knowledge silos',
    keywords: ['silo', 'silos', 'knowledge', 'ownership', 'owned', 'single owner', 'only one person', 'gap'],
    body: [
      'A knowledge silo is a file with at least 4 commits that is 90%+ written by a single developer.',
      'Silos are where onboarding, holidays and departures hurt most.',
      'The fix is social, not technical: shared reviews, pairing and documented context.',
    ],
    note: 'Ask "knowledge silos" to list them.',
  },
  {
    id: 'stale-branches', title: 'Stale and unmerged branches',
    keywords: ['stale', 'branch', 'branches', 'unmerged', 'cleanup', 'delete', 'idle', 'rotting', 'merged', 'unpushed', 'main'],
    body: [
      'Branch statuses: main, merged (in main), unmerged (work not in main yet), unpushed (local only).',
      'Stale = unmerged and idle beyond the stale threshold — 30 days unless you changed it in scan options.',
      'Unmerged counts commits whose branch has no path to main in the scan.',
      'Cleaning stale branches keeps the branch list readable and the unmerged count honest.',
    ],
    note: 'Ask "stale branches" or "which work is not merged yet?"',
  },
  {
    id: 'active-days', title: 'Active days, streaks and consistency',
    keywords: ['active', 'days', 'streak', 'consistency', 'regular', 'rhythm', 'tenure'],
    body: [
      'Active days = distinct days on which a developer committed inside the scan window.',
      'Longest streak = the longest run of consecutive active days.',
      'Consistency is usually a better signal than raw volume: a steady 3 commits a day beats one 40-commit burst.',
    ],
    note: 'Ask "top developers by active days".',
  },
  {
    id: 'heatmap', title: 'Working-hours patterns and the heatmap',
    keywords: ['heatmap', 'hours', 'when', 'weekend', 'night', 'busiest', 'pattern', 'patterns', 'timezone', 'local time'],
    body: [
      'The heatmap is weekday × hour of commits, using each author\'s local commit time.',
      'After-hours and weekend shares are informational — across time zones they often just mean remote work.',
      'Use it for team rhythm (when are we all online?), not for judging individuals.',
    ],
    note: 'Ask "when is the team most active?"',
  },

  // ---- how the app works ---------------------------------------------------------------------------
  {
    id: 'scans', title: 'How scans work',
    keywords: ['scan', 'scans', 'how', 'collect', 'data', 'source', 'clones', 'fetch', 'reads', 'analyse', 'analyze'],
    body: [
      'A scan clones or updates each enabled repository, then walks the commit history locally.',
      'It stores an aggregated report (developers, branches, hotspots, silos, timeline, commit log) — never your source files.',
      'Scans run on demand, on a schedule, or when the assistant starts one; each finished scan gets an id.',
      'Everything you ask the assistant is answered from the newest finished scan unless you name another.',
    ],
    note: 'Ask "run a scan" or "how many scans do we have?".',
  },
  {
    id: 'activity-page', title: 'The Activity page and its time windows',
    keywords: ['activity', 'recent activity', 'pushed', 'live', 'last 7 days', 'last 15 days', 'last 30 days', 'last 90 days', 'last 180 days', 'last 365 days', 'per branch', 'time window', 'who committed', 'export', 'png', 'pdf'],
    body: [
      'The Activity page shows what each developer pushed to any branch — it reads git directly, so no scan is needed; repositories are refreshed on every reload.',
      'Pick a window of 24 hours, 48 hours, 3 days, 7 days, 15 days, 30 days, 90 days, 180 days or 365 days (365 days is the maximum; older history belongs in a scan), plus one repository or all of them.',
      'The page opens on a developer list — sortable by commits, lines, files, branches or last commit, and filterable by name or email — with the window totals above it.',
      'Export PNG or Export PDF saves that list exactly as you see it: the current sort and filter, the window context, the totals row and the footnote. PDFs are paginated A4 landscape.',
      'Select a developer to open their detail, which is split into tabs: Overview (totals and the share of lines changed), Repos (each repository rolled up with what is still unmerged), Branches (with their status), Files (the biggest changed files) and Commits (the full list). Previous/next steps through the list and Esc (or the back button) returns to it; the tab you opened stays open while you step between developers.',
      'Each branch row is marked not merged, merged (naming the branch it came from) or on main, so long-lived feature branches stay visible.',
    ],
    note: 'Open Activity in the sidebar, or ask Claude-mode "who committed in the last 15 days?" for the same data live.',
  },
  {
    id: 'assistant-modes', title: 'Assistant modes: Smart vs Claude',
    keywords: ['mode', 'smart', 'claude', 'ai', 'model', 'llm', 'api', 'key', 'deterministic', 'why', 'no ai'],
    body: [
      'Smart mode is deterministic: it parses your question, picks a fixed report analysis and renders the numbers. No AI model is involved — every answer ends with "no AI used".',
      'Claude mode uses the Anthropic API for open-ended synthesis across many tools; it needs an API key in Settings.',
      'Auto picks Claude when a key exists and falls back to Smart when it does not.',
      'Smart mode can also chat: greetings, jokes, math, the time, and curated "how does X work" answers.',
    ],
    note: 'Switch modes with the segmented control in the assistant header.',
  },
  {
    id: 'privacy', title: 'Privacy: where your data goes',
    keywords: ['privacy', 'private', 'send', 'uploaded', 'cloud', 'secure', 'secret', 'token', 'credential', 'source code', 'leak'],
    body: [
      'Everything runs in your own instance: the database, reports and conversations stay on your machine or container.',
      'Repository access tokens are AES-256-GCM encrypted at rest; clone URLs are stored without credentials.',
      'Source files are not stored — only git metadata and aggregated statistics.',
      'Nothing is sent to Anthropic unless you configure a key AND use Claude mode.',
    ],
  },
  {
    id: 'schedules', title: 'Schedules and email reports',
    keywords: ['schedule', 'cron', 'email', 'report', 'automatic', 'daily', 'weekly', 'recipient', 'smtp', 'notification'],
    body: [
      'A schedule is a cron expression plus the repositories and filters to scan.',
      'After each scheduled scan the app can email the HTML report, optionally with an AI-written summary.',
      'SMTP is configured in Settings; "Test email" sends a message to verify it.',
      'Ask me "status of the app" to see the last schedule run.',
    ],
  },
  {
    id: 'adding-repos', title: 'Adding repositories and running scans',
    keywords: ['add', 'repository', 'repositories', 'repo', 'setup', 'configure', 'start', 'clone', 'url', 'local path'],
    body: [
      'Repositories → Add: paste an https:// clone URL (use an access token for private repos) or pick a local path.',
      'Then press Run scan on the dashboard, or ask me to "run a scan".',
      'Scans usually take seconds to a few minutes depending on history size.',
      'A CLI is included too: `git-report <repo> -f json -o out`.',
    ],
  },
  {
    id: 'commit-types', title: 'Commit types (conventional commits)',
    keywords: ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'type', 'conventional', 'prefix', 'tagged'],
    body: [
      'When subjects start with a type prefix (feat:, fix:, refactor:, docs:, test:, chore:, perf:, ci:, style:, build:, revert:), the report groups commits by it.',
      'Useful for questions like "show feat commits from last week".',
      'Merges are counted separately so they do not double-count the work on the branch.',
    ],
    note: 'Ask "find feat commits by Alice".',
  },

  // ---- git and development topics -----------------------------------------------------------------
  {
    id: 'rebase', title: 'Rebase',
    keywords: ['rebase', 'rebaseing', 'rebasing', 'interactive', 'rewrite', 'history'],
    body: [
      'Rebase replays your commits on top of another branch so history stays linear.',
      'It rewrites commit hashes — never rebase a branch other people have already pulled.',
      '`git rebase -i HEAD~3` lets you squash, reorder or reword the last three commits.',
      'Rule of thumb: rebase your own unpushed work; merge shared branches.',
    ],
  },
  {
    id: 'merge-conflict', title: 'Merge conflicts',
    keywords: ['conflict', 'conflicts', 'merge', 'resolve', 'clash', 'both changed'],
    body: [
      'A conflict means both sides changed the same lines since the merge base.',
      'Git marks the file with <<<<<<< / ======= / >>>>>>> sections; edit, then `git add` and continue.',
      '`git merge --abort` resets cleanly if you want to start over.',
      'Frequent conflicts in the same files are a signal: those files are hotspots — check them with "hotspot files".',
    ],
  },
  {
    id: 'cherry-pick', title: 'Cherry-pick',
    keywords: ['cherry', 'pick', 'cherry-pick', 'apply one commit', 'move commit'],
    body: [
      '`git cherry-pick <sha>` copies a single commit onto your current branch.',
      'Useful for pulling a fix forward to a release branch without merging everything.',
      'The report detects cherry-picks so the same change is not counted as two contributions.',
    ],
  },
  {
    id: 'head', title: 'HEAD and detached HEAD',
    keywords: ['head', 'detached', 'ref', 'pointer', 'checkout'],
    body: [
      'HEAD is the pointer to the commit your working tree is currently on (usually a branch).',
      'Detached HEAD means HEAD points at a commit directly — commits made there belong to no branch.',
      'Fix it by creating a branch: `git switch -c my-new-branch`.',
    ],
  },
  {
    id: 'pr', title: 'Pull requests, reviews and squash merges',
    keywords: ['pull request', 'pr', 'review', 'squash', 'merge', 'approve', 'code review'],
    body: [
      'A pull request proposes merging a branch and carries the review discussion.',
      'Squash merging lands the whole branch as one commit — it keeps main linear but hides individual steps.',
      'Merge commits keep the branch structure; the report marks them as merges so they do not skew author stats.',
      'Review coverage is not tracked here: this app measures git history, not review activity.',
    ],
  },
  {
    id: 'monorepo', title: 'Monorepos',
    keywords: ['monorepo', 'multiple', 'repositories', 'one repo', 'split', 'polyrepo'],
    body: [
      'A monorepo keeps many projects in one repository; a polyrepo keeps one repo per project.',
      'This app scans whatever repositories you configure and can break results down per repository.',
      'Ask "per repository breakdown" after a scan to compare projects side by side.',
    ],
  },
  {
    id: 'cicd', title: 'CI/CD',
    keywords: ['ci', 'cd', 'pipeline', 'continuous', 'integration', 'deployment', 'actions', 'jenkins', 'workflow'],
    body: [
      'CI runs checks automatically on every push or pull request; CD ships the result.',
      'This app does not run pipelines — it reads what your history says about the code around them.',
      'Commit prefixes like `ci:` and `build:` show pipeline work in the commit-type breakdown.',
    ],
  },
  {
    id: 'tech-debt', title: 'Technical debt',
    keywords: ['debt', 'technical debt', 'legacy', 'refactor', 'cleanup', 'messy', 'old code'],
    body: [
      'Technical debt is the extra cost of changes caused by shortcuts, age or missing structure.',
      'In this data, debt tends to show up as: hotspots (files everyone touches), silos (files one person knows) and repeated refactoring churn.',
      'Ask "hotspot files" and "knowledge silos" for the concrete list.',
    ],
  },
  {
    id: 'semver', title: 'Semantic versioning',
    keywords: ['version', 'semver', 'release', 'tag', 'bump', 'major', 'minor', 'patch'],
    body: [
      'MAJOR.MINOR.PATCH — breaking changes bump MAJOR, features bump MINOR, fixes bump PATCH.',
      'Tags and releases are git metadata; the reports focus on commits and branches rather than versions.',
    ],
  },
];

const byId = new Map(ARTICLES.map((a) => [a.id, a]));
const tokenize = (s) => String(s || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) || [];

// Keyword-scoring lookup with a light typo tolerance, so "buss factor" still finds the article.
function lookup(text, { minScore = 2 } = {}) {
  const q = String(text || '').toLowerCase();
  const words = tokenize(q).filter((w) => w.length > 2);
  if (!words.length) return null;
  let best = null;
  for (const a of ARTICLES) {
    let score = 0;
    for (const kw of a.keywords) {
      if (kw.includes(' ') ? q.includes(kw) : words.includes(kw)) {
        score += kw.includes(' ') ? 3 : 1.5;
        continue;
      }
      if (kw.length >= 5 && words.some((w) => w.length >= 5 && levenshtein(w, kw) <= 1)) score += 0.6;
    }
    for (const t of tokenize(a.title)) if (words.includes(t)) score += 0.5;
    if (score > (best ? best.score : 0)) best = { article: a, score };
  }
  return best && best.score >= minScore ? best.article : null;
}

// Titles offered when the assistant cannot answer — used for "did you mean" style suggestions.
function suggest(text, limit = 3) {
  const words = new Set(tokenize(text));
  if (!words.size) return [];
  return ARTICLES
    .map((a) => ({ title: a.title, score: a.keywords.filter((k) => words.has(k) || (k.includes(' ') && String(text).toLowerCase().includes(k))).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.title);
}

module.exports = { ARTICLES, lookup, suggest };
