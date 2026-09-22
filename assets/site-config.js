// Site-wide settings. Edit values here; every page reads them.
window.HD_CONFIG = {
  // Cloudflare Worker URL that creates Square checkout pages, e.g. "https://hdlaser-checkout.<account>.workers.dev/checkout".
  // Leave empty to fall back to plain quote requests (no online payment).
  CHECKOUT_ENDPOINT: "https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev/checkout",
  FORMSPREE_ENDPOINT: "https://formspree.io/f/xaenoorj",
  SETUP_FEE: 50,
  MIN_CUPS: 50,
  // Base price per cup (12 oz engraved) by order size. Printed finish and 16 oz each add $2.
  TIERS: [[200, 12], [150, 13], [100, 14], [0, 15]],
  ADD_16OZ: 2,
  ADD_PRINTED: 2
};
