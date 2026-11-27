// NetSuite Helper settings page (27/11/2026). Settings are kept in this browser only
// (chrome.storage.local "nshSettings"); content.js copies them into NetSuite pages so the
// tools can read them. Printers and copies are AutoPrint's own settings on this PC
// (autoprint\settings.ini), read and saved through the AutoPrint host.
(function () {
  "use strict";

  // Defaults = how the tools worked before there were settings. Keep in step with the
  // defaults each tool uses when a setting is missing.
  const DEFAULTS = {
    paperwork: [{ name: "Interflora", paper: "slip" }],
    toMethod: "59672",
    toSlips: true,
    workers: 3,
    autoRetry: true,
    shipAutoPrint: true,
    courierMethods: { CHILL: "58051", STE: "66829", STP: "66831", FW_SMALL: "74678", FW_BIG: "74679", PICKUP: "28953" },
    waveHelpers: "auto",
    wavesAutoPrint: false,
    stampWave: true,
    stampCode: true,
    stampDel: true,
    delFormat: "d/m",
    pendingView: "normal",
    stockLabel: "both",
    overdueGrace: 0,
    samplesSection: true,
    stripeColour: "#e8edf4",
    overdueColour: "#fbe3e3",
    connote: true,
    tidy: true,
    tools: { pending: true, shipOrders: true, bulkOpen: true, bulkWaves: true, bulkPrint: true, copyRow: true, homeBox: true, helperMenu: true },
    copyAll: true,
  };
  const METHODS = [
    ["58051", "Chill Refrigerated Transport - General"],
    ["59672", "Chill Refrigerated Transport - Express"],
    ["66829", "StarTrack Road Express"],
    ["66831", "StarTrack Premium"],
    ["74678", "Freeway Courier <25kg Standard"],
    ["74679", "Freeway 1/2 Tonne <500kg Standard"],
    ["28953", "Click & Collect"],
    ["6410", "Custom"],
  ];
  const COURIERS = [
    ["CHILL", "CHILL"],
    ["STE", "STE (StarTrack Express)"],
    ["STP", "STP (StarTrack Premium)"],
    ["FW_SMALL", "FW, 3 cartons or fewer"],
    ["FW_BIG", "FW, more than 3 cartons or pallets"],
    ["PICKUP", "PICKUP"],
  ];
  const TOOLS = [
    ["pending", "Pending Orders page"],
    ["shipOrders", "Ship Orders"],
    ["bulkOpen", "Bulk Open"],
    ["bulkWaves", "Bulk Waves"],
    ["bulkPrint", "Bulk Print"],
    ["copyRow", "Copy Tracker Row"],
    ["homeBox", "Home page box"],
    ["helperMenu", "Helper menu"],
  ];
  const PAPER = [
    ["slip", "Packing slip"],
    ["invoice", "Invoice"],
    ["both", "Both"],
  ];

  let S = JSON.parse(JSON.stringify(DEFAULTS));
  const $ = (sel) => document.querySelector(sel);
  const opt = (v, t) => `<option value="${v}">${t.replace(/</g, "&lt;")}</option>`;

  function save() {
    S.rev = Date.now();
    chrome.storage.local.set({ nshSettings: S }, () => {
      const el = $("#saved");
      el.style.display = "block";
      clearTimeout(save.t);
      save.t = setTimeout(() => (el.style.display = "none"), 1200);
    });
  }

  function drawPaperwork() {
    const t = $("#paperwork");
    t.innerHTML = S.paperwork
      .map(
        (r, i) =>
          `<tr><td><input type="text" data-i="${i}" class="pw-name" value="${String(r.name).replace(/"/g, "&quot;")}" placeholder="Customer name starts with"></td>` +
          `<td><select data-i="${i}" class="pw-paper">${PAPER.map((p) => opt(p[0], p[1])).join("")}</select></td>` +
          `<td><button type="button" data-i="${i}" class="pw-del">Remove</button></td></tr>`
      )
      .join("");
    t.querySelectorAll(".pw-paper").forEach((s) => (s.value = S.paperwork[s.dataset.i].paper));
    t.querySelectorAll(".pw-name").forEach((inp) => (inp.onchange = () => ((S.paperwork[inp.dataset.i].name = inp.value.trim()), save())));
    t.querySelectorAll(".pw-paper").forEach((s) => (s.onchange = () => ((S.paperwork[s.dataset.i].paper = s.value), save())));
    t.querySelectorAll(".pw-del").forEach((b) => (b.onclick = () => (S.paperwork.splice(b.dataset.i, 1), drawPaperwork(), save())));
  }

  function draw() {
    document.querySelectorAll("select.method").forEach((s) => (s.innerHTML = METHODS.map((m) => opt(m[0], m[1])).join("")));
    $("#courier-methods").innerHTML = COURIERS.map(
      (c) => `<label>${c[1]}<br><select data-courier="${c[0]}">${METHODS.map((m) => opt(m[0], m[1])).join("")}</select></label>`
    ).join("");
    $("#tools").innerHTML = TOOLS.map((t) => `<label><input type="checkbox" data-tool="${t[0]}"> ${t[1]}</label>`).join("");

    document.querySelectorAll("[data-key]").forEach((el) => {
      const v = S[el.dataset.key];
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = String(v);
      el.onchange = () => {
        S[el.dataset.key] = el.type === "checkbox" ? el.checked : el.dataset.num ? Number(el.value) : el.value;
        save();
      };
    });
    document.querySelectorAll("[data-courier]").forEach((el) => {
      el.value = S.courierMethods[el.dataset.courier];
      el.onchange = () => ((S.courierMethods[el.dataset.courier] = el.value), save());
    });
    document.querySelectorAll("[data-tool]").forEach((el) => {
      el.checked = S.tools[el.dataset.tool] !== false;
      el.onchange = () => ((S.tools[el.dataset.tool] = el.checked), save());
    });
    drawPaperwork();
    $("#paperwork-add").onclick = () => {
      S.paperwork.push({ name: "", paper: "slip" });
      drawPaperwork();
    };
  }

  // ---------- Auto Print (this PC's AutoPrint settings, through the host) ----------
  function apStatus(t) {
    $("#ap-status").textContent = t;
  }
  function loadPrinters() {
    apStatus("Asking AutoPrint...");
    chrome.runtime.sendMessage({ type: "nsh-printers-get" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        apStatus("AutoPrint isn't answering. Run Restart AutoPrint, then reopen this page.");
        return;
      }
      const list = res.printers || [];
      ["labelPrinter", "pagePrinter"].forEach((id) => {
        const cur = id === "labelPrinter" ? res.label : res.page;
        const names = list.includes(cur) || !cur ? list : [cur].concat(list);
        $("#" + id).innerHTML = names.map((n) => opt(n.replace(/"/g, "&quot;"), n)).join("");
        $("#" + id).value = cur || "";
      });
      $("#labelCopies").value = res.labelCopies || 1;
      $("#palletCopies").value = res.palletCopies || 2;
      $("#invoiceCopies").value = res.invoiceCopies || 1;
      $("#pageCopies").value = res.pageCopies || 1;
      apStatus("");
    });
  }
  $("#ap-save").onclick = () => {
    const n = (id) => Math.min(9, Math.max(1, parseInt($("#" + id).value, 10) || 1));
    apStatus("Saving...");
    chrome.runtime.sendMessage(
      { type: "nsh-printers-save", label: $("#labelPrinter").value, page: $("#pagePrinter").value, labelCopies: n("labelCopies"), palletCopies: n("palletCopies"), invoiceCopies: n("invoiceCopies"), pageCopies: n("pageCopies") },
      (res) => apStatus(chrome.runtime.lastError || !res || !res.ok ? "Couldn't save: " + ((res && res.error) || "AutoPrint isn't answering") : "Saved. AutoPrint has restarted with these printers.")
    );
  };

  chrome.storage.local.get("nshSettings", (v) => {
    const saved = v.nshSettings || {};
    S = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), saved);
    S.courierMethods = Object.assign({}, DEFAULTS.courierMethods, saved.courierMethods || {});
    S.tools = Object.assign({}, DEFAULTS.tools, saved.tools || {});
    draw();
    loadPrinters();
  });
})();
