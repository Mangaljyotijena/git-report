'use strict';

// Tests for the Activity list export: layout heights, drawing, pagination, the hand-built PDF
// (xref offsets and image streams) and the browser glue with a stubbed canvas and DOM.
const assert = require('assert');
const {
  EX, wrapLines, activityHeight, drawActivity, planActivityPages, b64ToBin, pdfFromPages, exportActivityList,
} = require('../public/export.js');

const mkCtx = () => ({
  font: '', fillStyle: '', textAlign: 'left', textBaseline: '', letterSpacing: '',
  texts: [], rects: [],
  fillText(t, x, y) { this.texts.push({ t, x, y, font: this.font, color: this.fillStyle, align: this.textAlign }); },
  fillRect(x, y, w, h) { this.rects.push({ x, y, w, h, color: this.fillStyle }); },
  roundRect(x, y, w, h) { this.rects.push({ x, y, w, h, color: this.fillStyle, round: true }); },
  measureText(t) { return { width: String(t).length * 7 }; },
  createLinearGradient() { return { addColorStop() {} }; },
  beginPath() {}, fill() {}, save() {}, restore() {},
});

const mkCanvas = () => {
  const c = {
    width: 0, height: 0, ctx: null, blobs: [], dataUrls: [],
    getContext() { if (!c.ctx) c.ctx = mkCtx(); return c.ctx; },
    toBlob(cb, type) { c.blobs.push(type); cb({ type, size: c.width * c.height }); },
    toDataURL(type) { c.dataUrls.push(type); return `data:${type};base64,${Buffer.from(`JPEG-${c.width}x${c.height}`).toString('base64')}`; },
  };
  return c;
};

const mkDoc = () => {
  const doc = {
    canvases: [], anchors: [],
    body: { appendChild(el) { el.parentNode = this; }, removeChild(el) { el.parentNode = null; } },
    createElement(tag) {
      if (tag === 'canvas') { const c = mkCanvas(); doc.canvases.push(c); return c; }
      const a = {
        tagName: tag, href: '', download: '', clicked: false, parentNode: null,
        click() { this.clicked = true; },
        remove() { this.removed = true; },
      };
      doc.anchors.push(a);
      return a;
    },
  };
  return doc;
};

const bin = (bytes) => bytes.map((b) => String.fromCharCode(b)).join('');

const model = {
  title: 'Recent activity — developers',
  context: [
    'Last 30 days · All enabled repositories · generated 2 Oct 2026, 10:00',
    '60 of 60 developers shown · sorted by lines descending',
  ],
  totalsLine: '600 commits · +600 −300 lines · 60 developers',
  columns: [
    { label: 'Developer', align: 'left', w: 500 },
    { label: 'Commits', align: 'right', w: 130 },
    { label: 'Lines', align: 'right', w: 180 },
    { label: 'Files', align: 'right', w: 110 },
    { label: 'Branches', align: 'right', w: 140 },
    { label: 'Last', align: 'right', w: 180 },
    { label: 'Share', align: 'right', w: 288 },
  ],
  rows: Array.from({ length: 60 }, (_, i) => ({
    cells: [
      { text: `Developer ${i}`, sub: `dev${i}@acme.com` },
      { text: String(i + 1) },
      { parts: [{ text: '+10', color: 'add' }, { text: ' −5', color: 'del' }] },
      { text: '3' },
      { text: '2' },
      { text: `${i % 9}d ago` },
      { bar: i % 100, text: `${i % 100}%` },
    ],
  })),
  totals: [
    { text: 'Total' }, { text: '600' },
    { parts: [{ text: '+600', color: 'add' }, { text: ' −300', color: 'del' }] },
    { text: '—' }, { text: '—' }, { text: '' }, { text: '' },
  ],
  footnote: 'A commit on several branches is listed under each of them but counted once in the totals. '
    + 'The window uses the commit date, so work rebased or cherry-picked in it is included and marked “rewritten”. '
    + 'A few lines in lock files and build output are not counted.',
};

const scale = EX.pdfScale;
const canvasW = Math.round(EX.baseWidth * scale);
const usableW = EX.page.w - EX.page.margin * 2;
const usableH = EX.page.h - EX.page.margin * 2;
const capH = Math.floor((usableH * canvasW) / usableW);

