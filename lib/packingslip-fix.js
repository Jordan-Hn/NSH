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
})();
