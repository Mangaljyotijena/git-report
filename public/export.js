// Export of the Activity developer list to PNG and PDF, dependency free: the list is drawn on a
// canvas, and every PDF page embeds one canvas slice as a JPEG inside a hand-built A4 file.
// Shared by the browser (window.exportActivityList) and by test/export.js.
(function (root) {
  'use strict';

  const EX = {
    baseWidth: 1600, // layout units; every size is multiplied by the chosen scale
    pad: 36,
    gut: 6,
    rowH: 46,
    totalsH: 46,
    headFull: 190,
    headCompact: 110,
    footGap: 24,
    footLine: 18,
    bottomPad: 30,
    page: { w: 842, h: 595, margin: 24 }, // A4 landscape in points
    pngScale: 2,
    pdfScale: 1.5,
    quality: 0.9,
    font: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    colors: {
      panel: '#ffffff', alt: '#f8f9fc', text: '#101828', muted: '#667085',
      line: '#e6e9f1', soft: '#f2f4f7', track: '#edf0f7', accent: '#4f46e5',
      add: '#12a05f', del: '#e0443c',
    },
  };

  const f = (weight, size, s) => `${weight} ${Math.round(size * s * 10) / 10}px ${EX.font}`;
  const measureWith = (ctx, text, font) => { ctx.font = font; return ctx.measureText(text).width; };

  function wrapLines(text, maxWidth, measure) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = '';
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (cur && measure(next) > maxWidth) { lines.push(cur); cur = w; } else cur = next;
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function activityMetrics(model, scale = 1) {
    const s = scale;
    const W = Math.round(EX.baseWidth * s);
    const pad = Math.round(EX.pad * s);
    const contentW = W - pad * 2;
    const declared = (model.columns || []).reduce((n, c) => n + (c.w || 0), 0) || 1;
    const k = contentW / declared;
    let x = pad;
    const cols = (model.columns || []).map((c) => {
      const w = (c.w || 0) * k;
      const col = { label: c.label || '', align: c.align === 'right' ? 'right' : 'left', x, w };
      x += w;
      return col;
    });
    return {
      s, W, pad, contentW, cols,
      rowH: EX.rowH * s, totalsH: EX.totalsH * s, bottomPad: EX.bottomPad * s,
      headFull: EX.headFull * s, headCompact: EX.headCompact * s,
      footGap: EX.footGap * s, footLine: EX.footLine * s, gut: EX.gut * s,
      fonts: {
        title: f(700, 30, s), titleSm: f(700, 24, s), ctx: f(400, 15, s), ctxSm: f(400, 13, s),
        total: f(600, 16, s), col: f(650, 12, s), name: f(600, 15, s), sub: f(400, 11.5, s),
        cell: f(400, 14, s), cellB: f(600, 14, s), foot: f(400, 12, s),
      },
      y: {
        title: 50 * s, ctx1: 80 * s, ctx2: 102 * s, totals: 136 * s, rule1: 154 * s, col: 180 * s,
        cTitle: 44 * s, cCtx: 72 * s, cCol: 98 * s,
        name: 21 * s, sub: 38 * s, cell: 28 * s,
      },
    };
  }

  function footLines(model, m, ctx) {
    if (!model.footnote) return [];
    return wrapLines(model.footnote, m.contentW, (t) => measureWith(ctx, t, m.fonts.foot));
  }

  // Height the caller must give the canvas before drawing those options.
  function activityHeight(model, opts = {}, ctx = null, scale = 1) {
    const m = activityMetrics(model, scale);
    const rows = model.rows || [];
    const to = opts.to == null ? rows.length : opts.to;
    const n = Math.max(0, to - (opts.from || 0));
    let end = (opts.head === 'compact' ? m.headCompact : m.headFull) + n * m.rowH;
    if (opts.totals && model.totals) end += m.totalsH;
    if (opts.foot && model.footnote && ctx) {
      const lines = footLines(model, m, ctx);
      if (lines.length) end += m.footGap + lines.length * m.footLine;
    }
    return Math.ceil(end + m.bottomPad);
  }

  const fit = (ctx, text, font, maxW) => {
    ctx.font = font;
    if (ctx.measureText(text).width <= maxW) return text;
    let out = String(text);
    while (out.length > 1 && ctx.measureText(`${out}…`).width > maxW) out = out.slice(0, -1);
    return `${out}…`;
  };

  const roundRect = (ctx, x, y, w, h, r) => {
    if (typeof ctx.roundRect === 'function') { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill(); return; }
    ctx.fillRect(x, y, w, h);
  };

  const text = (ctx, str, x, y, font, color) => {
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(str, x, y);
  };

  const rule = (ctx, x, y, w, color) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, 1);
  };

  function columnHeaders(ctx, m, baseline) {
    ctx.letterSpacing = `${Math.round(0.07 * 12 * m.s * 10) / 10}px`;
    for (const col of m.cols) {
      const right = col.align === 'right';
      ctx.textAlign = right ? 'right' : 'left';
      ctx.font = m.fonts.col;
      ctx.fillStyle = EX.colors.muted;
      ctx.fillText(col.label.toUpperCase(), right ? col.x + col.w - m.gut : col.x, baseline);
    }
    ctx.letterSpacing = '0px';
  }

  function drawCells(ctx, m, cells, top, bold) {
    const C = EX.colors;
    const font = bold ? m.fonts.cellB : m.fonts.cell;
    const baseline = top + m.y.cell;
    m.cols.forEach((col, ci) => {
      const cell = (cells || [])[ci] || {};
      const right = col.align === 'right';
      const x = right ? col.x + col.w - m.gut : col.x;
      const width = col.w - m.gut;
      if (cell.bar != null) {
        const pct = Math.max(0, Math.min(100, Number(cell.bar) || 0));
        const label = cell.text != null ? String(cell.text) : `${Math.round(pct)}%`;
        ctx.font = font;
        const labelW = ctx.measureText(label).width;
        const barMax = Math.max(24 * m.s, width - labelW - 14 * m.s);
        const barX = x - labelW - 14 * m.s - barMax;
        const barY = top + (m.rowH - 8 * m.s) / 2;
        ctx.fillStyle = C.track;
        roundRect(ctx, barX, barY, barMax, 8 * m.s, 4 * m.s);
        if (barMax * pct > 0) {
          ctx.fillStyle = C.accent;
          if (typeof ctx.createLinearGradient === 'function') {
            const g = ctx.createLinearGradient(barX, 0, barX + barMax, 0);
            g.addColorStop(0, C.accent);
            g.addColorStop(1, '#7c3aed');
            ctx.fillStyle = g;
          }
          roundRect(ctx, barX, barY, Math.max(3 * m.s, barMax * pct / 100), 8 * m.s, 4 * m.s);
        }
        ctx.font = font;
        ctx.fillStyle = C.text;
        ctx.textAlign = 'right';
        ctx.fillText(label, x, baseline);
        return;
      }
      if (cell.parts && cell.parts.length) {
        ctx.font = font;
        const widths = cell.parts.map((p) => ctx.measureText(p.text).width);
        const total = widths.reduce((n, w) => n + w, 0);
        let cx = right ? x - total : x;
        cell.parts.forEach((p, i) => {
          ctx.fillStyle = p.color ? (EX.colors[p.color] || p.color) : C.text;
          ctx.textAlign = 'left';
          ctx.fillText(p.text, cx, baseline);
          cx += widths[i];
        });
        return;
      }
      if (cell.text == null && cell.sub == null) return;
      if (cell.sub != null) {
        const head = cell.text == null ? '' : fit(ctx, String(cell.text), m.fonts.name, width);
        if (head) text(ctx, head, x, top + m.y.name, m.fonts.name, C.text);
        text(ctx, fit(ctx, String(cell.sub), m.fonts.sub, width), x, top + m.y.sub, m.fonts.sub, C.muted);
        return;
      }
      ctx.font = font;
      ctx.fillStyle = C.text;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.fillText(String(cell.text), x, baseline);
    });
    ctx.textAlign = 'left';
  }

  // Draws one slice of the list. The canvas must already be `activityHeight(...)` tall.
  function drawActivity(ctx, model, opts = {}) {
    const scale = opts.scale || 1;
    const m = activityMetrics(model, scale);
    const rows = model.rows || [];
    const from = opts.from || 0;
    const to = opts.to == null ? rows.length : opts.to;
    const C = EX.colors;
    const height = opts.height || activityHeight(model, opts, ctx, scale);
    const compact = opts.head === 'compact';

    ctx.fillStyle = C.panel;
    ctx.fillRect(0, 0, m.W, height);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    if (compact) {
      text(ctx, `${model.title || 'Recent activity'} · continued`, m.pad, m.y.cTitle, m.fonts.titleSm, C.text);
      if (model.context && model.context[0]) text(ctx, model.context[0], m.pad, m.y.cCtx, m.fonts.ctxSm, C.muted);
      columnHeaders(ctx, m, m.y.cCol);
    } else {
      text(ctx, model.title || 'Recent activity', m.pad, m.y.title, m.fonts.title, C.text);
      (model.context || []).slice(0, 2).forEach((line, i) => text(ctx, line, m.pad, i === 0 ? m.y.ctx1 : m.y.ctx2, m.fonts.ctx, C.muted));
      if (model.totalsLine) text(ctx, model.totalsLine, m.pad, m.y.totals, m.fonts.total, C.accent);
      rule(ctx, m.pad, m.y.rule1, m.contentW, C.line);
      columnHeaders(ctx, m, m.y.col);
    }

    let top = compact ? m.headCompact : m.headFull;
    for (let i = from; i < to; i++) {
      const row = rows[i] || { cells: [] };
      if ((i - from) % 2 === 1) { ctx.fillStyle = C.alt; ctx.fillRect(m.pad, top, m.contentW, m.rowH); }
      drawCells(ctx, m, row.cells, top, false);
      rule(ctx, m.pad, top + m.rowH, m.contentW, C.soft);
      top += m.rowH;
    }

    if (opts.totals && model.totals) {
      ctx.fillStyle = C.alt;
      ctx.fillRect(m.pad, top, m.contentW, m.totalsH);
      rule(ctx, m.pad, top, m.contentW, C.line);
      drawCells(ctx, m, model.totals, top, true);
      top += m.totalsH;
    }

    if (opts.foot && model.footnote && ctx) {
      const lines = footLines(model, m, ctx);
      if (lines.length) {
        const start = top + m.footGap;
        lines.forEach((line, i) => text(ctx, line, m.pad, start + (i + 1) * m.footLine, m.fonts.foot, C.muted));
        top = start + lines.length * m.footLine;
      }
    }
    return top + m.bottomPad;
  }

  // Splits the rows into pages that each fit `capH` canvas pixels. The totals and the footnote share
  // the final page, which gets a fair share of the remaining rows instead of ending up as a stub.
  function planActivityPages(model, capH, ctx, scale = 1) {
    const rows = model.rows || [];
    const n = rows.length;
    const fits = (opts) => activityHeight(model, opts, ctx, scale) <= capH;
    if (!n) return [{ from: 0, to: 0, head: 'full', totals: true, foot: true }];
    // Rows that fit on a page of that kind (row heights are uniform, so the rows chosen do not matter).
    const capacity = (head, totals, foot) => {
      let k = 0;
      while (k < n && fits({ from: 0, to: k + 1, head, totals, foot })) k++;
      return k;
    };
    const capLast = Math.max(1, capacity('compact', true, true));
    const pages = [];
    let i = 0;
    let first = true;
    while (i < n) {
      const remaining = n - i;
      const head = first ? 'full' : 'compact';
      const cap = Math.max(1, first ? capacity('full', false, false) : capacity('compact', false, false));
      const capT = Math.max(1, first ? capacity('full', true, true) : capLast);
      if (remaining <= cap && remaining <= capT) {
        pages.push({ from: i, to: n, head, totals: true, foot: true });
        break;
      }
      let count = Math.min(cap, remaining);
      const left = remaining - count;
      if (left === 0) {
        // Every remaining row fits only without the totals: save them for a final page that has them.
        const want = Math.min(capT, Math.floor(remaining / 2));
        count = Math.max(1, remaining - want);
      } else if (left < Math.ceil(capLast / 2)) {
        // Do not leave a stub for the totals: share the remainder with this page instead.
        const want = Math.min(capLast, Math.floor(remaining / 2));
        if (remaining - want >= 1 && remaining - want <= cap) count = remaining - want;
      }
      pages.push({ from: i, to: i + count, head, totals: false, foot: false });
      i += count;
      first = false;
    }
    return pages;
  }

  // base64 -> binary string (one character per byte), without relying on atob or Buffer.
  function b64ToBin(b64) {
    const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let out = '';
    let buf = 0;
    let bits = 0;
    for (const ch of String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '')) {
      const v = table.indexOf(ch);
      if (v < 0) continue;
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out += String.fromCharCode((buf >> bits) & 0xff);
        buf &= (1 << bits) - 1;
      }
    }
    return out;
  }

  // Pages: [{ bytes: binary string, width, height }] -> a complete PDF file.
  function pdfFromPages(pages, opts = {}) {
    const pageW = opts.pageW || EX.page.w;
    const pageH = opts.pageH || EX.page.h;
    const margin = opts.margin == null ? EX.page.margin : opts.margin;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;
    const chunks = [];
    let len = 0;
    const put = (s) => { chunks.push(s); len += s.length; };
    const offsets = [];
    const count = pages.length;
    const fontNum = 3 + count * 3;
    const write = (num, body) => { offsets[num] = len; put(`${num} 0 obj\n${body}\nendobj\n`); };

    put('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    write(1, '<< /Type /Catalog /Pages 2 0 R >>');
    write(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')}] /Count ${count} >>`);
    pages.forEach((p, i) => {
      const pageN = 3 + i * 3;
      const contentN = pageN + 1;
      const imgN = pageN + 2;
      const k = Math.min(usableW / p.width, usableH / p.height);
      const dw = p.width * k;
      const dh = p.height * k;
      const x = margin + (usableW - dw) / 2;
      const y = margin + (usableH - dh) / 2;
      const label = `Page ${i + 1} of ${count}`;
      const tx = (pageW - label.length * 4.6) / 2;
      const content = `q\n${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im${i} Do\nQ\n`
        + `BT /F1 9 Tf 0.42 0.44 0.50 rg ${tx.toFixed(2)} ${(margin - 13).toFixed(2)} Td (${label}) Tj ET\n`;
      write(imgN, `<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB`
        + ` /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n${p.bytes}endstream`);
      write(contentN, `<< /Length ${content.length} >>\nstream\n${content}endstream`);
      write(pageN, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}]`
        + ` /Resources << /XObject << /Im${i} ${imgN} 0 R >> /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentN} 0 R >>`);
    });
    write(fontNum, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

    const size = fontNum + 1;
    const xrefAt = len;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let num = 1; num < size; num++) xref += `${String(offsets[num]).padStart(10, '0')} 00000 n \n`;
    put(xref);
    put(`trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);

    const all = chunks.join('');
    const out = new Uint8Array(all.length);
    for (let i = 0; i < all.length; i++) out[i] = all.charCodeAt(i) & 0xff;
    return out;
  }

  const toBlob = (canvas, type) => new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The browser could not encode the image'))), type);
    } catch (err) { reject(err); }
  });

  function downloadBlob(blob, filename, deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const urlApi = deps.URL || (typeof URL !== 'undefined' ? URL : null);
    const url = urlApi.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    (doc.body || doc.documentElement).appendChild(a);
    a.click();
    if (typeof a.remove === 'function') a.remove();
    else if (a.parentNode) a.parentNode.removeChild(a);
    setTimeout(() => { try { urlApi.revokeObjectURL(url); } catch (_) { /* already gone */ } }, 4000);
    return filename;
  }

  // kind: 'png' | 'pdf'. Resolves with the filename that was saved.
  async function exportActivityList(model, kind, deps = {}) {
    const doc = deps.document || (typeof document !== 'undefined' ? document : null);
    const urlApi = deps.URL || (typeof URL !== 'undefined' ? URL : null);
    const BlobCtor = deps.Blob || (typeof Blob !== 'undefined' ? Blob : null);
    if (!doc || typeof doc.createElement !== 'function') throw new Error('Exporting needs a browser');
    const scratch = doc.createElement('canvas');
    const measureCtx = scratch.getContext('2d');
    const filename = deps.filename || `activity-export.${kind === 'pdf' ? 'pdf' : 'png'}`;
    let blob;

    if (kind === 'pdf') {
      const scale = EX.pdfScale;
      const canvasW = Math.round(EX.baseWidth * scale);
      const usableW = EX.page.w - EX.page.margin * 2;
      const usableH = EX.page.h - EX.page.margin * 2;
      const capH = Math.floor((usableH * canvasW) / usableW);
      const pages = planActivityPages(model, capH, measureCtx, scale).map((p) => {
        const height = activityHeight(model, p, measureCtx, scale);
        const c = doc.createElement('canvas');
        c.width = canvasW;
        c.height = height;
        drawActivity(c.getContext('2d'), model, { ...p, scale, height });
        const dataUrl = c.toDataURL('image/jpeg', EX.quality);
        return { bytes: b64ToBin(String(dataUrl).split(',')[1] || ''), width: canvasW, height };
      });
      if (!BlobCtor) throw new Error('This browser cannot build the PDF');
      blob = new BlobCtor([pdfFromPages(pages)], { type: 'application/pdf' });
    } else {
      const scale = EX.pngScale;
      const opts = { head: 'full', from: 0, to: (model.rows || []).length, totals: true, foot: true, scale };
      const height = activityHeight(model, opts, measureCtx, scale);
      const c = doc.createElement('canvas');
      c.width = Math.round(EX.baseWidth * scale);
      c.height = height;
      drawActivity(c.getContext('2d'), model, { ...opts, height });
      blob = await toBlob(c, 'image/png');
    }

    downloadBlob(blob, filename, { document: doc, URL: urlApi });
    return filename;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      EX, wrapLines, activityMetrics, activityHeight, drawActivity, planActivityPages,
      b64ToBin, pdfFromPages, downloadBlob, exportActivityList,
    };
  } else {
    root.exportActivityList = exportActivityList;
  }
})(this);
