// Site-wide settings. Edit values here; every page reads them.
window.HD_CONFIG = {
  // Cloudflare Worker URL that creates Square checkout pages, e.g. "https://hdlaser-checkout.<account>.workers.dev/checkout".
  // Leave empty to fall back to plain quote requests (no online payment).
  CHECKOUT_ENDPOINT: "https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev/checkout",
  // Same worker, used for cookieless funnel counts and resale-permit records. Leave empty to disable.
  WORKER_BASE: "https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev",
  // Worker route that stores form submissions and emails through Resend. Leave empty to keep using Formspree.
  SUBMIT_ENDPOINT: "",
  FORMSPREE_ENDPOINT: "https://formspree.io/f/xaenoorj",
  SETUP_FEE: 50,
  MIN_CUPS: 50,
  // Base price per cup (12 oz engraved) by order size. Printed finish and 16 oz each add $2.
  TIERS: [[200, 12], [150, 13], [100, 14], [0, 15]],
  ADD_16OZ: 2,
  ADD_PRINTED: 2
};

// Cookieless funnel beacon. One random id per browser tab session; no personal data.
window.hdTrack = function (name, ref) {
  try {
    var base = window.HD_CONFIG.WORKER_BASE; if (!base) return;
    var sid = sessionStorage.getItem('hd_sid'); if (!sid) { sid = Math.random().toString(36).slice(2, 12); sessionStorage.setItem('hd_sid', sid); }
    var body = JSON.stringify({ name: name, session: sid, ref: ref || null, path: location.pathname });
    if (navigator.sendBeacon) { navigator.sendBeacon(base + '/event', new Blob([body], { type: 'application/json' })); }
    else { fetch(base + '/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true }).catch(function () {}); }
  } catch (e) {}
};
