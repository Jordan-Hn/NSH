// NetSuite Helper background: Auto Print.
//
// 1. Toolbar button (same as the old "NetSuite Auto Print" extension):
//    clicking it saves the PDF open in the current tab to Downloads\AutoPrint
//    with no Save dialog. The AutoPrint helper watches that folder, prints each
//    file on the right printer (labels -> label printer, pages -> page printer),
//    then deletes it.
// 2. Bulk print can send its joined picking tickets the same way.
// 3. Invoices get their connote printed in the top-left corner (looked up from
//    the order's item fulfilment), so they're easy to match with their labels.
//    If that fails in any way, the invoice prints exactly as before.

importScripts("lib/pdf-lib.min.js", "lib/packingslip-fix.js");

const FOLDER = "AutoPrint";

function flash(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  // null = go back to the overall badge (e.g. "AP?" if the helper isn't running).
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: null }).catch(() => chrome.action.setBadgeText({ tabId, text: "" }));
    chrome.action.setBadgeBackgroundColor({ tabId, color: null }).catch(() => {});
  }, 3000);
}

// ---------- Off switch (27/11/2026) ----------
// A remote off switch for every PC, kept on its own branch of the update repo (the
// release on main is signed and never changes for this). switch.json = {"on": false}
// turns every tool off: NetSuite pages are left exactly as NetSuite makes them, the Auto
// Print button does nothing, and nothing is sent to AutoPrint. {"on": true} (or no file)
// = normal. Checked when the browser starts, every 15 minutes, and when a NetSuite page
// loads (at most every 5 minutes). If GitHub can't be reached, the last answer stands.
// Flipped with plugin-switch.ps1 on the release PC.
const SWITCH_URL = "https://raw.githubusercontent.com/Jordan-Hn/NSH/switch/switch.json";
let pluginOff = false;
let switchCheckedAt = 0;
chrome.storage.local.get("nshOff").then((v) => setOff(!!v.nshOff, false));
chrome.storage.onChanged.addListener((c, area) => area === "local" && c.nshOff && setOff(!!c.nshOff.newValue, false));
function setOff(off, save) {
  pluginOff = off;
  if (save) chrome.storage.local.set({ nshOff: off });
  if (off) {
    chrome.action.setBadgeBackgroundColor({ color: "#777777" });
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setTitle({ title: "NetSuite Helper is turned off" });
  } else {
    chrome.action.getBadgeText({}).then((t) => {
      if (t === "OFF") chrome.action.setBadgeText({ text: "" });
      if (typeof showHelperState === "function") showHelperState();
    });
  }
}
async function checkSwitch(force) {
  if (!force && Date.now() - switchCheckedAt < 5 * 60000) return;
  switchCheckedAt = Date.now();
  try {
    const res = await fetch(SWITCH_URL + "?t=" + Date.now(), { cache: "no-store" });
    if (res.status === 404) return setOff(false, true); // no switch file = on
    if (!res.ok) return; // GitHub trouble: keep the last answer
    const j = await res.json();
    if (typeof j.on === "boolean") setOff(!j.on, true);
  } catch (e) {} // offline: keep the last answer
}
chrome.alarms.create("nsh-switch", { periodInMinutes: 15 });
chrome.alarms.onAlarm.addListener((a) => a.name === "nsh-switch" && checkSwitch(true));
chrome.runtime.onStartup.addListener(() => checkSwitch(true));
chrome.runtime.onInstalled.addListener(() => checkSwitch(true));
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "nsh-switch-check") return;
  checkSwitch(false).finally(() => reply({ off: pluginOff }));
  return true;
});

// ---------- AutoPrint helper: started by the browser ----------
// The browser starts autoprint\host.cmd (registered by Setup.cmd, no admin
// needed), which starts the AutoPrint helper if it isn't running, restarts it if
// it stops, and reports back. Stays connected while the browser is open.

const HOST = "com.kokoblack.autoprint";
const DEFAULT_TITLE = "Auto Print (labels -> label printer, invoices -> page printer)";
let hostPort = null;
let helperState = "unknown"; // running | stopped | missing

function showHelperState() {
  if (pluginOff) return; // the OFF badge stays while the switch is off
  if (helperState === "running") {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: DEFAULT_TITLE });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: "#b00020" });
  chrome.action.setBadgeText({ text: "AP?" });
  chrome.action.setTitle({
    title:
      helperState === "missing"
        ? "AutoPrint isn't set up on this PC yet. Double-click autoprint\\Setup.cmd once, then restart the browser."
        : "The AutoPrint helper isn't running, so nothing will print. Click the button to try again, or double-click autoprint\\Restart AutoPrint.cmd.",
  });
}

