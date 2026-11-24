// NetSuite Helper: order details laid out like the CWS and Retail trackers,
// for the export buttons on the Pending Orders page (copy rows or download Excel).
//
// Runs on the Pending Orders saved search, in the page's own world, and only lends
// window.__nshOrderExport; stats.js adds the buttons.
//
// Where each column comes from (checked live 24/11/2026):
//   PICKING DATE / DATE  item fulfilment date (made at picking)
//   CUSTOMER / STORE     SO customer / TO destination ("Stores : Collins St." -> "Collins St.")
//   STATE                ship-to state as a code (VIC, NSW...)
//   COURIER              shipped fulfilment's method: Chill -> CHILL, StarTrack Road Express -> STE,
//                        StarTrack Premium -> STP, Freeway -> FW, Click & Collect -> PICKUP
//   CONNOTE #            Ready Freight consignment id (pickups: invoice number)
//   PLT/CTN              Ready Freight packages (custbodyrsc_freight_packages_data, Carton/Pallet)
//   SHIP DATE            order ship date
//   DISPATCH             YES once a fulfilment is Shipped
//   PICK QTY (#)         picked quantity on stock lines
//   WAVE                 newest wave holding the order
//   PO                   TO memo "Givex Purchase Order 700078764"
//   DELIVERY             Ready Freight required delivery date; COLLECTION = Ready Freight pickup date
// REF:, COMMENTS and MULTIDROP aren't in NetSuite, so they're left blank.

