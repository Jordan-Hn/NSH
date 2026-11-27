// NetSuite Helper: small quality-of-life tweaks.
// Each feature is a function in FEATURES. Add new ones there.

(function () {
  "use strict";
  // Off switch (27/11/2026): background.js checks the switch on GitHub; this keeps a copy in
  // the page's own storage so the page scripts (which can't ask the extension) see it too.
  // A change shows from the next page load.
  let switchedOff = false;
  try {
    switchedOff = localStorage.getItem("nshOff") === "1";
    chrome.runtime.sendMessage({ type: "nsh-switch-check" }, (res) => {
      if (chrome.runtime.lastError || !res) return;
      if (res.off) localStorage.setItem("nshOff", "1");
      else localStorage.removeItem("nshOff");
    });
  } catch (e) {}
  if (switchedOff) return;

  // ---------- Settings (27/11/2026) ----------
  // The Settings page keeps them in this browser (chrome.storage.local "nshSettings").
  // They're copied into the page's own storage so the page scripts (which can't ask the
  // extension) can read them. When something changes in Settings, the tick boxes and
  // choices the tools remember on their own pages are set to match once.
  let SET = {};
  try {
    SET = JSON.parse(localStorage.getItem("nshSettings") || "{}") || {};
  } catch (e) {}
  const toolOn = (k) => !(SET.tools && SET.tools[k] === false);
  function applySettings(s) {
    if (!s) return;
    SET = s;
    try {
      localStorage.setItem("nshSettings", JSON.stringify(s));
      if (String(s.rev || "") !== (localStorage.getItem("nshSettingsRev") || "")) {
        const yn = (v) => (v ? "1" : "0");
        const own = { shipAutoPrint: ["nshShipAutoPrint", yn], wavesAutoPrint: ["nshWavesAutoPrint", yn], toSlips: ["nshShipToSlips", yn], pendingView: ["nshPendingLayout", String], stockLabel: ["nshStockLabel", String] };
        Object.keys(own).forEach((k) => {
          if (s[k] !== undefined) localStorage.setItem(own[k][0], own[k][1](s[k]));
        });
        localStorage.setItem("nshSettingsRev", String(s.rev || ""));
      }
    } catch (e) {}
  }
  try {
    chrome.storage.local.get("nshSettings", (v) => applySettings(v && v.nshSettings));
    chrome.storage.onChanged.addListener((c, area) => area === "local" && c.nshSettings && applySettings(c.nshSettings.newValue));
    // Ship Orders keeps NetSuite's active shipping methods in localStorage; the Settings
    // page (which can't search NetSuite) offers them from this copy.
    const copyMethods = () => {
      try {
        const list = JSON.parse(localStorage.getItem("nshShipMethodList") || "null");
        if (Array.isArray(list) && list.length) chrome.storage.local.set({ nshMethodList: list });
      } catch (e) {}
    };
    copyMethods();
    setTimeout(copyMethods, 8000);
  } catch (e) {}

  // ---------- Enter in the Helper's paste boxes ----------
  // Enter (with or without Shift) in any of the Helper's paste boxes just makes a new
  // line. NetSuite's own key handling would otherwise submit the page's form: on the Item
  // Fulfillment search page that runs a search of every fulfilment and freezes the tab
  // (25/11/2026). Caught on window, capture phase, before NetSuite's handlers see it.
  const newLineInBox = (e) => {
    const t = e.target;
    if (!t || t.tagName !== "TEXTAREA" || !/^nsh-/.test(t.id || "") || e.key !== "Enter" || e.isComposing) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type !== "keydown") return;
    t.setRangeText("\n", t.selectionStart, t.selectionEnd, "end");
    t.dispatchEvent(new Event("input", { bubbles: true }));
  };
  ["keydown", "keypress", "keyup"].forEach((type) => window.addEventListener(type, newLineInBox, true));

  // ---------- shared helpers ----------

  let toastEl = null;
  let toastTimer = null;

  function toast(message) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "nsh-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = message;
    toastEl.classList.add("nsh-show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("nsh-show"), 1500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Fallback for pages where the clipboard API is blocked.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    toast("Copied " + text);
  }

  function makeCopyable(el, getText) {
    if (!el || el.dataset.nshCopy) return;
    el.dataset.nshCopy = "1";
    el.classList.add("nsh-copyable");
    el.title = "Click to copy";
    el.addEventListener("click", (e) => {
      // Let Ctrl/Shift clicks behave normally (e.g. opening links).
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const text = (getText ? getText(el) : el.textContent).trim();
      if (text) copyText(text);
    });
  }

  // ---------- features ----------

  // 1. Click the record number (TO12345, SO123456, PO, IF) or the name next to it
  //    (customer on an SO, e.g. "Samples - Marketing") in the page header to copy it.
  function copyRecordHeader() {
    document
      .querySelectorAll(".uir-record-id, .uir-record-name")
      .forEach((el) => {
        if (el.textContent.trim()) makeCopyable(el);
      });
  }

  // 2. Click the value of selected fields to copy it (view mode only, so editing still works).
  //    Add more field names here. Find them in NETSUITE-PAGE-MAP.md or on the page.
  const COPY_FIELDS = [
    "custbodyrsc_freight_carrier_consid", // Consignment ID on item fulfilments, e.g. KKB123456
  ];
  function copyFields() {
    COPY_FIELDS.forEach((name) => {
      document
        .querySelectorAll('.uir-field-wrapper[data-field-name="' + name + '"][data-mode="view"] .uir-field')
        .forEach((el) => {
          if (el.textContent.trim()) makeCopyable(el);
        });
    });
  }

  const FEATURES = [copyRecordHeader, copyFields];

  // ---------- run ----------

  function runAll() {
    FEATURES.forEach((f) => {
      try {
        f();
      } catch (e) {
        console.warn("[NetSuite Helper]", f.name, e);
      }
    });
  }

  runAll();

  // NetSuite redraws parts of the page, so re-run when the page changes.
  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      runAll();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- Home page shortcuts ----------
  // A "NetSuite Helper" box at the top of the Home dashboard's left column,
  // built like NetSuite's own portlets, linking to each tool's page.
  const TOOL_PAGES = [
    { key: "pending", name: "Pending Orders", what: "Not printed yet, by ship date, with stock", url: "/app/common/search/searchresults.nl?searchid=146970&whence=" },
    { key: "bulkWaves", name: "Bulk Waves", what: "Paste TOs/SOs, make a wave each, in list order", url: "/app/accounting/wms/orderrelease/searchform/searchorders.nl" },
    { key: "bulkPrint", name: "Bulk Print Picking Tickets", what: "Paste TOs/SOs, one stamped PDF in list order", url: "/app/accounting/print/printform.nl?trantype=salesord&printtype=pickingticket&method=print&title=Picking+Tickets" },
    { key: "shipOrders", name: "Ship Orders", what: "Paste tracker rows, ship, bill and print", url: "/app/common/search/search.nl?searchtype=Transaction&Transaction_TYPE=ItemShip" },
    { key: "bulkOpen", name: "Bulk Open", what: "Paste numbers, open each in a new tab", url: "/app/common/search/search.nl?searchtype=Transaction&Transaction_TYPE=ItemShip#nsh-open-panel" },
  ];
  const toolPages = () => TOOL_PAGES.filter((t) => toolOn(t.key));
  function addHomeShortcuts() {
    if (!toolOn("homeBox")) return;
    if (!/\/app\/center\/card\.nl$/.test(location.pathname) || !/(^|[?&])sc=-29(&|$)/.test(location.search)) return;
    if (document.getElementById("nsh-home-portlet")) return;
    const column = document.getElementById("dashboard-column-1");
    if (!column) return;
    const box = document.createElement("div");
    box.id = "nsh-home-portlet";
    box.className = "ns-portlet-wrapper ns-portlet-window-state-normal nsh-home-portlet";
    box.innerHTML =
      '<div class="ns-portlet-header nsh-home-header"><h2 class="ns-portlet-header-text">NetSuite Helper</h2></div>' +
      '<div class="nsh-home-grid">' +
      toolPages().map((t) => '<a class="nsh-home-tile" href="' + t.url + '"><span class="nsh-home-name">' + t.name + '</span><span class="nsh-home-what">' + t.what + "</span></a>").join("") +
      "</div>";
    column.insertBefore(box, column.firstChild);
    applyThemeColour(box);
  }
  // Tiles use the person's own NetSuite theme colour (the nav bar), so they match
  // whatever theme is set. Text goes white or dark depending on how light it is.
  function applyThemeColour(box) {
    let colour = "";
    const item = [...document.querySelectorAll("a, span, div")].find((e) => e.children.length === 0 && e.textContent.trim() === "Activities");
    for (let el = item; el && el !== document.body; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      if (bg && !/rgba?\(0, 0, 0, 0\)|transparent/.test(bg)) {
        colour = bg;
        break;
      }
    }
    const m = colour.match(/\d+(\.\d+)?/g);
    if (!m || m.length < 3) return; // keep the default blue
    const [r, g, b] = m.map(Number);
    // The edge strip takes the theme colour as is; the tool name uses it too unless
    // it's too light to read on the light tile, then it's dark grey.
    const light = 0.299 * r + 0.587 * g + 0.114 * b > 150;
    box.style.setProperty("--nsh-tile", colour);
    box.style.setProperty("--nsh-tile-text", light ? "#333333" : colour);
  }
  if (/\/app\/center\/card\.nl$/.test(location.pathname)) {
    addHomeShortcuts();
    // The dashboard draws its columns late: retry for a few seconds, then stop.
    let tries = 0;
    const t = setInterval(() => {
      addHomeShortcuts();
      if (document.getElementById("nsh-home-portlet") || ++tries > 30) clearInterval(t);
    }, 500);
  }

  // ---------- "Helper" menu at the end of the nav bar ----------
  // A copy of NetSuite's own last menu item (Support), so it looks the same,
  // with a dropdown of the tool pages. NetSuite redraws the bar sometimes, so
  // runAll puts it back if it goes.
  let navDrop = null;
  let navHideTimer = null;
  function navDropdown(item) {
    if (navDrop && document.body.contains(navDrop)) return navDrop;
    // Rows are built from NetSuite's own dropdown classes, so fonts, spacing,
    // dividers and the hover shade come from NetSuite's CSS ("just apply
    // the same css netsuite is using"). Class names as of NetSuite 2026.2; if a
    // NetSuite dropdown is on the page, its current class names are used instead.
    const cls = navMenuClasses();
    navDrop = document.createElement("div");
    navDrop.id = "nsh-nav-drop";
    navDrop.className = "nsh-nav-drop";
    navDrop.innerHTML =
      '<div class="nsh-nav-drop-body"><div role="menu" class="' + cls.menu + '">' +
      toolPages().concat([{ name: "Settings", url: "#nsh-settings" }]).map(
        (t) =>
          '<div role="group" class="' + cls.group + '"><div role="menuitem" class="nsh-nav-row ' + cls.item + '">' +
          '<a class="' + cls.a + '" href="' + t.url + '"><div class="' + cls.div + '"><span class="' + cls.span + '">' + t.name + "</span></div></a></div></div>"
      ).join("") +
      "</div></div>";
    // Settings opens the extension's Settings page (only the extension can open it).
    const settingsLink = navDrop.querySelector('a[href="#nsh-settings"]');
    if (settingsLink)
      settingsLink.addEventListener("click", (e) => {
        e.preventDefault();
        try {
          chrome.runtime.sendMessage({ type: "nsh-open-settings" });
        } catch (err) {}
      });
    navDrop.querySelectorAll(".nsh-nav-row").forEach((row) => {
      row.addEventListener("mouseenter", () => row.classList.add(cls.hover));
      row.addEventListener("mouseleave", () => row.classList.remove(cls.hover));
    });
    navDrop.addEventListener("mouseenter", () => clearTimeout(navHideTimer));
    navDrop.addEventListener("mouseleave", () => hideNavDrop(item));
    document.body.appendChild(navDrop);
    return navDrop;
  }
  function navMenuClasses() {
    const c = {
      menu: "uif1146 uif1148 uif1151 uif1152 uif1154 uif1155 uif1156",
      group: "uif1157 uif1159 uif1162 uif1164 uif1166 uif1169",
      item: "uif1170 uif1172 uif1175 uif1180 uif1183",
      a: "uif1117 uif1184 uif1187 uif1188 uif1181",
      div: "uif1189 uif1191 uif1194 uif1200",
      span: "uif1092 uif1116 uif1118 uif1198",
      hover: "uif1176",
    };
    // Take the live names from a NetSuite dropdown row if one is in the page.
    const row = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(
      (r) => !r.closest("#nsh-nav-drop") && !r.closest('[role="menubar"]') && r.querySelector(":scope > a > div > span")
    );
    if (row) {
      const a = row.querySelector(":scope > a");
      const parts = (el) => [...el.classList].filter((x) => x !== c.hover).join(" ");
      c.item = parts(row);
      c.a = parts(a);
      c.div = parts(a.firstElementChild);
      c.span = parts(a.firstElementChild.firstElementChild);
      const g = row.closest('[role="group"]');
      const m = row.closest('[role="menu"]');
      if (g) c.group = parts(g);
      if (m) c.menu = parts(m);
    }
    return c;
  }
  function showNavDrop(item) {
    clearTimeout(navHideTimer);
    const d = navDropdown(item);
    const r = item.getBoundingClientRect();
    d.style.top = r.bottom + "px";
    d.style.display = "block";
    // Keep it on screen at the right-hand end of the bar.
    d.style.left = Math.max(0, Math.min(r.left, window.innerWidth - d.offsetWidth - 8)) + "px";
    item.setAttribute("data-highlighted", "true");
    item.classList.add("nsh-nav-open");
  }
  function hideNavDrop(item) {
    clearTimeout(navHideTimer);
    navHideTimer = setTimeout(() => {
      if (navDrop) navDrop.style.display = "none";
      item.setAttribute("data-highlighted", "false");
      item.classList.remove("nsh-nav-open");
    }, 200);
  }
  function addNavMenu() {
    if (!toolOn("helperMenu")) return;
    if (document.getElementById("nsh-nav-item")) return;
    const group = document.querySelector('[role="menubar"] [role="group"]');
    const last = group && group.lastElementChild;
    if (!last || last.getAttribute("role") !== "menuitem") return;
    const label = last.textContent.trim();
    const item = last.cloneNode(true);
    [item, ...item.querySelectorAll("*")].forEach((el) => {
      ["id", "aria-controls", "data-automation-id", "data-walkthrough", "aria-label"].forEach((a) => el.removeAttribute(a));
    });
    item.id = "nsh-nav-item";
    item.setAttribute("data-highlighted", "false");
    item.setAttribute("aria-expanded", "false");
    // Swap the label text (the innermost element that holds it).
    const holder = [...item.querySelectorAll("*")].reverse().find((el) => el.children.length === 0 && el.textContent.trim() === label);
    if (holder) holder.textContent = "Helper";
    const link = item.querySelector("a");
    if (link) {
      link.setAttribute("href", "#");
      link.setAttribute("aria-label", "NetSuite Helper tools");
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const d = navDropdown(item);
        if (d.style.display === "block") hideNavDrop(item);
        else showNavDrop(item);
      });
    }
    item.addEventListener("mouseenter", () => showNavDrop(item));
    item.addEventListener("mouseleave", () => hideNavDrop(item));
    group.appendChild(item);
  }
  FEATURES.push(addNavMenu);
  try {
    addNavMenu();
  } catch (e) {
    console.warn("[NetSuite Helper] nav menu", e);
  }

  // ---------- Auto Print relay ----------
  // Page scripts (bulk print) can't reach the browser's downloads, so they post
  // the PDF here and this passes it to background.js, which saves it into
  // Downloads\AutoPrint for the AutoPrint helper to print.
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    // nsh-autoprint (PDF bytes), nsh-autoprint-url (a label link), nsh-autoprint-state (is the helper running?)
    // nsh-tab-open / nsh-tab-close: Ship Orders' billing tab, opened in the background (25/11/2026).
    const m = d && typeof d.type === "string" && d.type.match(/^(nsh-autoprint(?:-url|-state)?|nsh-tab-open|nsh-tab-close)-send$/);
    if (!m) return;
    const base = m[1];
    const answer = (res) => window.postMessage(Object.assign({ type: base + "-result", id: d.id }, res), location.origin);
    try {
      chrome.runtime.sendMessage({ type: base, name: d.name, dataUrl: d.dataUrl, url: d.url, tabId: d.tabId }, (res) => {
        if (chrome.runtime.lastError) answer({ ok: false, error: chrome.runtime.lastError.message });
        else answer(res || { ok: false, error: "No answer from the extension." });
      });
    } catch (err) {
      answer({ ok: false, error: "The extension was reloaded. Refresh this page." });
    }
  });
})();
