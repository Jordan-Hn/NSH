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
    // Tracker COURIER codes (several with commas) -> method; "big" = the method for more than
    // 3 cartons or any pallets ("" = the same method). Keep in step with ship.js DEFAULT_COURIERS.
    couriers: [
      { codes: "CHILL", method: "58051", name: "Chill Refrigerated Transport - General", big: "", bigName: "" },
      { codes: "STE", method: "66829", name: "StarTrack Road Express", big: "", bigName: "" },
      { codes: "STP", method: "66831", name: "StarTrack Premium", big: "", bigName: "" },
      { codes: "FW, FREEWAY", method: "74678", name: "Freeway Courier <25kg Standard", big: "74679", bigName: "Freeway 1/2 Tonne <500kg Standard" },
      { codes: "PICKUP, PU, PICK UP", method: "28953", name: "Click & Collect", big: "", bigName: "" },
    ],
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

  // Every active NetSuite shipping method, as Ship Orders last read it (content.js keeps a
  // copy in chrome.storage "nshMethodList"); the short list above until then.
  let ALL_METHODS = METHODS;
  const methodOpts = () => ALL_METHODS.map((m) => opt(m[0], m[1])).join("");
  const methodName = (id) => (ALL_METHODS.find((m) => m[0] === String(id)) || [, ""])[1];

  // One list of couriers (27/11/2026): tracker code(s), method, and an optional second method
  // for more than 3 cartons or pallets. The usual ones start in the list and can be changed.
  function fillMethod(s, id, name, blank) {
    s.innerHTML = (blank ? opt("", "Same method") : "") + methodOpts();
    if (id && !ALL_METHODS.some((m) => m[0] === String(id))) s.insertAdjacentHTML(blank ? "beforeend" : "afterbegin", opt(id, name || "Method " + id));
    s.value = id || (blank ? "" : s.value);
  }
  function drawCouriers() {
    const t = $("#couriers tbody");
    t.innerHTML = S.couriers
      .map(
        (r, i) =>
          `<tr><td><input type="text" data-i="${i}" class="cr-codes" value="${String(r.codes || "").replace(/"/g, "&quot;")}" placeholder="e.g. UBER" style="width:145px"></td>` +
          `<td><select data-i="${i}" class="cr-method" style="width:200px"></select></td>` +
          `<td><select data-i="${i}" class="cr-big" style="width:200px"></select></td>` +
          `<td><button type="button" data-i="${i}" class="cr-del">Remove</button></td></tr>`
      )
      .join("");
    t.querySelectorAll(".cr-method").forEach((s) => {
      const r = S.couriers[s.dataset.i];
      fillMethod(s, r.method, r.name, false);
      if (!r.method) ((r.method = s.value), (r.name = methodName(s.value)));
      s.onchange = () => ((r.method = s.value), (r.name = s.options[s.selectedIndex].text), save());
    });
    t.querySelectorAll(".cr-big").forEach((s) => {
      const r = S.couriers[s.dataset.i];
      fillMethod(s, r.big, r.bigName, true);
      s.onchange = () => ((r.big = s.value), (r.bigName = s.value ? s.options[s.selectedIndex].text : ""), save());
    });
    const tidy = (v) => v.split(",").map((c) => c.trim().toUpperCase()).filter(Boolean).join(", ");
    t.querySelectorAll(".cr-codes").forEach((inp) => (inp.onchange = () => ((S.couriers[inp.dataset.i].codes = tidy(inp.value)), drawCouriers(), save())));
    t.querySelectorAll(".cr-del").forEach((b) => (b.onclick = () => (S.couriers.splice(b.dataset.i, 1), drawCouriers(), save())));
  }

  function draw() {
    document.querySelectorAll("select.method").forEach((s) => (s.innerHTML = methodOpts()));
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
    document.querySelectorAll("[data-tool]").forEach((el) => {
      el.checked = S.tools[el.dataset.tool] !== false;
      el.onchange = () => ((S.tools[el.dataset.tool] = el.checked), save());
    });
    drawPaperwork();
    drawCouriers();
    $("#courier-add").onclick = () => {
      S.couriers.push({ codes: "", method: "", name: "", big: "", bigName: "" });
      drawCouriers();
    };
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

  chrome.storage.local.get(["nshSettings", "nshMethodList"], (v) => {
    const saved = v.nshSettings || {};
    if (Array.isArray(v.nshMethodList) && v.nshMethodList.length) ALL_METHODS = v.nshMethodList.map((m) => [String(m.id), String(m.name)]);
    S = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), saved);
    // Settings saved before the one list (0.30.0-0.30.2): carry their courier choices over.
    if (!saved.couriers && (saved.courierMethods || saved.customCouriers)) {
      const cm = saved.courierMethods || {};
      const pick = (r, id, big) => Object.assign(r, id ? { method: String(id), name: methodName(id) || r.name } : {}, big ? { big: String(big), bigName: methodName(big) || r.bigName } : {});
      const [chill, ste, stp, fw, pu] = S.couriers;
      pick(chill, cm.CHILL); pick(ste, cm.STE); pick(stp, cm.STP); pick(fw, cm.FW_SMALL, cm.FW_BIG); pick(pu, cm.PICKUP);
      (saved.customCouriers || []).forEach((c) => c && c.code && c.method && S.couriers.push({ codes: String(c.code).toUpperCase(), method: String(c.method), name: c.name || "", big: "", bigName: "" }));
    }
    delete S.courierMethods;
    delete S.customCouriers;
    S.tools = Object.assign({}, DEFAULTS.tools, saved.tools || {});
    draw();
    loadPrinters();
  });
})();
