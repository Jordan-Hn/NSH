// NetSuite Helper: ship and bill orders from pasted CWS tracker rows
// (Corporate SOP 2, plus SOP 3/4/5/6/7/8 cases).
//
// Runs on the Item Fulfillment search page, in the page's own world (needs NetSuite's
// nlapi functions and pdf-lib). Each order is done on its real NetSuite pages
// in a hidden frame, so Ready Freight, SPS and billing run their own scripts,
// exactly as if the buttons were clicked:
//   item fulfilment (Edit) -> Status Shipped, shipping method, Ready Freight
//   packages (through Ready Freight's own Quick Add code) -> Save
//   -> labels to AutoPrint -> Bill -> Save invoice -> invoice (or Interflora
//   packing slip) to AutoPrint -> connote collected.
// A failed order stops on its own; the rest carry on. Never bills twice.

(function () {
  "use strict";

  // Lives on the Item Fulfillment search page (light; the full list page loads
  // every fulfilment since 2019): /app/common/search/search.nl?searchtype=Transaction&Transaction_TYPE=ItemShip
  if (!/Transaction_TYPE=ItemShip/i.test(location.search) || /searchid=|style=|\bresults?\b/i.test(location.search)) return;

  // ---------- constants (checked on the live pages 23/11/2026) ----------

  const METHOD = {
    CHILL: { id: "58051", name: "Chill Refrigerated Transport - General" },
    CHILL_EXPRESS: { id: "59672", name: "Chill Refrigerated Transport - Express" }, // store orders (TOs) always go Express
    STE: { id: "66829", name: "StarTrack Road Express" },
    STP: { id: "66831", name: "StarTrack Premium" },
    FW_SMALL: { id: "74678", name: "Freeway Courier <25kg Standard" },
    FW_BIG: { id: "74679", name: "Freeway 1/2 Tonne < 500kg Standard" },
    PICKUP: { id: "28953", name: "Click & Collect" },
    CUSTOM: { id: "6410", name: "Custom" }, // store orders with no packages: just pushed (Shipped, no courier)
  };
  // Ready Freight package types (customrecordrsc_freight_packagetype).
  const PKG = { CTN: { type: "7", name: "Tall Large", kg: 4 }, PLT: { type: "101", name: "Pallet", kg: 250 } };
  const INVOICE_FORM = "195";
  const KBH = "Warehouses : KBH Warehouse";
  const DRY_KEY = "nshShipDryRun"; // "1" = fill in, never save (tests)

  const STATES = ["VIC", "NSW", "QLD", "WA", "SA", "TAS", "ACT", "NT"];
  const COURIERS = { CHILL: "CHILL", STE: "STE", STP: "STP", FW: "FW", FREEWAY: "FW", PICKUP: "PICKUP", "PICK UP": "PICKUP", PU: "PICKUP" };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  // ---------- reading the pasted rows ----------

  // Cells are read by what they look like. The connote is the cell straight
  // after the courier (empty = not shipped yet); DISPATCHED is the YES/NO cell.
  function parseRows(text) {
    const rows = [];
    const seen = {};
    // Two rows pasted without a line break between them ("...7CTNS SO427203 CASH SALE..."):
    // split before every order number after the first, so each order keeps its own
    // cells (otherwise the first order could pick up the second one's packages, 25/11/2026).
    const splitJoined = (line) => {
      const starts = [];
      const re = /(?:^|[\s,;])((?:SO|TO)\d{5,})(?=\s|$)/gi;
      let m;
      while ((m = re.exec(line))) starts.push(m.index + m[0].length - m[1].length);
      if (starts.length < 2) return [line];
      return starts.map((s, i) => line.slice(i ? s : 0, starts[i + 1] === undefined ? line.length : starts[i + 1]).replace(/[\s,;]+$/, ""));
    };
    text.split(/\r?\n/).flatMap(splitJoined).forEach((line, lineNo) => {
      if (!line.trim()) return;
      const cells = line.split("\t");
      const up = cells.map((c) => c.trim().toUpperCase());
      const soAt = up.findIndex((c) => /^(SO|TO)\d+$/.test(c));
      if (soAt < 0) return; // dates, dividers, headers
      const so = up[soAt];
      // Store orders (TOs, Retail tracker: DATE, PO, TO, WAVE, STORE, STATE, CONNOTE #,
      // PLT/CTN, DELIVERY, SHIP DATE, COLLECTION, DISPATCH): shipped like a sales order,
      // always Chill Express, with Ready Freight's required delivery date from DELIVERY,
      // never billed, packing slip instead of an invoice.
      const isTO = /^TO/.test(so);
      const courierAt = isTO ? -1 : up.findIndex((c, i) => i > soAt && COURIERS[c]);
      const multi = up.some((c) => /^MULTI[\s-]?DROP$/.test(c));
      const state = multi ? "MULTIDROP" : up.find((c) => STATES.includes(c)) || "";
      let ctn = 0;
      let plt = 0;
      let qtyText = "";
      up.forEach((c) => {
        const m = c.replace(/\s+/g, "").match(/^(\d+)(CTNS?|CARTONS?|PLTS?|PALLETS?)(?:\+?(\d+)(CTNS?|CARTONS?|PLTS?|PALLETS?))?$/);
        if (!m) return;
        qtyText = cells[up.indexOf(c)].trim();
        [[m[1], m[2]], [m[3], m[4]]].forEach(([n, unit]) => {
          if (!n) return;
          if (/^P/.test(unit)) plt += Number(n);
          else ctn += Number(n);
        });
      });
      let connoteAt = courierAt >= 0 && courierAt + 1 < cells.length ? courierAt + 1 : -1;
      let delivery = "";
      if (isTO) {
        // CONNOTE # is the cell after STATE.
        const stateAt = up.findIndex((c, i) => i > soAt && STATES.includes(c));
        connoteAt = stateAt >= 0 && stateAt + 1 < cells.length ? stateAt + 1 : -1;
        // DELIVERY is its own column (CONNOTE #, PLT/CTN, DELIVERY), never the SHIP DATE after it.
        const deliveryCell = connoteAt >= 0 ? (cells[connoteAt + 2] || "").trim() : "";
        delivery = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(deliveryCell) ? deliveryCell : "";
      }
      const row = {
        line: lineNo,
        raw: line,
        cells,
        so,
        isTO,
        delivery,
        customer: (cells[soAt + (isTO ? 2 : 1)] || "").trim(),
        state,
        courier: isTO ? "CHILL" : courierAt >= 0 ? COURIERS[up[courierAt]] : "",
        connoteAt,
        connote: connoteAt >= 0 ? cells[connoteAt].trim() : "",
        dispatchedAt: up.findIndex((c, i) => i > soAt && (c === "NO" || c === "YES")),
        ctn,
        plt,
        qtyText,
        dupe: !!seen[so],
      };
      seen[so] = true;
      rows.push(row);
    });
    return rows;
  }

  // Shipping method from the tracker courier (SOP 2 part C).
  function methodFor(row) {
    if (row.isTO) return METHOD.CHILL_EXPRESS;
    if (row.courier === "CHILL") return METHOD.CHILL;
    if (row.courier === "STE") return METHOD.STE;
    if (row.courier === "STP") return METHOD.STP;
    if (row.courier === "FW") return row.ctn <= 3 ? METHOD.FW_SMALL : METHOD.FW_BIG;
    if (row.courier === "PICKUP") return METHOD.PICKUP;
    return null;
  }

  // Code for the back of the sleeve (SOP 2 part G / SOP 6).
  function sleeveCode(row) {
    if (row.isTO) return ""; // store orders have no sleeve code
    const last3 = row.so.slice(-3);
    let code = "";
    if (row.courier === "CHILL") code = last3 + " " + (row.state === "ACT" ? "NSW" : row.state);
    else if (row.courier === "STE" || row.courier === "STP") code = last3 + " ST";
    else if (row.courier === "FW") code = last3 + " FW";
    else if (row.courier === "PICKUP") code = last3 + " PU";
    if (row.plt) code += " PLT";
    return code;
  }

  // d/m/yyyy (or d/m/yy) from the tracker -> Date, or null.
  function toDate(text) {
    const m = String(text || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
    if (!m) return null;
    const d = new Date(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return d.getDate() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 ? d : null;
  }

  // Store orders: Ready Freight's Required Delivery Date = the tracker's DELIVERY date.
  async function setDeliveryDate(w, p, where) {
    if (!p.row.isTO) return;
    const field = "custbodyrsc_freight_req_del_date";
    const text = w.nlapiDateToString ? w.nlapiDateToString(toDate(p.row.delivery)) : p.row.delivery;
    w.nlapiSetFieldValue(field, text);
    await sleep(500);
    if (!w.nlapiGetFieldValue(field)) throw step(where, "couldn't set the required delivery date (" + p.row.delivery + ")");
  }

  const looseName = (s) => String(s || "").toUpperCase().replace(/&/g, "AND").replace(/[^A-Z0-9]/g, "");
  function sameCustomer(tracker, netsuite) {
    const a = looseName(tracker);
    const b = looseName(String(netsuite || "").split(":").pop());
    if (!a) return true; // nothing to compare
    return a === b || b.includes(a) || a.includes(b);
  }

  // Ship Via on the order that disagrees with the tracker's courier.
  function family(name) {
    const n = String(name || "").toUpperCase();
    if (/CHILL/.test(n)) return "CHILL";
    if (/STARTRACK/.test(n)) return "ST";
    if (/FREEWAY/.test(n)) return "FW";
    if (/CLICK/.test(n)) return "PICKUP";
    return "";
  }
  const courierFamily = (c) => (c === "STE" || c === "STP" ? "ST" : c);

  // ---------- NetSuite lookups ----------

  const col = (n, join) => new window.nlobjSearchColumn(n, join || null);
  function search(type, filters, cols) {
    return window.nlapiSearchRecord(type, null, filters, cols) || [];
  }
  function anyTranid(list) {
    const any = [];
    list.forEach((o, i) => {
      if (i) any.push("OR");
      any.push(["tranid", "is", o]);
    });
    return any;
  }

  function lookup(orders) {
    const info = {};
    for (let i = 0; i < orders.length; i += 40) {
      const chunk = orders.slice(i, i + 40);
      search("salesorder", [anyTranid(chunk), "AND", ["mainline", "is", "T"]], [col("tranid"), col("entity"), col("statusref"), col("shipmethod")]).forEach((r) => {
        const o = String(r.getValue("tranid")).toUpperCase();
        if (!chunk.includes(o)) return;
        info[o] = { id: r.getId(), customer: r.getText("entity"), status: r.getText("statusref"), statusRef: r.getValue("statusref"), shipVia: r.getText("shipmethod"), ifs: [], invoices: [], short: [], wave: "", waveStatus: "" };
      });
    }
    // Transfer orders: the "customer" is the store (the TO's To Location).
    const tos = orders.filter((o) => /^TO/.test(o));
    for (let i = 0; i < tos.length; i += 40) {
      const chunk = tos.slice(i, i + 40);
      search("transferorder", [anyTranid(chunk), "AND", ["mainline", "is", "T"]], [col("tranid"), col("transferlocation"), col("statusref"), col("shipmethod")]).forEach((r) => {
        const o = String(r.getValue("tranid")).toUpperCase();
        if (!chunk.includes(o)) return;
        info[o] = { id: r.getId(), isTO: true, customer: r.getText("transferlocation"), status: r.getText("statusref"), statusRef: r.getValue("statusref"), shipVia: r.getText("shipmethod"), ifs: [], invoices: [], short: [], wave: "", waveStatus: "" };
      });
    }
    const byId = {};
    Object.keys(info).forEach((o) => (byId[info[o].id] = o));
    const ids = Object.keys(byId);
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      search("itemfulfillment", [["createdfrom", "anyof", chunk], "AND", ["mainline", "is", "T"]], [col("tranid"), col("createdfrom"), col("statusref"), col("location"), col("custbodyrsc_freight_carrier_consid"), col("custbodyrsc_freight_carrier")]).forEach((r) => {
        const o = byId[r.getValue("createdfrom")];
        if (o) info[o].ifs.push({ id: r.getId(), tranid: r.getValue("tranid"), status: r.getText("statusref"), statusRef: r.getValue("statusref"), location: r.getText("location"), consid: r.getValue("custbodyrsc_freight_carrier_consid"), carrier: r.getText("custbodyrsc_freight_carrier") });
      });
      search("invoice", [["createdfrom", "anyof", chunk], "AND", ["mainline", "is", "T"]], [col("tranid"), col("createdfrom")]).forEach((r) => {
        const o = byId[r.getValue("createdfrom")];
        if (o) info[o].invoices.push({ id: r.getId(), tranid: r.getValue("tranid") });
      });
      // Items the fulfilment doesn't cover (back ordered or taken out of the wave).
      // Shown as a note; billing only covers what's fulfilled.
      const soIds = chunk.filter((id) => !info[byId[id]].isTO);
      if (soIds.length) search("salesorder", [["internalid", "anyof", soIds], "AND", ["mainline", "is", "F"], "AND", ["item.type", "anyof", ["InvtPart", "Assembly", "Kit"]]], [col("item"), col("quantity"), col("quantitypicked"), col("quantityshiprecv")]).forEach((r) => {
        const o = byId[r.getId()];
        if (!o) return;
        const want = Math.abs(Number(r.getValue("quantity")) || 0);
        const got = Math.max(Number(r.getValue("quantitypicked")) || 0, Number(r.getValue("quantityshiprecv")) || 0);
        if (got < want) info[o].short.push(r.getText("item") + " (" + got + " of " + want + ")");
      });
      // The order's newest wave and its status. Wave Complete + an item
      // fulfilment = ready to ship and bill (23/11/2026).
      search("transaction", [["type", "anyof", "Wave"], "AND", ["appliedtotransaction", "anyof", chunk]], [col("tranid"), col("statusref"), col("appliedtotransaction")]).forEach((r) => {
        const o = byId[r.getValue("appliedtotransaction")];
        const w = r.getValue("tranid");
        if (o && /^\d+$/.test(w) && Number(w) > Number(info[o].wave || 0)) {
          info[o].wave = w;
          info[o].waveId = r.getId();
          info[o].waveStatus = r.getText("statusref") || r.getValue("statusref") || "";
        }
      });
    }
    return info;
  }

  // What to do with each row: { action: "ship" | "skip" | "flag", why, method, iff }
  function plan(rows, info) {
    return rows.map((row) => {
      const rec = info[row.so];
      const p = { row, rec, method: methodFor(row), code: sleeveCode(row), warn: [] };
      const out = (action, why) => Object.assign(p, { action, why });
      if (row.dupe) return out("skip", "Listed twice (done once)");
      if (!rec) return out("flag", row.isTO ? "No transfer order with this number" : "No sales order with this number");
      if (row.connote) return out("skip", "Has a connote already (shipped)");
      // A store order with no PLT/CTN (the store's other TOs in the delivery): pushed, i.e.
      // Shipped with method Custom and saved, so the store gets its paperwork. No packages,
      // labels or connote (retail SOP 3; 25/11/2026).
      if (!row.ctn && !row.plt && row.isTO) {
        p.push = true;
        p.method = METHOD.CUSTOM;
      } else if (!row.ctn && !row.plt) return out("skip", "No PLT/CTN (not picked yet)");
      if (!row.isTO && !sameCustomer(row.customer, rec.customer)) p.warn.push("Customer in NetSuite is " + rec.customer);
      if (row.isTO && !p.push && !row.delivery) return out("flag", "No DELIVERY date in the row (Ready Freight needs it)");
      if (row.isTO && !p.push && !toDate(row.delivery)) return out("flag", "DELIVERY date " + row.delivery + " not understood");
      if (row.state === "MULTIDROP") return out("flag", "MULTIDROP: do it by hand");
      if (!row.courier) return out("flag", "Courier not recognised");
      if (row.courier === "FW" && row.plt) return out("flag", "Freeway on a pallet: pick the method by hand");
      // Ready Freight refuses pallets on StarTrack (22 kg, 105 cm limit; checked 23/11/2026).
      if ((row.courier === "STE" || row.courier === "STP") && row.plt) return out("flag", "StarTrack on a pallet: Ready Freight won't take it (22 kg limit), do it by hand");
      if (/^MYER/i.test(rec.customer) && (row.courier !== "CHILL" || !row.plt)) return out("flag", "Myer should be Chill and pallets");
      const fam = row.isTO ? "" : family(rec.shipVia);
      if (fam && fam !== courierFamily(row.courier)) return out("flag", "Order's Ship Via is " + rec.shipVia + ", tracker says " + row.courier);
      const open = rec.ifs.filter((f) => f.statusRef !== "shipped");
      if (rec.ifs.length > 1) return out("flag", "Two item fulfilments, do it by hand");
      // Store orders only (retail SOP 3): a wave that isn't Complete, or a wave with no item
      // fulfilment yet, gets its Ready pick tasks marked Done first (25/11/2026). SOs: flagged.
      if (!rec.ifs.length && rec.wave) {
        if (!row.isTO) return out("flag", "Wave " + rec.wave + " but no item fulfilment, check it");
        p.finishWave = true;
        p.warn.push("Wave " + rec.wave + " has no item fulfilment yet: its Ready pick tasks get marked Done first");
      }
      if (!rec.ifs.length && !rec.wave) return out("skip", "No wave or item fulfilment (not picked yet)");
      if (rec.ifs.length && !open.length) {
        // Shipped but stuck on Aus Post Express (state problem) and not billed: carry on and fix it.
        const f = rec.ifs[0];
        if (p.push) {
          return out("skip", "Item fulfilment already Shipped (pushed)");
        } else if (row.isTO && f.consid) {
          return out("skip", "Item fulfilment already Shipped with connote " + f.consid + " (check the tracker)");
        } else if (!rec.invoices.length && !f.consid && row.courier !== "PICKUP") {
          // (a voided consignment leaves the old carrier name behind, so check the connote first)
          p.warn.push("Already shipped with no consignment: the address state is checked, it gets the courier and packages and is saved again, then carries on");
        } else if (!rec.invoices.length && /AUSTRALIA POST|EXPRESS POST/i.test(f.carrier || "")) {
          p.warn.push("Already shipped on Aus Post Express: the consignment gets voided, then it stops so you can fix the address");
        } else if (!rec.invoices.length) {
          // Shipped with its connote, just not billed: bill it and print the paperwork, not the labels again.
          p.warn.push("Already shipped (connote " + (f.consid || "none") + ") but not billed: it gets billed and the invoice printed. Labels only if you tick Print labels");
          p.skipLabels = true;
        } else {
          return out("skip", "Item fulfilment already Shipped (check the tracker)");
        }
      }
      // Fulfilment location doesn't matter (e.g. Warehouses : Online) as long as the wave is Complete (23/11/2026).
      if (rec.invoices.length) return out("flag", "Already has an invoice (" + rec.invoices[0].tranid + "), do it by hand");
      // A wave still Released (never started) next to an item fulfilment: the order was
      // fulfilled outside the wave (e.g. its own Fulfill button), so the wave is a leftover
      // and the fulfilment is what ships (SO424877 / SO427203, 25/11/2026).
      const leftoverWave = rec.wave && /released/i.test(rec.waveStatus) && rec.ifs.length;
      if (leftoverWave && !row.isTO) p.warn.push("Wave " + rec.wave + " was never picked (still Released); shipping item fulfilment " + rec.ifs[0].tranid + ", which was made outside the wave");
      if (rec.wave && !/complete/i.test(rec.waveStatus) && !(leftoverWave && !row.isTO)) {
        if (!row.isTO) return out("flag", "Wave " + rec.wave + " is " + (rec.waveStatus || "not complete") + ", not Complete");
        if (!p.finishWave) p.warn.push("Wave " + rec.wave + " is " + (rec.waveStatus || "not complete") + ": its Ready pick tasks get marked Done first");
        p.finishWave = true;
      }
      // Items left off a done wave are ignored (23/11/2026): the pick tasks are Done, so it ships.
      p.iff = rec.ifs[0];
      p.isTO = !!row.isTO;
      p.interflora = /^INTERFLORA/i.test(rec.customer);
      p.listAfter = /^MYER/i.test(rec.customer) ? "Myer ASN" : /^COLES/i.test(rec.customer) ? "Coles portal" : "";
      return out("ship", "");
    });
  }

  // ---------- the hidden frame ----------

  // One hidden frame per worker (several orders are worked on at once, v0.17).
  const frames = [];
  function getFrame(slot) {
    slot = slot || 0;
    if (frames[slot] && document.body.contains(frames[slot])) return frames[slot];
    const f = document.createElement("iframe");
    f.id = "nsh-ship-frame-" + slot;
    f.style.cssText = "position:fixed;left:0;top:0;width:1280px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1";
    document.body.appendChild(f);
    frames[slot] = f;
    return f;
  }

  // Resolves once the frame's next page has loaded and its scripts are up.
  function nextLoad(timeout, what, slot) {
    const f = getFrame(slot);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        f.removeEventListener("load", onLoad);
        reject(new Error("NetSuite took too long to load " + (what || "the page")));
      }, timeout || 60000);
      const onLoad = async () => {
        clearTimeout(timer);
        f.removeEventListener("load", onLoad);
        const w = f.contentWindow;
        for (let i = 0; i < 40 && !(w.document.readyState === "complete" && w.nlapiGetFieldValue); i++) await sleep(250);
        await sleep(800); // page init scripts
        resolve(w);
      };
      f.addEventListener("load", onLoad);
    });
  }

  async function openPage(url, what, slot) {
    const f = getFrame(slot);
    const loaded = nextLoad(60000, what, slot);
    f.src = url;
    return loaded;
  }

  // Catch the page's alerts and confirms (they'd block the run otherwise).
  function catchDialogs(w) {
    const said = [];
    w.alert = (m) => said.push(String(m));
    w.confirm = (m) => {
      said.push(String(m));
      return false; // say no to anything unexpected; the order is flagged
    };
    return said;
  }

  // Red/orange message boxes NetSuite and Ready Freight show on the page.
  function pageMessages(w) {
    const sel = ".uir-alert-box, .uir-message-error, .uir-message-warning, .x-window, .uir-message-popup";
    return [...w.document.querySelectorAll(sel)]
      .filter((e) => e.offsetParent !== null)
      .map((e) => e.innerText.replace(/\s+/g, " ").trim())
      // NetSuite's green "Confirmation ... successfully Saved" box isn't an error.
      .filter((t) => t && !/^Confirmation\b|successfully (saved|voided)|has been voided/i.test(t));
  }

  function leavePage(w) {
    try {
      w.setWindowChanged(w, false);
    } catch (e) {}
    try {
      w.NS.form.setChanged(false);
    } catch (e) {}
    w.onbeforeunload = null;
  }

  function button(w, label) {
    return [...w.document.querySelectorAll("input[type=button],input[type=submit],button")].find((b) => (b.value || b.textContent || "").trim() === label);
  }

  // Ready Freight's own Quick Add: open its popup code, but hand the values
  // straight to the page the way the popup's Submit does.
  async function quickAdd(w, pkg, qty, replace) {
    const ctx = "/SuiteBundles/Bundle 311355/RSC_ReadyFreight_C_IF_Buttons";
    const mod = await new Promise((res, rej) => w.require.config({ context: ctx })([ctx], res, rej));
    const d = w.nlapiLookupField("customrecordrsc_freight_packagetype", pkg.type, ["custrecordrsc_freight_pkgtype_length", "custrecordrsc_freight_pkgtype_width", "custrecordrsc_freight_pkgtype_height"]);
    const fake = { focus() {}, close() {} };
    const realOpen = w.open;
    w.open = () => fake;
    try {
      mod.RSC_ReadyFreight_C_IF_displayQuickAddPopup();
    } finally {
      w.open = realOpen;
    }
    if (typeof fake.callback !== "function") throw new Error("Ready Freight Quick Add didn't start");
    fake.callback({
      freightPackage: {
        pkgType: pkg.type,
        weight: pkg.kg,
        length: d.custrecordrsc_freight_pkgtype_length,
        width: d.custrecordrsc_freight_pkgtype_width,
        height: d.custrecordrsc_freight_pkgtype_height,
        containsDG: false,
        dgClass: "",
      },
      quantity: qty,
      replaceExistingPackages: replace,
    });
    for (let i = 0; i < 20; i++) {
      await sleep(250);
      if (countPackages(w, pkg.type) >= qty) return;
    }
    // Ready Freight refused it (e.g. a size or weight limit for the carrier): pass its message on.
    const msg = pageMessages(w).join(" ");
    if (msg) throw step("Shipping", "Ready Freight: " + msg.replace(/^.*?:\s*/, "").slice(0, 250));
  }
  function countPackages(w, type) {
    const n = w.nlapiGetLineItemCount("custpage_rfpackages");
    let c = 0;
    for (let i = 1; i <= n; i++) if (!type || w.nlapiGetLineItemValue("custpage_rfpackages", "custpage_rfpkgtype", i) === type) c++;
    return c;
  }

  // ---------- printing ----------

  async function fetchPdf(url) {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) throw new Error("NetSuite answered " + resp.status);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-") throw new Error("didn't get a PDF");
    return bytes;
  }

  function toDataUrl(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return "data:application/pdf;base64," + btoa(bin);
  }

  // Through content.js to background.js. msg: {name, dataUrl} or {name, url}.
  function toExtension(type, msg, timeout) {
    return new Promise((resolve) => {
      const id = Date.now() + "-" + Math.random();
      const done = (res) => {
        window.removeEventListener("message", onMsg);
        clearTimeout(timer);
        resolve(res);
      };
      const onMsg = (e) => {
        if (e.source === window && e.data && e.data.type === type + "-result" && e.data.id === id) done(e.data);
      };
      const timer = setTimeout(() => done({ ok: false, error: "The extension didn't answer. Reload it and refresh this page." }), timeout || 20000);
      window.addEventListener("message", onMsg);
      window.postMessage(Object.assign({ type: type + "-send", id }, msg), location.origin);
    });
  }
  async function autoPrint(bytes, name) {
    const res = await toExtension("nsh-autoprint", { name, dataUrl: toDataUrl(bytes) });
    if (!res.ok) throw new Error("AutoPrint: " + res.error);
  }
  async function autoPrintUrl(url, name) {
    const res = await toExtension("nsh-autoprint-url", { name, url });
    if (!res.ok) throw new Error("AutoPrint: " + res.error);
  }

  // ---------- printing in pasted order ----------

  const WORKERS = 3; // orders worked on at once
  // Each order collects its PDFs here as it goes ({bytes, name} or {url, name}).
  function queuePrint(p, job) {
    (p.prints = p.prints || []).push(job);
  }
  // Send queued paperwork in pasted order: stop at the first order that isn't finished.
  // One flush at a time; each call waits for the one before it.
  let printChain = Promise.resolve();
  function flushPrints(work, draw, title, send) {
    const sendJob = send || ((job) => (job.bytes ? autoPrint(job.bytes, job.name) : autoPrintUrl(job.url, job.name)));
    printChain = printChain.then(async () => {
      for (const p of work) {
        if (!p.finished) break;
        const jobs = p.prints || [];
        p.printedCount = p.printedCount || 0;
        while (p.printedCount < jobs.length) {
          const job = jobs[p.printedCount++];
          try {
            await sendJob(job);
          } catch (err) {
            p.printError = (p.printError ? p.printError + "; " : "") + job.name + ": " + err.message;
            p.note = (p.note || "") + " (didn't print: " + job.name + ")";
            if (draw) draw(title());
          }
        }
      }
    });
    return printChain;
  }

  // Small "CONNOTE:" + larger number, top left above the logo (same as the Auto Print button).
  async function stampConnote(bytes, connote) {
    const P = window.PDFLib;
    const doc = await P.PDFDocument.load(bytes);
    const font = await doc.embedFont(P.StandardFonts.HelveticaBold);
    const page = doc.getPage(0);
    const { height } = page.getSize();
    const label = "CONNOTE: ";
    page.drawText(label, { x: 40, y: height - 52, size: 8, font });
    page.drawText(connote, { x: 40 + font.widthOfTextAtSize(label, 8), y: height - 52, size: 15, font });
    return doc.save({ useObjectStreams: false });
  }

  const invoicePdfUrl = (id) =>
    "/app/accounting/print/hotprint.nl?regular=T&sethotprinter=T&formnumber=" + INVOICE_FORM + "&trantype=custinvc&id=" + encodeURIComponent(id) + "&label=Invoice&printtype=transaction";
  const packingSlipUrl = (soId, ifId, orgType) =>
    "/app/accounting/print/hotprint.nl?regular=T&sethotprinter=T&id=" + encodeURIComponent(soId) + "&label=Packing%20Slip&printtype=packingslip&trantype=itemship&orgtrantype=" + (orgType || "SalesOrd") + "&auxtrans=" + encodeURIComponent(ifId);

  // ---------- address state (Aus Post Express fix) ----------

  const STATE_FULL = {
    VICTORIA: "VIC", "NEW SOUTH WALES": "NSW", QUEENSLAND: "QLD", "WESTERN AUSTRALIA": "WA", "SOUTH AUSTRALIA": "SA",
    TASMANIA: "TAS", "AUSTRALIAN CAPITAL TERRITORY": "ACT", "NORTHERN TERRITORY": "NT",
  };
  // Australian postcode -> state code ("" if unknown).
  function stateFromPostcode(zip) {
    const n = Number(String(zip || "").trim());
    if (!/^\d{3,4}$/.test(String(zip || "").trim())) return "";
    if ((n >= 200 && n <= 299) || (n >= 2600 && n <= 2618) || (n >= 2900 && n <= 2920)) return "ACT";
    if (n >= 800 && n <= 999) return "NT";
    if (n >= 1000 && n <= 2999) return "NSW";
    if ((n >= 3000 && n <= 3999) || (n >= 8000 && n <= 8999)) return "VIC";
    if ((n >= 4000 && n <= 4999) || (n >= 9000 && n <= 9999)) return "QLD";
    if (n >= 5000 && n <= 5999) return "SA";
    if (n >= 6000 && n <= 6999) return "WA";
    if (n >= 7000 && n <= 7999) return "TAS";
    return "";
  }
  function stateCodeOf(state) {
    const up = String(state || "").trim().toUpperCase();
    return STATES.includes(up) ? up : STATE_FULL[up] || "";
  }
  // True when the state isn't stored as a proper code, or disagrees with the postcode.
  function badState(state, zip) {
    const s = String(state || "").trim();
    if (!STATES.includes(s)) return true;
    const byZip = stateFromPostcode(zip);
    return !!byZip && byZip !== s;
  }
  // On an item fulfilment edit page: set the ship-to state to its code. Returns
  // "Victoria → VIC" when changed, "" when it was already right.
  // ---------- suburb / postcode against Ready Freight's Chill list ----------
  // 24/11/2026: fix a suburb/postcode that doesn't match Chill's list (the
  // "Ready Freight Suburbs Chill" search, record customrecordrsc_freight_sortcode_chill),
  // the fix SOP 4 does by hand. The list writes "St" for Saint and "Mount" in full, and
  // one postcode can cover several suburbs.
  //   valid pair            -> fine (use the list's spelling if only that differs)
  //   suburb with 1 postcode in the state, postcode wrong -> correct the postcode
  //   anything unclear      -> stop before Save and show the closest options
  const CHILL_TYPE = "customrecordrsc_freight_sortcode_chill";
  const CHILL_SUBURB = "custrecordrsc_freight_sort_chi_suburb";
  const CHILL_STATE = "custrecordrsc_freight_sort_chi_state";
  const CHILL_POSTCODE = "custrecordrsc_freight_sort_chi_postcode";
  const CHILL_ZONE = "custrecordrsc_freight_sort_chi_zone";
  const CHILL_TENANCY = "custrecordrsc_freight_sort_chi_tenancy";
  function chillFind(field, value) {
    const f = field === "postcode" ? CHILL_POSTCODE : CHILL_SUBURB;
    return (window.nlapiSearchRecord(CHILL_TYPE, null, [[f, "is", value]], [col(CHILL_SUBURB), col(CHILL_STATE), col(CHILL_POSTCODE), col(CHILL_ZONE), col(CHILL_TENANCY)]) || []).map((r) => ({
      suburb: r.getValue(CHILL_SUBURB),
      state: r.getValue(CHILL_STATE),
      postcode: r.getValue(CHILL_POSTCODE),
      area: (r.getText(CHILL_ZONE) || r.getValue(CHILL_ZONE) || "") + "|" + (r.getText(CHILL_TENANCY) || r.getValue(CHILL_TENANCY) || ""),
    }));
  }
  const WORD_FIX = { SAINT: "ST", MT: "MOUNT", PT: "POINT", STH: "SOUTH", NTH: "NORTH", HTS: "HEIGHTS", PK: "PARK" };
  const suburbKey = (s) =>
    String(s || "")
      .toUpperCase()
      .replace(/[^A-Z0-9 ]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => WORD_FIX[w] || w)
      .join(" ");
  function chillCheck(city, zip, state, find) {
    if (!city || !zip) return { stop: "the address has no " + (city ? "postcode" : "suburb") + ". Fix the address by hand" };
    const key = suburbKey(city);
    const byPostcode = find("postcode", zip);
    const pair = byPostcode.find((r) => suburbKey(r.suburb) === key);
    // Capitals alone don't matter (the list matches either way): only reword real
    // spelling differences like Mt -> Mount or Saint -> St.
    const sameWords = (a, b) => String(a).toUpperCase().replace(/\s+/g, " ").trim() === String(b).toUpperCase().replace(/\s+/g, " ").trim();
    if (pair) return sameWords(pair.suburb, city) ? { city } : { city: pair.suburb };
    // The suburb as written, and as the list would write it (Mt -> Mount, Saint -> St).
    const tries = [...new Set([city, key.replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase())])];
    let bySuburb = [];
    tries.forEach((t) => (bySuburb = bySuburb.concat(find("suburb", t))));
    bySuburb = bySuburb.filter((r, i, a) => suburbKey(r.suburb) === key && a.findIndex((x) => x.postcode === r.postcode && x.suburb === r.suburb) === i);
    const inState = state ? bySuburb.filter((r) => r.state === state) : bySuburb;
    const postcodeSuburbs = state ? byPostcode.filter((r) => r.state === state) : byPostcode;
    const fmt = (r) => r.suburb + " " + r.state + " " + r.postcode;
    const stop = (why, options) => ({
      stop: why + (options.length ? ". " + [...new Set(options)].join(", ") : "") + ". Fix the address by hand, then Retry",
    });

    // Works both ways (24/11/2026: often the postcode is right and the suburb
    // wrong, sometimes a neighbouring suburb, e.g. North Ryde 2138 needed Rhodes).
    // Each list entry has a zone + tenancy (e.g. Metro Area 1 / NSW). When everything
    // involved is in the same zone, Chill treats it the same, so the postcode wins and
    // the suburb is taken from it: the clear best spelling match, else the first.
    const oneArea = (rows) => rows.length > 0 && rows.every((r) => r.area && r.area !== "|" && r.area === rows[0].area);
    const suburbFromPostcode = () => {
      if (postcodeSuburbs.length === 1) return postcodeSuburbs[0].suburb;
      const scored = postcodeSuburbs.map((r) => ({ r, score: likeness(key, suburbKey(r.suburb)) })).sort((a, b) => b.score - a.score);
      const next = scored[1] ? scored[1].score : 0;
      if (scored[0].score >= 0.75 && scored[0].score - next >= 0.15) return scored[0].r.suburb;
      return oneArea(postcodeSuburbs) ? postcodeSuburbs.map((r) => r.suburb).sort()[0] : null;
    };
    // Both on the list, just not together.
    if (inState.length && postcodeSuburbs.length) {
      const pick = oneArea(inState.concat(postcodeSuburbs)) && suburbFromPostcode();
      if (pick) return { city: pick };
      return stop(
        "suburb " + city + " and postcode " + zip + " don't go together on Chill's list. Either fix the postcode (" + inState.map(fmt).join(", ") +
          ") or the suburb (" + postcodeSuburbs.map(fmt).join(", ") + ")",
        []
      );
    }
    // Only the suburb is on the list: the postcode is wrong. Fix it if the suburb has one.
    if (inState.length) {
      const postcodes = [...new Set(inState.map((r) => r.postcode))];
      if (postcodes.length === 1) return { city: inState[0].suburb, zip: postcodes[0] };
      return stop("suburb " + city + " has more than one postcode on Chill's list. Closest:", inState.map(fmt));
    }
    // Only the postcode is on the list: the suburb is wrong.
    if (postcodeSuburbs.length) {
      const pick = suburbFromPostcode();
      if (pick) return { city: pick };
      return stop("suburb " + city + " isn't on Chill's list for postcode " + zip + ". Suburbs for " + zip + ":", postcodeSuburbs.map(fmt));
    }
    return stop("suburb " + city + " / postcode " + zip + " isn't on Chill's list" + (bySuburb.length ? ". Closest:" : ""), bySuburb.map(fmt));
  }
  // How alike two suburb names are, 0..1 (edit distance), e.g. DANDENONG STH vs DANDENONG SOUTH.
  function likeness(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return 1 - d[a.length][b.length] / Math.max(a.length, b.length);
  }

  // The address subrecord isn't ready straight after the page loads (NetSuite throws
  // SSS_INVALID_FIELD_ON_SUBRECORD_OPERATION), so wait and try again a few times.
  async function fixStateWhenReady(w, where, keepLine3, chill) {
    for (let i = 0; ; i++) {
      try {
        return fixState(w, where, keepLine3, chill);
      } catch (err) {
        if (err && err.where) throw err; // a real address problem
        if (i >= 8) throw err;
        await sleep(1000);
      }
    }
  }
  // Also removes a third street line (23/11/2026): the couriers take two
  // ("number of address lines entered (3) exceeds the selected carrier maximum (2)").
  function fixState(w, where, keepLine3, chill) {
    const s = w.nlapiEditSubrecord("shippingaddress");
    if (!s) return "";
    const country = s.getFieldValue("country") || "AU";
    const state = String(s.getFieldValue("state") || "").trim();
    let zip = String(s.getFieldValue("zip") || "").trim();
    const city = String(s.getFieldValue("city") || "").trim();
    const line3 = String(s.getFieldValue("addr3") || "").trim();
    const changes = [];
    let code = "";
    if (country === "AU" && badState(state, zip)) {
      const byName = stateCodeOf(state);
      const byZip = stateFromPostcode(zip);
      if (byName && byZip && byName !== byZip) {
        s.cancel();
        throw step(where, "the address says " + state + " but postcode " + zip + " is in " + byZip + ". Fix the address by hand");
      }
      code = byName || byZip;
      if (!code) {
        s.cancel();
        throw step(where, 'the address state "' + state + '" isn\'t a state, and postcode "' + zip + "\" doesn't say which. Fix the address by hand");
      }
      s.setFieldValue("state", code);
      changes.push((state || "(blank)") + " → " + code);
    }
    if (line3 && !keepLine3) {
      s.setFieldValue("addr3", "");
      changes.push('line 3 removed: "' + line3 + '"');
    }
    // Chill orders: suburb + postcode must be a pair on Ready Freight's Chill list.
    if (chill && country === "AU") {
      const res = chillCheck(city, zip, code || stateCodeOf(state) || stateFromPostcode(zip), chillFind);
      if (res.stop) {
        s.cancel();
        throw step(where, res.stop);
      }
      if (res.city && res.city !== city) {
        s.setFieldValue("city", res.city);
        changes.push("suburb " + city + " → " + res.city);
      }
      if (res.zip && res.zip !== zip) {
        s.setFieldValue("zip", res.zip);
        changes.push("postcode " + zip + " → " + res.zip);
        zip = res.zip;
      }
    }
    if (!changes.length) {
      s.cancel();
      return "";
    }
    s.commit();
    if (code && w.nlapiGetFieldValue("shipstate") !== code) throw step(where, "couldn't change the address state to " + code);
    return changes.join(", ");
  }

  // Carrier names as text; the connote as its value (a text lookup leaves free-text fields out).
  function carrierOf(ifId) {
    const c = w2f(window.nlapiLookupField("itemfulfillment", ifId, ["custbodyrsc_freight_carrier", "custbodyrsc_freight_carrier_service"], true));
    c.custbodyrsc_freight_carrier_consid = window.nlapiLookupField("itemfulfillment", ifId, "custbodyrsc_freight_carrier_consid") || "";
    return c;
  }
  const isAusPost = (rf) => /AUSTRALIA POST|EXPRESS POST|AUS POST/i.test(rf.custbodyrsc_freight_carrier + " " + rf.custbodyrsc_freight_carrier_service);
  function addressOf(ifId) {
    const r = search("itemfulfillment", [["internalid", "anyof", ifId], "AND", ["mainline", "is", "T"]], [col("shipstate"), col("shipzip"), col("shipcity")])[0];
    const a = { state: r ? r.getValue("shipstate") : "", zip: r ? r.getValue("shipzip") : "", city: r ? r.getValue("shipcity") : "" };
    a.text = [a.city, a.state, a.zip].filter(Boolean).join(" ");
    return a;
  }

  // Click Save on an item fulfilment edit page and check it really saved.
  async function saveFulfilment(w, ifId, where, slot) {
    const said = catchDialogs(w);
    const saveBtn = w.document.getElementById("btn_multibutton_submitter") || w.document.getElementById("submitter");
    if (!saveBtn) throw step(where, "no Save button on the item fulfilment");
    const loaded = nextLoad(120000, "the saved item fulfilment", slot);
    loaded.catch(() => {});
    saveBtn.click();
    const res = await Promise.race([loaded, sleep(8000).then(() => null)]);
    if (!res) {
      let msg = "";
      try {
        msg = said.concat(pageMessages(w)).join(" ");
      } catch (e) {}
      if (msg) {
        leavePage(w);
        throw step(where, reason(msg));
      }
      try {
        await loaded;
      } catch (e) {}
    }
    // NetSuite decides, not the page address: after Save the saved fulfilment can
    // show at the edit address (that wrongly failed 6 good saves, 23/11/2026).
    const fw = getFrame(slot).contentWindow;
    let shipped = false;
    for (let i = 0; i < 5 && !shipped; i++) {
      shipped = window.nlapiLookupField("itemfulfillment", ifId, "statusref") === "shipped";
      if (!shipped) await sleep(1500);
    }
    if (!shipped) {
      let msg = "";
      try {
        msg = said.concat(pageMessages(fw)).join(" ");
      } catch (e) {}
      throw step(where, reason(msg) || "the item fulfilment didn't save");
    }
  }

  // ---------- one order ----------

  // p.done remembers finished steps, so Retry never repeats one.
  async function runOrder(p, dry, say, slot) {
    const d = (p.done = p.done || {});
    if (p.skipLabels) d.labels = true; // shipped before this run: its labels are already out
    if (p.finishWave && !d.waveDone) {
      const goOn = await finishWave(p, dry, say, slot);
      if (!goOn) {
        p.dryResult = { status: "Wave " + p.rec.wave + ": would mark " + p.pickDone + " Ready pick task(s) Done", method: "then ship its item fulfilment (it doesn't exist until then, so the rest can't be shown in a dry run)", carrier: "", packages: "-", weight: "-" };
        return "dry";
      }
      if (!dry) d.waveDone = true;
    }
    const ifId = p.iff.id;
    const ifUrl = "/app/accounting/transactions/itemship.nl?id=" + ifId;
    if (p.push) return pushOrder(p, dry, say, slot, ifUrl);

    // 1. Ship (skipped if NetSuite already shows it shipped).
    let justSaved = false;
    let f =w2f(window.nlapiLookupField("itemfulfillment", ifId, ["statusref", "custbodyrsc_freight_carrier_consid"]));
    if (f.statusref !== "shipped") {
      say("Opening " + p.iff.tranid + "...");
      let w = await openPage(ifUrl + "&e=T", "the item fulfilment (edit)", slot);
      if (!w.nlapiSetFieldValue) throw step("Shipping", "the item fulfilment didn't open in edit mode");
      say("Setting Shipped, " + p.method.name + "...");
      w.nlapiSetFieldValue("shipstatus", "C");
      await sleep(1200);
      w.nlapiSetFieldValue("shipmethod", p.method.id);
      await sleep(2000);
      if (w.nlapiGetFieldValue("shipmethod") !== p.method.id) throw step("Shipping", "couldn't set the shipping method");
      say("Adding packages...");
      if (countPackages(w)) throw step("Shipping", "it already has Ready Freight packages, check it by hand");
      if (p.row.plt) await quickAdd(w, PKG.PLT, p.row.plt, true);
      if (p.row.ctn) await quickAdd(w, PKG.CTN, p.row.ctn, !p.row.plt);
      const want = p.row.plt + p.row.ctn;
      if (countPackages(w) !== want) throw step("Shipping", "Quick Add made " + countPackages(w) + " packages, expected " + want);
      // A state typed as a word ("Victoria") makes Ready Freight fall back to Aus Post Express: fix it first.
      const fixed = await fixStateWhenReady(w, "Shipping", p.row.courier === "PICKUP", p.row.courier === "CHILL");
      if (fixed) p.fixedState = fixed;
      await setDeliveryDate(w, p, "Shipping");
      if (dry) {
        p.dryResult = {
          status: w.nlapiGetFieldText("shipstatus"),
          method: w.nlapiGetFieldText("shipmethod") + (p.row.isTO ? ", delivery " + w.nlapiGetFieldValue("custbodyrsc_freight_req_del_date") : ""),
          carrier: [w.nlapiGetFieldText("custbodyrsc_freight_carrier"), w.nlapiGetFieldText("custbodyrsc_freight_carrier_service")].filter(Boolean).join(" / "),
          packages: countPackages(w),
          weight: w.nlapiGetFieldValue("custbodyrsc_freight_totalweight"),
        };
        leavePage(w);
        getFrame(slot).src = "about:blank";
        await sleep(300);
        return "dry";
      }
      say("Saving...");
      await saveFulfilment(w, ifId, "Shipping", slot);
      justSaved = true;
    }
    d.shipped = true;
    if (dry) {
      // Already shipped before this run: say what would happen, change nothing.
      const a = addressOf(ifId);
      const c = carrierOf(ifId);
      p.dryResult = {
        status: "Already Shipped",
        method: !c.custbodyrsc_freight_carrier_consid && p.row.courier !== "PICKUP" ? "no consignment: would check the state (" + a.text + ") and save again with " + p.method.name : isAusPost(c) ? "would void the Aus Post consignment and stop for the address (" + a.text + ") to be fixed by hand" : "would carry on to labels and billing",
        carrier: [c.custbodyrsc_freight_carrier, c.custbodyrsc_freight_carrier_service].filter(Boolean).join(" / "),
        packages: "?",
        weight: "?",
      };
      return "dry";
    }

    // 2. Consignment (not for pickups). The state was checked and fixed before Save, so if
    //    Ready Freight still picks Aus Post Express, void it and stop: the address needs a
    //    person (23/11/2026). Retry (or pasting the row again) saves it with the courier.
    //    It never voids and re-saves in a loop: each Aus Post result stops the order.
    const voidAndStop = async () => {
      const addr = addressOf(ifId).text;
      say("Aus Post Express: voiding the consignment...");
      let w = await openPage(ifUrl, "the item fulfilment", slot);
      const role = w.nlapiGetRole ? w.nlapiGetRole() : "";
      // Ready Freight's void page (what Void Consignment opens after its "Are you sure?"): press its Submit.
      w = await openPage(
        "/app/site/hosting/scriptlet.nl?script=customscriptrsc_readyfreight_s_void&deploy=1&custpage_rsc_freight_shipmentref=" + encodeURIComponent(ifId) +
          "&custpage_rsc_freight_shipmentreftype=itemfulfillment&custpage_rsc_freight_role=" + encodeURIComponent(role),
        "the void consignment page",
        slot
      );
      const submit = w.document.getElementById("submitter") || button(w, "Submit");
      if (!submit) throw step("Shipped, not billed", "Aus Post Express instead of the courier, and the void page had no Submit button. Void it and fix the address (" + addr + ") by hand");
      catchDialogs(w);
      const voided = nextLoad(60000, "the page after voiding", slot);
      submit.click();
      await voided;
      await sleep(1500);
      if (carrierOf(ifId).custbodyrsc_freight_carrier_consid) throw step("Shipped, not billed", "Aus Post Express instead of the courier, and it couldn't be voided. Void it and fix the address (" + addr + ") by hand");
      getFrame(slot).src = "about:blank";
      throw step("Shipped, consignment voided, not billed", "Ready Freight chose Aus Post Express instead of the courier. The consignment is voided; check and fix the address (" + addr + "), then Retry. No label printed");
    };

    let rf = carrierOf(ifId);
    if (p.row.courier !== "PICKUP" && !d.labels) {
      if (isAusPost(rf) && rf.custbodyrsc_freight_carrier_consid) await voidAndStop();
      if (!justSaved && !rf.custbodyrsc_freight_carrier_consid) {
        // Shipped earlier with no consignment (e.g. voided, address now fixed): check the
        // state, give it the courier and packages, save again.
        say("Checking the address state...");
        const w = await openPage(ifUrl + "&e=T", "the item fulfilment (edit)", slot);
        if (!w.nlapiSetFieldValue) throw step("Shipped, no consignment, not billed", "the item fulfilment didn't open in edit mode");
        const fixed = await fixStateWhenReady(w, "Shipped, no consignment, not billed", p.row.courier === "PICKUP", p.row.courier === "CHILL");
        if (fixed) p.fixedState = fixed;
        w.nlapiSetFieldValue("shipmethod", p.method.id);
        await sleep(2000);
        if (w.nlapiGetFieldValue("shipmethod") !== p.method.id) throw step("Shipped, no consignment, not billed", "couldn't set the shipping method to " + p.method.name);
        const want = p.row.plt + p.row.ctn;
        if (countPackages(w) !== want) {
          if (p.row.plt) await quickAdd(w, PKG.PLT, p.row.plt, true);
          if (p.row.ctn) await quickAdd(w, PKG.CTN, p.row.ctn, !p.row.plt);
        }
        if (countPackages(w) !== want) throw step("Shipped, no consignment, not billed", "packages are " + countPackages(w) + ", expected " + want);
        await setDeliveryDate(w, p, "Shipped, no consignment");
        say("Saving again...");
        await saveFulfilment(w, ifId, "Shipped, no consignment, not billed", slot);
        rf = carrierOf(ifId);
        if (!rf.custbodyrsc_freight_carrier_consid) {
          await sleep(4000);
          rf = carrierOf(ifId);
        }
        if (isAusPost(rf) && rf.custbodyrsc_freight_carrier_consid) await voidAndStop();
      }
    }
    let consid = rf.custbodyrsc_freight_carrier_consid;
    if (p.row.courier !== "PICKUP") {
      if (!consid) {
        await sleep(4000);
        consid = window.nlapiLookupField("itemfulfillment", ifId, "custbodyrsc_freight_carrier_consid");
      }
      if (!consid) throw step("Shipped, no consignment, not billed", "no Consignment ID after saving");
      p.connote = consid;

      // 3. Labels: the item fulfilment's Download Labels link.
      if (!d.labels) {
        say("Getting the labels...");
        let w = getFrame(slot).contentWindow;
        if (!/itemship\.nl/.test(w.location.pathname) || /e=T/.test(w.location.search)) w = await openPage(ifUrl, "the item fulfilment", slot);
        let link = [...w.document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Download Labels");
        if (!link) {
          w = await openPage(ifUrl, "the item fulfilment", slot); // refresh once
          link = [...w.document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Download Labels");
        }
        if (!link) throw step("Shipped, labels not printed, not billed", "no Download Labels link on the item fulfilment");
        const url = new URL(link.getAttribute("href"), location.href);
        const name = "Labels_" + p.row.so + "_" + consid + ".pdf";
        // The link points at NetSuite's extforms host; the same file path works on this
        // host with the login, so the PDF can be checked before printing.
        if (/\.netsuite\.com$/i.test(url.hostname)) queuePrint(p, { bytes: await fetchPdf(url.pathname + url.search), name });
        else queuePrint(p, { url: url.href, name });
        d.labels = true;
      }
    }

    // Store orders (TOs): packing slip after the labels, and that's it: never billed.
    if (p.row.isTO) {
      if (!d.paper) {
        say("Getting the packing slip...");
        queuePrint(p, { bytes: await fetchPdf(packingSlipUrl(p.rec.id, ifId, "TrnfrOrd")), name: "PackingSlip_" + p.row.so + ".pdf" });
        d.paper = true;
      }
      getFrame(slot).src = "about:blank";
      return "done";
    }

    // 4. Interflora: packing slip straight after the labels (SOP 2 part F prints it before Bill).
    if (p.interflora && !d.paper) {
      say("Getting the packing slip...");
      queuePrint(p, { bytes: await fetchPdf(packingSlipUrl(p.rec.id, ifId)), name: "PackingSlip_" + p.row.so + ".pdf" });
      d.paper = true;
    }

    // 5. Bill (never twice: check NetSuite for an invoice first).
    const findInvoice = () => search("invoice", [["createdfrom", "anyof", p.rec.id], "AND", ["mainline", "is", "T"]], [col("tranid")])[0];
    let inv = findInvoice();
    if (!inv) {
      const notBilled = p.row.courier === "PICKUP" ? "Shipped, not billed" : "Shipped, labels printed, not billed";
      say("Billing: opening the invoice...");
      const w = await openPage(ifUrl, "the item fulfilment", slot);
      const bill = button(w, "Bill");
      if (!bill) throw step(notBilled, "no Bill button on the item fulfilment");
      // The Bill button goes to custinvc.nl?...transform=salesord&itemship=<IF>. Open that
      // in a pop-up window, not the hidden frame: NetSuite's invoice set-up script crashes
      // inside a frame (NLDropdown, 23/11/2026), so its Save would never work there.
      const m = String(bill.getAttribute("onclick") || "").match(/'(\/app\/accounting\/transactions\/custinvc\.nl[^']*)'/);
      const billUrl = m ? m[1] : "/app/accounting/transactions/custinvc.nl?id=" + encodeURIComponent(p.rec.id) + "&memdoc=0&transform=salesord&e=T&itemship=" + encodeURIComponent(ifId) + "&whence=";
      getFrame(slot).src = "about:blank";
      const pop = window.open(billUrl, "nshBillWindow" + (slot || 0), "width=1000,height=760,left=" + (80 + 40 * (slot || 0)) + ",top=" + (60 + 40 * (slot || 0)));
      if (!pop) throw step(notBilled, "the browser blocked the billing pop-up. Allow pop-ups for NetSuite, then Retry");
      let said = [];
      try {
        // Ready = NetSuite says the page finished setting up (Save is ignored before that).
        let ready = false;
        for (let i = 0; i < 240 && !ready; i++) {
          await sleep(250);
          try {
            ready = /custinvc\.nl/.test(pop.location.pathname) && pop.document.readyState === "complete" && pop.NS && pop.NS.form && pop.NS.form.isInited();
          } catch (e) {}
        }
        if (!ready) throw step(notBilled, "the invoice page didn't finish loading. Nothing was billed, so Retry is safe");
        await sleep(500);
        say("Billing: saving the invoice...");
        said = catchDialogs(pop);
        const saveBtn = pop.document.getElementById("btn_multibutton_submitter") || pop.document.getElementById("submitter");
        if (!saveBtn) throw step(notBilled, "no Save button on the invoice");
        saveBtn.click();
        // NetSuite decides: wait for the invoice to exist (by hand it's a few seconds).
        for (let i = 0; i < 60 && !(inv = findInvoice()); i++) {
          await sleep(1500);
          let msgs = [];
          try {
            if (/transform=/.test(pop.location.search) && pop.document.readyState === "complete") msgs = said.concat(pageMessages(pop));
          } catch (e) {}
          if (i >= 3 && msgs.length) break; // still on the unsaved invoice with a message
        }
        if (!inv) {
          let msg = "";
          try {
            msg = reason(said.concat(pageMessages(pop)).join(" "));
          } catch (e) {}
          throw step(notBilled, msg || "the invoice didn't save. Check the sales order for an invoice before Retry");
        }
      } finally {
        try {
          leavePage(pop);
          pop.close();
        } catch (e) {}
      }
    }
    p.invoice = { id: inv.getId(), tranid: inv.getValue("tranid") };
    if (p.row.courier === "PICKUP") p.connote = p.invoice.tranid; // SOP 6: invoice number goes in CONNOTE #
    d.billed = true;

    // 6. Invoice (1 copy), connote stamped. Interflora already has its packing slip.
    if (!d.paper) {
      say("Getting the invoice...");
      {
        let pdf = await fetchPdf(invoicePdfUrl(p.invoice.id));
        if (p.row.courier !== "PICKUP") pdf = await stampConnote(pdf, p.connote);
        queuePrint(p, { bytes: pdf, name: "Invoice_" + p.invoice.tranid + ".pdf" });
      }
      d.paper = true;
    }
    getFrame(slot).src = "about:blank";
    return "done";
  }

  // Store orders only (retail SOP 3): the wave's Ready pick tasks (stock that wasn't
  // picked) are set to Done on each pick task's own page, line by line, then Save. A pick
  // task that also holds another order is never touched. Then the order's item fulfilment
  // is used (it appears once the wave is finished). Returns false in a dry run when there's
  // no item fulfilment yet (nothing more to show).
  async function finishWave(p, dry, say, slot) {
    const readyTasks = () => (p.rec.waveId ? search("picktask", [["wavename", "anyof", p.rec.waveId], "AND", ["status", "anyof", "READY"]], [col("status")]) : []);
    const tasks = readyTasks();
    let marked = 0;
    for (const t of tasks) {
      say("Wave " + p.rec.wave + ": pick task " + (marked + 1) + " of " + tasks.length + " to Done...");
      const w = await openPage(window.nlapiResolveURL("RECORD", "picktask", t.getId(), true), "the pick task", slot);
      if (!w.nlapiGetLineItemCount) throw step("Pick tasks", "a pick task on wave " + p.rec.wave + " didn't open in edit mode");
      const n = w.nlapiGetLineItemCount("pickactions");
      for (let i = 1; i <= n; i++) {
        if (String(w.nlapiGetLineItemValue("pickactions", "ordernumber", i)) !== String(p.rec.id)) {
          throw step("Pick tasks", "a Ready pick task on wave " + p.rec.wave + " also holds another order. Mark it Done by hand, then Retry");
        }
      }
      const said = catchDialogs(w);
      for (let i = 1; i <= n; i++) {
        w.nlapiSelectLineItem("pickactions", i);
        if (w.nlapiGetCurrentLineItemValue("pickactions", "status") === "DONE") continue;
        w.nlapiSetCurrentLineItemValue("pickactions", "status", "DONE");
        await sleep(400);
        w.nlapiCommitLineItem("pickactions");
        await sleep(300);
      }
      marked++;
      if (dry) {
        leavePage(w);
        continue;
      }
      const save = w.document.getElementById("btn_multibutton_submitter") || w.document.getElementById("submitter");
      if (!save) throw step("Pick tasks", "no Save button on the pick task");
      const saved = nextLoad(60000, "the saved pick task", slot);
      save.click();
      await saved;
      await sleep(800);
      if (said.length) throw step("Pick tasks", "NetSuite said: " + said.join(" ").slice(0, 200));
    }
    p.pickDone = marked;
    getFrame(slot).src = "about:blank";
    if (!dry && readyTasks().length) throw step("Pick tasks", "some pick tasks on wave " + p.rec.wave + " are still Ready after saving. Check the wave, then Retry");
    if (!p.iff) {
      if (dry) return false;
      say("Waiting for the item fulfilment...");
      for (let i = 0; i < 20 && !p.iff; i++) {
        const f = search("itemfulfillment", [["createdfrom", "anyof", p.rec.id], "AND", ["mainline", "is", "T"]], [col("tranid")])[0];
        if (f) p.iff = { id: f.getId(), tranid: f.getValue("tranid") };
        else await sleep(3000);
      }
      if (!p.iff) throw step("Pick tasks Done", "the Ready pick tasks are Done but no item fulfilment has appeared on wave " + p.rec.wave + " yet. Check it, then Retry");
    }
    return true;
  }

  // Store order with no packages (retail SOP 3, "push"): Shipped, method Custom, Save.
  // No courier, packages, labels or connote; nothing prints; never billed.
  async function pushOrder(p, dry, say, slot, ifUrl) {
    const d = (p.done = p.done || {});
    const ifId = p.iff.id;
    const f = w2f(window.nlapiLookupField("itemfulfillment", ifId, ["statusref"]));
    if (f.statusref !== "shipped") {
      say("Opening " + p.iff.tranid + "...");
      const w = await openPage(ifUrl + "&e=T", "the item fulfilment (edit)", slot);
      if (!w.nlapiSetFieldValue) throw step("Marking shipped", "the item fulfilment didn't open in edit mode");
      say("Setting Shipped, Custom...");
      w.nlapiSetFieldValue("shipstatus", "C");
      await sleep(1200);
      if (w.nlapiGetFieldValue("shipmethod") !== METHOD.CUSTOM.id) {
        w.nlapiSetFieldValue("shipmethod", METHOD.CUSTOM.id);
        await sleep(2000);
      }
      if (w.nlapiGetFieldValue("shipmethod") !== METHOD.CUSTOM.id) throw step("Marking shipped", "couldn't set the shipping method to Custom");
      if (dry) {
        p.dryResult = { status: w.nlapiGetFieldText("shipstatus"), method: w.nlapiGetFieldText("shipmethod") + ", no packages", carrier: "none", packages: countPackages(w), weight: "0" };
        leavePage(w);
        getFrame(slot).src = "about:blank";
        await sleep(300);
        return "dry";
      }
      say("Saving...");
      await saveFulfilment(w, ifId, "Marking shipped", slot);
    } else if (dry) {
      p.dryResult = { status: "Already Shipped", method: "nothing to do", carrier: "", packages: "-", weight: "-" };
      return "dry";
    }
    d.shipped = d.labels = d.paper = true;
    getFrame(slot).src = "about:blank";
    return "done";
  }

  function w2f(v) {
    return v || {};
  }
  function step(where, why) {
    const e = new Error(why);
    e.where = where;
    return e;
  }
  // Plain-words messages for the known errors (no SOP numbers, 23/11/2026).
  function reason(msg) {
    msg = String(msg || "").replace(/\s+/g, " ").trim();
    if (!msg) return "";
    if (/suburb|postcode|post code/i.test(msg)) return "Ready Freight can't match the suburb and postcode. Fix the address so it matches Chill's list (" + msg.slice(0, 200) + ")";
    if (/credit/i.test(msg)) return "Credit hold or limit: " + msg.slice(0, 200);
    return msg.slice(0, 300);
  }

  // ---------- copying (same as Bulk Waves) ----------

  async function copyText(text, btn) {
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
  // A connote or invoice number you can click to copy.
  const copyable = (v) => (v ? '<span class="nsh-copyable nsh-ship-num" title="Click to copy">' + esc(v) + "</span>" : "");
  function bindCopyables(root) {
    root.querySelectorAll(".nsh-ship-num").forEach((el) => {
      el.onclick = () => {
        const v = el.dataset.value || el.textContent;
        el.dataset.value = v;
        copyText(v);
        el.textContent = "Copied";
        setTimeout(() => (el.textContent = v), 1000);
      };
    });
  }

  // ---------- paste-back block ----------

  // Each pasted row whole, connote in the cell after the courier, NO -> YES.
  // Rows that weren't finished come back exactly as pasted.
  function pasteBack(plans) {
    return plans
      .map((p) => {
        const cells = p.row.cells.slice();
        if (p.result === "done" && p.connote && p.row.connoteAt >= 0) {
          cells[p.row.connoteAt] = p.connote;
          if (p.row.dispatchedAt >= 0) cells[p.row.dispatchedAt] = "YES";
        }
        return cells.join("\t");
      })
      .join("\n");
  }

  // ---------- panel (NetSuite look, shared CSS in content.css) ----------

  function getPanel() {
    let panel = document.getElementById("nsh-ship-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "nsh-ship-panel";
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

  function renderInput(text) {
    const panel = fill(
      "Ship Orders (Pasted Tracker Rows)",
      '<label class="nsh-label" for="nsh-ship-input">Rows from the CWS or Retail tracker</label>' +
        '<textarea id="nsh-ship-input" rows="6" placeholder="SO123456&#9;Customer name&#9;VIC&#9;CHILL&#9;&#9;3CTNS"></textarea>' +
        '<p class="nsh-wave-hint">Copy whole rows (dates and other columns are fine). Each order is shipped and billed: Shipped, shipping method, packages, Save, labels, Bill, invoice. Store orders (TOs) go Chill Express with the DELIVERY date, get labels and a packing slip, and are never billed. Everything prints through AutoPrint. You check the list before anything happens.</p>' +
        '<div class="nsh-wave-actions"><button type="button" id="nsh-ship-check">Check List</button></div>' +
        '<div id="nsh-ship-confirm"></div>' +
        restoreOffer()
    );
    const ta = panel.querySelector("#nsh-ship-input");
    if (text) ta.value = text;
    const restore = panel.querySelector("#nsh-ship-restore");
    panel.querySelector("#nsh-ship-check").onclick = () => {
      // A new list replaces the old job: stop offering to restore it (24/11/2026).
      // The saved job itself stays until a new run saves over it.
      const offer = restore && (restore.closest("p, div.nsh-ship-restore") || restore);
      if (offer) offer.remove();
      checkList(ta.value);
    };
    if (restore)
      restore.onclick = (e) => {
        e.preventDefault();
        const job = loadJob();
        if (!job) return;
        const plans = restoreJob(job);
        const work = plans.filter((p) => p.action === "ship");
        const done = work.filter((p) => p.result === "done").length;
        showFinished(plans, work, job.text, job.dry, true, (job.dry ? "Restored Dry Run" : "Restored Job: " + done + " of " + work.length + " done"));
      };
  }

  // Order number that opens the sales order in a new tab (24/11/2026), so the list stays put.
  const orderLink = (p) =>
    p.rec && p.rec.id
      ? '<a class="nsh-order-link" href="/app/accounting/transactions/transaction.nl?id=' + encodeURIComponent(p.rec.id) + '" target="_blank">' + esc(p.row.so) + "</a>"
      : esc(p.row.so);

  const pkgText = (row) => [row.plt ? row.plt + " PLT" : "", row.ctn ? row.ctn + " CTN" : ""].filter(Boolean).join(" + ");

  function checkList(text) {
    const box = getPanel().querySelector("#nsh-ship-confirm");
    const rows = parseRows(text);
    if (!rows.length) {
      box.innerHTML = '<p class="nsh-wave-warn">No SO or TO numbers found.</p>';
      return;
    }
    let info;
    try {
      info = lookup([...new Set(rows.map((r) => r.so))]);
    } catch (err) {
      alert("Ship orders: couldn't look the orders up in NetSuite. Refresh the page and try again.\n\n" + err.message);
      return;
    }
    const plans = plan(rows, info);
    const toShip = plans.filter((p) => p.action === "ship");
    const flagged = plans.filter((p) => p.action === "flag");
    const warned = toShip.filter((p) => p.warn.length);
    box.innerHTML =
      '<table class="nsh-wave-table"><tr><th>Order</th><th>Customer</th><th>Method</th><th>Packages</th><th>Sleeve</th><th></th></tr>' +
      plans
        .map(
          (p) =>
            '<tr class="' + (p.action === "flag" ? "nsh-wave-bad" : p.action === "skip" ? "nsh-wave-wait" : "") + '"><td>' + orderLink(p) + "</td><td>" + esc(p.row.customer) +
            "</td><td>" + esc(p.method ? p.method.name : "") + (p.push ? "<br>Store order, no packages: marked Shipped only" : p.row.isTO ? "<br>Store order: packing slip, not billed" : p.interflora ? "<br>Packing slip, not invoice" : "") +
            "</td><td>" + esc(pkgText(p.row)) + "</td><td>" + esc(p.action === "ship" ? p.code : "") + "</td><td>" +
            esc(p.action === "ship" ? (p.warn.join("; ") || "Ready") : (p.action === "flag" ? "Not shipped: " : "Skipped: ") + p.why) +
            // Already shipped by someone (or a run that stopped early): their labels may not be out.
            (p.action === "ship" && p.skipLabels
              ? '<br><label class="nsh-ship-labels"><input type="checkbox" data-order="' + esc(p.row.so) + '"> Print labels too (they didn\'t print)</label>'
              : "") +
            "</td></tr>"
        )
        .join("") +
      "</table>" +
      (toShip.some((p) => p.row.courier === "FW") ? '<p class="nsh-wave-hint">Freeway uses the Standard methods. Urgent Freeway (VIP or Premium) orders: take them off the list and do them by hand.</p>' : "") +
      (toShip.length
        ? '<label class="nsh-print-stamp"><input type="checkbox" id="nsh-ship-dry"' + (localStorage.getItem(DRY_KEY) === "1" ? " checked disabled" : "") + "> Dry run (fill each order in, don't save anything)</label>" +
          '<div class="nsh-wave-actions"><button type="button" class="nsh-primary" id="nsh-ship-go">' + (toShip.every((p) => p.row.isTO) ? "Ship " : "Ship and Bill ") + toShip.length + " Order" + (toShip.length > 1 ? "s" : "") + "</button></div>"
        : '<p class="nsh-wave-warn">Nothing to ship in this list.</p>');
    const msgs = [];
    if (flagged.length) msgs.push("Not shipped (do these by hand):\n" + flagged.map((p) => "  " + p.row.so + ": " + p.why).join("\n"));
    if (warned.length) msgs.push("Check these before you start:\n" + warned.map((p) => "  " + p.row.so + ": " + p.warn.join("; ")).join("\n"));
    if (msgs.length) alert("Ship orders: check your list.\n\n" + msgs.join("\n\n"));
    const go = box.querySelector("#nsh-ship-go");
    if (go)
      go.onclick = () => {
        box.querySelectorAll(".nsh-ship-labels input").forEach((cb) => {
          const p = plans.find((x) => x.row.so === cb.dataset.order);
          if (p) p.skipLabels = !cb.checked;
        });
        start(plans, text, box.querySelector("#nsh-ship-dry").checked || localStorage.getItem(DRY_KEY) === "1");
      };
  }

  async function helperReady() {
    const res = await toExtension("nsh-autoprint-state", {}, 8000);
    return res.ok && res.state === "running" ? "" : res.error || "The AutoPrint helper isn't running (AP? on the extension button).";
  }

  async function start(plans, text, dry) {
    const work = plans.filter((p) => p.action === "ship");
    if (!dry) {
      const notReady = await helperReady();
      if (notReady) {
        alert("Ship orders: AutoPrint isn't ready, so labels and invoices wouldn't print. Nothing was shipped.\n\n" + notReady);
        return;
      }
      if (!confirm("Ship and bill " + work.length + " order" + (work.length > 1 ? "s" : "") + " in NetSuite now?\n\nLabels and invoices print through AutoPrint as each order finishes.")) return;
    }
    if (typeof window.PDFLib === "undefined") {
      alert("Ship orders: the PDF tool didn't load. Reload the extension and refresh this page.");
      return;
    }
    await run(plans, work, text, dry);
  }

  // ---------- remembering the last job (survives a page refresh) ----------
  // 24/11/2026: after a refresh, offer to bring back the last job, finished or
  // cut off mid-run. Saved in this browser as the run goes (PDF bytes aren't kept).
  const JOB_KEY = "nshShipLastJob";
  let saveTimer = null;
  function saveJob(plans, text, dry, now) {
    const write = () => {
      saveTimer = null;
      try {
        const slim = plans.map((p) => {
          const q = Object.assign({}, p);
          const jobs = p.prints || [];
          q.printedNames = jobs.slice(0, p.printedCount || 0).map((j) => j.name);
          q.queuedNames = jobs.map((j) => j.name);
          delete q.prints;
          return q;
        });
        localStorage.setItem(JOB_KEY, JSON.stringify({ saved: Date.now(), text, dry, plans: slim }));
      } catch (e) {}
    };
    if (now) {
      clearTimeout(saveTimer);
      return write();
    }
    if (!saveTimer) saveTimer = setTimeout(write, 1000);
  }
  function loadJob() {
    try {
      const j = JSON.parse(localStorage.getItem(JOB_KEY) || "null");
      return j && Array.isArray(j.plans) ? j : null;
    } catch (e) {
      return null;
    }
  }
  // Rebuild a saved job. Anything not finished, or whose paperwork hadn't gone out, comes
  // back as failed so Retry Failed carries on: it checks NetSuite first (never ships or
  // bills twice) and only re-prints paperwork that never printed.
  function restoreJob(job) {
    const plans = job.plans;
    plans.forEach((p) => {
      if (p.action !== "ship") return;
      const printed = p.printedNames || [];
      const unsent = (p.queuedNames || []).length > printed.length;
      const d = (p.done = p.done || {});
      if (!p.skipLabels) d.labels = printed.some((n) => /^Labels_/.test(n));
      d.paper = printed.some((n) => /^(Invoice|PackingSlip)_/.test(n));
      p.prints = [];
      p.printedCount = 0;
      p.finished = true;
      if (!job.dry && (p.result === "" || p.result == null)) {
        p.result = "failed";
        p.note = "Stopped when the page was refreshed" + (p.lastStep ? " (while: " + p.lastStep + ")" : "") + ". Retry Failed carries on from there";
      } else if (!job.dry && p.result === "done" && unsent) {
        p.result = "failed";
        p.note = "Done, but its paperwork hadn't printed when the page was refreshed. Retry Failed prints it";
      }
    });
    return plans;
  }
  function restoreOffer() {
    const job = loadJob();
    if (!job || running) return "";
    const work = job.plans.filter((p) => p.action === "ship");
    if (!work.length) return "";
    const done = work.filter((p) => p.result === "done").length;
    const d = new Date(job.saved);
    const when = d.toLocaleDateString("en-AU", { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
    return (
      '<p class="nsh-ship-restore">Last job (' + esc(when) + "): " + work.length + " order" + (work.length > 1 ? "s" : "") + ", " +
      (job.dry ? "dry run" : done + " done") + '. <a href="#" class="dottedlink" id="nsh-ship-restore">Restore it</a></p>'
    );
  }

  function drawJob(work, title) {
    fill(
      title,
      '<table class="nsh-wave-table"><tr><th>Order</th><th>Customer</th><th>Sleeve</th><th>Connote</th><th>Invoice</th><th></th></tr>' +
        work
          .map((p) => {
            const cls = p.result === "failed" ? "nsh-wave-bad" : p.result ? "" : "nsh-wave-wait";
            const link = p.iff ? ' <a href="/app/accounting/transactions/itemship.nl?id=' + esc(p.iff.id) + '" target="_blank">' + esc(p.iff.tranid) + "</a>" : "";
            // Customer as pasted from the tracker (NetSuite's name if the row had none).
            const customer = p.row.customer || (p.rec && p.rec.customer) || "";
            return '<tr class="' + cls + '"><td>' + orderLink(p) + link + "</td><td>" + esc(customer) + "</td><td>" + esc(p.code) + "</td><td>" + copyable(p.connote) + "</td><td>" + copyable(p.invoice && p.invoice.tranid) + "</td><td>" + esc(p.note || "Waiting") + "</td></tr>";
          })
          .join("") +
        "</table><div id=\"nsh-ship-after\"></div>"
    );
    bindCopyables(getPanel());
  }

  let running = false;
  async function run(plans, work, text, dry) {
    if (running) return;
    running = true;
    window.__nshBusy = true; // the extension holds back its self-update while this is set
    window.onbeforeunload = () => "Orders are still being shipped.";
    const draw = (title) => {
      drawJob(work, title);
      saveJob(plans, text, dry);
    };
    // Faster (24/11/2026): WORKERS orders are worked on at once, each in its own
    // hidden frame and billing window; their labels and invoices print strictly in the
    // pasted order (an order's paperwork waits until every order above it is finished
    // and printed). Orders finished in an earlier run count as finished.
    const todo = [];
    work.forEach((p, k) => {
      if (p.result === "done" || p.result === "dry") p.finished = true;
      else {
        p.finished = false;
        p.result = "";
        todo.push(k);
      }
    });
    let finishedCount = work.length - todo.length;
    const title = () => (dry ? "Dry Run: " : "Shipping: ") + finishedCount + " of " + work.length + " done";
    let nextTodo = 0;
    const worker = async (slot) => {
      await sleep(slot * 1500); // stagger the start so the pages don't all load at once
      while (nextTodo < todo.length) {
        const k = todo[nextTodo++];
        await oneOrder(work[k], slot);
        work[k].finished = true;
        finishedCount++;
        draw(title());
        flushPrints(work, draw, title);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, (_, slot) => worker(slot)));
    await flushPrints(work, draw, title);

    async function oneOrder(p, slot) {
      p.lastStep = "";
      const say = (s) => {
        p.note = s;
        p.lastStep = s.replace(/\.\.\.$/, "");
        draw(title());
      };
      try {
        p.result = await runOrder(p, dry, say, slot);
        p.note = p.result === "dry"
          ? "Dry run OK: " + p.dryResult.status + ", " + p.dryResult.method + (p.dryResult.carrier ? " (" + p.dryResult.carrier + ")" : "") + ", " + p.dryResult.packages + " packages, " + p.dryResult.weight + " kg. Not saved."
          : "Done" + (p.listAfter ? ", now " + p.listAfter : "");
        if (p.fixedState) p.note += " (address fixed: " + p.fixedState + ")";
      } catch (err) {
        p.result = "failed";
        // Say how far it got, from what's done (e.g. a page that timed out).
        const d = p.done || {};
        const where = err.where || (d.billed ? "Shipped and billed, invoice not printed" : d.shipped ? "Shipped, not billed" : "Not shipped");
        // NetSuite's own errors (nlobjError) have no .message: use their code and details.
        let why = err && err.message;
        if (!why && err && typeof err.getDetails === "function") why = "NetSuite error " + (err.getCode ? err.getCode() + ": " : "") + err.getDetails();
        if (!why) why = String(err);
        p.note = where + ": " + why + (p.lastStep ? " (while: " + p.lastStep + ")" : "");
        try {
          leavePage(getFrame(slot).contentWindow);
          getFrame(slot).src = "about:blank";
        } catch (e) {}
      }
    }
    running = false;
    window.__nshBusy = false;
    window.onbeforeunload = null;
    saveJob(plans, text, dry, true);
    showFinished(plans, work, text, dry, false);
  }

  // The finished view (also used for a restored job; quiet = no pop-ups).
  function showFinished(plans, work, text, dry, quiet, heading) {
    const failed = work.filter((p) => p.result === "failed");
    const done = work.filter((p) => p.result === "done");
    const later = done.filter((p) => p.listAfter);
    drawJob(work, heading || (dry ? "Dry Run Finished (nothing saved)" : "Shipping Finished: " + done.length + " of " + work.length + " done"));
    const after = getPanel().querySelector("#nsh-ship-after");
    after.innerHTML =
      (later.length
        ? '<p><b>Still to do:</b></p><table class="nsh-wave-table"><tr><th>Order</th><th>Connote</th><th>Invoice</th><th></th></tr>' +
          later.map((p) => "<tr><td>" + orderLink(p) + "</td><td>" + copyable(p.connote) + "</td><td>" + copyable(p.invoice.tranid) + "</td><td>" + esc(p.listAfter) + "</td></tr>").join("") + "</table>"
        : "") +
      (!dry && done.length
        ? '<label class="nsh-label" for="nsh-ship-out">Paste back over the same rows in the tracker</label><textarea id="nsh-ship-out" rows="5" readonly></textarea>'
        : "") +
      '<div class="nsh-wave-actions">' +
      (!dry && done.length
        ? '<button type="button" class="nsh-primary" id="nsh-ship-copy-connotes">Copy Connotes</button>' +
          '<button type="button" id="nsh-ship-copy-both">Copy Orders + Connotes</button>' +
          '<button type="button" id="nsh-ship-copy">Copy Rows</button>'
        : "") +
      (failed.length ? '<button type="button" id="nsh-ship-retry">Retry Failed</button>' : "") +
      (dry && localStorage.getItem(DRY_KEY) !== "1" && work.some((p) => p.result === "dry")
        ? '<button type="button" class="nsh-primary" id="nsh-ship-real">Ship and Bill for Real</button>'
        : "") +
      '<button type="button" id="nsh-ship-new">New List</button></div>' +
      (!dry && done.length
        ? '<p class="nsh-wave-hint">Connotes copy one per line in the order you pasted, for the tracker\'s CONNOTE # column. Rows that weren\'t shipped copy their old connote, or a blank line. Click any connote or invoice number to copy just that one.</p>'
        : "");
    bindCopyables(after);
    const out = after.querySelector("#nsh-ship-out");
    if (out) out.value = pasteBack(plans);
    const connoteOf = (p) => (p.result === "done" && p.connote ? p.connote : p.row.connote || "");
    const copyConnotes = after.querySelector("#nsh-ship-copy-connotes");
    if (copyConnotes) copyConnotes.onclick = (e) => copyText(plans.map(connoteOf).join("\n"), e.target);
    const copyBoth = after.querySelector("#nsh-ship-copy-both");
    if (copyBoth) copyBoth.onclick = (e) => copyText(plans.map((p) => p.row.so + "\t" + connoteOf(p)).join("\n"), e.target);
    const copy = after.querySelector("#nsh-ship-copy");
    if (copy) copy.onclick = (e) => copyText(out.value, e.target);
    // After a dry run: run the same pasted list for real, no re-pasting. It's
    // checked against NetSuite again first (something may have changed since).
    const real = after.querySelector("#nsh-ship-real");
    if (real)
      real.onclick = async () => {
        let fresh;
        try {
          const rows = parseRows(text);
          fresh = plan(rows, lookup([...new Set(rows.map((r) => r.so))]));
        } catch (err) {
          alert("Ship orders: couldn't look the orders up in NetSuite again. Refresh the page and try again.");
          return;
        }
        const changed = fresh.filter((p) => p.action !== "ship" && work.some((w) => w.row.so === p.row.so && w.result === "dry"));
        if (changed.length) alert("Ship orders: these changed since the dry run and won't be shipped:\n\n" + changed.map((p) => p.row.so + ": " + p.why).join("\n"));
        if (!fresh.some((p) => p.action === "ship")) return;
        await start(fresh, text, false);
      };
    const retry = after.querySelector("#nsh-ship-retry");
    if (retry) retry.onclick = () => run(plans, work, text, dry);
    after.querySelector("#nsh-ship-new").onclick = () => renderInput("");
    if (quiet) return;
    const printProblems = work.filter((p) => p.printError);
    if (printProblems.length) {
      alert("Ship orders: some paperwork didn't print (the orders themselves are fine):\n\n" + printProblems.map((p) => p.row.so + ": " + p.printError).join("\n") + "\n\nPrint these by hand, or check AutoPrint is running.");
    }
    if (failed.length) {
      alert(
        "Ship orders: " + failed.length + (failed.length > 1 ? " orders need" : " order needs") + " doing by hand (the rest carried on):\n\n" +
          failed.map((p) => p.row.so + ": " + p.note).join("\n\n") +
          "\n\nFix the problem, then click Retry Failed. Finished steps are never repeated."
      );
    }
  }

  // ---------- start ----------

  if (window.__nshShipTest) {
    Object.assign(window.__nshShipTest, { parseRows, methodFor, sleeveCode, sameCustomer, plan, pasteBack, family, stateFromPostcode, badState, stateCodeOf, fixState, queuePrint, flushPrints, restoreJob, chillCheck, suburbKey });
    return;
  }
  // For checking the suburb/postcode rules against the live Chill list (read-only).
  window.__nshChillCheck = (city, zip, state) => chillCheck(city, zip, state, chillFind);
  renderInput("");
})();
