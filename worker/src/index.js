// HD Laser checkout worker.
// Receives an order built on hdlaser.net, re-prices it server-side, and asks Square for a hosted checkout page.
// Card details never touch this code or the website; Square collects them on its own page.

const PRICING = {
  tiers: [[200, 12], [150, 13], [100, 14], [0, 15]], // [min cups, base price per 12 oz engraved cup]
  add16oz: 2,
  addPrinted: 2,
  setupFee: 50,
  minCups: 50,
};

const COLORS = ["Pink", "Bikini Pink", "Cream", "Yellow", "Orange", "Purple", "Light Green", "Army Green", "Light Blue", "Navy", "Dark Gray", "Black"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, env: env.SQUARE_ENV }, 200, cors);
    if (request.method !== "POST" || url.pathname !== "/checkout") return json({ error: "Not found" }, 404, cors);
    if (!cors["Access-Control-Allow-Origin"]) return json({ error: "Origin not allowed" }, 403, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }

    const check = validate(body);
    if (check.error) return json({ error: check.error }, 400, cors);
    const { lines, customer, ref, notes } = check;

    const priced = price(lines);
    const depositPct = clamp(parseInt(env.DEPOSIT_PERCENT || "100", 10) || 100, 1, 100);

    const lineItems = priced.lines.map((l) => ({
      name: `${l.size} oz ${l.finish === "printed" ? "UV printed" : "laser engraved"} cup, ${l.color}, ${l.lid === "black" ? "black" : "matching"} lid`,
      quantity: String(l.qty),
      base_price_money: { amount: l.unit * 100, currency: "USD" },
    }));
    lineItems.push({ name: "One-time setup (first order only)", quantity: "1", base_price_money: { amount: PRICING.setupFee * 100, currency: "USD" } });

    let order;
    if (depositPct === 100) {
      order = { location_id: env.SQUARE_LOCATION_ID, reference_id: ref, line_items: lineItems };
    } else {
      const deposit = Math.round(priced.totalCents * depositPct / 100);
      order = {
        location_id: env.SQUARE_LOCATION_ID,
        reference_id: ref,
        line_items: [{
          name: `${depositPct}% deposit on order ${ref} (${priced.count} cups, $${priced.totalCents / 100} total)`,
          quantity: "1",
          base_price_money: { amount: deposit, currency: "USD" },
          note: priced.lines.map((l) => `${l.qty} x ${l.size} oz ${l.finish} ${l.color} (${l.lid} lid)`).join("; ").slice(0, 2000),
        }],
      };
    }

    const payload = {
      idempotency_key: `${ref}-${Date.now()}`,
      order,
      checkout_options: {
        redirect_url: `${env.SITE_URL}/thanks/?paid=1&ref=${encodeURIComponent(ref)}`,
        ask_for_shipping_address: false,
        merchant_support_email: env.SUPPORT_EMAIL,
        allow_tipping: false,
      },
      pre_populated_data: {
        buyer_email: customer.email,
        buyer_phone_number: e164(customer.phone),
      },
      payment_note: `hdlaser.net order ${ref} for ${customer.business || customer.name}${notes ? " | " + notes.slice(0, 200) : ""}`.slice(0, 500),
    };

    const host = env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
    const res = await fetch(`${host}/v2/online-checkout/payment-links`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
        "Square-Version": "2025-01-23",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.payment_link) {
      const msg = (data.errors && data.errors[0] && data.errors[0].detail) || "Square did not return a checkout link";
      return json({ error: msg }, 502, cors);
    }
    return json({ url: data.payment_link.url, ref, total: priced.totalCents / 100, deposit_percent: depositPct }, 200, cors);
  },
};

function validate(body) {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length || lines.length > 40) return { error: "No order lines" };
  const clean = [];
  for (const l of lines) {
    const size = String(l.size); const finish = String(l.finish); const lid = String(l.lid); const color = String(l.color); const qty = parseInt(l.qty, 10);
    if (!["12", "16"].includes(size)) return { error: "Bad size" };
    if (!["engraved", "printed"].includes(finish)) return { error: "Bad finish" };
    if (!["matching", "black"].includes(lid)) return { error: "Bad lid" };
    if (!COLORS.includes(color)) return { error: "Bad color" };
    if (!(qty >= 1 && qty <= 5000)) return { error: "Bad quantity" };
    clean.push({ size, finish, lid, color, qty });
  }
  const count = clean.reduce((a, l) => a + l.qty, 0);
  if (count < PRICING.minCups) return { error: `Orders start at ${PRICING.minCups} cups` };
  const c = body.customer || {};
  const email = String(c.email || "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Valid email required" };
  if (!c.agreed) return { error: "Terms must be accepted" };
  const ref = /^HD-[A-Z0-9]{4,12}$/.test(String(body.ref || "")) ? body.ref : "HD-" + Date.now().toString(36).toUpperCase();
  return {
    lines: clean,
    customer: { email, phone: String(c.phone || "").trim(), name: String(c.name || "").trim().slice(0, 80), business: String(c.business || "").trim().slice(0, 80) },
    ref,
    notes: String(body.notes || "").trim(),
  };
}

function price(lines) {
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const base = PRICING.tiers.find(([min]) => count >= min)[1];
  const priced = lines.map((l) => ({ ...l, unit: base + (l.size === "16" ? PRICING.add16oz : 0) + (l.finish === "printed" ? PRICING.addPrinted : 0) }));
  const cups = priced.reduce((a, l) => a + l.unit * l.qty, 0);
  return { lines: priced, count, base, cups, totalCents: (cups + PRICING.setupFee) * 100 };
}

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } }); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function e164(phone) { const d = String(phone || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return undefined; }