function connectHost() {
  if (hostPort) return;
  try {
    hostPort = chrome.runtime.connectNative(HOST);
  } catch (e) {
    hostPort = null;
    helperState = "missing";
    showHelperState();
    return;
  }
  hostPort.onMessage.addListener((m) => {
    helperState = m && m.running ? "running" : "stopped";
    showHelperState();
    reloadIfUpdated(m && m.version);
  });
  hostPort.onDisconnect.addListener(() => {
    const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "";
    hostPort = null;
    helperState = /not found|forbidden|native messaging host/i.test(err) ? "missing" : "stopped";
    showHelperState();
  });
}

// The launcher reports the version of the files in the extension folder. If it's
// different from what the browser has loaded (someone copied in an update), reload
// the extension so the new files take effect. Waits 10 s so anything in progress
// (a print being sent) finishes first. NetSuite pages need a refresh after it.
let reloadPending = false;
function reloadIfUpdated(folderVersion) {
  const loaded = chrome.runtime.getManifest().version;
  if (!folderVersion || folderVersion === loaded || reloadPending) return;
  reloadPending = true;
  console.log("NetSuite Helper: folder has " + folderVersion + ", loaded " + loaded + ". Reloading.");
  chrome.action.setBadgeBackgroundColor({ color: "#006aff" });
  chrome.action.setBadgeText({ text: "NEW" });
  chrome.action.setTitle({ title: "Updating NetSuite Helper to " + folderVersion + " once nothing is running... Refresh NetSuite pages after." });
  // Never reload in the middle of a run: it cuts the page off from AutoPrint
  // (23/11/2026, Ship Orders retry). Wait until no NetSuite tab is busy.
  const tryReload = async () => {
    if (await anyToolBusy()) return setTimeout(tryReload, 15000);
    chrome.runtime.reload();
  };
  setTimeout(tryReload, 10000);
}

// True while Ship Orders, Bulk Print or Bulk Waves is mid-run in any NetSuite tab.
async function anyToolBusy() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://*.netsuite.com/*" });
  } catch (e) {
    return false;
  }
  for (const tab of tabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          if (window.__nshBusy) return true;
          try {
            const job = JSON.parse(localStorage.getItem("nshBulkWavesJob") || "null");
            if (job && !job.stopped && job.items && job.items.some((x) => ["pending", "claimed", "ready", "saving"].includes(x.state))) return true;
          } catch (e) {}
          return false;
        },
      });
      if (res && res.result) return true;
    } catch (e) {}
  }
  return false;
}

// Make sure the helper is up (starts the connection if needed, else asks it to check).
function checkHelper() {
  if (!hostPort) return connectHost();
  try {
    hostPort.postMessage({ cmd: "check" });
  } catch (e) {
    hostPort = null;
    connectHost();
  }
}

chrome.runtime.onStartup.addListener(connectHost);
chrome.runtime.onInstalled.addListener(connectHost);
connectHost();

// NetSuite, plus the Amazon S3 bucket that some carrier labels open from.
const LABEL_HOST = "ap-prod-ddc-stack-content.s3.ap-southeast-2.amazonaws.com";

function isAllowedSite(url) {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".netsuite.com") || host === LABEL_HOST;
  } catch {
    return false;
  }
}

