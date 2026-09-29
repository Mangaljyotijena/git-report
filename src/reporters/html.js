'use strict';

// JSON embedded in <script>: neutralise "</script>" and the two JS line-separator characters.
const BACKSLASH = String.fromCharCode(92);
function safeJson(data) {
  return JSON.stringify(data)
    .split('<').join(BACKSLASH + 'u003c')
    .split(String.fromCharCode(0x2028)).join(BACKSLASH + 'u2028')
    .split(String.fromCharCode(0x2029)).join(BACKSLASH + 'u2029');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderHtml(report) {
  const { commitLog, ...data } = report; // raw commit log lives in commits.csv; keeps the page light
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.meta.title)}</title>
<style>
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1d2330; --muted: #667085; --line: #e4e7ec;
  --accent: #3b6fd8; --accent-rgb: 59,111,216; --add: #1a9e5c; --del: #d6453d; --warn: #b7791f; --good: #1a9e5c;
  --chip: #eef2f8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1216; --panel: #171b21; --text: #e6e9ee; --muted: #98a2b3; --line: #2a3039;
    --accent: #6d9bff; --accent-rgb: 109,155,255; --add: #3fcf8e; --del: #ff6b62; --warn: #f0b44c; --good: #3fcf8e;
    --chip: #222833;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 1280px; margin: 0 auto; padding: 24px 16px 48px; }