(async () => {
  // -- wrapping respects the width -------------------------------------------------------------------
  const measure = (t) => t.length * 7;
  const sentence = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
  const lines = wrapLines(sentence, 70, measure);
  assert.ok(lines.length > 1, 'a long line wraps');
  assert.ok(lines.every((l) => measure(l) <= 70), 'no wrapped line is too wide');
  assert.strictEqual(lines.join(' '), sentence, 'nothing is lost while wrapping');

  // -- heights grow with the content ------------------------------------------------------------------
  const ctx = mkCtx();
  const short = { head: 'full', from: 0, to: 10 };
  assert.ok(activityHeight(model, { ...short, to: 20 }, ctx, 1) > activityHeight(model, short, ctx, 1), 'more rows, taller image');
  assert.ok(activityHeight(model, { head: 'compact', from: 0, to: 10 }, ctx, 1) < activityHeight(model, short, ctx, 1), 'a continued page needs a smaller head');
  assert.ok(activityHeight(model, { ...short, totals: true, foot: true }, ctx, 1) > activityHeight(model, short, ctx, 1), 'totals and footnote add height');

  // -- drawing fills that height with the whole list ----------------------------------------------------
  const opts = { head: 'full', from: 0, to: model.rows.length, totals: true, foot: true, scale: 1 };
  const height = activityHeight(model, opts, ctx, 1);
  const drawn = drawActivity(ctx, model, { ...opts, height: height + 5 });
  assert.ok(Math.abs(drawn - height) < 1, `drawing reports the planned height (${drawn} vs ${height})`);
  const shown = ctx.texts.map((t) => t.t);
  for (const expected of [
    'Recent activity — developers', 'Last 30 days · All enabled repositories · generated 2 Oct 2026, 10:00',
    'DEVELOPER', 'COMMITS', 'Developer 0', 'dev0@acme.com', 'Developer 59', 'dev59@acme.com',
    '+10', ' −5', 'Total', '600',
  ]) {
    assert.ok(shown.includes(expected), `drawn: ${expected}`);
  }
  assert.ok(shown.some((t) => t.startsWith('A commit on several branches')), 'the footnote is wrapped and drawn');
  assert.ok(ctx.rects.some((r) => r.round), 'the share bars are drawn');
  assert.ok(ctx.texts.every((t) => t.y < height + 5), 'every baseline sits inside the canvas');
  assert.ok(ctx.rects.every((r) => r.y + r.h <= height + 5), 'every rectangle sits inside the canvas');

  // -- pagination covers the rows exactly once, with the totals at the end -------------------------------
  const pages = planActivityPages(model, capH, ctx, scale);
  assert.ok(pages.length > 1, `${model.rows.length} rows need more than one page`);
  assert.strictEqual(pages[0].from, 0, 'the first page starts at the first row');
  pages.forEach((p, i) => {
    if (i) assert.strictEqual(p.from, pages[i - 1].to, `page ${i + 1} continues where page ${i} stopped`);
    assert.ok(p.from <= p.to, 'the page has a sane range');
    const h = activityHeight(model, p, ctx, scale);
    assert.ok(h <= capH, `page ${i + 1} fits its page (${h} <= ${capH})`);
    assert.ok(p.head === 'full' ? i === 0 : true, 'only the first page has the full head');
  });
  assert.strictEqual(pages[pages.length - 1].to, model.rows.length, 'the last page ends at the last row');
  assert.ok(pages[pages.length - 1].totals && pages[pages.length - 1].foot, 'the totals and footnote are on the last page');
  assert.deepStrictEqual(planActivityPages({ ...model, rows: [] }, capH, ctx, scale),
    [{ from: 0, to: 0, head: 'full', totals: true, foot: true }], 'an empty list still exports');

  // -- base64 decoding without atob or Buffer ------------------------------------------------------------
  assert.strictEqual(b64ToBin(Buffer.from('hello world').toString('base64')), 'hello world');
  const raw = [0, 1, 2, 3, 250, 251, 252, 253, 254, 255, 128, 64];
  assert.strictEqual([...b64ToBin(Buffer.from(raw).toString('base64'))].map((c) => c.charCodeAt(0)).join(','), raw.join(','));

  // -- the PDF itself ---------------------------------------------------------------------------------------
  const pdfBytes = pdfFromPages([
    { bytes: bin([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xd9]), width: canvasW, height: capH },
    { bytes: bin([0xff, 0xd8, 9, 9, 9, 0xd9]), width: canvasW, height: 900 },
  ]);
  const pdf = Buffer.from(pdfBytes).toString('latin1');
  assert.ok(pdf.startsWith('%PDF-1.4'), 'a PDF header');
  assert.ok(pdf.includes('/Type /Catalog'), 'a catalog');
  assert.ok(pdf.includes('/Count 2'), 'two pages');
  assert.ok(pdf.includes('/MediaBox [0 0 842 595]'), 'A4 landscape');
  assert.ok(pdf.includes('/Filter /DCTDecode'), 'the page image is a JPEG');
  assert.ok(pdf.includes('Page 1 of 2') && pdf.includes('Page 2 of 2'), 'page numbers');
  assert.ok(pdf.includes(bin([0xff, 0xd8, 0xff, 0xe0])), 'the JPEG bytes are embedded verbatim');
  assert.ok(pdf.trimEnd().endsWith('%%EOF'), 'an end of file marker');

  const xref = /xref\n0 (\d+)\n/.exec(pdf);
  assert.ok(xref, 'an xref table');
  const size = Number(xref[1]);
  const start = xref.index + xref[0].length;
  assert.strictEqual(pdf.slice(start, start + 20), '0000000000 65535 f \n', 'the free entry');
  for (let num = 1; num < size; num++) {
    const entry = pdf.slice(start + num * 20, start + (num + 1) * 20);
    assert.ok(/^\d{10} 00000 n \n$/.test(entry), `xref entry ${num}: ${JSON.stringify(entry)}`);
    assert.ok(pdf.startsWith(`${num} 0 obj`, Number(entry.slice(0, 10))), `object ${num} sits at its xref offset`);
  }
  const trailer = /startxref\n(\d+)\n%%EOF\s*$/.exec(pdf);
  assert.ok(trailer, 'a trailer with startxref');
  assert.ok(pdf.startsWith('xref', Number(trailer[1])), 'startxref points at the xref table');
  assert.ok(pdf.includes(`/Size ${size} /Root 1 0 R`), 'the trailer size matches the table');

  // -- the browser glue: canvas, blob, download ----------------------------------------------------------
  const pngDoc = mkDoc();
  const pngUrls = [];
  const pngName = await exportActivityList(model, 'png', {
    document: pngDoc,
    URL: { createObjectURL: (b) => { pngUrls.push(b); return `blob:png/${pngUrls.length}`; }, revokeObjectURL() {} },
    filename: 'activity-30d-2026-10-02.png',
  });
  assert.strictEqual(pngName, 'activity-30d-2026-10-02.png');
  assert.strictEqual(pngDoc.canvases.length, 2, 'one canvas to measure with, one to draw on');
  const pngCanvas = pngDoc.canvases[1];
  assert.strictEqual(pngCanvas.width, 3200, 'the image is drawn at twice the layout width');
  assert.ok(pngCanvas.height > 1000, 'the whole list fits: ' + pngCanvas.height);
  assert.deepStrictEqual(pngCanvas.blobs, ['image/png'], 'encoded as a PNG');
  assert.strictEqual(pngUrls[0].type, 'image/png');
  assert.strictEqual(pngDoc.anchors[0].download, 'activity-30d-2026-10-02.png', 'saved under the given name');
  assert.ok(pngDoc.anchors[0].clicked, 'the download was triggered');
  assert.ok(pngCanvas.ctx.texts.some((t) => t.t === 'Developer 59'), 'the drawn image holds the list');

  const pdfDoc = mkDoc();
  const pdfUrls = [];
  await exportActivityList(model, 'pdf', {
    document: pdfDoc,
    URL: { createObjectURL: (b) => { pdfUrls.push(b); return `blob:pdf/${pdfUrls.length}`; }, revokeObjectURL() {} },
    filename: 'activity-30d-2026-10-02.pdf',
  });
  const pageCanvas = pdfDoc.canvases[pdfDoc.canvases.length - 1];
  assert.ok(pageCanvas.dataUrls.includes('image/jpeg'), 'every page is exported as a JPEG');
  assert.strictEqual(pdfUrls[0].type, 'application/pdf');
  const saved = Buffer.from(await pdfUrls[0].arrayBuffer()).toString('latin1');
  assert.ok(saved.startsWith('%PDF-1.4'), 'the downloaded bytes are a real PDF');
  assert.ok(saved.includes('/DCTDecode'), 'with the rendered pages inside');
  assert.strictEqual(pdfDoc.anchors[0].download, 'activity-30d-2026-10-02.pdf');
  assert.ok(pdfDoc.anchors[0].clicked);
  assert.ok(pdfDoc.canvases.length > 2, `the list is split across ${pdfDoc.canvases.length - 1} pages`);

  console.log('export test passed');
  process.exit(0); // the download helpers leave a revoke timer behind
})().catch((err) => { console.error(err); process.exit(1); });