function safeName(name) {
  let n = (name || "document").replace(/[\\/:*?"<>|]+/g, "_").trim();
  if (!/\.pdf$/i.test(n)) n += ".pdf";
  return FOLDER + "/" + Date.now() + "_" + n;
}

// The PDF viewer's tab title is the file name, e.g. "CustInvc_48753489.pdf".
function fileNameFor(tab) {
  return safeName(tab.title);
}

// ---------- connote on invoices ----------

// The invoice id, if this tab is an invoice PDF from its print button
// (hotprint.nl?...trantype=custinvc&id=...). Otherwise null.
function invoiceIdFrom(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".netsuite.com") || !/\/print\/hotprint\.nl$/i.test(u.pathname)) return null;
    if ((u.searchParams.get("trantype") || "").toLowerCase() !== "custinvc") return null;
    const id = u.searchParams.get("id");
    return id && /^\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// Runs inside a NetSuite page (needs its search functions and login): get the
// invoice PDF and the connote(s) of the order's item fulfilment(s).
async function lookupAndFetch(pdfUrl, invoiceId) {
  const pdf = fetch(pdfUrl, { credentials: "include" }).then((r) => r.arrayBuffer());
  let connotes = [];
  try {
    const inv = (window.nlapiSearchRecord("transaction", null, [["internalid", "anyof", invoiceId], "AND", ["mainline", "is", "T"]], [new window.nlobjSearchColumn("createdfrom")]) || [])[0];
    const so = inv && inv.getValue("createdfrom");
    if (so) {
      connotes = (window.nlapiSearchRecord(
        "transaction",
        null,
        [["type", "anyof", "ItemShip"], "AND", ["createdfrom", "anyof", so], "AND", ["mainline", "is", "T"]],
        [new window.nlobjSearchColumn("custbodyrsc_freight_carrier_consid")]
      ) || [])
        .map((r) => (r.getValue("custbodyrsc_freight_carrier_consid") || "").trim())
        .filter(Boolean);
    }
  } catch (e) {
    connotes = [];
  }
  const bytes = new Uint8Array(await pdf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return { connotes: [...new Set(connotes)], b64: btoa(bin) };
}

// A NetSuite page to run the lookup in: the page that opened the PDF, or any NetSuite tab.
async function netsuiteTabFor(tab) {
  const ok = (t) => t && t.url && /^https:\/\/[^/]+\.netsuite\.com\/app\//.test(t.url) && !/\/print\//.test(t.url);
  if (tab.openerTabId != null) {
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      if (ok(opener)) return opener.id;
    } catch {}
  }
  const tabs = await chrome.tabs.query({ url: "https://*.netsuite.com/app/*" });
  const same = tabs.filter(ok).sort((a, b) => (b.windowId === tab.windowId) - (a.windowId === tab.windowId));
  return same.length ? same[0].id : null;
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error("timed out")), ms))]);
}

// Returns a data: URL of the invoice with its connote stamped, or null to print it as it is.
async function invoiceWithConnote(tab, invoiceId) {
  const helperTab = await netsuiteTabFor(tab);
  if (helperTab == null) return null;
  const [res] = await withTimeout(
    chrome.scripting.executeScript({ target: { tabId: helperTab }, world: "MAIN", func: lookupAndFetch, args: [tab.url, invoiceId] }),
    10000
  );
  const out = res && res.result;
  if (!out || !out.connotes.length || !out.b64) return null;
  const raw = Uint8Array.from(atob(out.b64), (c) => c.charCodeAt(0));
  if (String.fromCharCode(...raw.slice(0, 5)) !== "%PDF-") return null;
  const doc = await PDFLib.PDFDocument.load(raw);
  const font = await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  const page = doc.getPage(0);
  const { height } = page.getSize();
  // Small "CONNOTE:" + larger number, like the ticket's "WAVE:" (23/11/2026).
  const label = "CONNOTE: ";
  const text = out.connotes.join(" / ");
  const small = 8;
  const size = out.connotes.length > 1 ? 11 : 15;
  // Empty top-left corner, above the KOKO BLACK logo (checked on invoice form 195).
  page.drawText(label, { x: 40, y: height - 52, size: small, font });
  page.drawText(text, { x: 40 + font.widthOfTextAtSize(label, small), y: height - 52, size, font });
  const saved = await doc.save({ useObjectStreams: false }); // plain layout so AutoPrint can read the page size
  let bin = "";
  for (let i = 0; i < saved.length; i += 0x8000) bin += String.fromCharCode.apply(null, saved.subarray(i, i + 0x8000));
  return "data:application/pdf;base64," + btoa(bin);
}

