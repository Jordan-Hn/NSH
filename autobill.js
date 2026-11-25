// NetSuite Helper: saves an invoice in a background tab for Ship Orders (25/11/2026).
// Only acts when the invoice page was opened by Ship Orders with #nshbill=<token> in its
// address (any other invoice page is left alone). It waits until NetSuite says the page has
// finished setting up, presses Save once, and reports to Ship Orders through localStorage
// (nshBill:<token>): loading -> saving, or error with NetSuite's messages. The token is
// taken out of the address straight away, so a refresh or Back can never save again.
// "#nshbill=<token>:dry" waits for the page and reports "ready-dry" without saving (tests).
(function () {
  "use strict";
  const m = location.hash.match(/^#nshbill=([A-Za-z0-9_-]+)(:dry)?$/);
  if (!m) return;
  const key = "nshBill:" + m[1];
  const dry = !!m[2];
  const put = (o) => {
    try {
      localStorage.setItem(key, JSON.stringify(Object.assign({ at: Date.now() }, o)));
    } catch (e) {}
  };
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch (e) {}
  // NetSuite's pop-ups would stop the page; note them instead and say no to questions.
  const said = [];
  window.alert = (x) => said.push(String(x));
  window.confirm = (x) => {
    said.push(String(x));
    return false;
  };
  const pageMessages = () =>
    [...document.querySelectorAll(".uir-alert-box, #div__alert, .uir-message-text, .descr")]
      .map((e) => e.innerText.trim())
      .filter((t, i, a) => t && a.indexOf(t) === i)
      .slice(0, 5);
  put({ state: "loading" });
  let tries = 0;
  const wait = setInterval(() => {
    tries++;
    let ready = false;
    try {
      ready = document.readyState === "complete" && window.NS && window.NS.form && window.NS.form.isInited();
    } catch (e) {}
    if (!ready) {
      if (tries > 360) {
        clearInterval(wait);
        put({ state: "error", msgs: ["the invoice page didn't finish loading"].concat(said) });
      }
      return;
    }
    clearInterval(wait);
    if (dry) return put({ state: "ready-dry" });
    const save = document.getElementById("btn_multibutton_submitter") || document.getElementById("submitter");
    if (!save) return put({ state: "error", msgs: ["no Save button on the invoice"] });
    put({ state: "saving" });
    setTimeout(() => {
      save.click();
      // Still on this page a while later = NetSuite didn't save it: pass on what it said.
      setTimeout(() => put({ state: "error", msgs: said.concat(pageMessages()) }), 25000);
    }, 500);
  }, 250);
})();
