# git-report

Contribution report for one or many git repositories, per developer (email). It comes in two forms:

- **Git Insights web app** (below): configure repositories, schedule periodic scans, get reports by Gmail, and ask the assistant about the data — with Claude or with the built-in deterministic Smart agent.
- **CLI** (further down): needs only Node 18+ and git, with no npm dependencies.

## Git Insights web app

```bash
cp .env.example .env          # optional: APP_SECRET, ADMIN_PASSWORD, ANTHROPIC_API_KEY
docker compose up -d --build  # http://localhost:3030
```

Without Docker (Node 22.13+ and git): `npm install && npm start`.

| Page | What it does |
|---|---|
| **Repositories** | Add HTTPS clone URLs (GitHub, GitLab, Bitbucket, …) with an optional access token, or local paths. Remote repos are cloned into the data volume, and every branch is fetched before each scan. |
| **Schedules** | Cron-based periodic scans, e.g. every Monday 09:00 for the last 7 days. Each schedule sets its repositories, filters, time zone, recipients, and whether to include a summary. |
| **Scans** | History of every scan, with its live log, the full interactive HTML report, **Email report** and **Generate summary**. |
| **Dashboard** | Totals, insights, monthly activity, developers, unmerged branches, hotspots and knowledge silos for any finished scan. |
| **Assistant** | Answers questions over all stored scans with tools (developers, branches, commit search, scan comparison) and can start new scans. Switch between **Auto**, **Smart** and **Claude** in the page header. |
| **Settings** | Gmail (address and [app password](https://myaccount.google.com/apppasswords)), default recipients, Anthropic API key, model and effort. |

**Setup notes**

- **Gmail**: turn on 2-Step Verification, create an app password, and enter it in Settings. Your normal Gmail password does not work. Use **Send test email** to check the setup.
- **AI**: add an Anthropic API key in Settings (or `ANTHROPIC_API_KEY`). The default model is `claude-opus-5-5`. The agent sees report data only (names, emails, counts, commit subjects), never source code. Requests enable server-side refusal fallbacks (`fallbacks: "default"`).
- **Assistant modes** (`agent_mode` setting, switchable in the Assistant header): `auto` (default) uses Claude when a key exists and otherwise the Smart agent, `smart` is the built-in deterministic agent — no API key, no LLM, every answer carries a "no AI used" provenance footer — and `claude` forces Claude (needs a key). Scan summaries and scheduled emails follow the same rule, so they work without a key too.
- **Local repositories in Docker**: put them under `./repos` (or set `LOCAL_REPOS_DIR`). They are mounted read-only at `/repos`, so add them as `/repos/<name>`.
- **Security**: tokens and passwords are stored AES-256-GCM encrypted with `APP_SECRET`. If it is not set, a key is generated in the data volume. Set `ADMIN_PASSWORD` to protect the UI with basic auth before exposing it on a network.
- **Data**: SQLite database, clones and key live in the `git-insights-data` volume (`/data`). Scans run one at a time.

**Layout**: `server/` (Express API, SQLite via `node:sqlite`, scanner, scheduler, mailer, agent), `public/` (single-page UI, no build step) and `src/` (the analysis engine shared with the CLI).

## CLI

```bash
node bin/git-report.js                       # current repo → console + ./git-report-output/git-report.html
node bin/git-report.js ../api ../web -f all  # several repos, every format
node bin/git-report.js --scan ~/work --since "6 months ago" --no-bots
node bin/git-report.js -a jane@acme.com      # one developer
node bin/git-report.js --domain acme.com     # everyone with an @acme.com email
node bin/git-report.js --fetch --blame       # refresh remote branches, add code ownership
npm link                                     # optional: install as `git-report` command
```

Run `node bin/git-report.js --help` for every option.

## What is measured

| Per developer | Across the repo(s) |
|---|---|
| commits, merges, co-authored commits | totals, date span, bus factor |
| lines added / deleted / net, files touched | monthly timeline, weekday × hour heatmap |
| work not merged to main, by branch | unmerged / stale / unpushed branches |
| active days, streak, first/last commit | breakdown by email domain and by repository |
| avg/median commit size, large commits | hotspot files, knowledge silos |
| languages, directories, commit types | languages |
| after-hours and weekend share | auto-generated insights |
| code owned at HEAD (`--blame`) | |

## Branches and unmerged work

- **All branches are scanned by default** (local + remote-tracking). A commit that is on several branches is counted once.
- The main branch is detected from `origin/HEAD`, then `main`, `master`, `develop`, `trunk`. Override it with `--main <ref>`.
- Each commit is marked **merged** (reachable from main) or **unmerged**. Unmerged work is broken down by developer and branch.
- **Rebased or cherry-picked** copies of a commit already on main (same patch, different hash) are detected with `git cherry` and counted once.
- Local main commits that are missing from `origin/main` are reported as **unpushed**.
- Unmerged branches idle for more than `--stale-days` (default 30) are flagged **stale**.
- `--main-only` counts only merged work. `--branch x,y` limits the report to specific refs.
- Remote branches are only as fresh as your last fetch. Use `--fetch` to update them first.

**Limitation:** squash-merged branches can't be matched to their squash commit, so they show as unmerged until the branch is deleted.

## Other edge cases handled

- **Identity merging:** the same person committing from several emails (same full name, or a GitHub `noreply` login) is merged, and `.mailmap` is honoured. Use `--no-merge-identities` to switch this off.
- **Co-authors:** `Co-authored-by:` trailers credit co-authors with a co-authored commit. The lines stay with the author.
- **Renames:** a renamed file counts only its real edits, not a full delete and re-add.
- **Files not counted:** binary files, plus lock files, `dist/`, `build/`, `vendor/`, `node_modules/` and minified files. Change this with `--exclude` or `--no-default-excludes`.
- **Merge commits:** counted separately, and they don't inflate line counts.
- **Uncommitted changes:** reported per repository and attributed to the local git user, but not counted in the stats.
- **Repository problems:**
  - shallow clones are flagged
  - empty repos and detached HEADs are handled
  - repos owned by another user are skipped, with a message that includes the fix command
  - two repos with the same folder name get distinct labels
- **Safe sharing:**
  - credentials are removed from remote URLs
  - CSV cells are protected against formula injection
  - HTML output is escaped
- **Other:** hours and weekdays use the author's own timezone. `-w` ignores whitespace-only changes. Bots can be dropped with `--no-bots`.

## Output (`-f console,json,csv,html`, default `console,html`)

- `git-report.html`: a self-contained dashboard you can open offline. It has a sortable, searchable developer table; click a row for details.
- `git-report.json`: the full data.
- CSV files for Excel: `developers`, `developer_monthly`, `developer_repos`, `branches`, `domains`, `files` and `commits` (one row per commit, including merged/unmerged status and branch).

## Test

```bash
npm test   # smoke test on a throwaway repo, then the Smart agent test (intents, tools, mode dispatch)
```