// ---------- packing slips ----------
// A NetSuite packing slip (its print icon, or a hotprint packing slip link).
function isPackingSlip(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(".netsuite.com")) return false;
    if (/\/print\/hotprint\.nl$/i.test(u.pathname)) return /packingslip|pickingticket/i.test(u.searchParams.get("printtype") || "");
    // The print icon's form page: only when it says it's a packing slip (or says nothing).
    if (!/nlsprintform\.nl$/i.test(u.pathname)) return false;
    const type = u.searchParams.get("printtype");
    return !type || /packingslip|pickingticket/i.test(type);
  } catch {
    return false;
  }
}
// Runs inside a NetSuite page (needs the login): the PDF as base64.
async function fetchPdfB64(pdfUrl) {
  const bytes = new Uint8Array(await (await fetch(pdfUrl, { credentials: "include" })).arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// The tidied packing slip as base64, or null (not a slip with the overlap, or no NetSuite tab).
async function tidiedPackingSlipB64(tab) {
  const helperTab = await netsuiteTabFor(tab);
  if (helperTab == null) return null;
  const [res] = await withTimeout(chrome.scripting.executeScript({ target: { tabId: helperTab }, world: "MAIN", func: fetchPdfB64, args: [tab.url] }), 10000);
  const b64 = res && res.result;
  if (!b64) return null;
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (String.fromCharCode(...raw.slice(0, 5)) !== "%PDF-") return null;
  const fixed = (await self.nshFixPackingSlip(raw)) || (await self.nshFixPickingTicket(raw));
  if (!fixed) return null;
  let bin = "";
  for (let i = 0; i < fixed.length; i += 0x8000) bin += String.fromCharCode.apply(null, fixed.subarray(i, i + 0x8000));
  return btoa(bin);
}
// Returns a data: URL of the tidied packing slip, or null to print it as it is.
async function tidiedPackingSlip(tab) {
  const b64 = await tidiedPackingSlipB64(tab);
  return b64 ? "data:application/pdf;base64," + b64 : null;
}

// Packing slips look tidied on screen too (25/11/2026): once a NetSuite packing slip tab
// has loaded, it's swapped to slip.html showing the tidied copy (Chrome's PDF viewer, so
// its print button prints the tidied one). The Auto Print button prints from slip.html.
// slip.html#<key>|<NetSuite link>: the link lets it fetch again after the browser forgets.
const VIEWER = chrome.runtime.getURL("slip.html");
const slipCache = new Map(); // key -> { b64, name }
const slipSwapped = new Set(); // tabId|url already swapped (Back shows NetSuite's version)
function rememberSlip(key, entry) {
  slipCache.set(key, entry);
  while (slipCache.size > 30) slipCache.delete(slipCache.keys().next().value);
}
async function slipEntry(hash) {
  const bar = hash.indexOf("|");
  const key = bar >= 0 ? hash.slice(0, bar) : hash;
  if (slipCache.has(key)) return slipCache.get(key);
  const original = bar >= 0 ? decodeURIComponent(hash.slice(bar + 1)) : "";
  if (!isPackingSlip(original)) return null;
  const b64 = await tidiedPackingSlipB64({ url: original });
  if (!b64) return null;
  const entry = { b64, name: "PackingSlip.pdf" };
  rememberSlip(key, entry);
  return entry;
}
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (pluginOff) return;
  if (info.status !== "complete" || !tab.url || !isPackingSlip(tab.url) || /#nsh-original$/.test(tab.url)) return;
  const seen = tabId + "|" + tab.url;
  if (slipSwapped.has(seen)) return;
  slipSwapped.add(seen);
  try {
    const b64 = await tidiedPackingSlipB64(tab);
    if (!b64) return; // nothing to tidy: leave NetSuite's slip as it is
    const key = Date.now().toString(36) + tabId;
    rememberSlip(key, { b64, name: tab.title || "PackingSlip.pdf" });
    const now = await chrome.tabs.get(tabId);
    if (now.url !== tab.url) return; // moved on meanwhile
    await chrome.tabs.update(tabId, { url: VIEWER + "#" + key + "|" + encodeURIComponent(tab.url) });
  } catch (e) {
    console.warn("Packing slip on screen not tidied:", e);
  }
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.type !== "nsh-slip-get" || !sender.url || !sender.url.startsWith(VIEWER)) return;
  slipEntry(String(msg.hash || "")).then(reply, () => reply(null));
  return true;
});

chrome.action.onClicked.addListener(async (tab) => {
  if (pluginOff) return flash(tab.id, "OFF", "#777777");
  // The tidied packing slip viewer: print the tidied copy it shows.
  if (tab.url && tab.url.startsWith(VIEWER)) {
    checkHelper();
    try {
      const entry = await slipEntry(new URL(tab.url).hash.slice(1));
      if (!entry) throw new Error("slip not found");
      await chrome.downloads.download({ url: "data:application/pdf;base64," + entry.b64, filename: safeName(entry.name), saveAs: false, conflictAction: "uniquify" });
      flash(tab.id, "OK", "#1b7f3b");
    } catch (e) {
      console.error(e);
      flash(tab.id, "ERR", "#b00020");
    }
    return;
  }
  if (!isAllowedSite(tab.url)) {
    flash(tab.id, "NS?", "#b00020");
    return;
  }
  checkHelper(); // starts AutoPrint if it isn't running (the file waits in the folder until it is)
  const invoiceId = invoiceIdFrom(tab.url);
  if (invoiceId) {
    try {
      const stamped = await invoiceWithConnote(tab, invoiceId);
      if (stamped) {
        await chrome.downloads.download({ url: stamped, filename: fileNameFor(tab), saveAs: false, conflictAction: "uniquify" });
        flash(tab.id, "OK", "#1b7f3b");
        return;
      }
    } catch (e) {
      console.warn("Connote stamp skipped:", e); // fall through: print it as it is
    }
  }
  if (isPackingSlip(tab.url)) {
    try {
      const tidied = await tidiedPackingSlip(tab);
      if (tidied) {
        await chrome.downloads.download({ url: tidied, filename: fileNameFor(tab), saveAs: false, conflictAction: "uniquify" });
        flash(tab.id, "OK", "#1b7f3b");
        return;
      }
    } catch (e) {
      console.warn("Packing slip tidy skipped:", e); // fall through: print it as it is
    }
  }
  try {
    await chrome.downloads.download({
      url: tab.url,
      filename: fileNameFor(tab),
      saveAs: false,
      conflictAction: "uniquify",
    });
    flash(tab.id, "OK", "#1b7f3b");
  } catch (e) {
    console.error(e);
    flash(tab.id, "ERR", "#b00020");
  }
});

