// NetSuite Helper: bulk open records in new tabs.
//
// Runs on the Item Fulfillment search page (the Ship Orders page), in the
// page's own world (needs nlapiSearchRecord). Paste TO/SO/IF/PO/INV numbers or
// whole tracker rows; each record opens in its own tab, in pasted order.
// Needs pop-ups allowed for NetSuite (one tab per record).

(function () {
  "use strict";
  // Off switch (27/11/2026): when NetSuite Helper is turned off, leave the page alone.
  try {
    if (localStorage.getItem("nshOff") === "1") return;
  } catch (e) {}

  if (!/Transaction_TYPE=ItemShip/i.test(location.search) || /searchid=|style=|\bresults?\b/i.test(location.search)) return;

  // Record numbers (the transaction's own number). Seen in this account (25/11/2026):
  // TO, SO, PO, IF, INV, IA, CS, IR, CR; plus the usual RMA, CM, VB, JE, WO.
  const RECORD = /\b(?:TO|SO|PO|IF|INV|IA|CS|IR|CR|RMA|CM|VB|JE|WO)\d+\b/gi;
  // On a line with no record number, these work too (25/11/2026):
  //   Givex (store) POs: 9 digits starting 7 or 8 -> the TO whose memo is "Givex Purchase Order <n>"
  //   connotes -> the item fulfilment with that Consignment ID: Chill KKB123456 / RETAIL_KKB123456,
  //     StarTrack Y7KZ12345678, Home Delivery KKBLCK-123456789, Aus Post HDS 12D3C4567890, DHL 10 digits
  //   wave numbers: 5 digits -> the wave
  const EXTRA = /\b(RETAIL_KKB\d{6}|KKBLCK-\d{9}|KKB\d{6}|Y\dKZ\d{8}|\d{2}D\dC\d{7}|[78]\d{8}|\d{10}|\d{5})\b/gi;
  const kindOf = (n) => (/^[78]\d{8}$/.test(n) ? "givex" : /^\d{5}$/.test(n) ? "wave" : /^(?:RETAIL_KKB|KKBLCK-|KKB|Y\dKZ|\d{2}D\dC|\d{10}$)/.test(n) ? "connote" : "record");
  const WARN_OVER = 25; // ask first when opening more tabs than this

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  // Every record number in the text, in order, each once.
  function parseNumbers(text) {
    const seen = new Set();
    const list = [];
    const dupes = [];
    const found = [];
    String(text)
      .toUpperCase()
      .split(/\r?\n/)
      .forEach((line) => {
        const records = line.match(RECORD) || [];
        // Whole tracker rows: only their TO/SO/... (not the row's PO, connote or wave as well).
        found.push(...(records.length ? records : line.replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, " ").match(EXTRA) || []));
      });
    found.forEach((n) => {
      if (seen.has(n)) {
        if (!dupes.includes(n)) dupes.push(n);
        return;
      }
      seen.add(n);
      list.push(n);
    });
    return { list, dupes };
  }

  // Each number -> { id, as } (as = the record it opens, when that's not the number itself).
  function lookup(list) {
    const ids = {};
    const col = (n) => new window.nlobjSearchColumn(n);
    const anyOf = (field, values, op) => {
      const any = [];
      values.forEach((v, j) => {
        if (j) any.push("OR");
        any.push([field, op || "is", v]);
      });
      return any;
    };
    const inChunks = (values, fn) => {
      for (let i = 0; i < values.length; i += 40) fn(values.slice(i, i + 40));
    };
    const of = (kind) => list.filter((n) => kindOf(n) === kind);
    inChunks(of("record"), (chunk) =>
      (window.nlapiSearchRecord("transaction", null, [anyOf("tranid", chunk), "AND", ["mainline", "is", "T"]], [col("tranid")]) || []).forEach((r) => {
        const n = String(r.getValue("tranid")).toUpperCase();
        if (chunk.includes(n) && !ids[n]) ids[n] = { id: r.getId() };
      })
    );
    // Givex POs: the TO's memo starts "Givex Purchase Order <n>", sometimes with a word after
    // it ("... 800023836 Christmas"). Last 2 years, so it stays quick.
    inChunks(of("givex"), (chunk) =>
      (window.nlapiSearchRecord("transferorder", null, [anyOf("memo", chunk.map((n) => "Givex Purchase Order " + n), "startswith"), "AND", ["mainline", "is", "T"], "AND", ["trandate", "onorafter", "daysago730"]], [col("tranid"), col("memo")]) || []).forEach((r) => {
        const n = (String(r.getValue("memo")).match(/Givex Purchase Order\s+(\d{9})\b/i) || [])[1];
        if (n && chunk.includes(n) && !ids[n]) ids[n] = { id: r.getId(), as: r.getValue("tranid") };
      })
    );
    inChunks(of("connote"), (chunk) =>
      (window.nlapiSearchRecord("itemfulfillment", null, [anyOf("custbodyrsc_freight_carrier_consid", chunk), "AND", ["mainline", "is", "T"]], [col("tranid"), col("custbodyrsc_freight_carrier_consid")]) || []).forEach((r) => {
        const n = String(r.getValue("custbodyrsc_freight_carrier_consid")).toUpperCase();
        if (chunk.includes(n) && !ids[n]) ids[n] = { id: r.getId(), as: r.getValue("tranid") };
      })
    );
    inChunks(of("wave"), (chunk) =>
      (window.nlapiSearchRecord("transaction", null, [["type", "anyof", "Wave"], "AND", anyOf("tranid", chunk), "AND", ["mainline", "is", "T"]], [col("tranid")]) || []).forEach((r) => {
        const n = String(r.getValue("tranid"));
        if (chunk.includes(n) && !ids[n]) ids[n] = { id: r.getId(), as: "Wave " + n };
      })
    );
    return ids;
  }

  function panel() {
    let p = document.getElementById("nsh-open-panel");
    if (p) return p;
    p = document.createElement("div");
    p.id = "nsh-open-panel";
    p.className = "nsh-wave-panel";
    p.innerHTML =
      '<div class="nsh-fg-title" role="button" aria-expanded="true"><span class="nsh-chevron"></span><span class="nsh-fg-text">Bulk Open (New Tabs)</span></div>' +
      '<div class="nsh-fg-body">' +
      '<label class="nsh-label" for="nsh-open-input">Record numbers, store POs, connotes or waves</label>' +
      '<textarea id="nsh-open-input" rows="4" placeholder="TO12345&#10;SO123456"></textarea>' +
      '<p class="nsh-wave-hint">One per line, or paste whole tracker rows. Each opens in its own tab, in this order. Needs pop-ups allowed for NetSuite.</p>' +
      '<div class="nsh-wave-actions"><button type="button" class="nsh-primary" id="nsh-open-go">Open in Tabs</button></div>' +
      '<div id="nsh-open-result"></div></div>';
    p.querySelector(".nsh-fg-title").onclick = () => p.classList.toggle("nsh-collapsed");
    // Under the Ship Orders panel if it's there, else under the page title.
    const ship = document.getElementById("nsh-ship-panel");
    const anchor = ship || document.querySelector(".uir-page-title") || document.body.firstChild;
    anchor.parentNode.insertBefore(p, anchor.nextSibling);
    p.querySelector("#nsh-open-go").onclick = () => openAll(p);
    return p;
  }

  function openAll(p) {
    const box = p.querySelector("#nsh-open-result");
    const { list, dupes } = parseNumbers(p.querySelector("#nsh-open-input").value);
    if (!list.length) {
      box.innerHTML = '<p class="nsh-wave-warn">No record numbers, store POs, connotes or wave numbers found.</p>';
      return;
    }
    let ids;
    try {
      ids = lookup(list);
    } catch (err) {
      alert("Bulk open: couldn't look the numbers up in NetSuite. Refresh the page and try again.");
      return;
    }
    const missing = list.filter((n) => !ids[n]);
    // A PO and its TO (or a connote and its IF) pasted together open once.
    const seenId = new Set();
    const found = list.filter((n) => ids[n] && !seenId.has(ids[n].id) && seenId.add(ids[n].id));
    if (found.length > WARN_OVER && !confirm("Open " + found.length + " tabs?")) return;
    // Open every tab straight away, inside this click, so the browser counts them as one action.
    let blocked = 0;
    found.forEach((n) => {
      const w = window.open("/app/accounting/transactions/transaction.nl?id=" + encodeURIComponent(ids[n].id), "_blank");
      if (!w) blocked++;
    });
    const mapped = found.filter((n) => ids[n].as && !/^Wave /.test(ids[n].as));
    box.innerHTML =
      "<p>Opened " + (found.length - blocked) + " of " + found.length + " tab" + (found.length === 1 ? "" : "s") + ".</p>" +
      (blocked ? '<p class="nsh-wave-warn">The browser blocked ' + blocked + ". Allow pop-ups for NetSuite and try again.</p>" : "") +
      (mapped.length ? '<p class="nsh-wave-hint">Opened as: ' + mapped.map((n) => esc(n) + " = " + esc(ids[n].as)).join(", ") + "</p>" : "") +
      (missing.length ? '<p class="nsh-wave-warn">Not found in NetSuite: ' + missing.map(esc).join(", ") + "</p>" : "") +
      (dupes.length ? '<p class="nsh-wave-hint">Listed more than once (opened once): ' + dupes.map(esc).join(", ") + "</p>" : "");
    if (missing.length) alert("Bulk open: not found in NetSuite (not opened):\n  " + missing.join("\n  "));
  }

  if (window.__nshOpenTest) {
    Object.assign(window.__nshOpenTest, { parseNumbers, kindOf });
    return;
  }
  // Wait a moment so the Ship Orders panel is placed first.
  setTimeout(() => {
    const p = panel();
    // From the Home page's Bulk Open link: jump to this box and put the cursor in it.
    if (location.hash === "#nsh-open-panel") {
      p.scrollIntoView({ block: "center" });
      p.querySelector("#nsh-open-input").focus();
    }
  }, 300);
})();
