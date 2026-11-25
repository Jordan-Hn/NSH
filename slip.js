// NetSuite Helper: shows a tidied packing slip (lib/packingslip-fix.js) in Chrome's PDF
// viewer. background.js swaps a NetSuite packing slip tab to this page; the Auto Print
// button prints what this page shows. The address holds a key and NetSuite's own link,
// so the slip can be fetched again if the browser has forgotten it.
(function () {
  "use strict";
  const frame = document.getElementById("pdf");
  const hash = location.hash.slice(1);
  const bar = hash.indexOf("|");
  const original = bar >= 0 ? decodeURIComponent(hash.slice(bar + 1)) : "";

  function fail() {
    frame.remove();
    const p = document.createElement("p");
    p.textContent = "Couldn't show the tidied packing slip. ";
    if (/^https:\/\/[^/]+\.netsuite\.com\//.test(original)) {
      const a = document.createElement("a");
      a.href = original + (original.includes("#") ? "" : "#nsh-original");
      a.textContent = "Open NetSuite's version";
      p.appendChild(a);
    }
    document.body.appendChild(p);
  }

  chrome.runtime.sendMessage({ type: "nsh-slip-get", hash }, (entry) => {
    if (chrome.runtime.lastError || !entry || !entry.b64) return fail();
    document.title = String(entry.name || "Packing Slip").replace(/\.pdf$/i, "");
    const bytes = Uint8Array.from(atob(entry.b64), (c) => c.charCodeAt(0));
    frame.src = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  });
})();