// Keep our own downloads out of the download list (other downloads untouched).
chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state || d.state.current !== "complete") return;
  const [item] = await chrome.downloads.search({ id: d.id });
  if (item && /[\\/]AutoPrint[\\/][^\\/]+$/i.test(item.filename)) chrome.downloads.erase({ id: d.id });
});

// From NetSuite pages (via content.js): save a PDF the page built to AutoPrint.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !/^nsh-autoprint(-url|-state)?$/.test(msg.type)) return;
  if (pluginOff) return reply({ ok: false, error: "NetSuite Helper is turned off." });
  const from = sender.tab && sender.tab.url;
  if (!from || !isAllowedSite(from)) {
    reply({ ok: false, error: "Not a NetSuite page." });
    return;
  }
  // Ship orders asks first, so it never ships with nothing printing.
  if (msg.type === "nsh-autoprint-state") {
    checkHelper();
    setTimeout(() => reply({ ok: true, state: helperState }), 2500);
    return true;
  }
  let url = msg.dataUrl;
  if (msg.type === "nsh-autoprint-url") {
    // A carrier label link (NetSuite or the Ready Freight label bucket only).
    url = msg.url;
    if (typeof url !== "string" || !isAllowedSite(url)) {
      reply({ ok: false, error: "Not a NetSuite or label link." });
      return;
    }
  } else if (typeof url !== "string" || !url.startsWith("data:application/pdf;base64,")) {
    reply({ ok: false, error: "Not a PDF." });
    return;
  }
  chrome.downloads
    .download({ url, filename: safeName(msg.name), saveAs: false, conflictAction: "uniquify" })
    .then(() => {
      if (sender.tab) flash(sender.tab.id, "OK", "#1b7f3b");
      reply({ ok: true });
    })
    .catch((e) => {
      if (sender.tab) flash(sender.tab.id, "ERR", "#b00020");
      reply({ ok: false, error: String((e && e.message) || e) });
    });
  return true; // reply comes later
});

// ---------- Ship Orders billing in a background tab (25/11/2026) ----------
// The invoice page can't run in a hidden frame (NetSuite's set-up crashes there), and a
// page can only open pop-ups in front. So Ship Orders asks for a background tab: opened
// next to its own tab, not switched to. autobill.js in that tab saves the invoice once;
// Ship Orders closes the tab when NetSuite shows the invoice. Only invoice pages.
const isInvoicePage = (url) => {
  try {
    const u = new URL(url);
    return u.hostname.endsWith(".netsuite.com") && /\/app\/accounting\/transactions\/custinvc\.nl$/i.test(u.pathname);
  } catch {
    return false;
  }
};
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || (msg.type !== "nsh-tab-open" && msg.type !== "nsh-tab-close")) return;
  if (pluginOff && msg.type === "nsh-tab-open") return reply({ ok: false, error: "NetSuite Helper is turned off." });
  const from = sender.tab && sender.tab.url;
  if (!from || !isAllowedSite(from)) {
    reply({ ok: false, error: "Not a NetSuite page." });
    return;
  }
  if (msg.type === "nsh-tab-open") {
    let url = "";
    try {
      url = new URL(msg.url, from).href;
    } catch {}
    if (!isInvoicePage(url)) {
      reply({ ok: false, error: "Only invoice pages open this way." });
      return;
    }
    chrome.tabs
      .create({ url, active: false, index: sender.tab.index + 1, openerTabId: sender.tab.id, windowId: sender.tab.windowId })
      .then((t) => reply({ ok: true, tabId: t.id }), (e) => reply({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  // Close: only a tab that is still (or was) a NetSuite invoice page.
  chrome.tabs
    .get(msg.tabId)
    .then((t) => (t && (isInvoicePage(t.url) || isInvoicePage(t.pendingUrl || "")) ? chrome.tabs.remove(t.id) : null))
    .catch(() => {})
    .finally(() => reply({ ok: true }));
  return true;
});