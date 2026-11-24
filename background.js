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

importScripts("lib/pdf-lib.min.js");

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

// ---------- AutoPrint helper: started by the browser ----------
// The browser starts autoprint\host.cmd (registered by Setup.cmd, no admin
// needed), which starts the AutoPrint helper if it isn't running, restarts it if
// it stops, and reports back. Stays connected while the browser is open.

const HOST = "com.kokoblack.autoprint";
const DEFAULT_TITLE = "Auto Print (labels -> label printer, invoices -> page printer)";
let hostPort = null;
let helperState = "unknown"; // running | stopped | missing

function showHelperState() {
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

chrome.action.onClicked.addListener(async (tab) => {
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