(function () {
  "use strict";

  // Loads on the Pending Orders page and only lends window.__nshOrderExport (no panel).
  if (!/[?&]searchid=146970(&|$)/.test(location.search) && !window.__nshOrdersTest) return;

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const col = (n, j) => new window.nlobjSearchColumn(n, j || null);
  const search = (type, filters, cols) => window.nlapiSearchRecord(type, null, filters, cols) || [];

  const CWS_COLS = ["PICKING DATE", "SO", "CUSTOMER", "STATE", "COURIER", "CONNOTE #", "PLT/CTN ", "SHIP DATE", "DISPATCH", "PICK QTY (#)", "WAVE", "REF:", "COMMENTS"];
  const CWS_WIDTHS = [30.29, 10.29, 77.71, 12.86, 11, 26, 11.86, 13.29, 10.57, 13.86, 9, 35.57, 41.43];
  const RETAIL_COLS = ["DATE", "PO", "TO", "WAVE", "STORE", "STATE", "CONNOTE #", "PLT/CTN ", "DELIVERY", "SHIP DATE", "COLLECTION", "DISPATCH", "COMMENTS"];
  const RETAIL_WIDTHS = [14.57, 11.86, 9.14, 8.57, 26.43, 6.86, 18.71, 9.57, 11.14, 11.71, 13.43, 10.86, 42];

  const STATE_CODES = {
    VIC: "VIC", VICTORIA: "VIC", NSW: "NSW", "NEW SOUTH WALES": "NSW", QLD: "QLD", QUEENSLAND: "QLD", WA: "WA", "WESTERN AUSTRALIA": "WA",
    SA: "SA", "SOUTH AUSTRALIA": "SA", TAS: "TAS", TASMANIA: "TAS", ACT: "ACT", "AUSTRALIAN CAPITAL TERRITORY": "ACT", NT: "NT", "NORTHERN TERRITORY": "NT",
  };
  const stateCode = (s) => STATE_CODES[String(s || "").trim().toUpperCase()] || String(s || "").trim();

  function courierOf(method, carrier) {
    const m = String(method || "") + " " + String(carrier || "");
    if (/Click/i.test(m)) return "PICKUP";
    if (/StarTrack Road Express/i.test(m)) return "STE";
    if (/StarTrack/i.test(m)) return "STP";
    if (/Freeway/i.test(m)) return "FW";
    if (/Chill/i.test(m)) return "CHILL";
    if (/Australia Post/i.test(m)) return "AUS POST";
    return String(method || carrier || "").toUpperCase();
  }

  // Ready Freight packages -> "3CTNS", "1PLT", "1PLT 2CTNS".
  function pltCtn(json) {
    let plt = 0;
    let ctn = 0;
    try {
      (JSON.parse(json || "[]") || []).forEach((p) => {
        const n = Number(p.quantity) || 1;
        if (/pallet|skid/i.test((p.packagingClassName || "") + " " + (p.packageTypeName || ""))) plt += n;
        else ctn += n;
      });
    } catch (e) {
      return "";
    }
    const part = (n, unit) => (n ? n + unit + (n > 1 ? "S" : "") : "");
    return [part(plt, "PLT"), part(ctn, "CTN")].filter(Boolean).join(" ");
  }

  // ---------- reading the list ----------

  function parseOrders(text) {
    const seen = new Set();
    const list = [];
    (String(text).toUpperCase().match(/\b(SO|TO)\d+\b/g) || []).forEach((o) => {
      if (!seen.has(o)) {
        seen.add(o);
        list.push(o);
      }
    });
    return list;
  }

  // ---------- NetSuite ----------

  function details(orders) {
    const info = {};
    const anyOf = (list) => {
      const any = [];
      list.forEach((o, i) => {
        if (i) any.push("OR");
        any.push(["tranid", "is", o]);
      });
      return any;
    };
    for (let i = 0; i < orders.length; i += 40) {
      const chunk = orders.slice(i, i + 40);
      search("transaction", [anyOf(chunk), "AND", ["mainline", "is", "T"], "AND", ["type", "anyof", ["SalesOrd", "TrnfrOrd"]]], [
        col("tranid"), col("type"), col("entity"), col("shipdate"), col("shipstate"), col("memo"), col("transferlocation"), col("statusref"),
      ]).forEach((r) => {
        const o = String(r.getValue("tranid")).toUpperCase();
        if (!chunk.includes(o)) return;
        const po = (String(r.getValue("memo") || "").match(/Purchase Order\s*(\d+)/i) || [])[1] || "";
        info[o] = {
          order: o, id: r.getId(), isTO: r.getValue("type") === "TrnfrOrd",
          customer: r.getText("entity") || "", store: String(r.getText("transferlocation") || "").replace(/^Stores\s*:\s*/i, ""),
          shipDate: r.getValue("shipdate") || "", state: stateCode(r.getValue("shipstate")), po, memo: r.getValue("memo") || "",
          status: r.getText("statusref") || "", ifs: [], wave: "", invoices: [], pickQty: 0,
        };
      });
    }
    const byId = {};
    Object.keys(info).forEach((o) => (byId[info[o].id] = o));
    const ids = Object.keys(byId);
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      search("itemfulfillment", [["createdfrom", "anyof", chunk], "AND", ["mainline", "is", "T"]], [
        col("createdfrom"), col("tranid"), col("trandate"), col("statusref"), col("shipmethod"), col("shipstate"),
        col("custbodyrsc_freight_carrier"), col("custbodyrsc_freight_carrier_consid"), col("custbodyrsc_freight_packages_data"),
        col("custbodyrsc_freight_req_del_date"), col("custbodyrsc_freight_pickup_date"), col("custbodyrsc_freight_shipment_created"),
      ]).forEach((r) => {
        const o = byId[r.getValue("createdfrom")];
        if (!o) return;
        info[o].ifs.push({
          tranid: r.getValue("tranid"), date: r.getValue("trandate"), shipped: r.getValue("statusref") === "shipped", status: r.getText("statusref"),
          method: r.getText("shipmethod"), carrier: r.getText("custbodyrsc_freight_carrier"), connote: r.getValue("custbodyrsc_freight_carrier_consid") || "",
          packages: pltCtn(r.getValue("custbodyrsc_freight_packages_data")), delivery: r.getValue("custbodyrsc_freight_req_del_date") || "",
          collection: r.getValue("custbodyrsc_freight_pickup_date") || "", state: stateCode(r.getValue("shipstate")),
          // When Ready Freight made the consignment = the day it actually shipped.
          shippedOn: (String(r.getValue("custbodyrsc_freight_shipment_created") || "").match(/^\d{1,2}\/\d{1,2}\/\d{4}/) || [""])[0],
        });
      });
      search("transaction", [["type", "anyof", "Wave"], "AND", ["appliedtotransaction", "anyof", chunk]], [col("tranid"), col("appliedtotransaction")]).forEach((r) => {
        const o = byId[r.getValue("appliedtotransaction")];
        const w = r.getValue("tranid");
        if (o && /^\d+$/.test(w) && Number(w) > Number(info[o].wave || 0)) info[o].wave = w;
      });
      search("invoice", [["createdfrom", "anyof", chunk], "AND", ["mainline", "is", "T"]], [col("tranid"), col("createdfrom")]).forEach((r) => {
        const o = byId[r.getValue("createdfrom")];
        if (o) info[o].invoices.push(r.getValue("tranid"));
      });
      search("transaction", [["internalid", "anyof", chunk], "AND", ["mainline", "is", "F"], "AND", ["item.type", "anyof", ["InvtPart", "Assembly", "Kit"]]], [
        col("quantitypicked"), col("quantityshiprecv"), col("quantity"), col("quantityuom"),
      ]).forEach((r) => {
        const o = byId[r.getId()];
        // Transfer orders list each line twice (from and to); only count the positive one.
        const n = Math.max(Number(r.getValue("quantitypicked")) || 0, Number(r.getValue("quantityshiprecv")) || 0);
        if (!o || n <= 0) return;
        // In the order's own units like the tracker (e.g. "ctn of 40": 1,980, not 79,200).
        const base = Math.abs(Number(r.getValue("quantity")) || 0);
        const inUnits = Math.abs(Number(r.getValue("quantityuom")) || 0);
        info[o].pickQty += base && inUnits ? (n * inUnits) / base : n;
      });
    }
    Object.keys(info).forEach((o) => {
      const d = info[o];
      // The fulfilment that carries the shipping details: newest shipped one with a connote, else newest.
      const withConnote = d.ifs.filter((f) => f.shipped && f.connote);
      d.main = withConnote[withConnote.length - 1] || d.ifs[d.ifs.length - 1] || null;
      d.shipped = d.ifs.some((f) => f.shipped);
      // The courier is only known once it ships: before that the fulfilment's method is a
      // placeholder ("Custom", "$32 Freight"), so leave it blank.
      d.courier = d.main && d.shipped ? courierOf(d.main.method, d.main.carrier) : "";
      // Shipped as "Custom" = a pickup, same as Click & Collect (24/11/2026: the two are
      // interchangeable). Before shipping every fulfilment shows Custom as a placeholder, so
      // this only applies once it's shipped.
      if (d.shipped && !d.isTO && (/^(CUSTOM|)$/.test(d.courier) || /^Custom$/i.test(String(d.main && d.main.method).trim()))) d.courier = "PICKUP";
      // SHIP DATE stays the order's ship date: it matched the tracker; Ready Freight's
      // "shipment created" is the packing day, a day early (checked 24/11/2026).
      d.pickQty = Math.round(d.pickQty * 100) / 100;
      const connotes = [...new Set(withConnote.map((f) => f.connote))];
      d.connote = d.courier === "PICKUP" ? d.invoices.join(" / ") : connotes.join(" / ");
      d.packages = d.main ? d.main.packages : "";
      d.pickDate = d.ifs.length ? d.ifs[0].date : "";
      if (!d.state && d.main) d.state = d.main.state;
    });
    return info;
  }

  // ---------- tracker rows ----------

  function cwsRows(orders, info) {
    return orders.filter((o) => info[o] && !info[o].isTO).map((o) => {
      const d = info[o];
      return [d.pickDate, d.order, d.customer, d.state, d.courier, d.connote, d.packages, d.shipDate, d.shipped ? "YES" : "NO", d.pickQty || "", d.wave, "", ""];
    });
  }

  // Store orders: consecutive TOs for the same store share one block, like the
  // tracker: the first row has the store's details, the rest just PO / TO / WAVE.
  function retailRows(orders, info) {
    const tos = orders.filter((o) => info[o] && info[o].isTO);
    const rows = [];
    for (let i = 0; i < tos.length; ) {
      const store = info[tos[i]].store;
      let j = i;
      while (j < tos.length && info[tos[j]].store === store) j++;
      const group = tos.slice(i, j).map((o) => info[o]);
      const lead = group.find((d) => d.main && d.main.connote) || group.find((d) => d.main) || group[0];
      const m = lead.main || {};
      group.forEach((d, k) => {
        rows.push(
          k === 0
            ? [d.pickDate || lead.pickDate, d.po, d.order, d.wave, store, lead.state || m.state || "", m.connote || "", m.packages || "", m.delivery || "", lead.shipDate, m.collection || "", group.some((x) => x.shipped) ? "YES" : "NO", ""]
            : ["", d.po, d.order, d.wave, "", "", "", "", "", "", "", "", ""]
        );
      });
      i = j;
    }
    return rows;
  }

  // ---------- Excel (.xlsx built here, no library) ----------

  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(b) {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // Plain (stored) zip.
  function zip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    });
    const cenSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, cenSize, true);
    end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]), { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  const xml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const colName = (i) => {
    let s = "";
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  };
  // dd/mm/yyyy -> Excel date number, or null.
  function excelDate(text) {
    const m = String(text || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return null;
    return (Date.UTC(+m[3], +m[2] - 1, +m[1]) - Date.UTC(1899, 11, 30)) / 86400000;
  }
  // Each sheet copies its tracker's look (read from the tracker files, 24/11/2026):
  //   CWS:    Aptos Narrow 11 bold, centred, thin black borders on every cell; header
  //           33 pt tall, 12 pt bold white on #215F9A; a grey (#AEAEAE) band row under
  //           it; PICKING DATE "Monday, 5 January 2026", SHIP DATE d/mm/yy; rows 14.25 pt.
  //   Retail: Calibri 11 bold, centred, thin borders; header 15.75 pt, 12 pt bold white
  //           on #2F5597; DATE d/mm/yyyy, DELIVERY / SHIP DATE / COLLECTION d/m/yyyy.
  //   Both:   DISPATCH YES = bold on green (#92D050), NO = bold on red (#FF0000),
  //           filter buttons on the header, header row frozen.
  // Style ids below match the cellXfs in STYLES_XML.
  const LOOKS = {
    cws: { header: 1, band: 2, text: 3, dates: { 0: 4, 7: 5 }, headerHeight: 33, rowHeight: 14.25 },
    retail: { header: 6, band: null, text: 7, dates: { 0: 8, 8: 9, 9: 9, 10: 9 }, headerHeight: 15.75, rowHeight: 15 },
  };
  function sheetXml(header, rows, widths, look, dispatchCol) {
    const L = LOOKS[look] || LOOKS.cws;
    const cell = (r, c, v, s) => {
      const ref = colName(c) + r;
      if (v === "" || v == null) return '<c r="' + ref + '" s="' + s + '"/>';
      if (s !== L.header && L.dates[c] != null && excelDate(v) != null) return '<c r="' + ref + '" s="' + L.dates[c] + '"><v>' + excelDate(v) + "</v></c>";
      if (s !== L.header && (typeof v === "number" || (/^\d{1,12}$/.test(String(v)) && !/^0\d/.test(String(v))))) return '<c r="' + ref + '" s="' + s + '"><v>' + Number(v) + "</v></c>";
      return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xml(v) + "</t></is></c>";
    };
    const n = header.length;
    const out = ['<row r="1" ht="' + L.headerHeight + '" customHeight="1">' + header.map((v, c) => cell(1, c, v.trim(), L.header)).join("") + "</row>"];
    let r = 2;
    if (L.band != null) {
      out.push('<row r="2" ht="' + L.rowHeight + '" customHeight="1">' + header.map((v, c) => cell(2, c, "", L.band)).join("") + "</row>");
      r = 3;
    }
    const first = r;
    rows.forEach((row) => {
      out.push('<row r="' + r + '" ht="' + L.rowHeight + '" customHeight="1">' + row.map((v, c) => cell(r, c, v, L.text)).join("") + "</row>");
      r++;
    });
    const last = r - 1;
    // Columns start at the tracker's widths and grow to fit what's in them (
    // some text didn't fit). Rough Excel character widths for bold text: 12 pt
    // header ~1.25 per character, 11 pt cells ~1.12, plus room for the filter arrow.
    const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const shown = (v, c) => {
      const m = String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m && L.dates[c] === 4) return DAYS[new Date(+m[3], +m[2] - 1, +m[1]).getDay()] + ", " + Number(m[1]) + " " + MONTHS[+m[2] - 1] + " " + m[3];
      return String(v);
    };
    // Measure the real text width with the sheet's font where the browser can
    // (canvas), else a generous estimate. Excel width = (pixels + padding) / 7.
    const family = look === "retail" ? "Calibri" : '"Aptos Narrow", Calibri';
    const measure = (text, pt) => {
      try {
        const ctx = (measure.ctx = measure.ctx || document.createElement("canvas").getContext("2d"));
        ctx.font = "bold " + (pt * 96) / 72 + "px " + family + ", Arial, sans-serif";
        return ctx.measureText(text).width;
      } catch (e) {
        return null;
      }
    };
    // Whichever is wider: the browser may not have Aptos Narrow and measures a stand-in
    // font, and a column a little too wide does no harm where a cut-off one does.
    const units = (text, pt, isHeader) => {
      const estimate = text.length * (isHeader ? 1.75 : 1.4) + (isHeader ? 4 : 2);
      const px = measure(text, pt);
      return px == null ? estimate : Math.max(estimate, (px + (isHeader ? 30 : 14)) / 7); // header: room for the filter arrow
    };
    const fitted = widths.map((w, c) => {
      let need = units(header[c].trim(), 12, true);
      rows.forEach((row) => {
        if (row[c] !== "" && row[c] != null) need = Math.max(need, units(shown(row[c], c), 11, false));
      });
      return Math.max(w, Math.ceil(need * 10) / 10);
    });
    const dcol = colName(dispatchCol);
    const cf =
      last >= first && dispatchCol >= 0
        ? '<conditionalFormatting sqref="' + dcol + first + ":" + dcol + last + '">' +
          '<cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="YES"><formula>NOT(ISERROR(SEARCH("YES",' + dcol + first + ")))</formula></cfRule>" +
          '<cfRule type="containsText" dxfId="1" priority="2" operator="containsText" text="NO"><formula>NOT(ISERROR(SEARCH("NO",' + dcol + first + ")))</formula></cfRule>" +
          "</conditionalFormatting>"
        : "";
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      "<cols>" + fitted.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols>" +
      "<sheetData>" + out.join("") + "</sheetData>" +
      '<autoFilter ref="A1:' + colName(n - 1) + '1"/>' +
      cf +
      "</worksheet>"
    );
  }
  const BORDER = '<border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border>';
  const CENTRE = '<alignment horizontal="center" vertical="center"/>';
  const xf = (numFmt, font, fill, border) =>
    '<xf numFmtId="' + numFmt + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + CENTRE + "</xf>";
  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="4"><numFmt numFmtId="164" formatCode="[$-C09]dddd\\,\\ d\\ mmmm\\ yyyy;@"/><numFmt numFmtId="165" formatCode="d/mm/yy;@"/><numFmt numFmtId="166" formatCode="d/mm/yyyy;@"/><numFmt numFmtId="167" formatCode="d/m/yyyy;@"/></numFmts>' +
    '<fonts count="5">' +
    '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Aptos Narrow"/><family val="2"/></font>' +
    '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Aptos Narrow"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="12"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>' +
    "</fonts>" +
    '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF215F9A"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFAEAEAE"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF2F5597"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + BORDER + "</borders>" +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="10"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    xf(0, 2, 2, 1) + // 1 CWS header
    xf(0, 1, 3, 1) + // 2 CWS grey band
    xf(0, 1, 0, 1) + // 3 CWS cell
    xf(164, 1, 0, 1) + // 4 CWS picking date
    xf(165, 1, 0, 1) + // 5 CWS ship date
    xf(0, 4, 4, 1) + // 6 Retail header
    xf(0, 3, 0, 1) + // 7 Retail cell
    xf(166, 3, 0, 1) + // 8 Retail DATE (d/mm/yyyy)
    xf(167, 3, 0, 1) + // 9 Retail DELIVERY / SHIP DATE / COLLECTION (d/m/yyyy, as the tracker)
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="2">' +
    '<dxf><font><b/><i val="0"/></font><fill><patternFill patternType="solid"><bgColor rgb="FF92D050"/></patternFill></fill></dxf>' +
    '<dxf><font><b/><i val="0"/><color theme="1"/></font><fill><patternFill patternType="solid"><bgColor rgb="FFFF0000"/></patternFill></fill></dxf>' +
    "</dxfs></styleSheet>";
  function excel(sheets) {
    const files = [
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + "</Types>" },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xml(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>" },
      { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "xl/styles.xml", data: STYLES_XML },
    ];
    sheets.forEach((s, i) => files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(s.header, s.rows, s.widths, s.look, s.header.indexOf("DISPATCH")) }));
    return zip(files);
  }

  // ---------- panel ----------

  async function copyText(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = old), 1200);
    }
  }



  // ---------- Excel laid out like the Pending Orders page ----------
  // 24/11/2026: a second Excel version that looks like the page: title,
  // summary counts, the list's header, a grey bar per section (Overdue, Ship today...),
  // white/grey striped rows, light red overdue rows, stock in red / amber / green.
  // spec = { title, subtitle, summary: [[[label, value]...]...], header: [...], widths: [...],
  //          groups: [{ title, rows: [{ cells: [...], overdue, stock, stockDetail }] }] }
  const PAGE_FILLS = { white: 6, stripe: 4, overdue: 5 };
  const PAGE_KINDS = ["text", "date", "number", "short", "ready", "check"];
  // cellXfs: 0 default, 1 title, 2 subtitle, 3 header, 4 section bar, 5 summary label,
  // 6 summary value, then 7.. = background x kind.
  const pageStyle = (bg, kind) => 7 + ["white", "stripe", "overdue"].indexOf(bg) * PAGE_KINDS.length + PAGE_KINDS.indexOf(kind);
  function pageStylesXml() {
    const thin = '<border><left/><right/><top/><bottom style="thin"><color rgb="FFE3E3E3"/></bottom><diagonal/></border>';
    const x = (numFmt, font, fill, border, align) =>
      '<xf numFmtId="' + numFmt + '" fontId="' + font + '" fillId="' + fill + '" borderId="' + border + '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"' + (align ? ' horizontal="' + align + '"' : "") + "/></xf>";
    const cells = [];
    ["white", "stripe", "overdue"].forEach((bg) => {
      const fill = PAGE_FILLS[bg];
      cells.push(x(0, 5, fill, 1)); // text
      cells.push(x(164, 5, fill, 1, "left")); // date
      cells.push(x(165, 5, fill, 1, "right")); // number
      cells.push(x(0, 6, fill, 1)); // stock short
      cells.push(x(0, 7, fill, 1)); // stock ready
      cells.push(x(0, 8, fill, 1)); // stock check
    });
    return (
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="#,##0.00"/></numFmts>' +
      '<fonts count="10">' +
      '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' + // 0
      '<font><b/><sz val="15"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>' + // 1 title
      '<font><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/><family val="2"/></font>' + // 2 subtitle
      '<font><sz val="9"/><color rgb="FF666666"/><name val="Calibri"/><family val="2"/></font>' + // 3 header / summary label
      '<font><b/><sz val="11"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>' + // 4 section bar
      '<font><sz val="10"/><color rgb="FF333333"/><name val="Calibri"/><family val="2"/></font>' + // 5 cell
      '<font><b/><sz val="10"/><color rgb="FFB00020"/><name val="Calibri"/><family val="2"/></font>' + // 6 short
      '<font><sz val="10"/><color rgb="FF1B7F3B"/><name val="Calibri"/><family val="2"/></font>' + // 7 ready
      '<font><b/><sz val="10"/><color rgb="FF8A5A00"/><name val="Calibri"/><family val="2"/></font>' + // 8 check
      '<font><b/><sz val="12"/><color rgb="FF255599"/><name val="Calibri"/><family val="2"/></font>' + // 9 summary value
      "</fonts>" +
      '<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      ["FFE5E5E5", "FFDFE4EB", "FFE8EDF4", "FFFBE3E3", "FFFFFFFF"].map((c) => '<fill><patternFill patternType="solid"><fgColor rgb="' + c + '"/><bgColor indexed="64"/></patternFill></fill>').join("") +
      "</fills>" +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' + thin + "</borders>" +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + (7 + cells.length) + '"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      x(0, 1, 0, 0) + x(0, 2, 0, 0) + x(0, 3, 2, 0) + x(0, 4, 3, 0) + x(0, 3, 2, 0, "center") + x(0, 9, 0, 0, "center") +
      cells.join("") +
      "</cellXfs>" +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
    );
  }
  function pageWorkbook(spec) {
    const n = spec.header.length;
    const last = colName(n - 1);
    const rows = [];
    const merges = [];
    let r = 1;
    const str = (ref, s, v) => '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + xml(v) + "</t></is></c>";
    const row = (cells, ht) => rows.push('<row r="' + r + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : "") + ">" + cells.join("") + "</row>");
    row([str("A" + r, 1, spec.title)], 22);
    merges.push("A" + r + ":" + last + r);
    r++;
    row([str("A" + r, 2, spec.subtitle || "")]);
    merges.push("A" + r + ":" + last + r);
    r += 2;
    // Summary: each table as a label row and a value row, side by side from column A.
    (spec.summary || []).forEach((pairs) => {
      if (!pairs.length) return;
      row(pairs.map((p, c) => str(colName(c) + r, 5, p[0])));
      r++;
      row(pairs.map((p, c) => (/^\d+$/.test(p[1]) ? '<c r="' + colName(c) + r + '" s="6"><v>' + p[1] + "</v></c>" : str(colName(c) + r, 6, p[1]))), 18);
      r += 2;
    });
    const headerRow = r;
    row(spec.header.map((h, c) => str(colName(c) + r, 3, h.toUpperCase())), 18);
    r++;
    const dateCol = spec.header.findIndex((h) => /DATE/i.test(h));
    const numCol = spec.header.findIndex((h) => /AMOUNT|TOTAL/i.test(h));
    const stockCol = spec.header.findIndex((h) => /STOCK/i.test(h));
    spec.groups.forEach((g) => {
      if (g.title) {
        row([str("A" + r, 4, g.title)].concat(spec.header.slice(1).map((h, c) => '<c r="' + colName(c + 1) + r + '" s="4"/>')), 20);
        merges.push("A" + r + ":" + last + r);
        r++;
      }
      g.rows.forEach((d, i) => {
        const bg = d.overdue ? "overdue" : i % 2 ? "stripe" : "white";
        row(
          d.cells.map((v, c) => {
            const ref = colName(c) + r;
            if (c === stockCol) return str(ref, pageStyle(bg, d.stock === "short" ? "short" : d.stock === "check" ? "check" : d.stock === "ready" ? "ready" : "text"), d.stockDetail && d.stock !== "ready" ? d.stockDetail.replace(/\n/g, "; ") : v);
            if (c === dateCol && excelDate(v) != null) return '<c r="' + ref + '" s="' + pageStyle(bg, "date") + '"><v>' + excelDate(v) + "</v></c>";
            const num = String(v).replace(/,/g, "");
            if (c === numCol && /^-?\d+(\.\d+)?$/.test(num)) return '<c r="' + ref + '" s="' + pageStyle(bg, "number") + '"><v>' + Number(num) + "</v></c>";
            return str(ref, pageStyle(bg, "text"), v);
          })
        );
        r++;
      });
    });
    const widths = spec.widths.map((w, c) => (c === stockCol ? Math.max(w, 40) : w));
    const sheet =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="' + headerRow + '" topLeftCell="A' + (headerRow + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      "<cols>" + widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join("") + "</cols>" +
      "<sheetData>" + rows.join("") + "</sheetData>" +
      '<mergeCells count="' + merges.length + '">' + merges.map((m) => '<mergeCell ref="' + m + '"/>').join("") + "</mergeCells>" +
      '<pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>' +
      "</worksheet>";
    return excelFiles([{ name: "Pending Orders", xml: sheet }], pageStylesXml());
  }
  // Workbook from ready-made sheet XML (shared by both Excel versions' zips).
  function excelFiles(sheets, stylesXml) {
    const files = [
      { name: "[Content_Types].xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join("") + "</Types>" },
      { name: "_rels/.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
      { name: "xl/workbook.xml", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => '<sheet name="' + xml(s.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join("") + "</sheets></workbook>" },
      { name: "xl/_rels/workbook.xml.rels", data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join("") + '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
      { name: "xl/styles.xml", data: stylesXml },
    ];
    sheets.forEach((s, i) => files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: s.xml }));
    return zip(files);
  }

  // Export for other pages (Pending Orders): the listed orders -> tracker rows / Excel.
  // The export lives on the list page, not a separate paste-in box (24/11/2026).
  function trackerExport(orders) {
    const info = details(orders);
    const cws = cwsRows(orders, info);
    const retail = retailRows(orders, info);
    const tabbed = (rows) => rows.map((r) => r.join("\t")).join("\n");
    const csvCell = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const csvRows = (header, rows) => [header.map((h) => h.trim())].concat(rows).map((r) => r.map(csvCell).join(",")).join("\r\n");
    return {
      count: cws.length + retail.filter((r) => r[2]).length,
      missing: orders.filter((o) => !info[o]),
      // Tracker layout as CSV: the CWS rows, then (if any) the Retail rows after a blank line.
      csv: () => [cws.length ? csvRows(CWS_COLS, cws) : "", retail.length ? csvRows(RETAIL_COLS, retail) : ""].filter(Boolean).join("\r\n\r\n"),
      copy: (btn) => copyText([cws.length ? tabbed(cws) : "", retail.length ? tabbed(retail) : ""].filter(Boolean).join("\n\n"), btn),
      download: (name) => {
        const sheets = [];
        if (cws.length) sheets.push({ name: "CWS", header: CWS_COLS, rows: cws, widths: CWS_WIDTHS, look: "cws" });
        if (retail.length) sheets.push({ name: "Retail", header: RETAIL_COLS, rows: retail, widths: RETAIL_WIDTHS, look: "retail" });
        if (!sheets.length) return;
        const url = URL.createObjectURL(excel(sheets));
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      },
    };
  }
  window.__nshOrderExport = { trackerExport, pageWorkbook };
  if (window.__nshOrdersTest) {
    Object.assign(window.__nshOrdersTest, { parseOrders, courierOf, pltCtn, cwsRows, retailRows, excelDate, stateCode, colName, sheetXml, crc32, excel, CWS_COLS, CWS_WIDTHS, RETAIL_COLS, RETAIL_WIDTHS, pageWorkbook });
  }
})();
