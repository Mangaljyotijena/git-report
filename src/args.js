'use strict';

const FORMATS = ['console', 'json', 'csv', 'html'];

// Generated / vendored files that distort line counts. Disable with --no-default-excludes.
const DEFAULT_EXCLUDES = [
  '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/composer.lock',
  '**/Gemfile.lock', '**/poetry.lock', '**/Cargo.lock', '**/go.sum', '**/*.lock',
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/vendor/**', '**/coverage/**',
  '**/*.min.js', '**/*.min.css', '**/*.map',
];

const HELP = `
git-report - developer contribution report for git repositories

USAGE
  git-report [repo-path ...] [options]

  With no path, the current directory is analysed.

SOURCES
  -r, --repo <path>          Repository to analyse (repeatable)
      --scan <dir>           Find every git repository under <dir> and analyse them all
      --scan-depth <n>       How deep --scan looks for repositories (default 3)
                             By default EVERY local and remote-tracking branch is analysed,
                             so work that is not merged yet is counted (each commit once).
  -b, --branch <ref>         Only analyse these branches/refs (repeatable or comma separated)
      --main <ref>           Branch that counts as "merged" (default: auto-detect
                             origin/HEAD, main, master, develop, trunk)
      --main-only            Only count work that reached the main branch
      --all                  Every ref including tags (stash excluded)
      --fetch                Run "git fetch --all --prune" first so remote branches are current
      --stale-days <n>       Unmerged branches idle this long are flagged stale (default 30)

FILTERS
  -s, --since <date>         Only commits after date ("2025-01-01", "6 months ago")
  -u, --until <date>         Only commits before date
  -a, --author <text>        Only developers whose email or name contains text
                             (repeatable or comma separated)
  -d, --domain <domain>      Only developers with an email at this domain (e.g. acme.com)
  -e, --exclude <glob>       Ignore files matching glob, e.g. "docs/**" or "*.sql" (repeatable)
      --no-default-excludes  Count lock files, dist/, build/, vendor/, minified files too
      --no-bots              Drop bot accounts (dependabot, github-actions, renovate, ...)
      --no-merge-identities  Do not merge emails that belong to the same person
  -w, --ignore-whitespace    Do not count whitespace-only line changes

OUTPUT
  -f, --format <list>        console,json,csv,html or "all" (default: console,html)
  -o, --out <dir>            Directory for report files (default: ./git-report-output)
  -n, --top <n>              Rows in console top lists (default 15)
      --title <text>         Report title
      --blame                Also compute current code ownership (lines per developer
                             at HEAD via git blame; slower on big repos)
      --blame-max-files <n>  Cap files blamed per repo (default 3000)
  -q, --quiet                No progress output
  -h, --help                 Show this help
  -v, --version              Show version

EXAMPLES
  git-report                                   # current repo, console + HTML
  git-report ../api ../web --since "90 days ago"
  git-report --scan ~/work -f all -o reports
  git-report -a jane@acme.com -f console       # one developer
  git-report --domain acme.com --no-bots --blame
  git-report --fetch --main origin/develop     # unmerged work vs. develop

NOTES
  * Commits rebased or cherry-picked onto main (same patch, new hash) are counted once.
  * Squash-merged branches still show as unmerged until the branch is deleted.
  * Co-authored-by trailers are credited to co-authors (as co-authored commits, not lines).
  * Honours .mailmap. Shallow clones are flagged because their history is incomplete.
`;

function list(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const o = {
    repos: [], scan: [], scanDepth: 3,
    branches: [], main: null, mainOnly: false, all: false, fetch: false, staleDays: 30,
    since: null, until: null,
    authors: [], domains: [], excludes: [],
    defaultExcludes: true, bots: true, mergeIdentities: true, ignoreWhitespace: false,
    formats: ['console', 'html'], out: 'git-report-output', top: 15, title: null,
    blame: false, blameMaxFiles: 3000,
    quiet: false, help: false, version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    let flag = argv[i];
    let inline;
    if (flag.startsWith('--') && flag.includes('=')) {
      inline = flag.slice(flag.indexOf('=') + 1);
      flag = flag.slice(0, flag.indexOf('='));
    }
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined || /^-[a-z-]/i.test(next)) throw new Error(`Option ${flag} requires a value`);
      return next;
    };
    const int = () => {
      const v = parseInt(value(), 10);
      if (!Number.isFinite(v) || v < 1) throw new Error(`Option ${flag} expects a positive number`);
      return v;
    };

    switch (flag) {
      case '-r': case '--repo': o.repos.push(value()); break;
      case '--scan': o.scan.push(value()); break;
      case '--scan-depth': o.scanDepth = int(); break;
      case '-b': case '--branch': o.branches.push(...list(value())); break;
      case '--main': o.main = value(); break;
      case '--main-only': o.mainOnly = true; break;
      case '--all': o.all = true; break;
      case '--fetch': o.fetch = true; break;
      case '--stale-days': o.staleDays = int(); break;
      case '-w': case '--ignore-whitespace': o.ignoreWhitespace = true; break;
      case '-s': case '--since': o.since = value(); break;
      case '-u': case '--until': o.until = value(); break;
      case '-a': case '--author': o.authors.push(...list(value()).map((s) => s.toLowerCase())); break;
      case '-d': case '--domain': o.domains.push(...list(value()).map((s) => s.toLowerCase().replace(/^@/, ''))); break;
      case '-e': case '--exclude': o.excludes.push(...list(value())); break;
      case '--no-default-excludes': o.defaultExcludes = false; break;
      case '--no-bots': o.bots = false; break;
      case '--no-merge-identities': o.mergeIdentities = false; break;
      case '-f': case '--format': {
        const f = list(value()).map((s) => s.toLowerCase());
        o.formats = f.includes('all') ? FORMATS.slice() : f;
        const bad = o.formats.filter((x) => !FORMATS.includes(x));
        if (bad.length) throw new Error(`Unknown format: ${bad.join(', ')} (use ${FORMATS.join(', ')}, all)`);
        break;
      }
      case '-o': case '--out': o.out = value(); break;
      case '-n': case '--top': o.top = int(); break;
      case '--title': o.title = value(); break;
      case '--blame': o.blame = true; break;
      case '--blame-max-files': o.blameMaxFiles = int(); break;
      case '-q': case '--quiet': o.quiet = true; break;
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      default:
        if (flag.startsWith('-')) throw new Error(`Unknown option: ${flag} (see --help)`);
        o.repos.push(flag);
    }
  }
  return o;
}

function globToRegex(glob) {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  if (!g.includes('/')) g = '**/' + g;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$', 'i');
}

function buildExcluder(opts) {
  const globs = [...(opts.defaultExcludes ? DEFAULT_EXCLUDES : []), ...opts.excludes];
  const regexes = globs.map(globToRegex);
  const cache = new Map();
  return (file) => {
    let hit = cache.get(file);
    if (hit === undefined) {
      hit = regexes.some((r) => r.test(file));
      cache.set(file, hit);
    }
    return hit;
  };
}

module.exports = { parseArgs, buildExcluder, globToRegex, HELP, FORMATS, DEFAULT_EXCLUDES };
