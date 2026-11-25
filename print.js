// NetSuite Helper: bulk print picking tickets.
//
// Runs on Shipping > Print Picking Tickets, in the page's own world (needs
// NetSuite's nlapiSearchRecord, and pdf-lib from lib/pdf-lib.min.js).
//
// Paste TO or SO numbers. Each ticket is fetched exactly as the order's own
// "Print Picking Ticket" button makes it (same form, same location), then all
// are joined into one PDF in pasted order, ready to print in one go.
// Printing a ticket marks the order "Picking Ticket Printed", the same as
// printing it by hand (the SOP's "Not Printed" search relies on this).

(function () {
  "use strict";

  // On the Bulk Waves pages this file only lends its ticket code (window.__nshTickets);
  // its own panel only appears on Print Picking Tickets.
  const ON_WAVE_PAGES = /\/wms\/orderrelease\/searchform\/searchorders\.nl|\/transactions\/wave\.nl/.test(location.pathname);
  if (!/pickingticket/.test(location.search) && !ON_WAVE_PAGES) return;

  const PREFILL_KEY = "nshPrintPrefill"; // list handed over from bulk waves
  const LOCATION_ID = "377"; // KBH Warehouse, as the record buttons use
  const TYPES = { TO: { search: "TrnfrOrd", tran: "trnfrord", page: "trnfrord.nl" }, SO: { search: "SalesOrd", tran: "salesord", page: "salesord.nl" } };

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  const STATES = ["VIC", "NSW", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
  const COURIERS = { CHILL: "CHILL", STE: "STE", STP: "STP", FW: "FW", FREEWAY: "FW", PICKUP: "PICKUP", "PICK UP": "PICKUP", PU: "PICKUP" };

  // Accepts a plain list (TO/SO numbers) or whole rows copied from a tracker.
  // From a row with one order number it also keeps the courier and state, for
  // the code stamped on corporate tickets. Dates, names, counts etc. are ignored.
  function parseOrders(text) {
    const seen = new Set();
    const good = [];
    const bad = [];
    const dupes = [];
    const rows = {};
    const add = (o) => {
      if (seen.has(o)) {
        if (!dupes.includes(o)) dupes.push(o);
        return false;
      }
      seen.add(o);
      good.push(o);
      return true;
    };
    // Tracker rows pasted without a line break between them ("...7CTNS SO427203 ..."):
    // split before every order number after the first, so each keeps its own courier and
    // state (25/11/2026). Plain lists with several numbers on a line are left alone.
    const splitJoined = (line) => {
      if (!/\t/.test(line)) return [line];
      const starts = [];
      const re = /(?:^|[\s,;])((?:SO|TO)\d{5,})(?=\s|$)/gi;
      let m;
      while ((m = re.exec(line))) starts.push(m.index + m[0].length - m[1].length);
      if (starts.length < 2) return [line];
      return starts.map((s, i) => line.slice(i ? s : 0, starts[i + 1] === undefined ? line.length : starts[i + 1]).replace(/[\s,;]+$/, ""));
    };
    text.split(/\r?\n/).flatMap(splitJoined).forEach((line) => {
      const up = line.toUpperCase();
      const orders = up.match(/\b(TO|SO)\d+\b/g) || [];
      if (!orders.length) {
        // A lone word on a line is probably a mistyped number; full rows without one (headers, dividers) are skipped quietly.
        const t = up.trim();
        if (t && !/[\t ]/.test(t)) bad.push(t);
        return;
      }
      if (orders.length > 1 || !/\t/.test(line)) {
        // A plain list (one or more numbers per line). Flag anything else that looks like a typo.
        up.split(/[\s,;]+/).filter(Boolean).forEach((t) => {
          if (/^(TO|SO)\d+$/.test(t)) add(t);
          else if (orders.length > 1 || /^[A-Z]{1,3}\d+$/.test(t)) bad.push(t);
        });
        return;
      }
      // A tracker row: cells are separated by tabs. Courier and state are whole cells.
      const order = orders[0];
      const cells = up.split("\t").map((c) => c.trim());
      // The tracker's STATE column can say MULTIDROP instead of a state.
      const multi = cells.some((c) => /^MULTI[\s-]?DROP$/.test(c));
      const state = multi ? "MULTIDROP" : cells.find((c) => STATES.includes(c)) || "";
      const courierCell = cells.find((c) => COURIERS[c]);
      if (add(order)) rows[order] = { state, courier: courierCell ? COURIERS[courierCell] : "" };
    });
    return { good, bad, dupes, rows };
  }

  // The code the SOP has written on a corporate ticket (SOP 1, "Mark the picking ticket").
  function courierCode(row) {
    if (!row) return "";
    // Multidrop orders get MULTIDROP whatever the courier (23/11/2026).
    if (row.state === "MULTIDROP") return "MULTIDROP";
    if (!row.courier) return "";
    if (row.courier === "CHILL") return row.state === "ACT" ? "NSW" : row.state;
    if (row.courier === "STE" || row.courier === "STP") return "ST";
    if (row.courier === "FW") return "FW";
    if (row.courier === "PICKUP") return "PU";
    return "";
  }

  // NetSuite's ship-to state (short or full name) as the CHILL code: VIC, NSW...
  // ACT ships with NSW, as in the SOP.
  const STATE_NAMES = {
    VIC: "VIC", VICTORIA: "VIC", NSW: "NSW", "NEW SOUTH WALES": "NSW", QLD: "QLD", QUEENSLAND: "QLD",
    WA: "WA", "WESTERN AUSTRALIA": "WA", SA: "SA", "SOUTH AUSTRALIA": "SA", TAS: "TAS", TASMANIA: "TAS",
    ACT: "NSW", "AUSTRALIAN CAPITAL TERRITORY": "NSW", NT: "NT", "NORTHERN TERRITORY": "NT",
  };
  function stateCode(s) {
    return STATE_NAMES[String(s || "").trim().toUpperCase()] || "";
  }

  // How the stamp reads (for the check screen); on the ticket "WAVE:" is small.
  function stampText(s) {
    return [s.wave ? "WAVE: " + s.wave : "NO WAVE", s.code].filter(Boolean).join("    ");
  }

  // Look up each order: internal id, custom form, and whether its ticket was printed.
  function lookup(orders) {
    const info = {};
    for (let i = 0; i < orders.length; i += 50) {
      const chunk = orders.slice(i, i + 50);
      const any = [];
      chunk.forEach((o, j) => {
        if (j) any.push("OR");
        any.push(["tranid", "is", o]);
      });
      const base = [any, "AND", ["mainline", "is", "T"], "AND", ["type", "anyof", ["TrnfrOrd", "SalesOrd"]]];
      const cols = [
        new window.nlobjSearchColumn("tranid"),
        new window.nlobjSearchColumn("customform"),
        new window.nlobjSearchColumn("type"),
        new window.nlobjSearchColumn("transferlocation"),
        new window.nlobjSearchColumn("shipstate"),
      ];
      (window.nlapiSearchRecord("transaction", null, base, cols) || []).forEach((r) => {
        const o = (r.getValue("tranid") || "").toUpperCase();
        const want = TYPES[o.slice(0, 2)];
        if (!chunk.includes(o) || !want || r.getValue("type") !== want.search) return;
        info[o] = {
          id: r.getId(),
          form: r.getValue("customform") || "",
          printed: false,
          store: r.getText("transferlocation") || "",
          state: r.getValue("shipstate") || "",
          wave: "",
        };
      });
      // "Picking Ticket Printed" only works as a filter, so ask which are printed.
      (window.nlapiSearchRecord("transaction", null, base.concat(["AND", ["printedpickingticket", "is", "T"]]), [new window.nlobjSearchColumn("tranid")]) || []).forEach((r) => {
        const o = (r.getValue("tranid") || "").toUpperCase();
        if (info[o]) info[o].printed = true;
      });
    }
    // Each order's wave: the newest (highest number) wave that holds it.
    const byId = {};
    Object.keys(info).forEach((o) => (byId[info[o].id] = o));
    const ids = Object.keys(byId);
    for (let i = 0; i < ids.length; i += 20) {
      (window.nlapiSearchRecord(
        "transaction",
        null,
        [["type", "anyof", "Wave"], "AND", ["appliedtotransaction", "anyof", ids.slice(i, i + 20)]],
        [new window.nlobjSearchColumn("tranid"), new window.nlobjSearchColumn("appliedtotransaction")]
      ) || []).forEach((r) => {
        const o = byId[r.getValue("appliedtotransaction")];
        const w = r.getValue("tranid");
        if (o && /^\d+$/.test(w) && Number(w) > Number(info[o].wave || 0)) info[o].wave = w;
      });
    }
    return info;
  }

  // What goes on each ticket, from the SOPs (delivery date stays handwritten):
  //   corporate SO: wave number + courier/state code (e.g. "WAVE 49870   VIC").
  //     From a tracker row if pasted; otherwise the ship-to state from NetSuite
  //     (the CHILL code), which can be changed to ST/FW/PU on the check screen.
  //   retail TO:    wave number + which of the store's TOs in this batch (e.g. "WAVE 50101   1/5")
  // Returns { order: { wave, code, from } }, from = "tracker" | "netsuite" | "count".
  function buildStamps(orders, info, rows) {
    const stamps = {};
    const storeCount = {};
    orders.forEach((o) => {
      if (o.startsWith("TO")) storeCount[info[o].store] = (storeCount[info[o].store] || 0) + 1;
    });
    const storeSeen = {};
    orders.forEach((o) => {
      const rec = info[o];
      if (o.startsWith("TO")) {
        storeSeen[rec.store] = (storeSeen[rec.store] || 0) + 1;
        stamps[o] = { wave: rec.wave, code: storeSeen[rec.store] + "/" + storeCount[rec.store], from: "count" };
      } else if (rows[o] && courierCode(rows[o])) {
        stamps[o] = { wave: rec.wave, code: courierCode(rows[o]), from: "tracker" };
      } else {
        stamps[o] = { wave: rec.wave, code: stateCode(rec.state), from: "netsuite" };
      }
    });
    return stamps;
  }

  // The form the order's own print button uses. Sales orders give it in the
  // search; transfer orders don't, so read it from the order's page.
  async function formFor(order, rec) {
    if (rec.form) return rec.form;
    const html = await (await fetch("/app/accounting/transactions/" + TYPES[order.slice(0, 2)].page + "?id=" + encodeURIComponent(rec.id), { credentials: "include" })).text();
    const m = html.match(/hotprint\.nl\?regular=T&sethotprinter=T&formnumber=(\d+)&trantype=/);
    if (!m) throw new Error("couldn't find its picking ticket form");
    return m[1];
  }

  async function fetchTicket(order, rec) {
    const form = await formFor(order, rec);
    const url =
      "/app/accounting/print/hotprint.nl?regular=T&sethotprinter=T&formnumber=" + encodeURIComponent(form) +
      "&trantype=" + TYPES[order.slice(0, 2)].tran + "&id=" + encodeURIComponent(rec.id) +
      "&label=Picking+Ticket&printtype=pickingticket&location=" + LOCATION_ID;
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error("NetSuite answered " + resp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("NetSuite didn't send a PDF (logged out?)");
    // Tidy the crowded header block (lib/packingslip-fix.js); any problem = the ticket as NetSuite made it.
    try {
      const tidy = window.nshFixPickingTicket && (await window.nshFixPickingTicket(bytes));
      if (tidy) return tidy;
    } catch (e) {
      console.warn("[NetSuite Helper] ticket tidy skipped", e);
    }
    return bytes;
  }

  // stamps[i] = text for part i's first page ("" = none). It goes in the empty
  // strip across the top right of the ticket, above "Picking Ticket" (checked
  // on both the TO and SO ticket forms), so it never covers anything.
  // Baseline (PDF units, from the bottom) of the last line of the "Ship To"
  // address on a ticket page, read from the page's own text. The address is
  // 4 to 6 lines, so this moves. null = not found (caller falls back).
  function shipToBottom(doc, page) {
    const L = window.PDFLib;
    let streams = page.node.Contents();
    if (!streams) return null;
    streams = streams instanceof L.PDFArray ? streams.asArray() : [streams];
    let src = "";
    for (const ref of streams) {
      const s = doc.context.lookup(ref);
      if (!s) continue;
      const bytes = s instanceof L.PDFRawStream ? L.decodePDFRawStream(s).decode() : s.getContents();
      for (let k = 0; k < bytes.length; k++) src += String.fromCharCode(bytes[k]);
      src += "\n";
    }
    const tok = /\[(?:\((?:\\.|[^\\)])*\)|[^\]])*\]|\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|\/[^\s\/\[\]()<>]+|-?\d*\.?\d+|[A-Za-z'"*]+/g;
    const textOf = (t) => (t.match(/\((?:\\.|[^\\)])*\)/g) || []).map((x) => x.slice(1, -1).replace(/\\(.)/g, "$1")).join("");
    let nums = [], strs = [], x = 0, y = 0, lead = 0;
    let ship = null, last = null;
    let m;
    while ((m = tok.exec(src))) {
      const t = m[0];
      if (/^-?\d*\.?\d+$/.test(t)) { nums.push(Number(t)); continue; }
      if (t[0] === "[" || t[0] === "(" || t[0] === "<" || t[0] === "/") { if (t[0] !== "/") strs.push(t); continue; }
      if (t === "BT") { x = 0; y = 0; }
      else if (t === "Td" || t === "TD") { x += nums[nums.length - 2]; y += nums[nums.length - 1]; if (t === "TD") lead = -nums[nums.length - 1]; }
      else if (t === "Tm") { x = nums[nums.length - 2]; y = nums[nums.length - 1]; }
      else if (t === "TL") { lead = nums[nums.length - 1]; }
      else if (t === "T*") { y -= lead; }
      else if (t === "Tj" || t === "TJ") {
        const text = strs.map(textOf).join("").replace(/\s+/g, " ").trim();
        if (!ship && /^Ship To$/i.test(text)) { ship = { x, y }; last = null; }
        else if (ship) {
          // Address lines sit straight under "Ship To"; anything else ends it.
          if (Math.abs(x - ship.x) < 1 && y < ship.y) last = y;
          else if (last !== null) break;
        }
      }
      nums = []; strs = [];
    }
    return last;
  }

  async function mergePdfs(parts, stamps) {
    const out = await window.PDFLib.PDFDocument.create();
    const font = await out.embedFont(window.PDFLib.StandardFonts.HelveticaBold);
    for (let i = 0; i < parts.length; i++) {
      const doc = await window.PDFLib.PDFDocument.load(parts[i]);
      const pages = await out.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => out.addPage(p));
      // Stamp = { wave, code }:
      //   wave: just under the Ship To address (24/11/2026), small
      //         "WAVE:" + large number. The address is 4 to 6 lines, so its
      //         end is read from the page; if that fails, top left as before.
      //   code: top right, above "Picking Ticket" (VIC, ST, PU, MULTIDROP, 1/3...)
      // No wave yet: "NO WAVE" in its place, large (23/11/2026).
      const s = stamps && stamps[i];
      if (s && pages[0]) {
        const { width, height } = pages[0].getSize();
        const big = 22;
        const small = 10;
        const y = height - 32;
        let addr = null;
        try {
          addr = shipToBottom(doc, doc.getPages()[0]);
        } catch (err) {
          addr = null;
        }
        const wx = addr === null ? 40 : 36;
        const wy = addr === null ? y : addr - 22; // fits the 26 pt gap above the item table (6-line address)
        if (s.wave) {
          pages[0].drawText("WAVE: ", { x: wx, y: wy, size: small, font });
          pages[0].drawText(s.wave, { x: wx + font.widthOfTextAtSize("WAVE: ", small), y: wy, size: big, font });
        } else {
          pages[0].drawText("NO WAVE", { x: wx, y: wy, size: big, font });
        }
        if (s.code) {
          pages[0].drawText(s.code, { x: width - 36 - font.widthOfTextAtSize(s.code, big), y, size: big, font });
        }
      }
    }
    // Plain (not object-stream) layout so the AutoPrint helper can read the page size.
    return out.save({ useObjectStreams: false });
  }

  // ---------- panel ----------

  function getPanel() {
    let panel = document.getElementById("nsh-print-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "nsh-print-panel";
      panel.className = "nsh-wave-panel";
      panel.innerHTML =
        '<div class="nsh-fg-title" role="button" aria-expanded="true"><span class="nsh-chevron"></span><span class="nsh-fg-text"></span></div>' +
        '<div class="nsh-fg-body"></div>';
      panel.querySelector(".nsh-fg-title").onclick = () => panel.classList.toggle("nsh-collapsed");
      const anchor = document.querySelector(".uir-page-title") || document.body.firstChild;
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }
    return panel;
  }
  function fill(title, html) {
    const panel = getPanel();
    panel.querySelector(".nsh-fg-text").textContent = title;
    panel.querySelector(".nsh-fg-body").innerHTML = html;
    return panel;
  }

  let lastPdfUrl = null;

  function renderInput(text) {
    const panel = fill(
      "Bulk Print (Pasted List)",
      '<label class="nsh-label" for="nsh-print-input">TO or SO numbers</label>' +
        '<textarea id="nsh-print-input" rows="6" placeholder="TO12345&#10;TO12346&#10;SO123456"></textarea>' +
        '<p class="nsh-wave-hint">One per line, or paste whole rows from the tracker. Tickets come out as one PDF in this order, the same as each order\'s own Print Picking Ticket button, with the wave number stamped under the address and the code top right.</p>' +
        '<div class="nsh-wave-actions"><button type="button" id="nsh-print-check">Check List</button></div>' +
        '<div id="nsh-print-confirm"></div>'
    );
    const ta = panel.querySelector("#nsh-print-input");
    if (text) ta.value = text;
    panel.querySelector("#nsh-print-check").onclick = () => checkList(ta.value);
    return panel;
  }

  function checkList(text) {
    const panel = getPanel();
    const box = panel.querySelector("#nsh-print-confirm");
    const btn = panel.querySelector("#nsh-print-check");
    const parsed = parseOrders(text);
    if (!parsed.good.length) {
      box.innerHTML = '<p class="nsh-wave-warn">No TO or SO numbers found.</p>';
      return;
    }
    btn.disabled = true;
    btn.textContent = "Checking...";
    setTimeout(() => {
      let info;
      try {
        info = lookup(parsed.good);
      } catch (err) {
        info = null;
      }
      btn.disabled = false;
      btn.textContent = "Check List";
      if (!info) {
        alert("Bulk print: couldn't look the orders up in NetSuite. Refresh the page and try again.");
        return;
      }
      const missing = parsed.good.filter((o) => !info[o]);
      const toPrint = parsed.good.filter((o) => info[o]);
      const stamps = buildStamps(toPrint, info, parsed.rows);
      const noWave = toPrint.filter((o) => !info[o].wave);
      const badRow = toPrint.filter((o) => o.startsWith("SO") && parsed.rows[o] && !courierCode(parsed.rows[o]));
      const hasSO = toPrint.some((o) => o.startsWith("SO"));
      // Code cell: sales orders get a dropdown (state / ST / FW / PU / none).
      const codeCell = (o) => {
        const s = stamps[o];
        if (!o.startsWith("SO")) return esc(s.code || "");
        const choices = [s.code, stateCode(info[o].state), "ST", "FW", "PU", "MULTIDROP"].filter((c, i, a) => c && a.indexOf(c) === i);
        return (
          '<select class="nsh-print-code" data-order="' + esc(o) + '">' +
          choices.map((c) => '<option value="' + esc(c) + '"' + (c === s.code ? " selected" : "") + ">" + esc(c) + "</option>").join("") +
          '<option value=""' + (s.code ? "" : " selected") + ">(none)</option></select>" +
          (s.from === "tracker" ? ' <span class="nsh-wave-hint">from tracker</span>' : "")
        );
      };

      const warnings = [];
      if (noWave.length) warnings.push("No wave yet (ticket stamped NO WAVE):\n  " + noWave.join("\n  "));
      if (badRow.length) warnings.push("Couldn't read the courier/state from the row (no code stamped):\n  " + badRow.join("\n  "));
      if (parsed.dupes.length) warnings.push("Listed more than once (printed once, in its first spot):\n  " + parsed.dupes.join("\n  "));
      if (missing.length) warnings.push("Not found in NetSuite (skipped):\n  " + missing.join("\n  "));
      if (parsed.bad.length) warnings.push("Not a TO or SO number (ignored):\n  " + parsed.bad.join("\n  "));
      if (warnings.length) alert("Check your list before you print.\n\n" + warnings.join("\n\n"));

      box.innerHTML =
        (toPrint.length
          ? "<p><b>" + toPrint.length + " ticket" + (toPrint.length > 1 ? "s" : "") + ", in this order:</b></p>" +
            '<table class="nsh-wave-table"><tr><th>Order</th><th>Wave</th><th>Code</th></tr>' +
            toPrint
              .map((o) => "<tr><td>" + esc(o) + "</td><td>" + esc(stamps[o].wave || "NO WAVE") + "</td><td>" + codeCell(o) + "</td></tr>")
              .join("") +
            "</table>" +
            '<label class="nsh-print-stamp"><input type="checkbox" id="nsh-print-stamp" checked> Stamp these on the tickets (wave under the address, code top right)</label>' +
            (hasSO
              ? '<p class="nsh-wave-hint">Sales orders show their ship-to state (the CHILL code, ACT as NSW). For STE/STP, Freeway or pickup orders pick ST, FW or PU. Pasting whole CWS tracker rows sets these for you.</p>'
              : "")
          : '<p class="nsh-wave-warn">None of these can be printed.</p>') +
        (parsed.dupes.length ? '<p class="nsh-wave-warn">Duplicates (printed once): ' + parsed.dupes.map(esc).join(", ") + "</p>" : "") +
        (missing.length ? '<p class="nsh-wave-warn">Not found in NetSuite: ' + missing.map(esc).join(", ") + "</p>" : "") +
        (parsed.bad.length ? '<p class="nsh-wave-warn">Ignored: ' + parsed.bad.map(esc).join(", ") + "</p>" : "") +
        (toPrint.length
          ? '<div class="nsh-wave-actions"><button type="button" class="nsh-primary" id="nsh-print-go">Print ' +
            toPrint.length + " Ticket" + (toPrint.length > 1 ? "s" : "") + "</button></div>" +
            '<p class="nsh-wave-hint">Each order is marked Picking Ticket Printed, the same as printing it by hand.</p>'
          : "");
      const go = box.querySelector("#nsh-print-go");
      if (go) {
        go.onclick = () => {
          if (!box.querySelector("#nsh-print-stamp").checked) return build(toPrint, info, text, null);
          // Use whatever code was picked in each dropdown.
          const texts = {};
          toPrint.forEach((o) => {
            const sel = box.querySelector('.nsh-print-code[data-order="' + o + '"]');
            texts[o] = { wave: stamps[o].wave, code: sel ? sel.value : stamps[o].code };
          });
          build(toPrint, info, text, texts);
        };
      }
    }, 30);
  }

  async function build(orders, info, text, stamps) {
    if (typeof window.PDFLib === "undefined") {
      alert("Bulk print: the PDF tool didn't load. Reload the extension and refresh this page.");
      return;
    }
    const rows = orders.map((o) => ({ order: o, state: "waiting", note: "" }));
    const draw = (title, extra) => {
      fill(
        title,
        '<table class="nsh-wave-table"><tr><th>Order</th><th></th></tr>' +
          rows
            .map((r) => '<tr class="' + (r.state === "failed" ? "nsh-wave-bad" : r.state === "waiting" ? "nsh-wave-wait" : "") + '"><td>' + esc(r.order) + "</td><td>" + esc(r.note || r.state) + "</td></tr>")
            .join("") +
          "</table>" + (extra || "")
      );
    };

    const parts = [];
    const partStamps = [];
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      r.state = "getting";
      r.note = "Getting ticket...";
      draw("Bulk Print: " + k + " of " + rows.length + " ready");
      try {
        parts.push(await fetchTicket(r.order, info[r.order]));
        partStamps.push(stamps ? stamps[r.order] || null : null);
        r.state = "ok";
        r.note = "Ready";
      } catch (err) {
        r.state = "failed";
        r.note = "Failed: " + err.message;
        const done = rows.filter((x) => x.state === "ok").map((x) => x.order);
        alert(
          "Bulk print stopped at " + r.order + ".\n\n" + err.message +
            (done.length ? "\n\nThese tickets were already fetched (and marked printed): " + done.join(", ") + ". You can still print them." : "")
        );
        rows.slice(k + 1).forEach((x) => (x.note = "Not started"));
        break;
      }
      await sleep(100);
    }

    const okCount = parts.length;
    if (!okCount) {
      draw("Bulk Print: Stopped", '<div class="nsh-wave-actions"><button type="button" id="nsh-print-new">New List</button></div>');
      getPanel().querySelector("#nsh-print-new").onclick = () => renderInput(text);
      return;
    }

    draw("Bulk Print: Joining " + okCount + " tickets...");
    let pdfBytes;
    try {
      pdfBytes = await mergePdfs(parts, partStamps);
    } catch (err) {
      alert("Bulk print: couldn't join the tickets into one PDF. " + err.message);
      return;
    }
    if (lastPdfUrl) URL.revokeObjectURL(lastPdfUrl);
    lastPdfUrl = URL.createObjectURL(new Blob([pdfBytes], { type: "application/pdf" }));

    const stopped = okCount < rows.length;
    draw(
      "Bulk Print: " + (stopped ? "Stopped, " + okCount + " of " + rows.length + " ready" : okCount + " Tickets Ready"),
      '<div class="nsh-wave-actions">' +
        '<button type="button" class="nsh-primary" id="nsh-print-auto">Send to AutoPrint</button>' +
        '<button type="button" id="nsh-print-print">Print</button>' +
        '<a class="nsh-print-open" id="nsh-print-open" href="' + lastPdfUrl + '" target="_blank" rel="noopener">Open PDF</a>' +
        '<button type="button" id="nsh-print-new">New List</button></div>' +
        '<p class="nsh-wave-hint" id="nsh-print-status">Tickets are in the order you pasted. Send to AutoPrint prints them on the page printer with no dialog (the AutoPrint helper must be running). Print opens the normal print dialog.</p>'
    );
    const panel = getPanel();
    const status = panel.querySelector("#nsh-print-status");
    panel.querySelector("#nsh-print-auto").onclick = async (e) => {
      e.target.disabled = true;
      status.textContent = "Sending to AutoPrint...";
      const res = await sendToAutoPrint(pdfBytes, "PickingTickets_" + okCount + ".pdf");
      e.target.disabled = false;
      if (res.ok) {
        status.textContent = "Sent to AutoPrint. It should print on the page printer in a few seconds. If nothing prints, check the AutoPrint helper is running.";
      } else {
        status.textContent = "Couldn't send to AutoPrint: " + res.error;
        alert("Bulk print: couldn't send to AutoPrint.\n\n" + res.error + "\n\nUse Print instead.");
      }
    };
    panel.querySelector("#nsh-print-print").onclick = () => printPdf(lastPdfUrl);
    panel.querySelector("#nsh-print-new").onclick = () => renderInput("");
  }

  // Hand the PDF to the extension (via content.js), which saves it into
  // Downloads\AutoPrint, the folder the AutoPrint helper prints from.
  function sendToAutoPrint(bytes, name) {
    return new Promise((resolve) => {
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const id = Date.now() + "-" + Math.random();
      const done = (res) => {
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        resolve(res);
      };
      const onMsg = (e) => {
        if (e.source === window && e.data && e.data.type === "nsh-autoprint-result" && e.data.id === id) done(e.data);
      };
      const timer = setTimeout(() => done({ ok: false, error: "The extension didn't answer. Reload it and refresh this page." }), 15000);
      window.addEventListener("message", onMsg);
      window.postMessage({ type: "nsh-autoprint-send", id, name, dataUrl: "data:application/pdf;base64," + btoa(bin) }, location.origin);
    });
  }

  // Load the PDF in a hidden frame and open the print dialog for it.
  function printPdf(url) {
    let frame = document.getElementById("nsh-print-frame");
    if (frame) frame.remove();
    frame = document.createElement("iframe");
    frame.id = "nsh-print-frame";
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0";
    frame.onload = () =>
      setTimeout(() => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch (err) {
          window.open(url, "_blank");
        }
      }, 300);
    frame.src = url;
    document.body.appendChild(frame);
  }

  // ---------- start ----------

  // Test hook (only when a test sets it up before this script runs).
  if (window.__nshPrintTest) {
    Object.assign(window.__nshPrintTest, { parseOrders, courierCode, buildStamps, stateCode, stampText });
    return;
  }

  // Ticket building for Bulk Waves (same tickets, stamps and order as Bulk Print).
  // ticketsPdf(orders, onProgress) -> { bytes, done: [orders], failed: [{order, error}] }
  // Fetching a ticket marks the order Picking Ticket Printed, like printing it by hand.
  if (ON_WAVE_PAGES) {
    window.__nshTickets = {
      async ticketsPdf(orders, onProgress) {
        if (typeof window.PDFLib === "undefined") throw new Error("the PDF tool didn't load. Reload the extension and refresh this page");
        window.__nshBusy = true;
        try {
          const info = lookup(orders);
          const list = orders.filter((o) => info[o]);
          const stamps = buildStamps(list, info, {});
          const parts = [];
          const partStamps = [];
          const done = [];
          const failed = orders.filter((o) => !info[o]).map((o) => ({ order: o, error: "not found in NetSuite" }));
          for (let i = 0; i < list.length; i++) {
            if (onProgress) onProgress(i, list.length);
            try {
              parts.push(await fetchTicket(list[i], info[list[i]]));
              partStamps.push(stamps[list[i]]);
              done.push(list[i]);
            } catch (err) {
              failed.push({ order: list[i], error: err.message });
            }
            await sleep(100);
          }
          if (onProgress) onProgress(list.length, list.length);
          const bytes = parts.length ? await mergePdfs(parts, partStamps) : null;
          return { bytes, done, failed };
        } finally {
          window.__nshBusy = false;
        }
      },
      sendToAutoPrint,
      printPdf,
    };
    return;
  }

  function main() {
    let prefill = "";
    try {
      prefill = localStorage.getItem(PREFILL_KEY) || "";
      localStorage.removeItem(PREFILL_KEY);
    } catch (e) {}
    renderInput(prefill);
    if (prefill) checkList(prefill);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
