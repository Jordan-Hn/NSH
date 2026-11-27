// NetSuite Helper: bulk create waves.
//
// Runs in the page's own world (needs NetSuite's getDropdown / nlapiSearchRecord)
// on the Wave Criteria page and the Wave page.
//
// Per order (from the SOPs): Location KBH Warehouse, type Sales Order or
// Transfer Order, Search, Picking Type Multiple Orders, tick only that order,
// Save. One wave per order.
//
// Several tabs can work on one run. The run is shared in localStorage and
// every change to it goes through a cross-tab lock (navigator.locks), so two
// tabs can never take the same order. Tabs search side by side, but each one
// waits its turn to click Save, strictly in list order, so wave numbers count
// up in the same order as the pasted list.

(function () {
  "use strict";
  // Off switch (27/11/2026): when NetSuite Helper is turned off, leave the page alone.
  try {
    if (localStorage.getItem("nshOff") === "1") return;
  } catch (e) {}
  // This browser's Settings (copied into the page by content.js, 27/11/2026). Anything not
  // set falls back to how the tool worked before there were settings.
  const SET = (() => {
    try {
      return JSON.parse(localStorage.getItem("nshSettings") || "{}") || {};
    } catch (e) {
      return {};
    }
  })();
  const setting = (k, d) => (SET[k] === undefined ? d : SET[k]);
  const toolOff = (k) => !!(SET.tools && SET.tools[k] === false);
  if (toolOff("bulkWaves")) return;

  const JOB_KEY = "nshBulkWavesJob"; // shared run (localStorage, all tabs)
  const TAB_KEY = "nshBulkWavesTab"; // this tab's part in it (sessionStorage)
  const LOCK = "nshBulkWaves";
  const CRITERIA_PATH = "/app/accounting/wms/orderrelease/searchform/searchorders.nl";
  const WAVE_PATH = "/app/accounting/transactions/wave.nl";
  const KBH_WAREHOUSE = "377";
  const TYPES = { TO: "TrnfrOrd", SO: "SalesOrd" };
  const CLAIM_STALE_MS = 60000; // searching with no progress this long = stuck
  const READY_STALE_MS = 30000; // waiting tab silent this long = frozen or closed
  const SAVE_STALE_MS = 180000; // saving tab silent this long = check NetSuite
  const STALE_MS = CLAIM_STALE_MS;
  const NOT_LISTED = "Not on Wave Criteria at its warehouse. Usually no stock committed yet, or it's closed.";
  const ACTIVE = ["claimed", "ready", "saving"];
  const FINAL = ["done", "skipped"];
  // Since 26/11/2026 the work runs in hidden frames on the Wave Criteria page (like Ship
  // Orders), so the page with the panel never moves. Each frame is one worker; the steps,
  // the shared run, the lock and the save order are the same as when they were tabs.
  const IN_FRAME = window.top !== window;
  const FRAME_TAG = "nshwave:";

  // ---------- storage ----------

  function readJob() {
    try {
      return JSON.parse(localStorage.getItem(JOB_KEY)) || null;
    } catch (e) {
      return null;
    }
  }
  function writeJob(job) {
    if (job) localStorage.setItem(JOB_KEY, JSON.stringify(job));
    else localStorage.removeItem(JOB_KEY);
  }
  // A frame keeps its part in its own window.name (it survives the frame's page loads);
  // sessionStorage is shared by every frame in the tab, so it can't be used there.
  function readSess() {
    try {
      if (IN_FRAME) return window.name.startsWith(FRAME_TAG) ? JSON.parse(window.name.slice(FRAME_TAG.length)) : null;
      return JSON.parse(sessionStorage.getItem(TAB_KEY)) || null;
    } catch (e) {
      return null;
    }
  }
  function writeSess(s) {
    if (IN_FRAME) {
      window.name = s ? FRAME_TAG + JSON.stringify(s) : "";
      return;
    }
    if (s) sessionStorage.setItem(TAB_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(TAB_KEY);
  }

  function withLock(fn) {
    if (navigator.locks && navigator.locks.request) return navigator.locks.request(LOCK, () => fn());
    return Promise.resolve(fn());
  }
  // Read, change and save the shared run as one step no other tab can interrupt.
  function updateJob(fn) {
    return withLock(() => {
      const job = readJob();
      const result = fn(job);
      if (job) writeJob(job);
      return result;
    });
  }

  // ---------- run logic (no page access) ----------

  const itemOf = (job, order) => job.items.find((x) => x.order === order);
  const isFinished = (job) => !job.items.some((x) => x.state === "pending" || ACTIVE.includes(x.state));
  const doneCount = (job) => job.items.filter((x) => x.state === "done").length;

  // An order may only be saved once every order before it in the list is finished.
  function canSave(job, it) {
    return job.items.every((x) => x.i >= it.i || FINAL.includes(x.state));
  }
  function earlierPending(job, it) {
    return job.items.some((x) => x.i < it.i && x.state === "pending");
  }

  // Tabs that stopped making progress (frozen, stuck, closed, logged out) get
  // their order taken back so another tab can do it:
  //   claimed: no new search for CLAIM_STALE_MS (a search takes ~10s)
  //   ready:   its waiting loop went quiet for READY_STALE_MS
  //   saving:  quiet for SAVE_STALE_MS. A wave may exist, so ask NetSuite
  //            (checkWave) instead of guessing: wave found = done, none = retry.
  //            Only if NetSuite can't be asked does the run stop.
  // Returns an error message if the run had to stop.
  function cleanupStale(job, myTab, now, checkWave) {
    let problem = "";
    job.items.forEach((it) => {
      if (!ACTIVE.includes(it.state) || it.tab === myTab) return;
      const quiet = now - (it.ts || 0);
      const noProgress = now - (typeof it.progress === "number" ? it.progress : it.ts || 0);
      if (it.state === "claimed" && noProgress < CLAIM_STALE_MS) return;
      if (it.state === "ready" && quiet < READY_STALE_MS) return;
      if (it.state === "saving" && quiet < SAVE_STALE_MS) return;
      if (it.state === "saving") {
        const wave = checkWave ? checkWave(it.order) : null;
        if (wave) {
          it.state = "done";
          it.wave = wave.split(", ")[0];
          it.note = wave.includes(",") ? "Has more than one wave: " + wave + "." : "Saved by a tab that stopped responding.";
          it.tab = null;
        } else if (wave === "") {
          it.state = "pending"; // NetSuite has no wave for it, safe to retry
          it.tab = null;
        } else {
          it.state = "error";
          it.note = "A tab stopped while saving this one and NetSuite couldn't be checked. Look at the order's Related Records for a wave before you resume.";
          it.tab = null;
          job.stopped = true;
          job.stopReason = it.order + ": a tab stopped while saving.";
          problem = job.stopReason;
        }
      } else {
        it.state = "pending"; // nothing was saved yet, safe to hand to another tab
        it.tab = null;
      }
    });
    return problem;
  }

  function claimNext(job, myTab, now) {
    if (job.stopped) return null;
    const it = job.items
      .filter((x) => x.state === "pending")
      .sort((a, b) => a.i - b.i)[0];
    if (!it) return null;
    it.state = "claimed";
    it.tab = myTab;
    it.ts = now;
    it.progress = now;
    return it.order;
  }

  // Things that look wrong once a run is over.
  function finalIssues(job) {
    const issues = [];
    job.items.forEach((it) => {
      if (it.state === "skipped" || it.state === "error") issues.push(it.order + ": " + it.note);
      else if (it.state === "done" && it.note && it.note !== "Out of order") issues.push(it.order + " (wave " + it.wave + "): " + it.note);
    });
    const done = job.items.filter((x) => x.state === "done" && x.wave).sort((a, b) => a.i - b.i);
    for (let k = 1; k < done.length; k++) {
      if (Number(done[k].wave) <= Number(done[k - 1].wave)) {
        issues.push(done[k].order + ": wave " + done[k].wave + " is out of order (after " + done[k - 1].wave + ").");
      }
    }
    const seen = {};
    done.forEach((it) => {
      if (seen[it.wave]) issues.push("Wave " + it.wave + " was recorded for both " + seen[it.wave] + " and " + it.order + ".");
      seen[it.wave] = it.order;
    });
    return issues;
  }

  // good = unique orders. all = every valid line as pasted (duplicates kept),
  // so copied wave numbers line up with the tracker rows.
  function parseOrders(text) {
    const seen = new Set();
    const good = [];
    const bad = [];
    const all = [];
    const dupes = [];
    text
      .toUpperCase()
      .split(/[\s,;]+/)
      .filter(Boolean)
      .forEach((t) => {
        if (!/^(TO|SO)\d+$/.test(t)) {
          bad.push(t);
          return;
        }
        all.push(t);
        if (seen.has(t)) {
          if (!dupes.includes(t)) dupes.push(t);
          return;
        }
        seen.add(t);
        good.push(t);
      });
    return { good, bad, all, dupes };
  }

  // Store POs (26/11/2026): a Givex PO number (9 digits starting 7 or 8) is swapped for
  // its TO, the transfer order whose memo starts "Givex Purchase Order <n>" (some have a
  // word after), so the list keeps its order and wave numbers still line up with the rows.
  // Returns { text, found: { po: to }, missing: [po] }, or null if NetSuite can't be asked.
  function posToTOs(text) {
    const pos = [...new Set(String(text).split(/[\s,;]+/).filter((t) => /^[78]\d{8}$/.test(t)))];
    const found = {};
    if (!pos.length) return { text, found, missing: [] };
    if (typeof window.nlapiSearchRecord !== "function") return null;
    for (let i = 0; i < pos.length; i += 40) {
      const any = [];
      pos.slice(i, i + 40).forEach((n, j) => {
        if (j) any.push("OR");
        any.push(["memo", "startswith", "Givex Purchase Order " + n]);
      });
      (window.nlapiSearchRecord("transferorder", null, [any, "AND", ["mainline", "is", "T"], "AND", ["trandate", "onorafter", "daysago730"]], [new window.nlobjSearchColumn("tranid"), new window.nlobjSearchColumn("memo")]) || []).forEach((r) => {
        const n = (String(r.getValue("memo")).match(/Givex Purchase Order\s+(\d{9})\b/i) || [])[1];
        if (n && pos.includes(n) && !found[n]) found[n] = String(r.getValue("tranid")).toUpperCase();
      });
    }
    const swapped = String(text).replace(/(^|[\s,;])([78]\d{8})(?=$|[\s,;])/g, (m, pre, n) => pre + (found[n] || n));
    return { text: swapped, found, missing: pos.filter((n) => !found[n]) };
  }

  // known = { order: ["50009"] }: waves each order already had at Check List.
  // skip = the same shape, for orders the user chose not to wave again.
  function buildJob(parsed, tn, ids, skip, known) {
    const already = skip || {};
    return {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      created: Date.now(),
      all: parsed.all,
      tn,
      ids: ids || {},
      known: known || {},
      stopped: false,
      stopReason: "",
      alerted: false,
      items: parsed.good.map((order, i) => {
        const base = { order, i, state: "skipped", tab: null, ts: 0, progress: 0, wave: "", note: "" };
        if (!tn[order]) return Object.assign(base, { note: "Not found in NetSuite. Typo?" });
        if (already[order] && already[order].length) {
          return Object.assign(base, { note: "Already has wave " + already[order].join(", ") + ". Not waved again." });
        }
        return Object.assign(base, { state: "pending" });
      }),
    };
  }

  // ---------- page helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout) {
    const end = Date.now() + (timeout || 20000);
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    return null;
  }

  function setDropdown(name, value) {
    const el = document.querySelector('[name="inpt_' + name + '"]');
    if (!el || typeof window.getDropdown !== "function") return false;
    window.getDropdown(el).setValue(value);
    const hidden = document.querySelector('[name="' + name + '"]');
    return !!hidden && hidden.value === value;
  }

  function setText(name, value) {
    const el = document.querySelector('[name="' + name + '"]');
    if (!el) return false;
    el.focus();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    return el.value === value;
  }

  function buttonByValue(value) {
    return document.querySelector(
      'input[type="button"][value="' + value + '"], input[type="submit"][value="' + value + '"]'
    );
  }

  function fieldNumber(name) {
    const w = document.querySelector('.uir-field-wrapper[data-field-name="' + name + '"]');
    const m = w && w.textContent.match(/(\d+(?:\.\d+)?)\s*$/);
    return m ? Number(m[1]) : NaN;
  }

  function allowLeave() {
    try {
      if (typeof window.setWindowChanged === "function") window.setWindowChanged(window, false);
    } catch (e) {}
    window.onbeforeunload = null;
  }

  function goToCriteria() {
    allowLeave();
    location.href = CRITERIA_PATH;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (btn && btn.tagName === "BUTTON") {
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 1200);
    }
  }

  // How many extra tabs to open for a run of this size. Saves happen one at a
  // time in list order, so more than 3 tabs in total wouldn't help.
  function helpersFor(count) {
    const fixed = setting("waveHelpers", "auto"); // Settings: "auto" or 0 / 1 / 2
    if (fixed !== "auto" && !isNaN(Number(fixed))) return Math.min(2, Math.max(0, Number(fixed)));
    return count >= 10 ? 2 : count >= 3 ? 1 : 0;
  }

  // Workers are hidden frames on this page (no pop-ups, the page never moves). Each loads
  // Wave Criteria with #nshframe, joins the run and works through it like a tab did.
  function openHelpers(n) {
    for (let k = 0; k < n; k++) {
      const f = document.createElement("iframe");
      f.className = "nsh-wave-frame";
      f.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1";
      f.src = CRITERIA_PATH + "#nshframe";
      document.body.appendChild(f);
    }
    watchFrames();
    return { wanted: n, opened: n };
  }
  // While frames work: warn before leaving the page, and take them away once nothing is
  // being worked on (never in the middle of a save).
  let frameWatch = null;
  function watchFrames() {
    window.onbeforeunload = () => "Waves are still being created.";
    clearInterval(frameWatch);
    frameWatch = setInterval(() => {
      const job = readJob();
      const busy = job && job.items.some((x) => ACTIVE.includes(x.state));
      if (busy || (job && !job.stopped && !isFinished(job))) return;
      clearInterval(frameWatch);
      document.querySelectorAll("iframe.nsh-wave-frame").forEach((f) => f.remove());
      window.onbeforeunload = null;
      renderPanel();
    }, 2000);
  }
  const workingHere = () => !!document.querySelector("iframe.nsh-wave-frame");

  // Helpers close themselves when there's nothing left. The browser can refuse
  // for a moment (e.g. while another tab shows a pop-up), so try a few times.
  // The end-of-run pop-up is left to the main tab.
  function closeHelperTab() {
    allowLeave();
    if (IN_FRAME) {
      writeSess(null);
      location.replace("about:blank");
      return;
    }
    [0, 1000, 3000, 6000].forEach((ms) =>
      setTimeout(() => {
        allowLeave();
        window.close();
      }, ms)
    );
    setTimeout(() => {
      const bar = document.getElementById("nsh-wave-bar");
      if (bar) bar.remove();
      if (location.pathname === CRITERIA_PATH) renderPanel(true);
    }, 7000);
  }

  // Each worker holds a lock named after its id for as long as the page is open.
  // A second page with the same id (a duplicated tab) can't get it, so it knows
  // to start fresh. Holding a lock also stops the browser freezing the tab in
  // the background, which is what made a tab stall mid-run.
  const heldLocks = {};
  function holdTabLock(tabId) {
    if (!navigator.locks || !navigator.locks.request) return Promise.resolve(true);
    if (heldLocks[tabId]) return Promise.resolve(true);
    return new Promise((resolve) => {
      navigator.locks.request("nshTab-" + tabId, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return null;
        }
        heldLocks[tabId] = true;
        resolve(true);
        return new Promise(() => {}); // hold until the page closes
      });
    });
  }

  function newTabId() {
    return (crypto.randomUUID && crypto.randomUUID()) || Date.now() + "-" + Math.random();
  }

  // Look up NetSuite's internal transaction number (e.g. TO12345 = TRNFRORD67890).
  // The Wave Criteria "Transaction #" filter matches its digits, so the search
  // returns just that order instead of every open order.
  function lookupOrders(orders) {
    const map = {};
    const ids = {};
    const store = {}; // TO -> its store (To Location), for the 1/N ticket blocks
    if (typeof window.nlapiSearchRecord !== "function") return null;
    for (let i = 0; i < orders.length; i += 50) {
      const any = [];
      orders.slice(i, i + 50).forEach((o, j) => {
        if (j) any.push("OR");
        any.push(["tranid", "is", o]);
      });
      const res =
        window.nlapiSearchRecord(
          "transaction",
          null,
          [any, "AND", ["mainline", "is", "T"], "AND", ["type", "anyof", ["TrnfrOrd", "SalesOrd"]]],
          [new window.nlobjSearchColumn("tranid"), new window.nlobjSearchColumn("transactionnumber"), new window.nlobjSearchColumn("transferlocation")]
        ) || [];
      res.forEach((r) => {
        const tranid = (r.getValue("tranid") || "").toUpperCase();
        const digits = (r.getValue("transactionnumber") || "").replace(/\D/g, "");
        if (orders.includes(tranid) && digits) {
          map[tranid] = digits;
          ids[tranid] = r.getId();
          if (tranid.startsWith("TO")) store[tranid] = r.getText("transferlocation") || "";
        }
      });
    }
    return { tn: map, ids, loc: lookupLocations(ids), store };
  }

  // Which warehouse each order is waved at. Sales orders: where their stock lines
  // are (the header can say KBH while the lines are at Warehouses : Online,
  // 23/11/2026). Transfer orders: their from-location. KBH if unclear.
  // Returns { order: { id, name, mixed } }.
  function lookupLocations(ids) {
    const loc = {};
    const byId = {};
    Object.keys(ids).forEach((o) => (byId[ids[o]] = o));
    const all = Object.keys(byId);
    for (let i = 0; i < all.length; i += 40) {
      const chunk = all.slice(i, i + 40);
      const seen = {};
      (window.nlapiSearchRecord(
        "transaction",
        null,
        [["internalid", "anyof", chunk], "AND", ["mainline", "is", "F"], "AND", ["item.type", "anyof", ["InvtPart", "Assembly", "Kit"]], "AND", ["quantity", "notequalto", "0"]],
        [new window.nlobjSearchColumn("location"), new window.nlobjSearchColumn("type")]
      ) || []).forEach((r) => {
        const o = byId[r.getId()];
        const id = r.getValue("location");
        if (!o || !id) return;
        // Transfer orders list each line twice (from and to); keep their own warehouse lines only.
        if (r.getValue("type") === "TrnfrOrd" && !/^Warehouses/i.test(r.getText("location"))) return;
        (seen[o] = seen[o] || {})[id] = r.getText("location");
      });
      Object.keys(seen).forEach((o) => {
        const places = Object.keys(seen[o]);
        const id = places.includes(KBH_WAREHOUSE) || !places.length ? KBH_WAREHOUSE : places[0];
        loc[o] = { id, name: seen[o][id] || "Warehouses : KBH Warehouse", mixed: places.length > 1 };
      });
    }
    return loc;
  }

  // Waves that already hold these orders, from NetSuite itself.
  // orderIds = { TO12345: "12345678", ... }  ->  { TO12345: ["501", "502"] }
  // Throws if NetSuite can't be asked, so callers never mistake "couldn't check" for "none".
  function findWaves(orderIds) {
    if (typeof window.nlapiSearchRecord !== "function") throw new Error("NetSuite search isn't available on this page.");
    const byId = {};
    Object.keys(orderIds).forEach((o) => {
      if (orderIds[o]) byId[orderIds[o]] = o;
    });
    const ids = Object.keys(byId);
    const out = {};
    // Small batches: results are one row per wave line, capped at 1000.
    for (let i = 0; i < ids.length; i += 20) {
      const res =
        window.nlapiSearchRecord(
          "transaction",
          null,
          [["type", "anyof", "Wave"], "AND", ["appliedtotransaction", "anyof", ids.slice(i, i + 20)]],
          [new window.nlobjSearchColumn("tranid"), new window.nlobjSearchColumn("appliedtotransaction")]
        ) || [];
      res.forEach((r) => {
        const order = byId[r.getValue("appliedtotransaction")];
        const wave = r.getValue("tranid");
        if (!order || !wave) return;
        out[order] = out[order] || [];
        if (!out[order].includes(wave)) out[order].push(wave);
      });
    }
    return out;
  }

  // For the stale check: "" = no wave, "50708" = has one, null = couldn't check.
  function waveForOrder(order) {
    try {
      const job = readJob();
      const id = job && job.ids && job.ids[order];
      if (!id) return null;
      const known = (job.known || {})[order] || [];
      return (findWaves({ [order]: id })[order] || []).filter((w) => !known.includes(w)).join(", ");
    } catch (e) {
      return null;
    }
  }

  // ---------- this tab's work ----------

  let heartbeat = null;
  function startHeartbeat(s) {
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      updateJob((job) => {
        const it = job && s.order && itemOf(job, s.order);
        if (it && it.tab === s.tab && ACTIVE.includes(it.state)) it.ts = Date.now();
      });
    }, 5000);
  }

  function clearOrder(s) {
    s.order = null;
    s.mode = null;
    s.stage = null;
    s.retry = 0;
    writeSess(s);
  }

  let leaving = false;
  window.addEventListener("pagehide", () => (leaving = true));

  // Give this tab's order back so another tab (or a resume) can take it.
  function releaseMine(s) {
    if (!s.order) return Promise.resolve();
    return updateJob((job) => {
      const it = job && itemOf(job, s.order);
      if (it && it.tab === s.tab && (it.state === "claimed" || it.state === "ready")) {
        it.state = "pending";
        it.tab = null;
      }
    });
  }

  // Only the tab that owns an order may finish it. Returns false if it doesn't.
  function record(s, state, wave, note) {
    const order = s.order;
    return updateJob((job) => {
      const it = job && itemOf(job, order);
      if (!it || it.tab !== s.tab || !ACTIVE.includes(it.state)) return false;
      it.state = state;
      it.wave = wave || it.wave || "";
      it.note = note || "";
      it.tab = null;
      it.ts = Date.now();
      return true;
    });
  }

  // Something unexpected: stop every tab and tell the user.
  async function fail(s, why, wave) {
    const order = s.order;
    clearInterval(heartbeat);
    await updateJob((job) => {
      if (!job) return;
      const it = order && itemOf(job, order);
      if (it) {
        it.state = "error";
        it.note = why;
        it.wave = wave || it.wave || "";
        it.tab = null;
      }
      job.stopped = true;
      job.stopReason = (order ? order + ": " : "") + why;
    });
    clearOrder(s);
    allowLeave();
    alert("Bulk waves stopped" + (order ? " at " + order : "") + ".\n\n" + why + "\n\nAll tabs in this run will stop.");
    if (location.pathname === CRITERIA_PATH) renderPanel();
    else goToCriteria();
  }

  // ---------- floating bar ----------

  function progressBar(s, status) {
    if (IN_FRAME) return; // the panel on the page shows progress
    let bar = document.getElementById("nsh-wave-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "nsh-wave-bar";
      bar.className = "nsh-wave-bar";
      bar.innerHTML =
        '<span id="nsh-wave-bar-text"></span>' +
        '<button type="button" id="nsh-wave-helper" title="Open another tab to work on this run">+ Helper Tab</button>' +
        '<button type="button" id="nsh-wave-stop">Stop</button>';
      document.body.appendChild(bar);
      bar.querySelector("#nsh-wave-helper").onclick = () => openHelpers(1);
      bar.querySelector("#nsh-wave-stop").onclick = async () => {
        await updateJob((job) => {
          if (job) {
            job.stopped = true;
            job.stopReason = "Stopped by you.";
          }
        });
        const cur = readSess();
        if (cur && cur.stage === "saving") {
          setBarText("Stopping after this save...");
          return; // let the save finish and be recorded
        }
        if (cur) {
          await releaseMine(cur);
          clearOrder(cur);
          if (cur.helper) return closeHelperTab();
        }
        setBarText("Stopped");
        goToCriteria();
      };
    }
    const job = readJob();
    const total = job ? job.items.length : 0;
    setBarText(
      "Bulk waves: " + (job ? doneCount(job) : 0) + " of " + total + " done" +
        (s.order ? " | " + (s.helper ? "helper" : "this tab") + ": " + s.order + (status ? " (" + status + ")" : "") : "") +
        (sessionStorage.getItem("nshWavesPopupNote") ? " | Pop-ups blocked, fewer tabs in use" : "")
    );
    const helperBtn = document.getElementById("nsh-wave-helper");
    if (helperBtn) helperBtn.style.display = s.helper ? "none" : "";
  }
  function setBarText(t) {
    const el = document.getElementById("nsh-wave-bar-text");
    if (el) el.textContent = t;
  }

  // ---------- steps ----------

  // On Wave Criteria: take the next order (if this tab has none) and search for it.
  // Search modes, in order: f1 and f2 filter on the internal number (a fresh page
  // ignores the filter, the reloaded page after it applies it), then "any" (all
  // open orders) before giving up.
  async function stepCriteria(s) {
    if (!s.order) {
      // Take the next order. If none are free but other tabs are still going,
      // stay ready in case one is handed back (a tab closed, or a tab yielded).
      let order = null;
      for (;;) {
        order = await updateJob((job) => {
          if (!job) return null;
          const problem = cleanupStale(job, s.tab, Date.now(), waveForOrder);
          if (problem) setTimeout(() => alert("Bulk waves stopped.\n\n" + problem), 0);
          return claimNext(job, s.tab, Date.now());
        });
        if (order) break;
        const job = readJob();
        if (!job || job.stopped || isFinished(job)) break;
        progressBar(s, "");
        setBarText("Bulk waves: " + doneCount(job) + " of " + job.items.length + " done | this tab: waiting for other tabs");
        await sleep(1500);
      }
      if (!order) {
        clearInterval(heartbeat);
        const helper = s.helper;
        writeSess(null);
        const bar = document.getElementById("nsh-wave-bar");
        if (bar) bar.remove();
        if (helper) return closeHelperTab();
        return renderPanel();
      }
      s.order = order;
      s.mode = null;
      s.stage = null;
      writeSess(s);
    }
    startHeartbeat(s);
    progressBar(s, "searching");

    const job = readJob();
    const order = s.order;
    const digits = job && job.tn && job.tn[order];

    // The first search from a freshly loaded Wave Criteria page comes back empty
    // (seen with and without the number filter); the same search on the page it
    // returns to works. So every kind of search gets two tries: f1, f2 (number
    // filter), then a1, a2 (all open orders) before an order is skipped.
    const ORDER = digits ? ["f1", "f2", "a1", "a2"] : ["a1", "a2"];
    const at = s.mode ? ORDER.indexOf(s.mode) : -1;
    const next = ORDER[at + 1];
    if (!next) {
      await record(s, "skipped", "", NOT_LISTED);
      clearOrder(s);
      return stepCriteria(s);
    }

    const ready = await waitFor(() => document.querySelector('[name="inpt_Transaction_LOCATION"]'));
    if (!ready) return fail(s, "The Wave Criteria page didn't load. NetSuite may have logged you out.");

    const filtered = next === "f1" || next === "f2";
    const ok =
      setDropdown("Transaction_LOCATION", (job && job.loc && job.loc[order] && job.loc[order].id) || KBH_WAREHOUSE) &&
      setDropdown("Transaction_TYPE", TYPES[order.slice(0, 2)]) &&
      setDropdown("Transaction_TRANSACTIONNUMBERTEXTtype", filtered ? "CONTAINS" : "ANY");
    setText("Transaction_TRANSACTIONNUMBERTEXT", filtered ? digits : "");
    if (!ok) return fail(s, "Couldn't set the search filters on Wave Criteria.");

    // Still ours? (Another tab may have taken it over if this tab stalled.)
    const check = await updateJob((j) => {
      if (!j || j.stopped) return "stopped";
      const it = itemOf(j, order);
      if (!it || it.tab !== s.tab || it.state !== "claimed") return "lost";
      it.progress = Date.now();
      it.ts = Date.now();
      return "ok";
    });
    if (check === "stopped") {
      await releaseMine(s);
      clearOrder(s);
      if (s.helper) return closeHelperTab();
      return renderPanel();
    }
    if (check === "lost") {
      clearOrder(s);
      return stepCriteria(s);
    }

    s.mode = next;
    s.stage = "search";
    writeSess(s);
    await sleep(200);
    allowLeave();
    (document.querySelector('input[name="submitter"]') || buttonByValue("Search")).click();

    // Watchdog: if the search hasn't moved the page on in 25 seconds, try again
    // from a fresh page. After 2 retries, hand the order back for another go.
    setTimeout(async () => {
      if (leaving) return;
      const cur = readSess();
      if (!cur || cur.order !== order || cur.stage !== "search") return;
      cur.retry = (cur.retry || 0) + 1;
      if (cur.retry > 2) {
        await releaseMine(cur);
        clearOrder(cur);
        return stepCriteria(cur);
      }
      cur.mode = null;
      writeSess(cur);
      goToCriteria();
    }, 25000);
  }

  // On the wave draft: tick only this order, wait for our turn, Save.
  async function stepDraft(s) {
    startHeartbeat(s);
    progressBar(s, "preparing");
    const order = s.order;
    const table = await waitFor(() => document.getElementById("Order__tab"), 30000);
    if (!table) {
      // Page stalled. Retry from Wave Criteria a couple of times before giving up.
      s.retry = (s.retry || 0) + 1;
      if (s.retry <= 2) {
        s.mode = null;
        writeSess(s);
        return goToCriteria();
      }
      return fail(s, "The wave page didn't load its order list after 3 tries.");
    }
    const rows = [...table.rows].filter((r) => r.querySelector('input[type="checkbox"][name^="Order_cb"]'));
    const row = rows.find((r) => r.cells[1] && r.cells[1].textContent.trim().toUpperCase() === order);

    if (!row) {
      if (s.mode === "f1" || s.mode === "f2") {
        // The number filter found other orders but not this one. Do the full
        // search next (two tries, as it starts from a fresh page).
        s.mode = "f2";
        writeSess(s);
        return goToCriteria();
      }
      // The full list loaded and this order isn't in it.
      await record(s, "skipped", "", NOT_LISTED);
      clearOrder(s);
      return goToCriteria();
    }

    if (!setDropdown("picktype", "MULTI")) return fail(s, "Couldn't set Picking Type to Multiple Orders.");
    await sleep(400);
    rows.forEach((r) => {
      const cb = r.querySelector('input[type="checkbox"][name^="Order_cb"]');
      if (cb.checked !== (r === row)) cb.click();
    });
    await sleep(600);
    const cb = row.querySelector('input[type="checkbox"][name^="Order_cb"]');
    if (!cb.checked) return fail(s, "Couldn't tick the order on the wave page.");
    const selected = fieldNumber("totalorders");
    if (selected !== 1) return fail(s, "The wave page shows " + selected + " orders selected instead of 1.");
    if (document.querySelector('[name="picktype"]').value !== "MULTI") return fail(s, "Picking Type didn't stay on Multiple Orders.");

    // Wait until every earlier order in the list is saved, so numbers stay in order.
    const mine = await updateJob((job) => {
      const it = job && itemOf(job, order);
      if (!it || it.tab !== s.tab || it.state !== "claimed") return false;
      it.state = "ready";
      it.ts = Date.now();
      it.progress = Date.now();
      return true;
    });
    if (!mine) {
      // Another tab took this order over while this one stalled. Leave it to them.
      clearInterval(heartbeat);
      clearOrder(s);
      return goToCriteria();
    }
    for (;;) {
      const verdict = await updateJob((job) => {
        if (!job) return "gone";
        const it = itemOf(job, order);
        if (!it || it.tab !== s.tab) return "lost";
        if (job.stopped) {
          it.state = "pending";
          it.tab = null;
          return "stopped";
        }
        const problem = cleanupStale(job, s.tab, Date.now(), waveForOrder);
        if (problem) {
          it.state = "pending";
          it.tab = null;
          return "stale:" + problem;
        }
        it.ts = Date.now();
        if (earlierPending(job, it)) {
          it.state = "pending"; // an earlier order has no tab; go take it instead
          it.tab = null;
          return "yield";
        }
        if (canSave(job, it)) {
          it.state = "saving";
          return "go";
        }
        return "wait";
      });
      if (verdict === "go") break;
      if (verdict === "wait") {
        progressBar(s, "waiting for earlier orders to save");
        await sleep(700);
        continue;
      }
      clearInterval(heartbeat);
      if (verdict === "yield" || verdict === "stopped") {
        clearOrder(s);
        return goToCriteria();
      }
      if (verdict.startsWith("stale:")) {
        clearOrder(s);
        alert("Bulk waves stopped.\n\n" + verdict.slice(6));
        return goToCriteria();
      }
      writeSess(null);
      alert("Bulk waves: this tab lost track of " + order + " (the run was cleared or taken over). Nothing was saved from this tab.");
      return goToCriteria();
    }

    if (!cb.checked || fieldNumber("totalorders") !== 1) return fail(s, "The selection changed while waiting. Nothing was saved.");

    // Last safety net: ask NetSuite itself whether a wave for this order has
    // appeared since Check List (made by another tab, or a save that was slow to
    // report back). If one has, never save another. Waves the order already had
    // at Check List don't count; you chose to wave those again.
    let fresh;
    try {
      const job = readJob();
      const id = (job.ids || {})[order];
      if (!id) throw new Error("No NetSuite id stored for " + order + ".");
      const known = (job.known || {})[order] || [];
      fresh = (findWaves({ [order]: id })[order] || []).filter((w) => !known.includes(w));
    } catch (err) {
      return fail(s, "Couldn't check NetSuite for an existing wave, so nothing was saved. " + err.message);
    }
    if (fresh.length) {
      clearInterval(heartbeat);
      await record(s, "done", fresh[0], "Wave " + fresh.join(", ") + " was already made during this run. Not saved again.");
      clearOrder(s);
      return goToCriteria();
    }

    // Testing switch: localStorage.nshWavesDryRun = "1" stops here without saving.
    if (localStorage.getItem("nshWavesDryRun") === "1") {
      clearInterval(heartbeat);
      await record(s, "skipped", "", "Dry run: ticked and ready, not saved");
      clearOrder(s);
      return goToCriteria();
    }

    progressBar(s, "saving");
    s.stage = "saving";
    writeSess(s);
    const save = buttonByValue("Save");
    if (!save) return fail(s, "Couldn't find the Save button.");
    allowLeave();
    save.click();
    setTimeout(() => {
      const cur = readSess();
      if (cur && cur.stage === "saving" && /CREATE_DRAFT/.test(location.search)) {
        fail(cur, "Save didn't go through after 30 seconds. Check the page for a NetSuite message.");
      }
    }, 30000);
  }

  // Back on the draft page after clicking Save means NetSuite refused it.
  function saveRefused(s) {
    const msg = [...document.querySelectorAll(".uir-message-text, .uir-alert-box, [class*='error']")]
      .map((e) => e.textContent.trim())
      .filter(Boolean)[0];
    return fail(s, "NetSuite didn't save the wave." + (msg ? ' It said: "' + msg.slice(0, 200) + '"' : ""));
  }

  // On the saved wave: check it, record its number, move on.
  async function stepSaved(s) {
    progressBar(s, "checking");
    const order = s.order;
    const wave = await waitFor(() => {
      const els = [
        document.querySelector(".uir-record-id"),
        document.querySelector('.uir-field-wrapper[data-field-name="name"] .uir-field'),
        document.querySelector('.uir-field-wrapper[data-field-name="tranid"] .uir-field'),
      ];
      for (const el of els) {
        const t = el && el.textContent.trim();
        if (t && /^\d+$/.test(t)) return t;
      }
      return null;
    }, 15000);
    if (!wave) return fail(s, "A wave was saved but its number couldn't be read. Check the Waves list.");

    const table = await waitFor(() => document.getElementById("waveorders_splits"), 10000);
    if (table) {
      const inWave = [...table.rows]
        .slice(1)
        .map((r) => ((r.cells[0] && r.cells[0].textContent.match(/\b(TO|SO)\d+\b/)) || [""])[0])
        .filter(Boolean);
      if (inWave.length !== 1 || inWave[0] !== order) {
        return fail(s, "Wave " + wave + " should hold only " + order + " but holds: " + (inWave.join(", ") || "nothing") + ". Check it in NetSuite.", wave);
      }
    }

    const problem = await updateJob((job) => {
      if (!job) return "The run was cleared while this wave was saving. Wave " + wave + " is for " + order + ".";
      const it = itemOf(job, order);
      const earlier = job.items.filter((x) => x.i < it.i && x.state === "done" && x.wave);
      const maxEarlier = Math.max(0, ...earlier.map((x) => Number(x.wave)));
      const dupe = job.items.find((x) => x !== it && x.wave === wave);
      if (it.state === "done" && it.wave && it.wave !== wave) {
        const first = it.wave;
        it.note = "Has two waves: " + first + " and " + wave + ". Delete one.";
        return order + " now has two waves (" + first + " and " + wave + "). Delete " + wave + " in NetSuite, or delete " + first + " and fix the tracker.";
      }
      it.state = "done";
      it.wave = wave;
      it.tab = null;
      it.ts = Date.now();
      it.note = table ? "" : "Couldn't check which order the wave holds.";
      if (dupe) return "Wave " + wave + " was also recorded for " + dupe.order + ".";
      if (Number(wave) <= maxEarlier) {
        it.note = "Out of order";
        return "Wave " + wave + " for " + order + " came out lower than an earlier order's wave (" + maxEarlier + ").";
      }
      return "";
    });
    if (problem) {
      clearInterval(heartbeat);
      await updateJob((job) => {
        if (job) {
          job.stopped = true;
          job.stopReason = problem;
        }
      });
      clearOrder(s);
      alert("Bulk waves stopped.\n\n" + problem + "\n\nAll tabs in this run will stop.");
      return goToCriteria();
    }
    clearOrder(s);
    goToCriteria();
  }

  // ---------- panel on the Wave Criteria page ----------

  let panelMode = "";

  // Built like a NetSuite field group ("Primary Information"): grey title bar
  // with a chevron that collapses it, body underneath.
  function getPanel() {
    let panel = document.getElementById("nsh-wave-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "nsh-wave-panel";
      panel.className = "nsh-wave-panel";
      panel.innerHTML =
        '<div class="nsh-fg-title" role="button" aria-expanded="true"><span class="nsh-chevron"></span><span class="nsh-fg-text"></span></div>' +
        '<div class="nsh-fg-body"></div>';
      panel.querySelector(".nsh-fg-title").onclick = () => {
        const collapsed = panel.classList.toggle("nsh-collapsed");
        panel.querySelector(".nsh-fg-title").setAttribute("aria-expanded", String(!collapsed));
      };
      const anchor = document.querySelector(".uir-page-title") || document.body.firstChild;
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }
    return panel;
  }
  function fill(panel, title, html) {
    panel.querySelector(".nsh-fg-text").textContent = title;
    panel.querySelector(".nsh-fg-body").innerHTML = html;
  }

  // quiet = don't show the end-of-run pop-up (helper tabs).
  async function renderPanel(quiet) {
    if (IN_FRAME) return;
    const panel = getPanel();
    let job = readJob();
    if (job && !job.stopped && !isFinished(job)) {
      const problem = await updateJob((j) => (j ? cleanupStale(j, "", Date.now(), waveForOrder) : ""));
      if (problem) alert("Bulk waves stopped.\n\n" + problem);
      job = readJob();
    }
    if (!job) return renderInput(panel);
    if (!job.stopped && !isFinished(job)) return renderRunning(panel, job);
    renderResults(panel, job);
    if (!job.alerted && !quiet) {
      const issues = await updateJob((j) => {
        if (!j || j.alerted) return null;
        j.alerted = true;
        return finalIssues(j);
      });
      if (issues && issues.length) {
        alert(
          "Bulk waves " + (job.stopped ? "stopped" : "finished") + " with " + issues.length +
            " thing" + (issues.length > 1 ? "s" : "") + " to check:\n\n" + issues.slice(0, 15).join("\n") +
            (issues.length > 15 ? "\n...and " + (issues.length - 15) + " more (see the list)." : "")
        );
      }
    }
  }

  function renderInput(panel) {
    panelMode = "input";
    fill(
      panel,
      "Bulk Waves",
      '<label class="nsh-label" for="nsh-wave-input">TO or SO numbers</label>' +
        '<textarea id="nsh-wave-input" rows="6" placeholder="TO12345&#10;SO123456&#10;800012345"></textarea>' +
        '<div class="nsh-wave-actions"><button type="button" id="nsh-wave-check">Check List</button></div>' +
        '<div id="nsh-wave-confirm"></div>'
    );
    const ta = panel.querySelector("#nsh-wave-input");
    panel.querySelector("#nsh-wave-check").onclick = (e) => {
      const box = panel.querySelector("#nsh-wave-confirm");
      let conv = null;
      try {
        conv = posToTOs(ta.value);
      } catch (err) {}
      if (!conv) {
        alert("Bulk waves: couldn't look the store POs up in NetSuite. Refresh the page and try again.");
        return;
      }
      const parsed = parseOrders(conv.text);
      const poOf = {}; // TO -> the store PO it was found from
      Object.keys(conv.found).forEach((po) => (poOf[conv.found[po]] = po));
      // POs with no TO are listed as such, not as "not a TO or SO number".
      parsed.bad = parsed.bad.filter((t) => !conv.missing.includes(t));
      if (!parsed.good.length) {
        box.innerHTML = '<p class="nsh-wave-warn">No TO or SO numbers found' + (conv.missing.length ? " (no TO found for " + conv.missing.map(esc).join(", ") + ")" : "") + ".</p>";
        return;
      }
      e.target.disabled = true;
      e.target.textContent = "Checking...";
      setTimeout(() => {
        let found = null;
        let already = null;
        try {
          found = lookupOrders(parsed.good);
          already = found ? findWaves(found.ids) : null;
        } catch (err) {
          found = null;
        }
        e.target.disabled = false;
        e.target.textContent = "Check List";
        if (!found || !already) {
          box.innerHTML = '<p class="nsh-wave-warn">Couldn\'t look the orders up in NetSuite. Refresh the page and try again.</p>';
          alert("Bulk waves: couldn't look the orders up in NetSuite. Refresh the page and try again.");
          return;
        }
        const tn = found.tn;
        const missing = parsed.good.filter((o) => !tn[o]);
        const waved = parsed.good.filter((o) => tn[o] && already[o]);
        const toWave = parsed.good.filter((o) => tn[o] && !already[o]);
        const warnings = [];
        if (parsed.dupes.length) {
          warnings.push(
            "Duplicates (each gets one wave):\n" +
              parsed.dupes.map((d) => "  " + d + " (listed " + parsed.all.filter((o) => o === d).length + " times)").join("\n")
          );
        }
        if (missing.length) warnings.push("Not found in NetSuite (will be skipped):\n  " + missing.join("\n  "));
        if (parsed.bad.length) warnings.push("Not a TO or SO number (ignored):\n  " + parsed.bad.join("\n  "));
        if (conv.missing.length) warnings.push("Store PO with no TO in NetSuite (skipped):\n  " + conv.missing.join("\n  "));
        // Stock split between two warehouses (e.g. KBH and Online): only the KBH part gets waved.
        const loc = found.loc || {};
        const mixed = toWave.filter((o) => loc[o] && loc[o].mixed);
        if (mixed.length) warnings.push("Stock at two warehouses (waved at KBH Warehouse only; wave the other part by hand):\n  " + mixed.join("\n  "));
        const elsewhere = toWave.filter((o) => loc[o] && loc[o].id !== KBH_WAREHOUSE);
        // Orders with an older wave may still have lines left to wave (e.g. stock
        // that came back in), so ask rather than always skip.
        let reWave = false;
        if (waved.length) {
          reWave = confirm(
            (warnings.length ? "Check your list before you carry on.\n\n" + warnings.join("\n\n") + "\n\n" : "") +
              "These already have a wave in NetSuite:\n" +
              waved.map((o) => "  " + o + " (wave " + already[o].join(", ") + ")").join("\n") +
              "\n\nOK = wave them again (only if they still have lines to pick).\nCancel = skip them."
          );
        } else if (warnings.length) {
          alert("Check your list before you carry on.\n\n" + warnings.join("\n\n"));
        }
        if (reWave) toWave.splice(0, toWave.length, ...parsed.good.filter((o) => tn[o]));

        box.innerHTML =
          (toWave.length
            ? "<p><b>" + toWave.length + " wave" + (toWave.length > 1 ? "s" : "") + " will be created, in this order:</b> " +
              toWave.map((o) => esc(o) + (poOf[o] ? " (PO " + esc(poOf[o]) + ")" : "")).join(", ") + "</p>"
            : '<p class="nsh-wave-warn">None of these can be waved.</p>') +
          (conv.missing.length ? '<p class="nsh-wave-warn">No TO in NetSuite for PO ' + conv.missing.map(esc).join(", ") + "</p>" : "") +
          (elsewhere.length
            ? '<p class="nsh-wave-hint">Waved at their own warehouse: ' + elsewhere.map((o) => esc(o) + " (" + esc(loc[o].name) + ")").join(", ") + "</p>"
            : "") +
          (parsed.dupes.length ? '<p class="nsh-wave-warn">Duplicates: ' + parsed.dupes.map(esc).join(", ") + ". One wave each, copied to every row they're on.</p>" : "") +
          (waved.length
            ? '<p class="nsh-wave-warn">Already have a wave' + (reWave ? ", waving again: " : ", skipped: ") +
              waved.map((o) => esc(o) + " (" + esc(already[o].join(", ")) + ")").join(", ") + "</p>"
            : "") +
          (missing.length ? '<p class="nsh-wave-warn">Not found in NetSuite: ' + missing.map(esc).join(", ") + "</p>" : "") +
          (parsed.bad.length ? '<p class="nsh-wave-warn">Ignored: ' + parsed.bad.map(esc).join(", ") + "</p>" : "") +
          (toWave.length
            ? delBoxes(toWave, {}, found.store) +
              '<label class="nsh-print-stamp"><input type="checkbox" id="nsh-wave-autoprint"' + (localStorage.getItem("nshWavesAutoPrint") === "1" ? " checked" : "") + '> Send the picking tickets to AutoPrint when the waves are done</label>' +
              '<div class="nsh-wave-actions"><button type="button" class="nsh-primary" id="nsh-wave-go">Create ' +
              toWave.length + " Wave" + (toWave.length > 1 ? "s" : "") + "</button></div>"
            : "");
        const readDels = wireDelBoxes(box);
        // The AutoPrint tick is remembered in this browser (26/11/2026).
        const apBox = box.querySelector("#nsh-wave-autoprint");
        if (apBox)
          apBox.onchange = () => {
            try {
              localStorage.setItem("nshWavesAutoPrint", apBox.checked ? "1" : "0");
            } catch (e) {}
          };
        const go = box.querySelector("#nsh-wave-go");
        if (go) {
          go.onclick = async () => {
            const cur = readJob();
            if (cur && !cur.stopped && !isFinished(cur)) {
              alert("Another bulk wave run is still going. Stop it or wait for it to finish first.");
              return renderPanel();
            }
            go.disabled = true;
            const started = await updateJob((cur) => {
              if (cur && !cur.stopped && !isFinished(cur)) return false;
              const autoPrint = !!(box.querySelector("#nsh-wave-autoprint") || {}).checked;
              writeJob(Object.assign(buildJob(parsed, tn, found.ids, reWave ? {} : already, already), { loc: found.loc || {}, autoPrint, printState: "", del: readDels(), store: found.store || {} }));
              return true;
            });
            if (!started) {
              alert("Another bulk wave run is still going. Stop it or wait for it to finish first.");
              return renderPanel();
            }
            // The frames join the run that was just saved; this page only shows progress.
            openHelpers(1 + helpersFor(toWave.length));
            renderPanel();
          };
        }
      }, 30);
    };
  }

  async function joinRun(helper) {
    if (!helper && !IN_FRAME) {
      // From the panel (Help With This Run / Resume): one more frame does the work.
      openHelpers(1);
      return renderPanel();
    }
    const job = readJob();
    if (!job || job.stopped || isFinished(job)) return helper ? closeHelperTab() : renderPanel();
    const s = { job: job.id, tab: newTabId(), order: null, mode: null, stage: null, helper: !!helper };
    await holdTabLock(s.tab);
    writeSess(s);
    stepCriteria(s);
  }

  function renderRunning(panel, job) {
    panelMode = "running";
    fill(
      panel,
      "Bulk Waves: Running",
      "<p>" + doneCount(job) + " of " + job.items.length + " done." + (workingHere() ? "" : " Another tab is working on it.") + "</p>" +
        '<div class="nsh-wave-actions">' +
        (workingHere() ? "" : '<button type="button" class="nsh-primary" id="nsh-wave-join">Help With This Run</button>') +
        '<button type="button" id="nsh-wave-stopall">' + (workingHere() ? "Stop" : "Stop All") + "</button></div>" +
        resultsTable(job)
    );
    const join = panel.querySelector("#nsh-wave-join");
    if (join) join.onclick = () => joinRun(false);
    panel.querySelector("#nsh-wave-stopall").onclick = () =>
      updateJob((j) => {
        if (j) {
          j.stopped = true;
          j.stopReason = "Stopped by you.";
        }
      }).then(renderPanel);
    wireWaveClicks(panel);
  }

  function resultsTable(job) {
    const itemByOrder = {};
    job.items.forEach((it) => (itemByOrder[it.order] = it));
    const lines = job.all;
    const count = {};
    lines.forEach((o) => (count[o] = (count[o] || 0) + 1));
    const nthSeen = {};
    return (
      '<table class="nsh-wave-table"><tr><th>Order</th><th>Wave</th><th></th></tr>' +
      lines
        .map((o) => {
          const it = itemByOrder[o] || { state: "skipped", note: "" };
          const nth = (nthSeen[o] = (nthSeen[o] || 0) + 1);
          let cls = "";
          let note = it.note || "";
          if (it.state === "pending") {
            note = "Not started";
            cls = "nsh-wave-wait";
          } else if (ACTIVE.includes(it.state)) {
            note = it.state === "saving" ? "Saving..." : "In progress";
            cls = "nsh-wave-wait";
          } else if (it.state === "skipped" || it.state === "error" || note === "Out of order") {
            cls = "nsh-wave-bad";
          }
          if (count[o] > 1) {
            note = (nth === 1 ? "Duplicate: listed " + count[o] + " times" : "Duplicate: same wave as above") + (note ? ". " + note : "");
            if (!cls) cls = "nsh-wave-dupe";
          }
          // Order number opens the record. Runs from before ids were stored look it up on click.
          const id = job.ids && job.ids[o];
          const orderCell = id
            ? '<a class="nsh-order-link" href="/app/accounting/transactions/transaction.nl?id=' + encodeURIComponent(id) + '">' + esc(o) + "</a>"
            : '<a class="nsh-order-link nsh-order-lookup" href="#" data-order="' + esc(o) + '">' + esc(o) + "</a>";
          return (
            '<tr class="' + cls + '"><td>' + orderCell + "</td><td>" +
            (it.wave ? '<span class="nsh-copyable nsh-wave-num" title="Click to copy">' + esc(it.wave) + "</span>" : "-") +
            "</td><td>" + esc(note) + "</td></tr>"
          );
        })
        .join("") +
      "</table>"
    );
  }

  function wireWaveClicks(panel) {
    panel.querySelectorAll(".nsh-order-lookup").forEach((a) => {
      a.onclick = (e) => {
        e.preventDefault();
        const order = a.dataset.order;
        try {
          const found = lookupOrders([order]);
          const id = found && found.ids[order];
          if (!id) return alert("Couldn't find " + order + " in NetSuite.");
          const url = "/app/accounting/transactions/transaction.nl?id=" + encodeURIComponent(id);
          if (e.ctrlKey || e.metaKey) window.open(url, "_blank");
          else location.href = url;
        } catch (err) {
          alert("Couldn't open " + order + ": " + err.message);
        }
      };
    });
    panel.querySelectorAll(".nsh-wave-num").forEach((el) => {
      el.onclick = () => {
        const wave = el.textContent;
        copy(wave);
        el.textContent = "Copied";
        setTimeout(() => (el.textContent = wave), 1000);
      };
    });
  }

  // ---------- picking tickets for the waved orders ----------

  // Delivery date boxes for store tickets (26/11/2026): "DEL: 2/12" stamped next to the
  // wave, as the SOP has it written. Optional: a blank box = no DEL stamp. One box sets
  // them all; each ticket can then be changed. dels = { TO: "2026-12-02" }.
  // stores = { TO: store name }: the TOs are shown in their store blocks (1/6, 2/6...) like
  // Bulk Print, and only the first ticket of each block gets a box (the date goes on that one).
  function delBoxes(orders, dels, stores) {
    const tos = orders.filter((o) => o.startsWith("TO"));
    if (!tos.length) return "";
    const st = stores || {};
    const count = {};
    tos.forEach((o) => (count[st[o]] = (count[st[o]] || 0) + 1));
    const seen = {};
    return (
      '<label class="nsh-label">Delivery date (all store tickets)</label><input type="date" class="nsh-del-all">' +
      '<table class="nsh-wave-table"><tr><th>Order</th><th>Store</th><th>Ticket</th><th>Delivery</th></tr>' +
      tos
        .map((o) => {
          const n = (seen[st[o]] = (seen[st[o]] || 0) + 1);
          return (
            "<tr><td>" + esc(o) + "</td><td>" + esc(String(st[o] || "").replace(/^Stores : /, "")) + "</td><td>" + n + "/" + count[st[o]] + "</td><td>" +
            (n === 1 ? '<input type="date" class="nsh-del" data-order="' + esc(o) + '" value="' + esc((dels || {})[o] || "") + '">' : "") +
            "</td></tr>"
          );
        })
        .join("") +
      "</table>"
    );
  }
  // Wires the boxes; returns a function that reads them. onChange(dels) after any change.
  function wireDelBoxes(root, onChange) {
    const all = root.querySelector(".nsh-del-all");
    const boxes = [...root.querySelectorAll(".nsh-del")];
    const read = () => {
      const d = {};
      boxes.forEach((b) => b.value && (d[b.dataset.order] = b.value));
      return d;
    };
    if (all)
      all.onchange = () => {
        boxes.forEach((b) => (b.value = all.value));
        if (onChange) onChange(read());
      };
    boxes.forEach((b) => (b.onchange = () => onChange && onChange(read())));
    return read;
  }

  let ticketCache = null; // { key, bytes, url, done, failed }
  async function buildTickets(orders, status, btn) {
    const dels = (readJob() || {}).del || {};
    const key = orders.join(",") + "|" + JSON.stringify(dels);
    if (ticketCache && ticketCache.key === key) return ticketCache;
    if (!window.__nshTickets) {
      alert("Bulk waves: the ticket printer didn't load. Reload the extension and refresh this page.");
      return null;
    }
    if (btn) btn.disabled = true;
    try {
      const res = await window.__nshTickets.ticketsPdf(orders, (i, n) => {
        if (status) status.textContent = i < n ? "Getting picking tickets... " + i + " of " + n : "Joining " + n + " tickets...";
      }, dels);
      if (!res.bytes) throw new Error(res.failed.map((f) => f.order + ": " + f.error).join("; ") || "no tickets");
      const url = URL.createObjectURL(new Blob([res.bytes], { type: "application/pdf" }));
      ticketCache = { key, bytes: res.bytes, url, done: res.done, failed: res.failed };
      if (res.failed.length) alert("Bulk waves: these tickets couldn't be fetched (the rest are in the PDF):\n\n" + res.failed.map((f) => f.order + ": " + f.error).join("\n"));
      return ticketCache;
    } catch (err) {
      if (status) status.textContent = "Couldn't get the picking tickets: " + err.message;
      alert("Bulk waves: couldn't get the picking tickets.\n\n" + err.message);
      return null;
    } finally {
      if (btn) btn.disabled = false;
    }
  }
  async function ticketsUrl(orders, status, btn) {
    const t = await buildTickets(orders, status, btn);
    if (t && status) status.textContent = t.done.length + " picking tickets ready, in list order.";
    return t && t.url;
  }
  async function sendTickets(orders, status, btn, auto) {
    const t = await buildTickets(orders, status, btn);
    if (!t) {
      if (auto) await updateJob((j) => j && (j.printState = ""));
      return;
    }
    if (status) status.textContent = "Sending " + t.done.length + " tickets to AutoPrint...";
    const res = await window.__nshTickets.sendToAutoPrint(t.bytes, "PickingTickets_Waves_" + t.done.length + ".pdf");
    if (res.ok) {
      if (status) status.textContent = t.done.length + " picking tickets sent to AutoPrint (page printer). If nothing prints, check the AutoPrint helper is running.";
      if (auto) await updateJob((j) => j && (j.printState = "done"));
    } else {
      if (status) status.textContent = "Couldn't send to AutoPrint: " + res.error;
      alert("Bulk waves: couldn't send the tickets to AutoPrint.\n\n" + res.error + "\n\nUse Print Tickets instead.");
      if (auto) await updateJob((j) => j && (j.printState = ""));
    }
  }

  function renderResults(panel, job) {
    panelMode = "results";
    const waveOf = {};
    job.items.forEach((it) => (waveOf[it.order] = it.state === "done" ? it.wave : ""));
    const seenT = new Set();
    const ticketOrders = job.all.filter((o) => waveOf[o] && !seenT.has(o) && seenT.add(o));
    const remaining = job.items.filter((x) => x.state === "pending" || ACTIVE.includes(x.state) || (x.state === "error" && !x.wave)).length;
    const dupeLines = job.all.length - new Set(job.all).size;
    const problems = job.items.filter((x) => x.state === "skipped" || x.state === "error" || x.note === "Out of order").length;
    fill(
      panel,
      "Bulk Waves: " + (job.stopped ? "Stopped" : "Done"),
      (job.stopped && job.stopReason ? '<p class="nsh-wave-warn">' + esc(job.stopReason) + "</p>" : "") +
      "<p>" + doneCount(job) + " of " + job.items.length + " waves created." +
      (problems ? ' <span class="nsh-wave-warn">' + problems + " to check (red).</span>" : "") +
      (dupeLines ? ' <span class="nsh-wave-warn">' + dupeLines + " duplicate row" + (dupeLines > 1 ? "s" : "") + " (yellow).</span>" : "") +
      "</p>" +
      resultsTable(job) +
      '<div class="nsh-wave-actions">' +
      (job.stopped && remaining ? '<button type="button" class="nsh-primary" id="nsh-wave-resume">Resume (' + remaining + " Left)</button>" : "") +
      '<button type="button"' + (job.stopped && remaining ? "" : ' class="nsh-primary"') + ' id="nsh-wave-copy">Copy Wave Numbers</button>' +
      '<button type="button" id="nsh-wave-copy-both">Copy Orders + Waves</button>' +
      '<button type="button" id="nsh-wave-new">New Batch</button></div>' +
      (doneCount(job)
        ? '<div class="nsh-wave-actions">' +
          '<button type="button" id="nsh-wave-tickets-auto">Send Tickets to AutoPrint</button>' +
          '<button type="button" id="nsh-wave-tickets-print">Print Tickets</button>' +
          '<button type="button" id="nsh-wave-tickets-open">Open Tickets PDF</button></div>' +
          '<div id="nsh-wave-dels">' + delBoxes(ticketOrders, job.del, job.store) + "</div>" +
          '<p class="nsh-wave-hint" id="nsh-wave-print-status">' +
          (job.printState === "done" ? "Picking tickets were sent to AutoPrint." : "") +
          "</p>"
        : "")
    );

    const delsBox = panel.querySelector("#nsh-wave-dels");
    if (delsBox) wireDelBoxes(delsBox, (d) => updateJob((j) => j && (j.del = d)));
    panel.querySelector("#nsh-wave-copy").onclick = (e) => copy(job.all.map((o) => waveOf[o] || "").join("\n"), e.target);
    panel.querySelector("#nsh-wave-copy-both").onclick = (e) =>
      copy(job.all.map((o) => o + "\t" + (waveOf[o] || "")).join("\n"), e.target);
    // Picking tickets for the waved orders, built here by Bulk Print's own code
    // (print.js lends it as window.__nshTickets): send to AutoPrint, print, or open.
    const status = panel.querySelector("#nsh-wave-print-status");
    const ticketBtn = (id, fn) => {
      const b = panel.querySelector(id);
      if (b) b.onclick = () => fn(b);
    };
    ticketBtn("#nsh-wave-tickets-auto", (b) => sendTickets(ticketOrders, status, b));
    ticketBtn("#nsh-wave-tickets-print", async (b) => {
      const url = await ticketsUrl(ticketOrders, status, b);
      if (url) window.__nshTickets.printPdf(url);
    });
    ticketBtn("#nsh-wave-tickets-open", async (b) => {
      const url = await ticketsUrl(ticketOrders, status, b);
      if (url) window.open(url, "_blank");
    });
    // Ticked "send to AutoPrint when done": one tab only (claimed in the shared run).
    if (job.autoPrint && !job.printState && !job.stopped && isFinished(job) && ticketOrders.length) {
      updateJob((j) => {
        if (!j || j.id !== job.id || j.printState) return false;
        j.printState = "printing";
        return true;
      }).then((mine) => {
        if (mine) sendTickets(ticketOrders, status, null, true);
      });
    }
    panel.querySelector("#nsh-wave-new").onclick = () => {
      writeJob(null);
      writeSess(null);
      renderInput(panel);
    };
    wireWaveClicks(panel);
    const resume = panel.querySelector("#nsh-wave-resume");
    if (resume) {
      resume.onclick = async () => {
        await updateJob((j) => {
          if (!j) return;
          j.stopped = false;
          j.stopReason = "";
          j.alerted = false;
          j.items.forEach((it) => {
            // Retry errors that never produced a wave. A wave that exists stays as it is.
            if ((it.state === "error" && !it.wave) || ACTIVE.includes(it.state)) {
              it.state = "pending";
              it.tab = null;
              it.note = "";
            }
          });
        });
        openHelpers(1 + helpersFor(remaining));
        renderPanel();
      };
    }
  }

  // Keep idle tabs' panels up to date as other tabs work.
  let refreshTimer = null;
  window.addEventListener("storage", (e) => {
    if (e.key !== JOB_KEY || location.pathname !== CRITERIA_PATH) return;
    const s = readSess();
    if (s && s.order) return; // this tab is busy working
    if (panelMode === "input" && e.newValue === null) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => renderPanel(!!(s && s.helper)), 300);
  });

  // ---------- start ----------

  async function main() {
    const onCriteria = location.pathname === CRITERIA_PATH;
    const onWave = location.pathname === WAVE_PATH;
    const onDraft = onWave && /CREATE_DRAFT/.test(location.search);
    const onSavedWave = onWave && !onDraft && /[?&]id=\d+/.test(location.search);
    const job = readJob();
    let s = readSess();

    // A helper tab is opened from a working tab, and the browser copies that
    // tab's sessionStorage into it. Throw the copy away: a helper must never
    // carry on as the tab that opened it (that caused a doubled wave).
    const isHelperLoad = onCriteria && (location.hash === "#nshhelp" || (IN_FRAME && location.hash === "#nshframe"));
    if (isHelperLoad) {
      writeSess(null);
      sessionStorage.removeItem("nshWavesPopupNote");
      s = null;
    }

    if (s && (!job || job.id !== s.job)) {
      writeSess(null);
      s = null;
    }

    // Same protection for a duplicated browser tab: only one page may act as a
    // given worker. If another page holds this worker's lock, start fresh.
    if (s && !(await holdTabLock(s.tab))) {
      writeSess(null);
      s = null;
    }

    // A helper tab (opened automatically or with "+ Helper Tab") joins the run.
    // It can load a moment before the run is saved, so give it a few seconds.
    if (isHelperLoad) {
      history.replaceState(null, "", location.pathname);
      const running = await waitFor(() => {
        const j = readJob();
        return j && !j.stopped && !isFinished(j) ? j : null;
      }, 10000);
      if (running) return joinRun(true);
      if (IN_FRAME) return closeHelperTab();
    }
    if (IN_FRAME && !s) return; // a frame that isn't one of ours, or has finished

    if (s && s.order) {
      if (s.stage === "saving") {
        if (onSavedWave) return stepSaved(s);
        if (onDraft) return saveRefused(s);
        return onCriteria ? renderPanel() : undefined; // the stale check will catch it
      }
      if (job.stopped) {
        await releaseMine(s);
        clearOrder(s);
        if (s.helper) return closeHelperTab();
        if (onCriteria) return renderPanel();
        return goToCriteria();
      }
      if (onCriteria) return stepCriteria(s);
      if (onDraft && s.stage === "search") return stepDraft(s);
      return;
    }
    if (s && !s.order && onCriteria && job && !job.stopped && !isFinished(job)) return stepCriteria(s);
    if (onCriteria) renderPanel();
  }

  // Test hook (only when a test sets it up before this script runs).
  if (window.__nshWavesTest) {
    Object.assign(window.__nshWavesTest, {
      parseOrders, buildJob, claimNext, canSave, earlierPending, cleanupStale, finalIssues, isFinished, helpersFor,
      STALE_MS, CLAIM_STALE_MS, READY_STALE_MS, SAVE_STALE_MS,
    });
    return;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", main);
  else main();
})();
