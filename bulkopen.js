// NetSuite Helper: bulk open records in new tabs.
//
// Runs on the Item Fulfillment search page (the Ship Orders page), in the
// page's own world (needs nlapiSearchRecord). Paste TO/SO/IF/PO/INV numbers or
// whole tracker rows; each record opens in its own tab, in pasted order.
// Needs pop-ups allowed for NetSuite (one tab per record).

(function () {
  "use strict";

  if (!/Transaction_TYPE=ItemShip/i.test(location.search) || /searchid=|style=|\bresults?\b/i.test(location.search)) return;

  const PATTERN = /\b(TO|SO|PO|IF|INV)\d+\b/gi;
  const WARN_OVER = 25; // ask first when opening more tabs than this

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  // Every record number in the text, in order, each once.
  function parseNumbers(text) {
    const seen = new Set();
    const list = [];
    const dupes = [];
    (String(text).toUpperCase().match(PATTERN) || []).forEach((n) => {
      if (seen.has(n)) {
        if (!dupes.includes(n)) dupes.push(n);
        return;
      }
      seen.add(n);
      list.push(n);
    });
    return { list, dupes };
  }

  // tranid -> internal id (main line only).
  function lookup(list) {
    const ids = {};
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      const any = [];
      chunk.forEach((n, j) => {
        if (j) any.push("OR");
        any.push(["tranid", "is", n]);
      });
      (window.nlapiSearchRecord("transaction", null, [any, "AND", ["mainline", "is", "T"]], [new window.nlobjSearchColumn("tranid")]) || []).forEach((r) => {
        const n = String(r.getValue("tranid")).toUpperCase();
        if (chunk.includes(n) && !ids[n]) ids[n] = r.getId();
      });
    }
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
      '<label class="nsh-label" for="nsh-open-input">TO, SO, IF, PO or INV numbers</label>' +
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
      box.innerHTML = '<p class="nsh-wave-warn">No TO, SO, IF, PO or INV numbers found.</p>';
      return;
    }
    let ids;
    try {
      ids = lookup(list);
    } catch (err) {
      alert("Bulk open: couldn't look the numbers up in NetSuite. Refresh the page and try again.");
      return;
    }
    const found = list.filter((n) => ids[n]);
    const missing = list.filter((n) => !ids[n]);
    if (found.length > WARN_OVER && !confirm("Open " + found.length + " tabs?")) return;
    // Open every tab straight away, inside this click, so the browser counts them as one action.
    let blocked = 0;
    found.forEach((n) => {
      const w = window.open("/app/accounting/transactions/transaction.nl?id=" + encodeURIComponent(ids[n]), "_blank");
      if (!w) blocked++;
    });
    box.innerHTML =
      "<p>Opened " + (found.length - blocked) + " of " + found.length + " tab" + (found.length === 1 ? "" : "s") + ".</p>" +
      (blocked ? '<p class="nsh-wave-warn">The browser blocked ' + blocked + ". Allow pop-ups for NetSuite and try again.</p>" : "") +
      (missing.length ? '<p class="nsh-wave-warn">Not found in NetSuite: ' + missing.map(esc).join(", ") + "</p>" : "") +
      (dupes.length ? '<p class="nsh-wave-hint">Listed more than once (opened once): ' + dupes.map(esc).join(", ") + "</p>" : "");
    if (missing.length) alert("Bulk open: not found in NetSuite (not opened):\n  " + missing.join("\n  "));
  }

  if (window.__nshOpenTest) {
    Object.assign(window.__nshOpenTest, { parseNumbers });
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