header h1 { margin: 0 0 4px; font-size: 24px; }
.muted { color: var(--muted); }
.small { font-size: 12px; }
h2 { font-size: 15px; margin: 0 0 12px; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-top: 16px; min-width: 0; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 20px; }
.kpi { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
.kpi .v { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
.kpi .l { color: var(--muted); font-size: 12px; }
.grid2 { display: grid; grid-template-columns: 3fr 2fr; gap: 16px; }
.grid2 > .card { margin-top: 16px; }
@media (max-width: 860px) { .grid2 { grid-template-columns: 1fr; } }
ul.insights { list-style: none; margin: 0; padding: 0; }
ul.insights li { padding: 6px 0 6px 22px; position: relative; border-bottom: 1px solid var(--line); }
ul.insights li:last-child { border: 0; }
ul.insights li::before { position: absolute; left: 2px; font-weight: 700; }
li.info::before { content: "•"; color: var(--accent); }
li.warn::before { content: "!"; color: var(--warn); }
li.good::before { content: "✓"; color: var(--good); }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 7px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
th { font-size: 12px; color: var(--muted); font-weight: 600; position: sticky; top: 0; background: var(--panel); }
th.sort { cursor: pointer; user-select: none; }
th.sort:hover { color: var(--text); }
th.asc::after { content: " ▲"; } th.desc::after { content: " ▼"; }
td.r, th.r { text-align: right; }
tr.dev { cursor: pointer; }
tr.dev:hover td { background: var(--chip); }
.add { color: var(--add); } .del { color: var(--del); }
.who b { display: block; } .who span { color: var(--muted); font-size: 12px; }
.badge { display: inline-block; font-size: 11px; padding: 0 6px; border-radius: 8px; background: var(--chip); color: var(--muted); margin-left: 6px; font-weight: 500; }
.sharebar { display: flex; align-items: center; gap: 8px; min-width: 150px; }
.sharebar .t { flex: 1; height: 8px; background: var(--chip); border-radius: 4px; overflow: hidden; }
.sharebar .f { height: 100%; background: var(--accent); }
.sharebar .p { width: 48px; text-align: right; font-size: 12px; }
.detail td { background: var(--bg); white-space: normal; padding: 16px; }
.dgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px; }
.dgrid h3 { font-size: 12px; color: var(--muted); margin: 0 0 6px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
.kv { display: grid; grid-template-columns: auto auto; gap: 2px 12px; font-size: 13px; }
.kv span:nth-child(odd) { color: var(--muted); }
.mini { display: flex; align-items: flex-end; gap: 2px; height: 48px; }
.mini div { flex: 1; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; opacity: .85; }
.minilabels { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); }
.chips span { display: inline-block; background: var(--chip); border-radius: 10px; padding: 1px 8px; margin: 0 4px 4px 0; font-size: 12px; }
.hbars .row { display: grid; grid-template-columns: minmax(80px, 160px) 1fr 56px; gap: 8px; align-items: center; margin: 5px 0; font-size: 13px; }
.hbars .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hbars .t { height: 10px; background: var(--chip); border-radius: 5px; overflow: hidden; }
.hbars .f { height: 100%; background: var(--accent); }
.heat { display: grid; grid-template-columns: 36px repeat(24, 1fr); gap: 2px; font-size: 10px; color: var(--muted); }
.heat .c { aspect-ratio: 1; border-radius: 2px; background: rgba(var(--accent-rgb), var(--v)); outline: 1px solid var(--line); outline-offset: -1px; }
.heat .h { text-align: center; }
svg text { fill: var(--muted); font-size: 10px; }
input.search { width: 100%; max-width: 320px; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); font: inherit; margin-bottom: 10px; }
.legend { display: flex; gap: 14px; font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
footer { margin-top: 24px; font-size: 12px; color: var(--muted); }
.path { max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title"></h1>
    <div class="muted" id="subtitle"></div>
  </header>
  <section class="kpis" id="kpis"></section>
  <section class="card"><h2>Insights</h2><ul class="insights" id="insights"></ul></section>
  <section class="grid2">
    <div class="card"><h2>Monthly activity</h2>
      <div class="legend"><span><i style="background:var(--add)"></i>Lines added</span><span><i style="background:var(--del)"></i>Lines deleted</span><span><i style="background:var(--accent)"></i>Commits</span></div>
      <div id="timeline"></div></div>
    <div class="card"><h2>Share of changed lines</h2><div class="hbars" id="share"></div></div>
  </section>
  <section class="card">
    <h2>Developers <span class="muted small">· click a row for details</span></h2>
    <input class="search" id="q" type="search" placeholder="Filter by name, email or domain…">
    <div class="tablewrap"><table id="devs"></table></div>
  </section>
  <section class="grid2">
    <div class="card"><h2>When commits happen <span class="muted small">(author local time)</span></h2><div class="heat" id="heat"></div></div>
    <div class="card"><h2>Languages by lines changed</h2><div class="hbars" id="langs"></div></div>
  </section>
  <section class="card" id="branchesCard"><h2>Branches not merged into main <span class="muted small">· counted in totals, shown here so pending work is visible</span></h2><div class="tablewrap"><table id="branches"></table></div></section>
  <section class="card" id="domainsCard"><h2>By email domain</h2><div class="tablewrap"><table id="domains"></table></div></section>
  <section class="card" id="reposCard"><h2>Repositories</h2><div class="tablewrap"><table id="repos"></table></div></section>
  <section class="card"><h2>Hotspot files <span class="muted small">· most changed</span></h2><div class="tablewrap"><table id="hotspots"></table></div></section>
  <section class="card" id="silosCard"><h2>Knowledge silos <span class="muted small">· files changed 4+ times, 90%+ by one developer</span></h2><div class="tablewrap"><table id="silos"></table></div></section>
  <footer id="footer"></footer>
</div>
<script>window.REPORT = ${safeJson(data)};</script>
<script>
(function () {
  var R = window.REPORT, S = R.summary;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var n = function (v) { return Number(v || 0).toLocaleString('en-US'); };
  var compact = function (v) { v = Number(v || 0); var a = Math.abs(v); return a >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : n(v); };
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var multi = R.repositories.length > 1;

  $('title').textContent = R.meta.title;
  var f = R.meta.filters, bits = [];
  if (f.since) bits.push('since ' + f.since); if (f.until) bits.push('until ' + f.until);
  if (f.branch) bits.push('branch ' + f.branch); if (f.authors.length) bits.push('author ~ ' + f.authors.join(' | '));
  if (f.domains.length) bits.push('domain ' + f.domains.join(' | ')); if (!f.bots) bits.push('bots excluded');
  $('subtitle').textContent = (S.firstCommit || '–') + ' → ' + (S.lastCommit || '–') + ' · ' + n(S.spanDays) + ' days' + (bits.length ? ' · ' + bits.join(', ') : '');

  var kpis = [
    ['Commits', n(S.commits), n(S.merges) + ' merges'], ['Developers', n(S.developers), S.activeLast90Days + ' active in 90 days'],
    ['Lines added', '<span class="add">+' + compact(S.additions) + '</span>', ''], ['Lines deleted', '<span class="del">−' + compact(S.deletions) + '</span>', ''],
    ['Files touched', n(S.filesTouched), ''], ['Bus factor', n(S.busFactor), 'devs writing 50% of changes'],
    ['Not merged to main', n(S.unmergedCommits), S.unmergedBranches + ' open branch' + (S.unmergedBranches === 1 ? '' : 'es')],
  ];
  if (multi) kpis.unshift(['Repositories', n(S.repositories), '']);
  if (S.ownedLines != null) kpis.push(['Lines at HEAD', compact(S.ownedLines), 'via git blame']);
  $('kpis').innerHTML = kpis.map(function (k) { return '<div class="kpi"><div class="v">' + k[1] + '</div><div class="l">' + esc(k[0]) + (k[2] ? ' · ' + esc(k[2]) : '') + '</div></div>'; }).join('');

  $('insights').innerHTML = R.insights.map(function (i) { return '<li class="' + esc(i.level) + '">' + esc(i.text) + '</li>'; }).join('');

  // Timeline: additions above the axis, deletions below, commits as a line.
  (function () {
    var T = R.timeline; if (!T.length) { $('timeline').innerHTML = '<p class="muted">No activity.</p>'; return; }
    var W = 720, H = 240, pl = 44, pr = 36, pt = 10, pb = 22, iw = W - pl - pr, ih = H - pt - pb, mid = pt + ih / 2;
    var maxL = Math.max.apply(null, T.map(function (m) { return Math.max(m.additions, m.deletions); }).concat([1]));
    var maxC = Math.max.apply(null, T.map(function (m) { return m.commits; }).concat([1]));
    var bw = iw / T.length, g = '';
    g += '<line x1="' + pl + '" x2="' + (W - pr) + '" y1="' + mid + '" y2="' + mid + '" stroke="var(--line)"/>';
    g += '<text x="' + (pl - 6) + '" y="' + (pt + 8) + '" text-anchor="end">+' + compact(maxL) + '</text>';
    g += '<text x="' + (pl - 6) + '" y="' + (H - pb) + '" text-anchor="end">−' + compact(maxL) + '</text>';
    g += '<text x="' + (W - pr + 6) + '" y="' + (pt + 8) + '">' + compact(maxC) + '</text>';
    var pts = [], step = Math.ceil(T.length / 12);
    T.forEach(function (m, i) {
      var x = pl + i * bw, w = Math.max(1, bw - 2), ha = (m.additions / maxL) * (ih / 2), hd = (m.deletions / maxL) * (ih / 2);
      var tip = '<title>' + m.month + ': ' + n(m.commits) + ' commits, +' + n(m.additions) + ' / −' + n(m.deletions) + ', ' + m.developers + ' developer(s)</title>';
      g += '<g><rect x="' + (x + 1) + '" y="' + (mid - ha) + '" width="' + w + '" height="' + ha + '" fill="var(--add)" rx="1">' + tip + '</rect>';
      g += '<rect x="' + (x + 1) + '" y="' + mid + '" width="' + w + '" height="' + hd + '" fill="var(--del)" rx="1">' + tip + '</rect>';
      g += '<rect x="' + x + '" y="' + pt + '" width="' + bw + '" height="' + ih + '" fill="transparent">' + tip + '</rect></g>';
      pts.push((x + bw / 2).toFixed(1) + ',' + (pt + ih - (m.commits / maxC) * ih).toFixed(1));
      if (i % step === 0) g += '<text x="' + (x + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + m.month + '</text>';
    });
    g += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" pointer-events="none"/>';
    $('timeline').innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="Monthly lines added, deleted and commits">' + g + '</svg>';
  })();

  function hbars(el, rows, label, value, fmtv) {
    var max = Math.max.apply(null, rows.map(value).concat([1]));
    el.innerHTML = rows.map(function (r) {
      return '<div class="row"><div class="name" title="' + esc(label(r)) + '">' + esc(label(r)) + '</div><div class="t"><div class="f" style="width:' + (value(r) / max * 100).toFixed(1) + '%"></div></div><div class="r small">' + fmtv(r) + '</div></div>';
    }).join('') || '<p class="muted">No data.</p>';
  }
  hbars($('share'), R.developers.slice(0, 12), function (d) { return d.name; }, function (d) { return d.shareOfChurn; }, function (d) { return d.shareOfChurn.toFixed(1) + '%'; });
  hbars($('langs'), R.languages.slice(0, 12), function (l) { return l.language; }, function (l) { return l.churn; }, function (l) { return l.share.toFixed(1) + '%'; });

  // Heatmap, Monday first.
  (function () {
    var order = [1, 2, 3, 4, 5, 6, 0], max = 1, html = '<div></div>';
    R.heatmap.forEach(function (row) { row.forEach(function (v) { if (v > max) max = v; }); });
    for (var h = 0; h < 24; h++) html += '<div class="h">' + (h % 3 === 0 ? h : '') + '</div>';
    order.forEach(function (d) {
      html += '<div>' + DAYS[d] + '</div>';
      R.heatmap[d].forEach(function (v, h) { html += '<div class="c" style="--v:' + (v ? 0.12 + 0.88 * v / max : 0).toFixed(2) + '" title="' + DAYS[d] + ' ' + h + ':00 · ' + v + ' commits"></div>'; });
    });
    $('heat').innerHTML = html;
  })();

  // Generic sortable table.
  function table(el, cols, rows, opts) {
    opts = opts || {};
    var state = { key: opts.sortKey, dir: -1 };
    function draw() {
      var data = rows();
      if (state.key != null) {
        var c = cols.filter(function (c) { return c.key === state.key; })[0];
        data = data.slice().sort(function (a, b) { var x = c.sortv(a), y = c.sortv(b); return (x > y ? 1 : x < y ? -1 : 0) * state.dir; });
      }
      var head = '<thead><tr>' + cols.map(function (c) {
        var cls = [c.num ? 'r' : '', c.sortv ? 'sort' : '', state.key === c.key ? (state.dir > 0 ? 'asc' : 'desc') : ''].join(' ');
        return '<th class="' + cls + '" data-k="' + c.key + '">' + esc(c.label) + '</th>';
      }).join('') + '</tr></thead>';
      var body = data.map(function (r, i) {
        var tr = '<tr' + (opts.rowAttr ? opts.rowAttr(r, i) : '') + '>' + cols.map(function (c) { return '<td class="' + (c.num ? 'r' : '') + (c.cls ? ' ' + c.cls : '') + '">' + c.html(r) + '</td>'; }).join('') + '</tr>';
        return tr + (opts.after ? opts.after(r) : '');
      }).join('');
      el.innerHTML = head + '<tbody>' + (body || '<tr><td colspan="' + cols.length + '" class="muted">Nothing to show.</td></tr>') + '</tbody>';
      el.querySelectorAll('th.sort').forEach(function (th) {
        th.onclick = function () { var k = th.getAttribute('data-k'); state.dir = state.key === k ? -state.dir : -1; state.key = k; draw(); };
      });
      if (opts.onDraw) opts.onDraw(el);
    }
    draw();
    return draw;
  }
  var col = function (key, label, html, sortv, num, cls) { return { key: key, label: label, html: html, sortv: sortv, num: num, cls: cls }; };
  var numCol = function (key, label, cls) { return col(key, label, function (r) { return n(r[key]); }, function (r) { return r[key]; }, true, cls); };
  var shareCell = function (p) { return '<div class="sharebar"><div class="t"><div class="f" style="width:' + p + '%"></div></div><div class="p">' + p.toFixed(1) + '%</div></div>'; };

  // Developers.
  var open = {}, query = '';
  function spark(values, labels) {
    var max = Math.max.apply(null, values.concat([1]));
    return '<div class="mini">' + values.map(function (v, i) { return '<div style="height:' + (v / max * 100).toFixed(0) + '%" title="' + esc(labels[i]) + ': ' + v + '"></div>'; }).join('') + '</div>';
  }
  function detail(d) {
    var months = d.monthly.slice(-24), types = Object.keys(d.commitTypes);
    var wk = [1, 2, 3, 4, 5, 6, 0];
    var kv = function (pairs) { return '<div class="kv">' + pairs.map(function (p) { return '<span>' + esc(p[0]) + '</span><span>' + p[1] + '</span>'; }).join('') + '</div>'; };
    return '<tr class="detail"><td colspan="20"><div class="dgrid">' +
      '<div><h3>Profile</h3>' + kv([
        ['Email', esc(d.email)], ['Other emails', esc(d.aliases.emails.join(', ') || '–')], ['Other names', esc(d.aliases.names.join(', ') || '–')],
        ['Active', esc(d.firstCommit) + ' → ' + esc(d.lastCommit)], ['Days since last commit', n(d.daysSinceLastCommit)],
        ['Active days / streak', n(d.activeDays) + ' / ' + n(d.longestStreakDays) + ' days'],
        ['Commits per active day', d.commitsPerActiveDay], ['Avg / median lines per commit', n(d.avgChurnPerCommit) + ' / ' + n(d.medianChurnPerCommit)],
        ['Large commits (1000+ lines)', n(d.largeCommits)], ['Merges', n(d.merges)], ['Co-authored commits', n(d.coAuthoredCommits)],
        ['Not merged to main', n(d.unmerged.commits) + ' commits · +' + n(d.unmerged.additions) + ' / −' + n(d.unmerged.deletions) + ' (' + d.mergedShare + '% of lines merged)'],
        ['After hours / weekend', d.afterHoursShare + '% / ' + d.weekendShare + '%']
      ].concat(d.ownership ? [['Owns at HEAD', n(d.ownership.lines) + ' lines (' + d.ownership.share + '%)']] : [])) + '</div>' +
      '<div><h3>Monthly commits</h3>' + spark(months.map(function (m) { return m.commits; }), months.map(function (m) { return m.month; })) +
        '<div class="minilabels"><span>' + esc(months[0] ? months[0].month : '') + '</span><span>' + esc(months.length ? months[months.length - 1].month : '') + '</span></div>' +
        '<h3 style="margin-top:14px">Weekday</h3>' + spark(wk.map(function (i) { return d.weekday[i]; }), wk.map(function (i) { return DAYS[i]; })) +
        '<div class="minilabels"><span>Mon</span><span>Sun</span></div>' +
        '<h3 style="margin-top:14px">Hour of day</h3>' + spark(d.hour, d.hour.map(function (_, h) { return h + ':00'; })) +
        '<div class="minilabels"><span>0:00</span><span>12:00</span><span>23:00</span></div></div>' +
      '<div><h3>Commit types</h3><div class="chips">' + (types.map(function (t) { return '<span>' + esc(t) + ' ' + d.commitTypes[t].share + '%</span>'; }).join('') || '–') + '</div>' +
        '<h3 style="margin-top:14px">Languages</h3><div class="chips">' + (d.topLanguages.map(function (l) { return '<span>' + esc(l.language) + ' · ' + compact(l.churn) + '</span>'; }).join('') || '–') + '</div>' +
        '<h3 style="margin-top:14px">Main directories</h3><div class="chips">' + (d.topDirectories.map(function (l) { return '<span>' + esc(l.directory) + '</span>'; }).join('') || '–') + '</div>' +
        (d.largestCommit ? '<h3 style="margin-top:14px">Largest commit</h3><div class="small"><code>' + esc(d.largestCommit.hash) + '</code> ' + esc(d.largestCommit.date) + ' · ' + n(d.largestCommit.churn) + ' lines<br>' + esc(d.largestCommit.subject) + '</div>' : '') +
      '</div>' +
      '<div><h3>Repositories</h3>' + kv(d.repos.map(function (r) { return [r.name, n(r.commits) + ' commits · <span class="add">+' + compact(r.additions) + '</span> <span class="del">−' + compact(r.deletions) + '</span>']; })) +
        (d.branches.length ? '<h3 style="margin-top:14px">Unmerged work by branch</h3>' + kv(d.branches.slice(0, 12).map(function (b) { return [(multi ? b.repo + ':' : '') + b.name, n(b.commits) + ' commits · <span class="add">+' + compact(b.additions) + '</span> <span class="del">−' + compact(b.deletions) + '</span>']; })) : '') + '</div>' +
      '</div></td></tr>';
  }
  var devCols = [
    col('rank', '#', function (d) { return d.rank; }, function (d) { return -d.rank; }, true),
    col('name', 'Developer', function (d) {
      return '<div class="who"><b>' + esc(d.name) + (d.isBot ? '<span class="badge">bot</span>' : '') + (d.aliases.emails.length ? '<span class="badge" title="' + esc(d.aliases.emails.join(', ')) + '">+' + d.aliases.emails.length + ' email' + (d.aliases.emails.length > 1 ? 's' : '') + '</span>' : '') + '</b><span>' + esc(d.email) + '</span></div>';
    }, function (d) { return d.name.toLowerCase(); }),
    numCol('commits', 'Commits'),
    col('additions', 'Added', function (d) { return '+' + n(d.additions); }, function (d) { return d.additions; }, true, 'add'),
    col('deletions', 'Deleted', function (d) { return '−' + n(d.deletions); }, function (d) { return d.deletions; }, true, 'del'),
    numCol('net', 'Net'), numCol('filesTouched', 'Files'), numCol('activeDays', 'Active days'),
    col('lastCommit', 'Last commit', function (d) { return esc(d.lastCommit || '–'); }, function (d) { return d.lastCommit || ''; }),
    col('unmerged', 'Unmerged', function (d) { return d.unmerged.commits ? '<span style="color:var(--warn)">' + n(d.unmerged.commits) + '</span>' : '<span class="muted">–</span>'; }, function (d) { return d.unmerged.commits; }, true),
  ];
  if (S.ownedLines != null) devCols.push(col('own', 'Owns', function (d) { return d.ownership.share + '%'; }, function (d) { return d.ownership.lines; }, true));
  devCols.push(col('shareOfChurn', 'Share of changes', function (d) { return shareCell(d.shareOfChurn); }, function (d) { return d.shareOfChurn; }));
  var drawDevs = table($('devs'), devCols, function () {
    return R.developers.filter(function (d) { return !query || (d.name + ' ' + d.email + ' ' + d.aliases.emails.join(' ') + ' ' + d.aliases.names.join(' ')).toLowerCase().indexOf(query) >= 0; });
  }, {
    rowAttr: function (d) { return ' class="dev" data-rank="' + d.rank + '"'; },
    after: function (d) { return open[d.rank] ? detail(d) : ''; },
    onDraw: function (el) {
      el.querySelectorAll('tr.dev').forEach(function (tr) {
        tr.onclick = function () { var k = tr.getAttribute('data-rank'); open[k] = !open[k]; drawDevs(); };
      });
    },
  });
  $('q').oninput = function (e) { query = e.target.value.trim().toLowerCase(); drawDevs(); };

  if (R.domains.length > 1) {
    table($('domains'), [
      col('domain', 'Domain', function (d) { return esc(d.domain); }, function (d) { return d.domain; }),
      numCol('developers', 'Developers'), numCol('commits', 'Commits'),
      col('additions', 'Added', function (d) { return '+' + n(d.additions); }, function (d) { return d.additions; }, true, 'add'),
      col('deletions', 'Deleted', function (d) { return '−' + n(d.deletions); }, function (d) { return d.deletions; }, true, 'del'),
      col('shareOfChurn', 'Share of changes', function (d) { return shareCell(d.shareOfChurn); }, function (d) { return d.shareOfChurn; }),
    ], function () { return R.domains; });
  } else $('domainsCard').style.display = 'none';

  table($('repos'), [
    col('name', 'Repository', function (r) { return '<b>' + esc(r.name) + '</b><div class="muted small">' + esc(r.remote || r.path) + '</div>'; }, function (r) { return r.name.toLowerCase(); }),
    col('mainBranch', 'Main branch', function (r) {
      return esc(r.mainBranch || '–') + (r.shallow ? '<span class="badge">shallow</span>' : '') +
        (r.uncommitted ? '<span class="badge" title="' + esc(r.uncommitted.files + ' changed, ' + r.uncommitted.untrackedFiles + ' untracked, by ' + (r.uncommitted.user || r.uncommitted.email || 'local user')) + '">uncommitted</span>' : '');
    }),
    numCol('commits', 'Commits'), numCol('developers', 'Developers'), numCol('unmergedBranches', 'Unmerged branches'),
    col('additions', 'Added', function (r) { return '+' + n(r.additions); }, function (r) { return r.additions; }, true, 'add'),
    col('deletions', 'Deleted', function (r) { return '−' + n(r.deletions); }, function (r) { return r.deletions; }, true, 'del'),
    numCol('busFactor', 'Bus factor'),
    col('topDeveloper', 'Top developer', function (r) { return esc(r.topDeveloper || '–'); }),
    col('lastCommit', 'Last commit', function (r) { return esc(r.lastCommit || '–'); }, function (r) { return r.lastCommit || ''; }),
  ], function () { return R.repositories; }, { sortKey: 'commits' });

  var pending = R.branches.filter(function (b) { return b.status === 'unmerged' || b.status === 'unpushed'; });
  if (pending.length) {
    table($('branches'), [
      col('name', 'Branch', function (b) { return '<b>' + (multi ? '<span class="muted">' + esc(b.repo) + ':</span>' : '') + esc(b.name) + '</b>' + (b.local && !b.remote ? '<span class="badge">local only</span>' : ''); }, function (b) { return b.name.toLowerCase(); }),
      col('status', 'Status', function (b) { return b.status === 'unpushed' ? '<span class="del">unpushed</span>' : b.stale ? '<span style="color:var(--warn)">stale · ' + b.daysIdle + 'd idle</span>' : 'open'; }, function (b) { return b.daysIdle || 0; }),
      numCol('aheadCommits', 'Ahead of main'),
      col('additions', 'Added', function (b) { return '+' + n(b.additions); }, function (b) { return b.additions; }, true, 'add'),
      col('deletions', 'Deleted', function (b) { return '−' + n(b.deletions); }, function (b) { return b.deletions; }, true, 'del'),
      col('lastCommit', 'Last commit', function (b) { return esc(b.lastCommit || '–'); }, function (b) { return b.lastCommit || ''; }),
      col('developers', 'Developers', function (b) { return esc(b.developers.map(function (d) { return d.name + ' (' + d.commits + ')'; }).join(', ') || '–'); }),
    ], function () { return pending; }, { sortKey: 'aheadCommits' });
  } else $('branchesCard').style.display = 'none';

  var fileCols = [
    col('path', 'File', function (f) { return '<div class="path" title="' + esc(f.path) + '">' + (multi ? '<span class="muted">' + esc(f.repo) + ':</span>' : '') + esc(f.path) + '</div>'; }, function (f) { return f.path; }),
    numCol('commits', 'Commits'), numCol('churn', 'Lines changed'), numCol('authors', 'Developers'),
    col('topAuthor', 'Main author', function (f) { return esc(f.topAuthor) + ' <span class="muted small">' + f.topAuthorShare + '%</span>'; }, function (f) { return f.topAuthorShare; }),
    col('lastChanged', 'Last changed', function (f) { return esc(f.lastChanged); }, function (f) { return f.lastChanged; }),
  ];
  table($('hotspots'), fileCols, function () { return R.hotspots.slice(0, 25); });
  if (R.silos.length) table($('silos'), fileCols, function () { return R.silos; });
  else $('silosCard').style.display = 'none';

  $('footer').textContent = 'Generated ' + new Date(R.meta.generatedAt).toLocaleString() + ' by git-contrib-report' +
    (S.excludedLines ? ' · ' + n(S.excludedLines) + ' lines in lock/build/vendored files excluded' : '') +
    (R.meta.mergedIdentities ? ' · ' + R.meta.mergedIdentities + ' developer(s) had multiple emails merged' : '');
})();
</script>
</body>
</html>
`;
}

module.exports = { renderHtml };
