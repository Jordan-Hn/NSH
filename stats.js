// NetSuite Helper: pending orders summary on the saved search the warehouse uses
// ("KKB BDU Sales Order Status (LS) Not Printed", searchid 146970).
//
// Runs in the page's own world (needs nlapiSearchRecord). Adds:
//   - a summary panel: how many orders are overdue / ship today / tomorrow /
//     later, Samples orders, by department, and how many are short of stock;
//     click a count to show only those rows.
//   - overdue rows highlighted (ship date before today; Samples orders aren't
//     counted as overdue, they wait on purpose).
//   - a STOCK column: Ready, or Short with the items, worked out like this
//     (checked against NetSuite's own Back Ordered column, 24/11/2026):
//       not committed yet = ordered - committed - already fulfilled, per stock line
//       "Back ordered" alone isn't a shortage: NetSuite often hasn't committed stock
//       that's sitting there (e.g. 60 back ordered with 1,109 available). So the
//       uncommitted amount is checked against what's Available at the line's
//       warehouse, shared out in ship-date order so two orders can't both count
//       the same stock. Not enough left = Short. Kits have no stock of their own,
//       so an uncommitted kit line shows "Check".

(function () {
  "use strict";

  // The search's own results page, or the Home dashboard (its portlet of the same search, 25/11/2026).
  const onResults = /[?&]searchid=146970(&|$)/.test(location.search);
  const onHome = /\/app\/center\/card\.nl$/i.test(location.pathname);
  if (!onResults && !onHome) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const col = (n, j) => new window.nlobjSearchColumn(n, j || null);

  // dd/mm/yyyy -> day number (local), or null.
  function dayOf(text) {
    const m = String(text || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return Math.floor(new Date(+m[3], +m[2] - 1, +m[1]).getTime() / 86400000);
  }
  const today = () => {
    const d = new Date();
    return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
  };

  // ---------- the list on the page ----------

  // The results table itself (the Summary uses the same NetSuite classes, so never
  // look rows or headers up across the whole page).
  // On the Home page this points at the portlet's table while it's being worked on.
  let ROOT = null;
  const resultsTable = () => ROOT || document.getElementById("div__body") || document;

  function readRows() {
    const head = resultsTable().querySelector("tr.uir-list-headerrow");
    if (!head) return null;
    const names = [...head.cells].map((c) => c.innerText.trim().toUpperCase());
    const at = (n) => names.indexOf(n);
    const iDoc = at("DOCUMENT NUMBER");
    if (iDoc < 0) return null;
    const iDate = at("SHIP DATE");
    const iName = at("NAME");
    const iDept = at("DEPARTMENT");
    return [...resultsTable().querySelectorAll("tr.uir-list-row-tr")].map((tr, n) => {
      const cell = (i) => (i >= 0 && tr.cells[i] ? tr.cells[i].innerText.trim() : "");
      return { tr, n, so: cell(iDoc).toUpperCase(), date: cell(iDate), day: dayOf(cell(iDate)), name: cell(iName), dept: cell(iDept) };
    });
  }

  const isSamples = (r) => /^Samples\b/i.test(r.name);

  function bucket(r, t) {
    if (isSamples(r)) return "samples";
    if (r.day == null) return "nodate";
    if (r.day < t) return "overdue";
    if (r.day === t) return "today";
    if (r.day === t + 1) return "tomorrow";
    return "later";
  }

  // ---------- stock ----------

  // { SO: { state: "ready" | "short" | "check", lines: [text] } }
  function stockFor(rows) {
    const orders = [...new Set(rows.map((r) => r.so).filter((o) => /^SO\d+$/.test(o)))];
    const lines = [];
    for (let i = 0; i < orders.length; i += 60) {
      const any = [];
      orders.slice(i, i + 60).forEach((o, j) => {
        if (j) any.push("OR");
        any.push(["tranid", "is", o]);
      });
      (window.nlapiSearchRecord(
        "salesorder",
        null,
        [any, "AND", ["mainline", "is", "F"], "AND", ["item.type", "anyof", ["InvtPart", "Assembly", "Kit"]], "AND", ["closed", "is", "F"]],
        [col("tranid"), col("item"), col("location"), col("quantity"), col("quantitycommitted"), col("quantityshiprecv"), col("type", "item"), col("displayname", "item")]
      ) || []).forEach((r) => {
        const q = Math.abs(Number(r.getValue("quantity")) || 0);
        const need = q - (Number(r.getValue("quantitycommitted")) || 0) - (Number(r.getValue("quantityshiprecv")) || 0);
        lines.push({
          so: String(r.getValue("tranid")).toUpperCase(),
          item: r.getValue("item"),
          name: r.getText("item"),
          // In this account the item's "display name" field holds the product code (e.g. 11GB0003).
          code: r.getValue("displayname", "item") || "",
          loc: r.getValue("location"),
          kit: r.getValue("type", "item") === "Kit",
          need: Math.max(0, need),
        });
      });
    }

    // What's available, per item and warehouse.
    const avail = {};
    const items = [...new Set(lines.filter((l) => l.need > 0 && !l.kit).map((l) => l.item))];
    const locs = [...new Set(lines.filter((l) => l.need > 0 && l.loc).map((l) => l.loc))];
    for (let i = 0; i < items.length && locs.length; i += 300) {
      (window.nlapiSearchRecord(
        "item",
        null,
        [["internalid", "anyof", items.slice(i, i + 300)], "AND", ["inventorylocation", "anyof", locs]],
        [col("inventorylocation"), col("locationquantityavailable")]
      ) || []).forEach((r) => {
        avail[r.getId() + "|" + r.getValue("inventorylocation")] = Number(r.getValue("locationquantityavailable")) || 0;
      });
    }

    // Share it out in ship-date order (then list order).
    const order = rows.slice().sort((a, b) => (a.day == null ? 1e9 : a.day) - (b.day == null ? 1e9 : b.day) || a.n - b.n);
    const out = {};
    order.forEach((r) => {
      if (out[r.so]) return;
      const mine = lines.filter((l) => l.so === r.so);
      const res = { state: "ready", lines: [] };
      mine.forEach((l) => {
        if (l.need <= 0) return;
        if (l.kit || !l.loc) {
          res.lines.push({ name: l.name, code: l.code, rest: l.need + " to check (" + (l.kit ? "kit" : "no warehouse") + ")" });
          if (res.state === "ready") res.state = "check";
          return;
        }
        const key = l.item + "|" + l.loc;
        const left = avail[key] || 0;
        if (left >= l.need) {
          avail[key] = left - l.need;
        } else {
          res.state = "short";
          res.lines.push({ name: l.name, code: l.code, rest: "need " + l.need + " · have " + left });
        }
      });
      out[r.so] = res;
    });
    return out;
  }

  // How stock items are named (27/11/2026): product code, name, or both. The Stock field
  // next to View picks it; remembered per browser, and the Home portlet follows it too.
  const STOCK_LABEL_KEY = "nshStockLabel";
  const STOCK_LABELS = [
    ["both", "Code + name"],
    ["code", "Code"],
    ["name", "Name"],
  ];
  function stockLabelNow() {
    let v = "both";
    try {
      v = localStorage.getItem(STOCK_LABEL_KEY) || "both";
    } catch (e) {}
    return STOCK_LABELS.some((l) => l[0] === v) ? v : "both";
  }
  function itemLabel(l) {
    const mode = stockLabelNow();
    if (mode === "code" && l.code) return l.code;
    if (mode === "both" && l.code && l.code !== l.name) return l.code + " " + l.name;
    return l.name;
  }
  const lineText = (l) => itemLabel(l) + ": " + l.rest;

  // Stock lines in the PDF (27/11/2026: all-red text was hard to read): only "Short:" /
  // "Check:" keeps the colour; each item is dark text with its code/name in bold.
  function stockHtml(r) {
    return (
      '<span class="nsh-ps-state">' + esc(r.stock === "short" ? "Short:" : "Check:") + "</span>" +
      r.stockDetail
        .split("\n")
        .map((l) => {
          const i = l.lastIndexOf(": ");
          return '<div class="nsh-ps-line">' + (i > 0 ? "<b>" + esc(l.slice(0, i)) + "</b>: " + '<span class="nsh-ps-qty">' + esc(l.slice(i + 2)) + "</span>" : esc(l)) + "</div>";
        })
        .join("")
    );
  }

  // ---------- drawing ----------

  const LABELS = { overdue: "Overdue", today: "Ship today", tomorrow: "Tomorrow", later: "Later", samples: "Samples", nodate: "No ship date" };
  // Several counts can be picked at once (24/11/2026): { bucket: [], stock: [], dept: [] }.
  // Within one kind = either (Overdue or Ship today); across kinds = both (Overdue and
  // Stock short). null when nothing is picked.
  let filter = null;
  const picked = (type, value) => !!(filter && filter[type] && filter[type].includes(value));
  function togglePick(type, value) {
    const f = filter || { bucket: [], stock: [], dept: [] };
    f[type] = picked(type, value) ? f[type].filter((v) => v !== value) : f[type].concat(value);
    filter = f.bucket.length || f.stock.length || f.dept.length ? f : null;
  }

  function applyFilter(rows, stock, t) {
    const shown = {};
    rows.forEach((r) => {
      let show = true;
      if (filter) {
        if (filter.bucket.length && !filter.bucket.includes(bucket(r, t))) show = false;
        if (filter.dept.length && !filter.dept.includes(r.dept)) show = false;
        if (filter.stock.length && !(stock && stock[r.so] && filter.stock.includes(stock[r.so].state))) show = false;
      }
      r.tr.style.display = show ? "" : "none";
      if (show) shown[bucket(r, t)] = (shown[bucket(r, t)] || 0) + 1;
    });
    // Stripes again over just the rows showing (a filter left the pattern
    // uneven), counted per section in the order on screen.
    const seen = {};
    [...resultsTable().querySelectorAll("tr.uir-list-row-tr")].forEach((tr) => {
      const r = rows.find((x) => x.tr === tr);
      if (!r || tr.style.display === "none") return;
      const b = bucket(r, t);
      const i = (seen[b] = (seen[b] || 0) + 1) - 1;
      tr.classList.remove("uir-list-row-even", "uir-list-row-odd");
      tr.classList.add(i % 2 ? "uir-list-row-odd" : "uir-list-row-even");
      shade(tr, b === "overdue" ? "#fbe3e3" : i % 2 ? "#e8edf4" : "#ffffff", b === "overdue" ? "#fbe3e3" : "#ffffff");
    });
    // Section headings: hide empty ones, show how many are listed.
    document.querySelectorAll("tr.nsh-group-row").forEach((g) => {
      const n = shown[g.dataset.bucket] || 0;
      g.style.display = n ? "" : "none";
      g.querySelector(".nsh-group-count").textContent = n + (n === 1 ? " order" : " orders");
    });
  }

  // Easier reading (fine to remodel the page): orders grouped under
  // Overdue / Ship today / Tomorrow / Later / Samples headings, by ship date
  // inside each. Rows are moved, not changed, so their links still work.
  const GROUP_ORDER = ["overdue", "today", "tomorrow", "later", "nodate", "samples"];

  // The saved search highlights every row bold yellow, written onto each cell as
  // a forced inline style, so it says nothing and is hard to read (
  // 24/11/2026). Replace it per cell with plain rows: normal text, white / light
  // grey stripes, light red for overdue.
  // Cells point at a variable rather than the colour itself, so the Tiles view can
  // swap the stripes for plain white cards (content.css sets --nsh-cell-bg there).
  function shade(tr, colour, tileColour) {
    tr.style.setProperty("--nsh-row-bg", colour);
    tr.style.setProperty("--nsh-cell-bg", colour);
    tr.style.setProperty("--nsh-tile-bg", tileColour || colour);
    [...tr.cells].forEach((td) => {
      td.style.setProperty("background-color", "var(--nsh-cell-bg, " + colour + ")", "important");
      td.style.setProperty("border-color", "#ffffff " + colour + " #ffffff " + colour, "important");
      td.style.removeProperty("font-weight");
    });
  }
  function groupRows(rows, t) {
    if (!rows.length || rows[0].tr.parentNode.querySelector("tr.nsh-group-row")) return;
    const parent = rows[0].tr.parentNode;
    const width = rows[0].tr.cells.length;
    GROUP_ORDER.forEach((b) => {
      const mine = rows.filter((r) => bucket(r, t) === b).sort((x, y) => (x.day == null ? 1e9 : x.day) - (y.day == null ? 1e9 : y.day) || x.n - y.n);
      if (!mine.length) return;
      const head = document.createElement("tr");
      head.className = "nsh-group-row";
      head.dataset.bucket = b;
      head.innerHTML = '<td colspan="' + width + '"><span class="nsh-group-name">' + esc(LABELS[b]) + '</span> <span class="nsh-group-count"></span></td>';
      parent.appendChild(head);
      mine.forEach((r, i) => {
        // Keep NetSuite's alternating row shading within each section.
        r.tr.classList.remove("uir-list-row-even", "uir-list-row-odd");
        r.tr.classList.add(i % 2 ? "uir-list-row-odd" : "uir-list-row-even");
        shade(r.tr, b === "overdue" ? "#fbe3e3" : i % 2 ? "#e8edf4" : "#ffffff", b === "overdue" ? "#fbe3e3" : "#ffffff");
        parent.appendChild(r.tr);
      });
    });
  }

  // STOCK column, straight after AMOUNT (or after the last column if there's no AMOUNT).
  function drawStock(rows, stock) {
    const head = resultsTable().querySelector("tr.uir-list-headerrow");
    const headNames = head ? [...head.cells].map((c) => c.innerText.trim().toUpperCase()) : [];
    let at = headNames.indexOf("AMOUNT");
    if (at < 0) at = headNames.length - 1;
    if (head && !head.querySelector(".nsh-stock-head")) {
      const th = head.cells[at].cloneNode(false);
      th.className = (head.cells[at].className || "") + " nsh-stock-head";
      th.innerHTML = '<div class="listheader">Stock</div>';
      head.cells[at].after(th);
    }
    rows.forEach((r) => {
      let td = r.tr.querySelector(".nsh-stock-cell");
      if (!td) {
        td = document.createElement("td");
        td.className = "listtext uir-list-row-cell nsh-stock-cell";
        const before = r.tr.cells[at] || r.tr.lastElementChild;
        before.after(td);
        // Same shade as the rest of its row.
        const bg = before.style.getPropertyValue("background-color");
        if (bg) td.style.setProperty("background-color", bg, "important");
      }
      const s = stock && stock[r.so];
      if (!stock) td.innerHTML = '<span class="nsh-stock-wait">Checking...</span>';
      else if (!s) td.textContent = "";
      else if (s.state === "ready") td.innerHTML = '<span class="nsh-stock-ready">Ready</span>';
      else {
        // First item, then "+N more"; the full list (needed vs available) on hover.
        const names = s.lines.map(itemLabel);
        const texts = s.lines.map(lineText);
        td.innerHTML =
          '<span class="' + (s.state === "short" ? "nsh-stock-short" : "nsh-stock-check") + '" data-detail="' + esc(texts.join("\n")) + '">' +
          (s.state === "short" ? "Short: " : "Check: ") + '<span class="nsh-stock-brief">' + esc(names[0]) + (names.length > 1 ? " +" + (names.length - 1) + " more" : "") + "</span></span>" +
          '<div class="nsh-stock-all">' + s.lines.map((l) => esc(itemLabel(l)) + ': <span class="nsh-ps-qty">' + esc(l.rest) + "</span>").join("<br>") + "</div>";
      }
    });

  }

  let lastStock = null;
  function draw(rows, stock) {
    lastStock = stock;
    const t = today();
    const counts = {};
    const depts = {};
    rows.forEach((r) => {
      const b = bucket(r, t);
      counts[b] = (counts[b] || 0) + 1;
      depts[r.dept || "(none)"] = (depts[r.dept || "(none)"] || 0) + 1;
      r.tr.classList.toggle("nsh-overdue-row", b === "overdue");
    });

    drawStock(rows, stock);

    labelCells(rows);

    // Summary panel.
    let panel = document.getElementById("nsh-stats-panel");
    if (!panel) {
      // NetSuite's own Filters box (same classes; its CSS folds it with "collapsed").
      panel = document.createElement("div");
      panel.id = "nsh-stats-panel";
      panel.className = "uir-filters nsh-stats-box";
      panel.innerHTML =
        '<div class="uir-filters-header"><span><span class="ns-icon ns-filters-onoff-button" role="button" tabindex="0"></span><span>Summary</span></span></div><div class="uir-filters-body"></div>';
      const fold = () => {
        panel.classList.toggle("collapsed");
        window.dispatchEvent(new Event("resize"));
      };
      panel.querySelector(".uir-filters-header").onclick = fold;
      panel.querySelector(".ns-filters-onoff-button").onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          fold();
        }
      };
      const anchor = document.querySelector(".uir-page-title") || document.body.firstChild;
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }
    // Built from NetSuite's own list-table classes (same as the results below),
    // counts as NetSuite's dotted links ("more similar to the style of netsuite").
    const stockCounts = { short: 0, check: 0, ready: 0 };
    if (stock) Object.keys(stock).forEach((o) => stockCounts[stock[o].state]++);
    const on = picked;
    const count = (type, value, n, bad) =>
      n
        ? '<a href="#" class="dottedlink nsh-stat' + (bad ? " nsh-stat-bad" : "") + (on(type, value) ? " nsh-stat-on" : "") + '" data-type="' + type + '" data-value="' + esc(value) + '">' + n + "</a>"
        : '<span class="nsh-stat-zero">0</span>';
    const table = (cols) =>
      '<table class="uir-list-body nsh-stats-table"><tr class="uir-list-headerrow">' +
      cols.map((c) => '<td class="listheadertd listheadertextb uir-list-header-td"><div class="listheader">' + esc(c[0]) + "</div></td>").join("") +
      '</tr><tr class="uir-list-row-tr uir-list-row-even">' +
      cols.map((c) => '<td class="listtext uir-list-row-cell">' + c[1] + "</td>").join("") +
      "</tr></table>";
    const when = [["Orders", String(rows.length)]].concat(
      ["overdue", "today", "tomorrow", "later", "samples", "nodate"].filter((b) => b !== "nodate" || counts[b]).map((b) => [LABELS[b], count("bucket", b, counts[b], b === "overdue")])
    );
    const stockCols = stock
      ? [["Stock Short", count("stock", "short", stockCounts.short, true)], ["Stock Ready", count("stock", "ready", stockCounts.ready)]].concat(
          stockCounts.check ? [["Stock to Check", count("stock", "check", stockCounts.check)]] : []
        )
      : [["Stock", '<span class="nsh-stat-zero">Checking...</span>']];
    const deptCols = Object.keys(depts)
      .sort((a, b) => depts[b] - depts[a])
      .map((d) => [d.split(" : ").pop(), count("dept", d, depts[d])]);
    const body = panel.querySelector(".uir-filters-body");
    body.innerHTML =
      '<div class="nsh-stats-tables">' + table(when.concat(stockCols)) + table(deptCols) + "</div>" +
      (filter ? '<p class="nsh-stats-showing">Showing ' + esc(filterLabel()) + ' only. <a href="#" class="dottedlink" id="nsh-stat-all">Show all</a></p>' : "");
    currentRows = rows;
    body.querySelectorAll(".nsh-stat[data-type]").forEach((b) => {
      b.onclick = (e) => {
        e.preventDefault();
        togglePick(b.dataset.type, b.dataset.value);
        applyFilter(rows, stock, t);
        draw(rows, stock);
      };
    });
    const all = body.querySelector("#nsh-stat-all");
    if (all)
      all.onclick = (e) => {
        e.preventDefault();
        filter = null;
        applyFilter(rows, stock, t);
        draw(rows, stock);
      };
  }

  function filterLabel() {
    if (!filter) return "";
    const parts = [];
    if (filter.bucket.length) parts.push(filter.bucket.map((v) => LABELS[v].toLowerCase()).join(" or "));
    if (filter.stock.length) parts.push("stock " + filter.stock.join(" or "));
    if (filter.dept.length) parts.push(filter.dept.map((v) => v.split(" : ").pop()).join(" or "));
    return parts.join(", ");
  }

  // ---------- export through NetSuite's own Excel button ----------
  // 24/11/2026: use the page's Excel icon, with a choice of our tracker
  // layout or NetSuite's standard export. The click is caught before NetSuite's
  // handler; "NetSuite standard export" lets the same click through untouched.
  // Exports the rows showing (all, or the current filter), in the order shown.
  let currentRows = [];
  let passThrough = false;
  const listedOrders = () =>
    currentRows
      .filter((r) => r.tr.style.display !== "none" && /^(SO|TO)\d+$/.test(r.so))
      .sort((a, b) => (a.tr.compareDocumentPosition(b.tr) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map((r) => r.so);

  function toast(msg) {
    const t = document.createElement("div");
    t.className = "nsh-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("nsh-show"));
    setTimeout(() => {
      t.classList.remove("nsh-show");
      setTimeout(() => t.remove(), 400);
    }, 1800);
  }

  function exportListed(fn) {
    const api = window.__nshOrderExport;
    if (!api) return alert("Export: the export tool didn't load. Reload the extension and refresh this page.");
    const orders = listedOrders();
    if (!orders.length) return alert("Export: no orders showing.");
    document.body.style.cursor = "progress";
    setTimeout(() => {
      try {
        const ex = api.trackerExport(orders);
        fn(ex);
        if (ex.missing.length) alert("Export: not found in NetSuite: " + ex.missing.join(", "));
      } catch (err) {
        alert("Export: couldn't get the orders from NetSuite.\n\n" + (err.message || (err.getDetails && err.getDetails()) || err));
      }
      document.body.style.cursor = "";
    }, 30);
  }

  // Same dropdown look as NetSuite's menus (its dropdown classes; content.css has the box).
  const MENU_CLS = {
    menu: "uif1146 uif1148 uif1151 uif1152 uif1154 uif1155 uif1156",
    group: "uif1157 uif1159 uif1162 uif1164 uif1166 uif1169",
    item: "uif1170 uif1172 uif1175 uif1180 uif1183",
    a: "uif1117 uif1184 uif1187 uif1188 uif1181",
    div: "uif1189 uif1191 uif1194 uif1200",
    span: "uif1092 uif1116 uif1118 uif1198",
    hover: "uif1176",
  };
  // choices = [[value, text]]; onPick(value). Clicking the same anchor again closes it.
  function dropMenu(anchor, choices, onPick) {
    const old = document.getElementById("nsh-export-menu");
    if (old) {
      const same = old.nshAnchor === anchor;
      old.remove();
      if (same) return;
    }
    const cls = MENU_CLS;
    const menu = document.createElement("div");
    menu.id = "nsh-export-menu";
    menu.nshAnchor = anchor;
    menu.className = "nsh-nav-drop";
    menu.innerHTML =
      '<div class="nsh-nav-drop-body"><div role="menu" class="' + cls.menu + '">' +
      choices
        .map(
          (c) =>
            '<div role="group" class="' + cls.group + '"><div role="menuitem" class="nsh-nav-row ' + cls.item + '" data-choice="' + c[0] + '">' +
            '<a class="' + cls.a + '" href="#"><div class="' + cls.div + '"><span class="' + cls.span + '">' + esc(c[1]) + "</span></div></a></div></div>"
        )
        .join("") +
      "</div></div>";
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = r.bottom + 4 + "px";
    menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + "px";
    menu.style.display = "block";
    const close = (e) => {
      if (!menu.contains(e.target) && !anchor.contains(e.target)) {
        menu.remove();
        document.removeEventListener("mousedown", close, true);
      }
    };
    menu.querySelectorAll(".nsh-nav-row").forEach((row) => {
      row.addEventListener("mouseenter", () => row.classList.add(cls.hover));
      row.addEventListener("mouseleave", () => row.classList.remove(cls.hover));
      row.addEventListener("click", (e) => {
        e.preventDefault();
        menu.remove();
        document.removeEventListener("mousedown", close, true);
        onPick(row.dataset.choice);
      });
    });
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
  }

  function exportMenu(button) {
    const n = listedOrders().length;
    const what = (filter ? filterLabel() + ", " : "") + n + " order" + (n === 1 ? "" : "s");
    const isPrint = button.classList.contains("uir-list-print");
    const isCsv = button.classList.contains("uir-list-export-csv");
    const isPdf = button.classList.contains("uir-list-export-pdf");
    const choices = isPrint || isPdf
      ? [
          ["pdf", "This page as a PDF, " + what],
          ["standard", isPdf ? "NetSuite standard PDF export" : "NetSuite standard print"],
        ]
      : isCsv
        ? [
            ["page-csv", "This page's layout (CSV), " + what],
            ["tracker-csv", "Tracker layout (CSV), " + what],
            ["copy", "Copy tracker rows, " + what],
            ["standard", "NetSuite standard export"],
          ]
        : [
            ["page", "This page's layout (Excel), " + what],
            ["tracker", "Tracker layout (Excel), " + what],
            ["copy", "Copy tracker rows, " + what],
            ["standard", "NetSuite standard export"],
          ];
    dropMenu(button, choices, (choice) => {
        if (choice === "standard") {
          passThrough = true;
          button.click();
          passThrough = false;
        } else if (choice === "copy") {
          exportListed((ex) => {
            ex.copy();
            toast("Copied " + ex.count + " tracker row" + (ex.count === 1 ? "" : "s"));
          });
        } else if (choice === "pdf") {
          printPage();
        } else if (choice === "page") {
          pageExcel();
        } else if (choice === "page-csv") {
          pageCsv();
        } else if (choice === "tracker-csv") {
          exportListed((ex) => saveFile(ex.csv(), "text/csv", pageTitle() + " (tracker) " + todayText().replace(/\//g, "-") + ".csv"));
        } else {
          exportListed((ex) => {
            const d = new Date();
            const when = String(d.getDate()).padStart(2, "0") + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + d.getFullYear();
            ex.download("Pending Orders" + (filter ? " - " + filterLabel() : "") + " " + when + ".xlsx");
          });
        }
    });
  }

  // ---------- this page as it looks: PDF and Excel ----------
  // 24/11/2026: the print icon saves the page as a PDF in its current layout
  // (summary, sections, colours, stock), and the Excel icon has a version laid out like
  // the page too. Both use only what's showing (all, or the current filter).

  const todayText = () => {
    const d = new Date();
    return String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + d.getFullYear();
  };
  const pageTitle = () => "Pending Orders" + (filter ? " - " + filterLabel() : "");

  // What's showing, section by section, read from the page itself.
  // Read in the plain table layout whatever the View is (tiles hide the header and
  // move cells), so the PDF/Excel/CSV come out the same; put back straight after.
  function pageSnapshot() {
    const table = document.getElementById("div__body");
    const view = [...table.classList].filter((c) => /^nsh-view-/.test(c));
    table.classList.remove(...view);
    try {
      return readSnapshot(table);
    } finally {
      table.classList.add(...view);
    }
  }
  function readSnapshot(table) {
    const head = table.querySelector("tr.uir-list-headerrow");
    const cols = [...head.cells].map((c, i) => ({ i, name: c.innerText.trim(), px: c.getBoundingClientRect().width })).filter((c) => !/EDIT|VIEW/i.test(c.name) && c.name);
    const groups = [];
    let group = null;
    [...table.querySelectorAll("tr")].forEach((tr) => {
      if (tr.style.display === "none") return;
      if (tr.classList.contains("nsh-group-row")) {
        group = { title: tr.innerText.replace(/\s+/g, " ").trim(), bucket: tr.dataset.bucket, rows: [] };
        groups.push(group);
        return;
      }
      if (!tr.classList.contains("uir-list-row-tr")) return;
      if (!group) groups.push((group = { title: "", bucket: "", rows: [] }));
      const stockCell = tr.querySelector(".nsh-stock-cell span");
      group.rows.push({
        cells: cols.map((c) => (tr.cells[c.i] ? tr.cells[c.i].innerText.trim() : "")),
        overdue: tr.classList.contains("nsh-overdue-row") || group.bucket === "overdue",
        stock: stockCell ? (stockCell.classList.contains("nsh-stock-short") ? "short" : stockCell.classList.contains("nsh-stock-check") ? "check" : "ready") : "",
        stockDetail: stockCell ? stockCell.getAttribute("data-detail") || "" : "",
      });
    });
    const summary = [...document.querySelectorAll("#nsh-stats-panel .nsh-stats-table")].map((t) => {
      const rows = [...t.rows];
      return rows.length > 1 ? [...rows[0].cells].map((c, i) => [c.innerText.trim(), rows[1].cells[i] ? rows[1].cells[i].innerText.trim() : ""]) : [];
    });
    return { cols, groups, summary };
  }

  // PDF: a clean copy of the summary and the list, shown only while printing, landscape;
  // the browser's print dialog then saves it as a PDF (or prints it).
  function printPage() {
    const snap = pageSnapshot();
    if (!snap.groups.some((g) => g.rows.length)) return alert("Print: no orders showing.");
    const old = document.getElementById("nsh-print-sheet");
    if (old) old.remove();
    const sheet = document.createElement("div");
    sheet.id = "nsh-print-sheet";
    const summaryHtml = snap.summary
      .map((pairs) => '<table class="nsh-print-summary"><tr>' + pairs.map((p) => "<th>" + esc(p[0]) + "</th>").join("") + "</tr><tr>" + pairs.map((p) => "<td>" + esc(p[1]) + "</td>").join("") + "</tr></table>")
      .join("");
    const width = snap.cols.length;
    const body = snap.groups
      .map(
        (g) =>
          (g.title ? '<tr class="nsh-print-group"><td colspan="' + width + '">' + esc(g.title) + "</td></tr>" : "") +
          g.rows
            .map(
              (r, i) =>
                '<tr class="' + (r.overdue ? "nsh-print-overdue" : i % 2 ? "nsh-print-stripe" : "") + '">' +
                r.cells
                  .map((v, c) => {
                    const isStock = /STOCK/i.test(snap.cols[c].name);
                    // Every short item in full (the PDF must hold all of it).
                    const text =
                      isStock && r.stockDetail && r.stock !== "ready"
                        ? stockHtml(r)
                        : esc(v);
                    return '<td class="' + (isStock ? "nsh-print-stock-" + r.stock : "") + '">' + text + "</td>";
                  })
                  .join("") +
                "</tr>"
            )
            .join("")
      )
      .join("");
    // Tiles view prints as cards (24/11/2026: the PDF follows the chosen view).
    // Every view prints the full stock list.
    const stockText = (r, v) => (r.stockDetail && r.stock !== "ready" ? stockHtml(r) : esc(v));
    const cards = () => {
      const at = (name) => snap.cols.findIndex((c) => c.name.toUpperCase() === name);
      const top = [at("DOCUMENT NUMBER"), at("SHIP DATE")].filter((i) => i >= 0);
      return snap.groups
        .map(
          (g) =>
            (g.title ? '<div class="nsh-print-group nsh-print-cardgroup">' + esc(g.title) + "</div>" : "") +
            '<div class="nsh-print-cards">' +
            g.rows
              .map((r) => {
                const field = (i) => {
                  const c = snap.cols[i];
                  const isStock = /STOCK/i.test(c.name);
                  const v = isStock ? stockText(r, r.cells[i]) : esc(r.cells[i]);
                  if (!String(r.cells[i] || "").trim()) return "";
                  return '<div class="nsh-print-field' + (isStock ? " nsh-print-stock-" + r.stock : "") + '"><span>' + esc(c.name) + "</span>" + v + "</div>";
                };
                return (
                  '<div class="nsh-print-card' + (r.overdue ? " nsh-print-overdue" : "") + '"><div class="nsh-print-cardtop">' + top.map(field).join("") + "</div>" +
                  snap.cols.map((c, i) => (top.includes(i) ? "" : field(i))).join("") + "</div>"
                );
              })
              .join("") +
            "</div>"
        )
        .join("");
    };
    sheet.innerHTML =
      '<div class="nsh-print-head"><h1>' + esc(pageTitle()) + "</h1><span>" + esc(todayText()) + "</span></div>" + summaryHtml +
      (layoutNow() === "tiles"
        ? cards()
        : '<table class="nsh-print-list"><thead><tr>' + snap.cols.map((c) => "<th>" + esc(c.name) + "</th>").join("") + "</tr></thead><tbody>" + body + "</tbody></table>");
    document.body.appendChild(sheet);
    document.body.classList.add("nsh-printing");
    // 24/11/2026: the PDF ran to the edges (the print window's Margins setting
    // can be None). So the page margin is 0 and the sheet carries its own 12 mm border,
    // repeated on every page (box-decoration-break: clone): same result either way.
    const pageCss = document.createElement("style");
    pageCss.id = "nsh-print-page";
    pageCss.textContent = "@page { size: A4 landscape; margin: 0 !important; } @media print { html, body.nsh-printing { margin: 0 !important; padding: 0 !important; } body.nsh-printing #nsh-print-sheet { padding: 12mm !important; -webkit-box-decoration-break: clone; box-decoration-break: clone; } }";
    document.head.appendChild(pageCss);
    // The PDF's file name comes from the page title while printing: Sales-Order-Status-26-11-2026
    // (26/11/2026). Put back after.
    const oldTitle = document.title;
    document.title = "Sales-Order-Status-" + todayText().replace(/\//g, "-");
    const done = () => {
      document.body.classList.remove("nsh-printing");
      pageCss.remove();
      sheet.remove();
      document.title = oldTitle;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    setTimeout(() => window.print(), 50);
  }

  // Excel laid out like the page (title, summary, sections, colours, stock).
  function pageExcel() {
    const api = window.__nshOrderExport;
    if (!api || !api.pageWorkbook) return alert("Export: the export tool didn't load. Reload the extension and refresh this page.");
    const snap = pageSnapshot();
    if (!snap.groups.some((g) => g.rows.length)) return alert("Export: no orders showing.");
    const blob = api.pageWorkbook({
      title: pageTitle(),
      subtitle: "Exported " + todayText() + " from NetSuite",
      summary: snap.summary,
      header: snap.cols.map((c) => c.name),
      widths: snap.cols.map((c) => Math.max(8, Math.min(60, Math.round(c.px / 7)))),
      groups: snap.groups,
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = pageTitle() + " " + todayText().replace(/\//g, "-") + ".xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // CSV versions (the CSV icon, 24/11/2026): same data, plain text. A CSV can't
  // hold colours or merged bars, so the page layout gets a Section column instead.
  const csvCell = (v) => {
    const s = String(v == null ? "" : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  function saveFile(text, type, name) {
    // A byte-order mark so Excel opens accents (e.g. Café) correctly.
    const url = URL.createObjectURL(new Blob(["﻿" + text], { type: type + ";charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function pageCsv() {
    const snap = pageSnapshot();
    if (!snap.groups.some((g) => g.rows.length)) return alert("Export: no orders showing.");
    const stockCol = snap.cols.findIndex((c) => /STOCK/i.test(c.name));
    const rows = [["Section"].concat(snap.cols.map((c) => c.name))];
    snap.groups.forEach((g) => {
      const section = g.title.replace(/\s*\d+\s+orders?$/i, "");
      g.rows.forEach((r) =>
        rows.push([section].concat(r.cells.map((v, c) => (c === stockCol && r.stockDetail && r.stock !== "ready" ? r.stockDetail.replace(/\n/g, "; ") : v))))
      );
    });
    saveFile(toCsv(rows), "text/csv", pageTitle() + " " + todayText().replace(/\//g, "-") + ".csv");
  }

  function hookExcelButton() {
    const catchIt = (e) => {
      const button = e.target.closest && e.target.closest(".uir-list-export-xls, .uir-list-export-csv, .uir-list-export-pdf, .uir-list-print");
      if (!button || passThrough) return;
      if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      exportMenu(button);
    };
    window.addEventListener("click", catchIt, true);
    window.addEventListener("keydown", catchIt, true);
  }

  // Stock details box (24/11/2026: a hover tooltip vanishes when you take a
  // screenshot). Hover shows it, a click keeps it open until you click elsewhere or
  // press Escape. Only where the list is cut short (Normal view).
  function hookStockDetails() {
    let pop = null;
    let pinned = false;
    const close = () => {
      if (pop) pop.remove();
      pop = null;
      pinned = false;
    };
    const open = (span) => {
      if (pop && pop.nshFor === span) return;
      close();
      const brief = span.querySelector(".nsh-stock-brief");
      if (brief && getComputedStyle(brief).display === "none") return;
      const td = span.closest("td");
      pop = document.createElement("div");
      pop.className = "nsh-stock-pop";
      pop.nshFor = span;
      pop.innerHTML =
        '<div class="nsh-stock-pop-head">' + (span.classList.contains("nsh-stock-short") ? "Short" : "Check") + "</div>" +
        span.getAttribute("data-detail").split("\n").map((l) => "<div>" + esc(l) + "</div>").join("");
      td.classList.add("nsh-stock-pop-cell");
      td.appendChild(pop);
    };
    const spanOf = (e) => e.target.closest && e.target.closest(".nsh-stock-cell [data-detail]");
    document.addEventListener("mouseover", (e) => {
      const span = spanOf(e);
      if (span && !pinned) open(span);
    });
    document.addEventListener("mouseout", (e) => {
      const span = spanOf(e);
      if (!span || pinned || !pop) return;
      if (e.relatedTarget && (span.contains(e.relatedTarget) || pop.contains(e.relatedTarget))) return;
      close();
    });
    document.addEventListener("click", (e) => {
      const span = spanOf(e);
      if (span) {
        e.preventDefault();
        if (pinned && pop && pop.nshFor === span) return close();
        open(span);
        if (pop) {
          pinned = true;
          pop.classList.add("nsh-stock-pop-pinned");
        }
        return;
      }
      if (pinned && pop && !pop.contains(e.target)) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && pop) close();
    });
  }

  // ---------- View: Normal / Large rows / Tiles (24/11/2026) ----------
  // Only a class on the results table plus content.css, so the rows, links, filters,
  // sections and exports are the same in every view. Remembered per browser.
  const LAYOUT_KEY = "nshPendingLayout";
  const LAYOUTS = [
    ["normal", "Normal"],
    ["large", "Large rows"],
    ["tiles", "Tiles"],
  ];
  function layoutNow() {
    let v = "normal";
    try {
      v = localStorage.getItem(LAYOUT_KEY) || "normal";
    } catch (e) {}
    return LAYOUTS.some((l) => l[0] === v) ? v : "normal";
  }
  function applyLayout(v) {
    const table = document.getElementById("div__body");
    if (!table) return;
    LAYOUTS.forEach((l) => table.classList.toggle("nsh-view-" + l[0], l[0] === v && v !== "normal"));
    window.dispatchEvent(new Event("resize"));
  }
  // Tiles show each value under its column name, and place the main ones by name.
  const TILE_AREAS = { "DOCUMENT NUMBER": "doc", "SHIP DATE": "date", "EDIT | VIEW": "edit", NAME: "name", STATUS: "status", DEPARTMENT: "dept", AMOUNT: "amount", MEMO: "memo", STOCK: "stock" };
  function labelCells(rows) {
    const head = resultsTable().querySelector("tr.uir-list-headerrow");
    if (!head) return;
    const names = [...head.cells].map((c) => c.textContent.replace(/\s+/g, " ").trim());
    rows.forEach((r) =>
      [...r.tr.cells].forEach((td, i) => {
        const name = names[i] || "";
        td.dataset.label = /EDIT/i.test(name) ? "" : name;
        td.dataset.area = TILE_AREAS[name.toUpperCase()] || "";
        td.toggleAttribute("data-blank", !td.textContent.replace(/\u00a0/g, " ").trim());
      })
    );
  }
  // A "View" field next to NetSuite's Style field: a copy of that field's look
  // (attributes and ids stripped so NetSuite's own scripts leave it alone).
  function addViewField() {
    if (document.getElementById("nsh-view-field")) return;
    const style = document.querySelector(".uir-filters:not(#nsh-stats-panel) .uir-field-wrapper");
    let field;
    if (style) {
      field = style.cloneNode(true);
      field.querySelectorAll(".ns-dropdown, input[type=hidden], script").forEach((e) => e.remove());
      [field, ...field.querySelectorAll("*")].forEach((e) =>
        [...e.attributes].forEach((a) => {
          // Keep what NetSuite styles by (classes, inline sizes, data-* types); drop ids,
          // names, handlers and anything that points at the real Style field.
          if (/^(id|name|for|aria-labelledby|title|placeholder|data-nsps-id|data-field-name|data-input-id|data-walkthrough|data-options)$|^on/.test(a.name)) e.removeAttribute(a.name);
        })
      );
      const label = field.querySelector(".uir-label a, .uir-label-span, .uir-label");
      const realLabel = style.querySelector(".uir-label a, .uir-label-span, .uir-label");
      if (label) {
        label.textContent = "View";
        // Same lettering as NetSuite's "STYLE" (some of its look hangs on the stripped ids).
        if (realLabel) {
          const ls = getComputedStyle(realLabel);
          ["textTransform", "fontSize", "fontWeight", "color", "letterSpacing", "fontFamily"].forEach((k) => (label.style[k] = ls[k]));
        }
      }
    } else {
      field = document.createElement("div");
      field.className = "uir-field-wrapper";
      field.innerHTML = '<span class="smalltextnolink uir-label">View</span><span class="uir-field"><input class="dropdownInput textbox" type="text"></span>';
    }
    field.id = "nsh-view-field";
    const input = field.querySelector("input");
    input.readOnly = true;
    input.setAttribute("aria-label", "View");
    // The copied Style input is sized for its own short words; "Large rows" and "Code + name" got cut off (27/11/2026).
    input.style.setProperty("width", "115px", "important");
    setTimeout(() => input.style.setProperty("width", "115px", "important"), 1500);
    const show = () => (input.value = (LAYOUTS.find((l) => l[0] === layoutNow()) || LAYOUTS[0])[1]);
    show();
    const box = field.querySelector(".uir-select-input-container") || input;
    field.querySelector(".uir-field").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropMenu(box, LAYOUTS, (v) => {
        try {
          localStorage.setItem(LAYOUT_KEY, v);
        } catch (err) {}
        show();
        applyLayout(v);
      });
    });
    if (style) {
      style.after(field);
      // 24/11/2026: with View there, NetSuite's Style field isn't needed
      // (Grid looks like Normal here). Hidden while it says Normal; if someone has
      // Grid or Report on, it stays so they can switch back.
      const styleInput = style.querySelector("input.dropdownInput");
      if (!styleInput || /^normal$/i.test(styleInput.value.trim())) {
        style.style.display = "none";
        field.style.marginLeft = "0";
      }
    } else {
      const panel = document.getElementById("nsh-stats-panel");
      if (panel) panel.querySelector(".uir-filters-body").appendChild(field);
    }
    addStockLabelField(field);
  }
  // "Stock" field (Code + name / Code / Name): a copy of the View field just made.
  function addStockLabelField(viewField) {
    if (document.getElementById("nsh-stocklabel-field")) return;
    const field = viewField.cloneNode(true);
    field.id = "nsh-stocklabel-field";
    field.style.marginLeft = "";
    const label = field.querySelector(".uir-label a, .uir-label-span, .uir-label");
    if (label) label.textContent = "Stock";
    const input = field.querySelector("input");
    input.setAttribute("aria-label", "Stock");
    const show = () => (input.value = (STOCK_LABELS.find((l) => l[0] === stockLabelNow()) || STOCK_LABELS[0])[1]);
    show();
    const box = field.querySelector(".uir-select-input-container") || input;
    field.querySelector(".uir-field").addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropMenu(box, STOCK_LABELS, (v) => {
        try {
          localStorage.setItem(STOCK_LABEL_KEY, v);
        } catch (err) {}
        show();
        if (currentRows) {
          draw(currentRows, lastStock);
          applyFilter(currentRows, lastStock, today());
        }
      });
    });
    viewField.after(field);
  }

  // Helper view on/off (24/11/2026: switch between the old and new page).
  // A NetSuite switch next to EDIT in the list's icon bar (a copy of that one; its
  // look only applies inside the bar). Remembered per browser; flipping reloads.
  const VIEW_KEY = "nshPendingView";
  function helperOn() {
    try {
      return localStorage.getItem(VIEW_KEY) !== "off";
    } catch (e) {
      return true;
    }
  }
  async function addViewSwitch() {
    let edit = null;
    for (let i = 0; i < 20 && !(edit = document.querySelector(".uir-extreme-list-edit-field")); i++) await sleep(300);
    const near = edit || document.querySelector(".uir-list-print");
    const anchorTd = near && near.closest("td");
    if (!anchorTd || document.getElementById("nsh-view-switch")) return;
    const on = helperOn();
    const td = document.createElement("td");
    td.innerHTML =
      '<div class="uir-extreme-list-edit-field" id="nsh-view-switch"><span class="label">Helper view</span><div class="' +
      (on ? "toggled-on" : "toggled-off") + '" role="button" tabindex="0"></div></div>';
    const sep = document.querySelector(".uir-control-bar-separator");
    const sepTd = sep && sep.closest("td") ? sep.closest("td").cloneNode(true) : null;
    anchorTd.after(td);
    if (sepTd) anchorTd.after(sepTd);
    const flip = () => {
      try {
        localStorage.setItem(VIEW_KEY, on ? "off" : "on");
      } catch (e) {}
      location.reload();
    };
    const button = td.querySelector("[role=button]");
    // NetSuite draws its switch by id (#extreme-list-edit-button), so copy the look
    // from that button: flip its class for a moment just to read the styles (no click).
    const real = document.getElementById("extreme-list-edit-button");
    if (real) {
      const was = real.className;
      real.className = on ? "toggled-on" : "toggled-off";
      const cs = getComputedStyle(real);
      ["backgroundImage", "backgroundPosition", "backgroundSize", "backgroundRepeat", "backgroundColor", "width", "height", "display", "verticalAlign", "margin", "border", "borderRadius"].forEach(
        (k) => (button.style[k] = cs[k])
      );
      real.className = was;
    }
    td.querySelector("#nsh-view-switch").onclick = flip;
    button.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        flip();
      }
    };
  }

  // ---------- the Home dashboard portlet (25/11/2026) ----------
  // The same saved search added to the Home page as a portlet gets the same look: sections
  // by ship date, plain stripes, overdue in light red, the Stock column. A "Helper view"
  // switch in the portlet's title bar turns it off and on (remembered per browser). No
  // Summary or exports there: the portlet only shows one page of the search.
  const HOME_KEY = "nshHomePendingView";
  function homeOn() {
    try {
      return localStorage.getItem(HOME_KEY) !== "off";
    } catch (e) {
      return true;
    }
  }
  const homePortlets = () =>
    [...document.querySelectorAll(".ns-portlet-wrapper")].filter(
      (w) => w.querySelector("a[href*='searchid=146970']") && w.querySelector("tr.uir-list-headerrow") && !w.querySelector(".nsh-home-header")
    );
  function addHomeSwitch(wrap) {
    // In the filter row (next to TOTAL), which is always showing; the title bar's icons
    // only appear on hover.
    const bar = wrap.querySelector(".portletFilterBar") || wrap.querySelector(".ns-portlet-controls");
    if (!bar || wrap.querySelector(".nsh-home-switch")) return;
    const on = homeOn();
    const sw = document.createElement("span");
    sw.className = "nsh-home-switch" + (on ? " nsh-on" : "");
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", String(on));
    sw.tabIndex = 0;
    sw.innerHTML = '<span class="nsh-home-switch-label">Helper view</span><span class="nsh-home-switch-pill"></span>';
    const flip = (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        localStorage.setItem(HOME_KEY, on ? "off" : "on");
      } catch (err) {}
      location.reload();
    };
    sw.addEventListener("click", flip);
    sw.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && flip(e));
    // The title bar is the portlet's drag handle: a click on the switch mustn't start a drag.
    sw.addEventListener("mousedown", (e) => e.stopPropagation());
    const right = document.createElement("span");
    right.className = "nsh-home-right";
    right.appendChild(sw);
    bar.insertBefore(right, bar.firstChild);
  }
  // The Summary, squeezed into the portlet's filter row (between TOTAL and the switch):
  // counts for the orders on this page, click to filter (several at once), Show all.
  function drawHomeSummary(wrap, table, rows, stock) {
    let cell = wrap.querySelector(".nsh-home-summary");
    if (!cell) {
      const total = [...wrap.querySelectorAll(".portletFilterBar td")].find((td) => /TOTAL:/i.test(td.textContent) && !td.querySelector("td"));
      if (!total) return;
      cell = document.createElement("td");
      cell.className = "nsh-home-summary";
      total.after(cell);
      cell.addEventListener("click", (e) => {
        const a = e.target.closest && e.target.closest("a[data-type], a.nsh-home-all");
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        if (a.classList.contains("nsh-home-all")) filter = null;
        else togglePick(a.dataset.type, a.dataset.value);
        ROOT = table;
        applyFilter(table.__nshRows, table.__nshStock, today());
        ROOT = null;
        drawHomeSummary(wrap, table, table.__nshRows, table.__nshStock);
      });
    }
    table.__nshRows = rows;
    table.__nshStock = stock;
    const t = today();
    const counts = {};
    const depts = {};
    rows.forEach((r) => {
      const b = bucket(r, t);
      counts[b] = (counts[b] || 0) + 1;
      const d = r.dept || "(none)";
      depts[d] = (depts[d] || 0) + 1;
    });
    const sc = { short: 0, check: 0, ready: 0 };
    if (stock) rows.forEach((r) => stock[r.so] && sc[stock[r.so].state]++);
    const stat = (type, value, label, n, bad) =>
      n
        ? '<span class="nsh-home-stat"><span class="nsh-home-stat-label">' + esc(label) + '</span><a href="#" class="nsh-stat' + (bad ? " nsh-stat-bad" : "") + (picked(type, value) ? " nsh-stat-on" : "") +
          '" data-type="' + type + '" data-value="' + esc(value) + '">' + n + "</a></span>"
        : "";
    const group = (html) => (html ? '<span class="nsh-home-group">' + html + "</span>" : "");
    cell.innerHTML =
      group(["overdue", "today", "tomorrow", "later", "samples", "nodate"].map((b) => stat("bucket", b, LABELS[b], counts[b], b === "overdue")).join("")) +
      group(stock ? stat("stock", "short", "Stock short", sc.short, true) + stat("stock", "ready", "Stock ready", sc.ready) + stat("stock", "check", "Stock to check", sc.check) : '<span class="nsh-home-stat"><span class="nsh-home-stat-label">Stock</span><span class="nsh-stat-zero">Checking...</span></span>') +
      group(Object.keys(depts).sort((a, b) => depts[b] - depts[a]).map((d) => stat("dept", d, d.split(" : ").pop(), depts[d])).join("")) +
      (filter ? '<a href="#" class="dottedlink nsh-home-all">Show all</a>' : "");
  }

  // View (Normal / Large rows / Tiles) for the portlet, remembered apart from the Pending
  // Orders page's (the portlet is narrower). Looks like the portlet's own page dropdown
  // (a copy with its ids and handlers removed). Only with Helper view on.
  const HOME_LAYOUT_KEY = "nshHomeLayout";
  function homeLayout() {
    let v = "normal";
    try {
      v = localStorage.getItem(HOME_LAYOUT_KEY) || "normal";
    } catch (e) {}
    return LAYOUTS.some((l) => l[0] === v) ? v : "normal";
  }
  function applyHomeLayout(table) {
    const v = homeLayout();
    LAYOUTS.forEach((l) => table.classList.toggle("nsh-view-" + l[0], l[0] === v && v !== "normal"));
  }
  function addHomeViewField(wrap, table) {
    const right = wrap.querySelector(".nsh-home-right");
    if (!right) return;
    let field = right.querySelector(".nsh-home-view");
    const name = () => (LAYOUTS.find((l) => l[0] === homeLayout()) || LAYOUTS[0])[1];
    if (!field) {
      field = document.createElement("span");
      field.className = "nsh-home-view";
      const look = wrap.querySelector(".portletFilterBar .uir-pagination-select");
      let box;
      if (look) {
        box = look.cloneNode(true);
        [box, ...box.querySelectorAll("*")].forEach((e) =>
          [...e.attributes].forEach((a) => {
            if (/^(id|name|for|title|aria-\w+|data-[\w-]+)$|^on/.test(a.name)) e.removeAttribute(a.name);
          })
        );
      } else {
        box = document.createElement("span");
        box.className = "uir-pagination-select";
        box.innerHTML = '<span class="uir-pagination-label"></span>';
      }
      box.classList.add("nsh-home-view-box");
      // NetSuite draws the box and its arrow from where the original sits, so copy the
      // look from the real one (computed styles, theme included).
      if (look) {
        const cs = getComputedStyle(look);
        ["border", "padding", "backgroundColor", "display"].forEach((k) => (box.style[k] = cs[k]));
        const realLabel = look.querySelector(".uir-pagination-label");
        const myLabel = box.querySelector(".uir-pagination-label");
        if (realLabel && myLabel) {
          const ls = getComputedStyle(realLabel);
          ["padding", "font", "color", "display"].forEach((k) => (myLabel.style[k] = ls[k]));
          myLabel.style.position = "relative";
          const a = getComputedStyle(realLabel, "::after");
          if (a.content !== "none" && !document.getElementById("nsh-home-caret")) {
            const st = document.createElement("style");
            st.id = "nsh-home-caret";
            st.textContent =
              ".nsh-home-view-box .uir-pagination-label::after{content:'';position:absolute;right:" + a.right + ";top:" + a.top + ";width:" + a.width + ";height:" + a.height +
              ";background-image:" + a.backgroundImage + ";background-position:" + a.backgroundPosition + ";background-size:" + a.backgroundSize + ";background-repeat:no-repeat}";
            document.head.appendChild(st);
          }
        }
        box.querySelectorAll("ul").forEach((u) => u.remove()); // NetSuite's own option list
      }
      box.setAttribute("role", "button");
      box.tabIndex = 0;
      field.innerHTML = '<span class="nsh-home-switch-label">View</span>';
      field.appendChild(box);
      right.insertBefore(field, right.firstChild);
      const open = (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropMenu(box, LAYOUTS, (v) => {
          try {
            localStorage.setItem(HOME_LAYOUT_KEY, v);
          } catch (err) {}
          const label = box.querySelector(".uir-pagination-label") || box;
          label.textContent = name();
          const t = [...wrap.querySelectorAll("table")].find((x) => x.querySelector("tr.nsh-group-row"));
          if (t) applyHomeLayout(t);
        });
      };
      box.addEventListener("click", open);
      box.addEventListener("mousedown", (e) => e.stopPropagation());
      box.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && open(e));
    }
    const label = field.querySelector(".uir-pagination-label") || field.querySelector(".nsh-home-view-box");
    label.textContent = name();
  }

  async function dressPortlet(wrap) {
    addHomeSwitch(wrap);
    if (!homeOn()) return;
    const table = [...wrap.querySelectorAll("table")].find((t) => t.querySelector(":scope > thead > tr.uir-list-headerrow, :scope > tbody > tr.uir-list-headerrow, :scope > tr.uir-list-headerrow"));
    if (!table || table.querySelector("tr.nsh-group-row") || table.dataset.nshBusy) return;
    table.dataset.nshBusy = "1";
    try {
      ROOT = table;
      filter = null; // a fresh page starts unfiltered
      const rows = readRows();
      if (!rows || !rows.length) return;
      drawStock(rows, null);
      groupRows(rows, today());
      labelCells(rows);
      applyFilter(rows, null, today());
      ROOT = null;
      drawHomeSummary(wrap, table, rows, null);
      addHomeViewField(wrap, table);
      applyHomeLayout(table);
      await sleep(50);
      let stock = {};
      try {
        stock = stockFor(rows);
      } catch (err) {
        console.warn("[NetSuite Helper] stock check", err);
      }
      ROOT = table;
      drawStock(rows, stock);
      applyFilter(rows, stock, today()); // section counts ("4 orders") and even stripes
      ROOT = null;
      drawHomeSummary(wrap, table, rows, stock);
    } finally {
      ROOT = null;
      delete table.dataset.nshBusy;
    }
  }
  function startHome() {
    hookStockDetails();
    const run = () => homePortlets().forEach((w) => dressPortlet(w));
    let tries = 0;
    const first = setInterval(() => {
      run();
      if (homePortlets().length || ++tries > 20) clearInterval(first);
    }, 500);
    // The portlet redraws its list when it's refreshed, filtered or paged: dress it again.
    let timer = null;
    new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(run, 400);
    }).observe(document.body, { childList: true, subtree: true });
  }

  async function start() {
    addViewSwitch();
    if (!helperOn()) return;
    hookExcelButton();
    let rows = null;
    for (let i = 0; i < 20 && !(rows = readRows()); i++) await sleep(300);
    if (!rows || !rows.length) return;
    draw(rows, null);
    groupRows(rows, today());
    addViewField();
    applyLayout(layoutNow());
    hookStockDetails();
    applyFilter(rows, null, today());
    await sleep(50);
    let stock = null;
    try {
      stock = stockFor(rows);
    } catch (err) {
      console.warn("[NetSuite Helper] stock check", err);
      stock = {};
    }
    draw(rows, stock);
    applyFilter(rows, stock, today());
  }

  if (window.__nshStatsTest) {
    Object.assign(window.__nshStatsTest, { dayOf, bucket, isSamples });
    return;
  }
  if (onHome) startHome();
  else start();
})();
