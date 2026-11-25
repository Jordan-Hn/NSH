// NetSuite Helper: tidies NetSuite's packing slip before it prints (25/11/2026).
// The packing slip template draws a fixed block on top of its own Ship Date / Tracking # /
// Ship Via rows: a placeholder "Element 16" (12 pt), the order's memo (9 pt) and a
// placeholder "Message" (9 pt), all at x 346, so they overlap the real labels.
// This takes those out of the page's drawing instructions (nothing is covered up, so the
// real labels stay whole) and writes the memo again as a "Notes" row under the last row.
// Only PDFs with that "Element 16" placeholder are changed; anything else returns null.
// Needs pdf-lib (globalThis.PDFLib). Used by background.js (Auto Print button) and ship.js.

(function () {
  "use strict";

  const PDF_OPS = /\[(?:[^\]\\]|\\[\s\S])*\]\s*TJ|\((?:[^)\\]|\\[\s\S])*\)\s*Tj|[-\d.]+\s+[-\d.]+\s+Td|\/[A-Za-z0-9_]+\s+[-\d.]+\s+Tf|[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+Tm|\bBT\b/g;

  // Text of a TJ / Tj operand: the (strings) joined, PDF escapes undone.
  function textOf(op) {
    return (op.match(/\((?:[^)\\]|\\[\s\S])*\)/g) || [])
      .map((s) =>
        s
          .slice(1, -1)
          .replace(/\\([0-7]{1,3})/g, (m, o) => String.fromCharCode(parseInt(o, 8)))
          .replace(/\\([nrtbf])/g, (m, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" })[c])
          .replace(/\\([\s\S])/g, "$1")
      )
      .join("");
  }

  async function fixPackingSlip(bytes) {
    const PDFLib = globalThis.PDFLib;
    if (!PDFLib || !bytes || bytes.length < 5) return null;
    const doc = await PDFLib.PDFDocument.load(bytes);
    let changed = false;
    for (const page of doc.getPages()) {
      const contents = page.node.Contents();
      if (!contents) continue;
      const streams = contents instanceof PDFLib.PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
      let text = "";
      for (const s of streams) {
        const raw = s instanceof PDFLib.PDFRawStream ? PDFLib.decodePDFRawStream(s).decode() : s.getContents();
        let part = "";
        for (let i = 0; i < raw.length; i += 0x8000) part += String.fromCharCode.apply(null, raw.subarray(i, i + 0x8000));
        text += part + "\n";
      }
      if (!/\(Element 16\)/.test(text)) continue;

      // Walk the text, tracking where each piece is drawn.
      let x = 0, y = 0, size = 0;
      const drops = []; // [start, end] of operators to empty
      const notes = []; // memo lines to write again
      const labelYs = []; // y of the right-hand labels (Ship Date, Tracking #, ...)
      let m;
      PDF_OPS.lastIndex = 0;
      while ((m = PDF_OPS.exec(text))) {
        const k = m[0];
        let t;
        if (k === "BT") x = y = 0;
        else if ((t = k.match(/^([-\d.]+)\s+([-\d.]+)\s+Td$/))) { x += +t[1]; y += +t[2]; }
        else if ((t = k.match(/^\/\S+\s+([-\d.]+)\s+Tf$/))) size = +t[1];
        else if (/Tm$/.test(k)) { const a = k.trim().split(/\s+/); x = +a[4]; y = +a[5]; }
        else {
          const s = textOf(k).trim();
          const inBlock = x > 335 && x < 360 && y > 560 && y < 700;
          if (!inBlock) continue;
          if (size >= 11.5 && s === "Element 16") drops.push([m.index, m.index + k.length]);
          else if (size < 10.5) {
            drops.push([m.index, m.index + k.length]);
            if (s && s !== "Message") notes.push(s);
          } else if (size >= 10.5 && size < 11.5) labelYs.push(y);
        }
      }
      if (!drops.length) continue;
      let out = "";
      let at = 0;
      for (const [a, b] of drops) {
        out += text.slice(at, a) + "[]TJ";
        at = b;
      }
      out += text.slice(at);
      const bytesOut = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) bytesOut[i] = out.charCodeAt(i) & 0xff;
      page.node.set(PDFLib.PDFName.of("Contents"), doc.context.register(doc.context.flateStream(bytesOut)));

      // The memo, as its own row under the last label, wrapped into the value column.
      if (notes.length && labelYs.length) {
        const bold = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
        const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
        const safe = (s) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
        const words = safe(notes.join("  ")).split(/\s+/);
        const lines = [];
        let line = "";
        for (const w of words) {
          const tryLine = line ? line + " " + w : w;
          if (font.widthOfTextAtSize(tryLine, 9) > 118 && line) {
            lines.push(line);
            line = w;
          } else line = tryLine;
        }
        if (line) lines.push(line);
        const top = Math.min(...labelYs) - 18;
        const shown = lines.slice(0, 3);
        if (lines.length > 3) shown[2] = shown[2].replace(/\s*\S*$/, "") + "...";
        page.drawText("Notes", { x: 346, y: top, size: 11, font: bold });
        shown.forEach((l, i) => page.drawText(l, { x: 465, y: top - i * 10.5, size: 9, font }));
      }
      changed = true;
    }
    if (!changed) return null;
    return await doc.save({ useObjectStreams: false }); // plain layout so AutoPrint can read the page size
  }

  globalThis.nshFixPackingSlip = fixPackingSlip;

  // ---------- picking tickets (25/11/2026) ----------
  // The ticket's right-hand block (Memo, PO #, Carrier, Ship Via, Ship Date, Carrier
  // Instructions, Ready Freight Req..., Item Description, CARTON, Required Delivery ...) is
  // 10 pt text only 9 pt apart, and its last row lands inside the CARTON / UNITS box. Those
  // rows are taken out and drawn again a little smaller, spread evenly between Order # and
  // the top of the box. Nothing else moves, so the item table keeps its room.
  async function fixPickingTicket(bytes) {
    const PDFLib = globalThis.PDFLib;
    if (!PDFLib || !bytes || bytes.length < 5) return null;
    const doc = await PDFLib.PDFDocument.load(bytes);
    let changed = false;
    let bold = null;
    let font = null;
    for (const page of doc.getPages()) {
      const contents = page.node.Contents();
      if (!contents) continue;
      const streams = contents instanceof PDFLib.PDFArray ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
      let text = "";
      for (const s of streams) {
        const raw = s instanceof PDFLib.PDFRawStream ? PDFLib.decodePDFRawStream(s).decode() : s.getContents();
        let part = "";
        for (let i = 0; i < raw.length; i += 0x8000) part += String.fromCharCode.apply(null, raw.subarray(i, i + 0x8000));
        text += part + "\n";
      }
      // (Text is split up for letter spacing, e.g. [(Or)20(der #)], so check the decoded words below.)
      // The CARTON / UNITS box: the wide rectangle on the right under the block.
      let boxTop = null;
      const RECT = /([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+re\b/g;
      let r;
      while ((r = RECT.exec(text))) {
        const [x, y, w, h] = [+r[1], +r[2], +r[3], +r[4]];
        if (x > 330 && x < 365 && w > 150 && h > 40 && y > 450) boxTop = Math.max(boxTop || 0, y + h);
      }
      if (!boxTop) continue;
      let x = 0, y = 0, size = 0;
      let orderY = null;
      let isTicket = false;
      const items = []; // { start, end, x, y, s }
      let m;
      PDF_OPS.lastIndex = 0;
      while ((m = PDF_OPS.exec(text))) {
        const k = m[0];
        let t;
        if (k === "BT") x = y = 0;
        else if ((t = k.match(/^([-\d.]+)\s+([-\d.]+)\s+Td$/))) { x += +t[1]; y += +t[2]; }
        else if ((t = k.match(/^\/\S+\s+([-\d.]+)\s+Tf$/))) size = +t[1];
        else if (/Tm$/.test(k)) { const a = k.trim().split(/\s+/); x = +a[4]; y = +a[5]; }
        else {
          const s = textOf(k).trim();
          if (s === "Order #" && x > 330) orderY = y;
          if (s === "Picking Ticket") isTicket = true;
          if (x > 330 && size > 0 && size < 10.5) items.push({ start: m.index, end: m.index + k.length, x, y, s });
        }
      }
      if (orderY == null || !isTicket) continue;
      // The block: below Order #, down to just inside the box.
      const block = items.filter((it) => it.y < orderY - 4 && it.y > boxTop - 14);
      if (!block.length) continue;
      // Rows by height; in each, the first piece is the label, the rest its value.
      const rows = [];
      block.forEach((it) => {
        let row = rows.find((rw) => Math.abs(rw.y - it.y) < 1.5);
        if (!row) rows.push((row = { y: it.y, label: "", value: [] }));
        if (!row.label && it.x < 400) row.label = it.s;
        else row.value.push(it.s);
      });
      rows.sort((a, b) => b.y - a.y);
      const lowest = rows[rows.length - 1].y;
      if (lowest > boxTop + 2 && rows.every((rw, i) => !i || rows[i - 1].y - rw.y >= 10)) continue; // nothing hidden or touching
      // Take the old rows out.
      let out = "";
      let at = 0;
      block.sort((a, b) => a.start - b.start).forEach((it) => {
        out += text.slice(at, it.start) + "[]TJ";
        at = it.end;
      });
      out += text.slice(at);
      const bytesOut = new Uint8Array(out.length);
      for (let i = 0; i < out.length; i++) bytesOut[i] = out.charCodeAt(i) & 0xff;
      page.node.set(PDFLib.PDFName.of("Contents"), doc.context.register(doc.context.flateStream(bytesOut)));
      // And draw them again, evenly between Order # and the box.
      bold = bold || (await doc.embedFont(PDFLib.StandardFonts.HelveticaBold));
      font = font || (await doc.embedFont(PDFLib.StandardFonts.Helvetica));
      const safe = (s) => s.replace(/\\\(/g, "(").replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
      // Rows with nothing in them (e.g. an empty Memo or Carrier) are left out (25/11/2026),
      // so the rest get more room.
      const shown = rows.filter((rw) => rw.value.join("").trim());
      const top = orderY - 12;
      const bottom = boxTop + 5;
      const step = shown.length > 1 ? Math.min(11, (top - bottom) / (shown.length - 1)) : 0;
      const size2 = Math.max(6, Math.min(9.5, step * 0.85 || 9.5));
      shown.forEach((rw, i) => {
        const yy = top - i * step;
        if (rw.label) page.drawText(safe(rw.label), { x: 347, y: yy, size: size2, font: bold });
        if (rw.value.length) {
          let v = safe(rw.value.join(" "));
          while (v.length > 3 && font.widthOfTextAtSize(v, size2) > 135) v = v.slice(0, -4) + "...";
          page.drawText(v, { x: 455, y: yy, size: size2, font });
        }
      });
      changed = true;
    }
    if (!changed) return null;
    return await doc.save({ useObjectStreams: false });
  }
  globalThis.nshFixPickingTicket = fixPickingTicket;
})();
