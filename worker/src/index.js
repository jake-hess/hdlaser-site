// HD Laser worker: Square checkout, order ledger, Square sync, KPI dashboard, weekly digest.
// Card details never touch this code; Square collects them on its hosted page.
//
// Routes
//   POST /checkout            create a Square checkout for a calculator order (called by the website)
//   POST /event               funnel beacon from the website (cookieless)
//   POST /resale              resale permit info from the thank-you page
//   POST /webhooks/square     Square webhook (payment.*, refund.*), verified with the signature key
//   GET  /health
//   GET  /admin               KPI dashboard (Basic auth, password = ADMIN_KEY)
//   GET  /api/kpis?from&to    KPI JSON (Basic auth)
//   GET  /api/orders.csv      export (Basic auth)
//   POST /api/orders/:ref     set a status timestamp or note (Basic auth)
//   POST /api/sync            pull recent payments/refunds from Square now (Basic auth)
//   POST /api/digest          send the weekly digest now (Basic auth)
// Cron (hourly): sync Square; on Mondays at 15:00 UTC also send the digest.

const PRICING = {
  tiers: [[200, 12], [150, 13], [100, 14], [0, 15]], // [min cups, base price per 12 oz engraved cup]
  add16oz: 2,
  addPrinted: 2,
  setupFee: 50,
  minCups: 50,
};
const COLORS = ["Pink", "Bikini Pink", "Cream", "Yellow", "Orange", "Purple", "Light Green", "Army Green", "Light Blue", "Navy", "Dark Gray", "Black"];
const EVENT_NAMES = ["calc_view", "add_line", "checkout_click", "details_submitted", "payment_started", "quote_request", "paid_return"];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (ref TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, business TEXT, name TEXT, email TEXT, phone TEXT, notes TEXT, text_consent INTEGER DEFAULT 0, cups INTEGER, base_price_cents INTEGER, cups_subtotal_cents INTEGER, setup_fee_cents INTEGER, total_cents INTEGER, deposit_percent INTEGER, square_order_id TEXT, square_payment_id TEXT, paid_at TEXT, paid_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, refunded_cents INTEGER DEFAULT 0, resale_permit TEXT, resale_business TEXT, resale_received_at TEXT, logo_received_at TEXT, proof_approved_at TEXT, completed_at TEXT, tax_invoiced_at TEXT, admin_notes TEXT);
CREATE TABLE IF NOT EXISTS order_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, size TEXT, finish TEXT, lid TEXT, color TEXT, qty INTEGER, unit_cents INTEGER);
CREATE INDEX IF NOT EXISTS order_lines_ref ON order_lines(ref);
CREATE TABLE IF NOT EXISTS payments (payment_id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, status TEXT, amount_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, refunded_cents INTEGER DEFAULT 0, square_order_id TEXT, ref TEXT, source TEXT, card_brand TEXT);
CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at);
CREATE TABLE IF NOT EXISTS refunds (refund_id TEXT PRIMARY KEY, payment_id TEXT, created_at TEXT, status TEXT, amount_cents INTEGER DEFAULT 0, reason TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, name TEXT NOT NULL, session TEXT, ref TEXT, path TEXT);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS square_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, created_at TEXT, location_id TEXT, name TEXT, variation TEXT, qty REAL, gross_cents INTEGER DEFAULT 0, source TEXT);
CREATE INDEX IF NOT EXISTS square_items_order ON square_items(order_id);
CREATE INDEX IF NOT EXISTS square_items_created ON square_items(created_at);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);`;

let migrated = false;
async function ensureSchema(env) {
  if (migrated || !env.DB) return;
  const stmts = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  migrated = true;
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      await ensureSchema(env);
      if (path === "/health") return json({ ok: true, env: env.SQUARE_ENV, db: !!env.DB }, 200, cors);

      // ---- public, site-facing ----
      if (path === "/checkout" && request.method === "POST") return requireOrigin(cors) || checkout(request, env, cors);
      if (path === "/event" && request.method === "POST") return requireOrigin(cors) || recordEvent(request, env, cors);
      if (path === "/resale" && request.method === "POST") return requireOrigin(cors) || recordResale(request, env, cors);
      if (path === "/webhooks/square" && request.method === "POST") return squareWebhook(request, env);

      // ---- admin ----
      if (path === "/admin" || path.startsWith("/api/")) {
        const denied = requireAdmin(request, env);
        if (denied) return denied;
        if (path === "/admin") return new Response(dashboardHtml(env), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        if (path === "/api/kpis") return json(await kpis(env, url.searchParams.get("from"), url.searchParams.get("to")), 200, { "Cache-Control": "no-store" });
        if (path === "/api/orders.csv") return ordersCsv(env);
        if (path === "/api/sync" && request.method === "POST") return json(await syncSquare(env, clamp(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1, 1095)), 200);
        if (path === "/api/digest" && request.method === "POST") return json(await sendDigest(env), 200);
        const m = path.match(/^\/api\/orders\/(HD-[A-Z0-9]+)$/);
        if (m && request.method === "POST") return json(await updateOrder(env, m[1], await request.json()), 200);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (e) {
      console.error("Unhandled", e && e.stack || e);
      return json({ error: "Server error: " + (e && e.message || e) }, 500, cors);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env);
    ctx.waitUntil((async () => {
      await syncSquare(env, 3);
      const d = new Date(event.scheduledTime || Date.now());
      if (d.getUTCDay() === 1 && d.getUTCHours() === 15) await sendDigest(env);
    })());
  },
};

// ---------------------------------------------------------------- checkout
async function checkout(request, env, cors) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const check = validate(body);
  if (check.error) { console.error("Validation:", check.error); return json({ error: check.error }, 400, cors); }
  const { lines, customer, ref, notes, textConsent } = check;
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
    order = { location_id: env.SQUARE_LOCATION_ID, reference_id: ref, line_items: [{
      name: `${depositPct}% deposit on order ${ref} (${priced.count} cups, $${priced.totalCents / 100} total)`, quantity: "1",
      base_price_money: { amount: deposit, currency: "USD" },
      note: priced.lines.map((l) => `${l.qty} x ${l.size} oz ${l.finish} ${l.color} (${l.lid} lid)`).join("; ").slice(0, 2000) }] };
  }
  const payload = {
    idempotency_key: `${ref}-${Date.now()}`,
    order,
    checkout_options: { redirect_url: `${env.SITE_URL}/thanks/?paid=1&ref=${encodeURIComponent(ref)}`, ask_for_shipping_address: false, merchant_support_email: env.SUPPORT_EMAIL, allow_tipping: false },
    pre_populated_data: { buyer_email: customer.email, buyer_phone_number: e164(customer.phone) },
    payment_note: `hdlaser.net order ${ref} for ${customer.business || customer.name}${notes ? " | " + notes.slice(0, 200) : ""}`.slice(0, 500),
  };
  const res = await squareFetch(env, "/v2/online-checkout/payment-links", { method: "POST", body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  const linkOk = res.ok && data.payment_link;
  if (!linkOk) console.error("Square error", res.status, JSON.stringify(data).slice(0, 800));

  // ledger: record the attempt either way
  if (env.DB) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO orders (ref, created_at, status, business, name, email, phone, notes, text_consent, cups, base_price_cents, cups_subtotal_cents, setup_fee_cents, total_cents, deposit_percent, square_order_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ref, now, linkOk ? "checkout_started" : "pay_later", customer.business, customer.name, customer.email, customer.phone, notes, textConsent ? 1 : 0,
        priced.count, priced.base * 100, priced.cups * 100, PRICING.setupFee * 100, priced.totalCents, depositPct, linkOk ? (data.payment_link.order_id || null) : null),
      env.DB.prepare(`DELETE FROM order_lines WHERE ref = ?`).bind(ref),
      ...priced.lines.map((l) => env.DB.prepare(`INSERT INTO order_lines (ref, size, finish, lid, color, qty, unit_cents) VALUES (?,?,?,?,?,?,?)`).bind(ref, l.size, l.finish, l.lid, l.color, l.qty, l.unit * 100)),
    ]);
  }
  if (!linkOk) {
    const msg = (data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].code)) || "Square did not return a checkout link";
    return json({ error: msg }, 502, cors);
  }
  return json({ url: data.payment_link.url, ref, total: priced.totalCents / 100, deposit_percent: depositPct }, 200, cors);
}

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
  const email = String(c.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: "Valid email required" };
  if (!c.agreed) return { error: "Terms must be accepted" };
  const ref = /^HD-[A-Z0-9]{4,12}$/.test(String(body.ref || "")) ? body.ref : "HD-" + Date.now().toString(36).toUpperCase();
  return {
    lines: clean, ref,
    customer: { email, phone: String(c.phone || "").trim().slice(0, 40), name: String(c.name || "").trim().slice(0, 80), business: String(c.business || "").trim().slice(0, 80) },
    notes: String(body.notes || "").trim().slice(0, 2000),
    textConsent: !!c.textConsent,
  };
}

function price(lines) {
  const count = lines.reduce((a, l) => a + l.qty, 0);
  const base = PRICING.tiers.find(([min]) => count >= min)[1];
  const priced = lines.map((l) => ({ ...l, unit: base + (l.size === "16" ? PRICING.add16oz : 0) + (l.finish === "printed" ? PRICING.addPrinted : 0) }));
  const cups = priced.reduce((a, l) => a + l.unit * l.qty, 0);
  return { lines: priced, count, base, cups, totalCents: (cups + PRICING.setupFee) * 100 };
}

// ---------------------------------------------------------------- events + resale
async function recordEvent(request, env, cors) {
  if (!env.DB) return json({ ok: false }, 200, cors);
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const name = String(b.name || "");
  if (!EVENT_NAMES.includes(name)) return json({ error: "Unknown event" }, 400, cors);
  const session = String(b.session || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || null;
  const ref = /^HD-[A-Z0-9]{4,12}$/.test(String(b.ref || "")) ? b.ref : null;
  const path = String(b.path || "").slice(0, 120);
  await env.DB.prepare(`INSERT INTO events (ts, name, session, ref, path) VALUES (?,?,?,?,?)`).bind(new Date().toISOString(), name, session, ref, path).run();
  return json({ ok: true }, 200, cors);
}

async function recordResale(request, env, cors) {
  if (!env.DB) return json({ ok: false }, 200, cors);
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const ref = /^HD-[A-Z0-9]{4,12}$/.test(String(b.ref || "")) ? b.ref : null;
  if (!ref) return json({ error: "Bad ref" }, 400, cors);
  const permit = String(b.permit || "").trim().slice(0, 40), business = String(b.business || "").trim().slice(0, 120);
  if (!permit) return json({ error: "Permit required" }, 400, cors);
  const r = await env.DB.prepare(`UPDATE orders SET resale_permit = ?, resale_business = ?, resale_received_at = ? WHERE ref = ?`).bind(permit, business, new Date().toISOString(), ref).run();
  return json({ ok: true, updated: r.meta ? r.meta.changes : undefined }, 200, cors);
}

// ---------------------------------------------------------------- Square webhook + sync
async function squareWebhook(request, env) {
  const raw = await request.text();
  if (env.SQUARE_WEBHOOK_SIGNATURE_KEY) {
    const sig = request.headers.get("x-square-hmacsha256-signature") || "";
    const expected = await hmacBase64(env.SQUARE_WEBHOOK_SIGNATURE_KEY, request.url + raw);
    if (sig !== expected) { console.error("Webhook signature mismatch"); return json({ error: "Bad signature" }, 401); }
  } else {
    return json({ error: "Webhook key not configured" }, 503);
  }
  let evt; try { evt = JSON.parse(raw); } catch { return json({ error: "Bad JSON" }, 400); }
  const type = evt.type || "", obj = (evt.data && evt.data.object) || {};
  if (type.startsWith("payment.") && obj.payment) await upsertPayment(env, obj.payment);
  if (type.startsWith("refund.") && obj.refund) await upsertRefund(env, obj.refund);
  return json({ ok: true }, 200);
}

async function syncSquare(env, days) {
  if (!env.DB || !env.SQUARE_ACCESS_TOKEN) return { ok: false, reason: "no db or token" };
  const begin = new Date(Date.now() - days * 86400000).toISOString();
  const errors = [];
  let payments = 0, refunds = 0, orders = 0, items = 0;

  // every location on the account (in-store, online, invoices)
  let locations = [];
  {
    const res = await squareFetch(env, "/v2/locations");
    const data = await res.json().catch(() => ({}));
    if (res.ok) locations = (data.locations || []).map((l) => l.id);
    else errors.push("locations " + res.status + " " + squareErr(data));
  }

  const page = async (pathBase, key, handler) => {
    let cursor = "";
    do {
      const q = new URLSearchParams({ begin_time: begin, sort_order: "ASC", limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const res = await squareFetch(env, `${pathBase}?${q}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errors.push(`${key} ${res.status} ${squareErr(data)}`); break; }
      for (const row of data[key] || []) await handler(row);
      cursor = data.cursor || "";
    } while (cursor);
  };
  await page("/v2/payments", "payments", async (p) => { await upsertPayment(env, p); payments++; });
  await page("/v2/refunds", "refunds", async (r) => { await upsertRefund(env, r); refunds++; });

  // itemised orders (what was actually sold), for product KPIs across the whole business
  if (locations.length) {
    let cursor = "";
    do {
      const body = { location_ids: locations.slice(0, 10), limit: 500, query: { filter: { state_filter: { states: ["COMPLETED"] }, date_time_filter: { closed_at: { start_at: begin } } }, sort: { sort_field: "CLOSED_AT", sort_order: "ASC" } } };
      if (cursor) body.cursor = cursor;
      const res = await squareFetch(env, "/v2/orders/search", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { errors.push("orders " + res.status + " " + squareErr(data)); break; }
      for (const o of data.orders || []) {
        const lines = o.line_items || [];
        if (!lines.length) continue;
        const stmts = [env.DB.prepare(`DELETE FROM square_items WHERE order_id = ?`).bind(o.id)];
        for (const li of lines) stmts.push(env.DB.prepare(`INSERT INTO square_items (order_id, created_at, location_id, name, variation, qty, gross_cents, source) VALUES (?,?,?,?,?,?,?,?)`)
          .bind(o.id, o.closed_at || o.created_at || null, o.location_id || null, (li.name || "Custom amount").slice(0, 120), (li.variation_name || "").slice(0, 120), parseFloat(li.quantity || "1") || 1, money(li.gross_sales_money) || money(li.total_money), (o.source && o.source.name) || null));
        await env.DB.batch(stmts);
        orders++; items += lines.length;
      }
      cursor = data.cursor || "";
    } while (cursor);
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('last_sync', ?)`).bind(new Date().toISOString()).run();
  return { ok: errors.length === 0, payments, refunds, orders, items, locations: locations.length, since: begin, errors };
}
function squareErr(data) { return (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].code)) || ""; }

async function upsertPayment(env, p) {
  const amount = money(p.amount_money), fee = (p.processing_fee || []).reduce((a, f) => a + money(f.amount_money), 0), refunded = money(p.refunded_money);
  const brand = p.card_details && p.card_details.card && p.card_details.card.card_brand || null;
  const orderRow = p.order_id ? await env.DB.prepare(`SELECT ref FROM orders WHERE square_order_id = ?`).bind(p.order_id).first() : null;
  const ref = orderRow ? orderRow.ref : null;
  await env.DB.prepare(`INSERT INTO payments (payment_id, created_at, updated_at, status, amount_cents, fee_cents, refunded_cents, square_order_id, ref, source, card_brand) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(payment_id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, amount_cents=excluded.amount_cents, fee_cents=excluded.fee_cents, refunded_cents=excluded.refunded_cents, ref=COALESCE(excluded.ref, payments.ref), card_brand=COALESCE(excluded.card_brand, payments.card_brand)`)
    .bind(p.id, p.created_at || null, p.updated_at || null, p.status || null, amount, fee, refunded, p.order_id || null, ref, p.source_type || null, brand).run();
  if (ref && p.status === "COMPLETED") {
    await env.DB.prepare(`UPDATE orders SET status = CASE WHEN ? >= total_cents AND ? > 0 THEN 'refunded' ELSE 'paid' END, square_payment_id = ?, paid_at = COALESCE(paid_at, ?), paid_cents = ?, fee_cents = ?, refunded_cents = ? WHERE ref = ?`)
      .bind(refunded, refunded, p.id, p.created_at || new Date().toISOString(), amount, fee, refunded, ref).run();
  }
}

async function upsertRefund(env, r) {
  await env.DB.prepare(`INSERT INTO refunds (refund_id, payment_id, created_at, status, amount_cents, reason) VALUES (?,?,?,?,?,?)
    ON CONFLICT(refund_id) DO UPDATE SET status=excluded.status, amount_cents=excluded.amount_cents`)
    .bind(r.id, r.payment_id || null, r.created_at || null, r.status || null, money(r.amount_money), r.reason || null).run();
  if (r.payment_id && r.status === "COMPLETED") {
    const tot = await env.DB.prepare(`SELECT COALESCE(SUM(amount_cents),0) s FROM refunds WHERE payment_id = ? AND status = 'COMPLETED'`).bind(r.payment_id).first();
    await env.DB.prepare(`UPDATE payments SET refunded_cents = ? WHERE payment_id = ?`).bind(tot.s, r.payment_id).run();
    await env.DB.prepare(`UPDATE orders SET refunded_cents = ?, status = CASE WHEN ? >= total_cents THEN 'refunded' ELSE status END WHERE square_payment_id = ?`).bind(tot.s, tot.s, r.payment_id).run();
  }
}

// ---------------------------------------------------------------- KPIs
async function kpis(env, from, to) {
  if (!env.DB) return { error: "No database bound" };
  const toIso = to ? new Date(to).toISOString() : new Date().toISOString();
  const fromIso = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
  const span = new Date(toIso) - new Date(fromIso);
  const prevFrom = new Date(new Date(fromIso) - span).toISOString(), prevTo = fromIso;
  const q = (sql, ...args) => env.DB.prepare(sql).bind(...args);

  const salesFor = async (a, b) => {
    const s = await q(`SELECT COUNT(*) orders, COALESCE(SUM(paid_cents - refunded_cents),0) revenue, COALESCE(SUM(cups),0) cups, COALESCE(SUM(setup_fee_cents),0) setup, COALESCE(SUM(fee_cents),0) fees, COALESCE(SUM(refunded_cents),0) refunded
      FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ? AND paid_at < ?`, a, b).first();
    const cust = await q(`SELECT COUNT(DISTINCT email) n FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ? AND paid_at < ?`, a, b).first();
    const repeat = await q(`SELECT COUNT(*) n FROM orders o WHERE status IN ('paid','refunded') AND paid_at >= ? AND paid_at < ? AND EXISTS (SELECT 1 FROM orders p WHERE p.email = o.email AND p.status IN ('paid','refunded') AND p.paid_at < o.paid_at)`, a, b).first();
    return { orders: s.orders, revenue_cents: s.revenue, cups: s.cups, aov_cents: s.orders ? Math.round(s.revenue / s.orders) : 0, cups_per_order: s.orders ? +(s.cups / s.orders).toFixed(1) : 0, setup_fees_cents: s.setup, customers: cust.n, repeat_orders: repeat.n, square_fees_cents: s.fees, refunded_cents: s.refunded };
  };
  const sales = await salesFor(fromIso, toIso), prev = await salesFor(prevFrom, prevTo);

  const mix = async (col) => (await q(`SELECT l.${col} k, SUM(l.qty) cups, SUM(l.qty*l.unit_cents) revenue FROM order_lines l JOIN orders o ON o.ref = l.ref WHERE o.status IN ('paid','refunded') AND o.paid_at >= ? AND o.paid_at < ? GROUP BY l.${col} ORDER BY cups DESC`, fromIso, toIso).all()).results;
  const tiers = (await q(`SELECT CASE WHEN cups >= 200 THEN '200+' WHEN cups >= 150 THEN '150-199' WHEN cups >= 100 THEN '100-149' ELSE '50-99' END tier, COUNT(*) orders, SUM(cups) cups, SUM(paid_cents - refunded_cents) revenue FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ? AND paid_at < ? GROUP BY tier ORDER BY MIN(cups)`, fromIso, toIso).all()).results;

  const funnelRows = (await q(`SELECT name, COUNT(DISTINCT COALESCE(session, id)) n FROM events WHERE ts >= ? AND ts < ? GROUP BY name`, fromIso, toIso).all()).results;
  const funnel = Object.fromEntries(EVENT_NAMES.map((n) => [n, 0]));
  for (const r of funnelRows) funnel[r.name] = r.n;
  funnel.paid = sales.orders;
  funnel.conversion_pct = funnel.calc_view ? +((sales.orders / funnel.calc_view) * 100).toFixed(1) : 0;

  const fin = await q(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) gross, COALESCE(SUM(fee_cents),0) fees, COALESCE(SUM(refunded_cents),0) refunded, COALESCE(SUM(CASE WHEN ref IS NULL THEN amount_cents ELSE 0 END),0) other_gross FROM payments WHERE status = 'COMPLETED' AND created_at >= ? AND created_at < ?`, fromIso, toIso).first();
  const taxRate = parseFloat(env.TAX_RATE || "0.0775");
  const taxDue = await q(`SELECT COUNT(*) n, COALESCE(SUM(cups_subtotal_cents + setup_fee_cents),0) base FROM orders WHERE status = 'paid' AND resale_received_at IS NULL AND tax_invoiced_at IS NULL`).first();
  const months = (await q(`SELECT substr(created_at,1,7) month, COUNT(*) payments, SUM(amount_cents) gross, SUM(fee_cents) fees, SUM(refunded_cents) refunded FROM payments WHERE status='COMPLETED' AND created_at >= ? AND created_at < ? GROUP BY month ORDER BY month DESC`, fromIso, toIso).all()).results;
  const topItems = (await q(`SELECT name || CASE WHEN variation != '' THEN ' - ' || variation ELSE '' END k, SUM(qty) qty, SUM(gross_cents) revenue, COUNT(DISTINCT order_id) orders FROM square_items WHERE created_at >= ? AND created_at < ? GROUP BY k ORDER BY revenue DESC LIMIT 25`, fromIso, toIso).all()).results;
  const cards = (await q(`SELECT COALESCE(card_brand, source, 'other') k, COUNT(*) n, SUM(amount_cents) amount FROM payments WHERE status='COMPLETED' AND created_at >= ? AND created_at < ? GROUP BY k ORDER BY amount DESC`, fromIso, toIso).all()).results;

  const attention = {
    unpaid: (await q(`SELECT ref, created_at, business, name, email, phone, total_cents, status FROM orders WHERE status IN ('checkout_started','pay_later') AND created_at < ? ORDER BY created_at DESC LIMIT 50`, new Date(Date.now() - 3600000).toISOString()).all()).results,
    missing_logo: (await q(`SELECT ref, paid_at, business, name, email, phone FROM orders WHERE status = 'paid' AND logo_received_at IS NULL ORDER BY paid_at DESC LIMIT 50`).all()).results,
    tax_due: (await q(`SELECT ref, paid_at, business, name, email, phone, cups_subtotal_cents + setup_fee_cents base_cents, resale_permit FROM orders WHERE status = 'paid' AND resale_received_at IS NULL AND tax_invoiced_at IS NULL ORDER BY paid_at ASC LIMIT 50`).all()).results.map((r) => ({ ...r, tax_cents: Math.round(r.base_cents * taxRate) })),
    in_production: (await q(`SELECT ref, paid_at, proof_approved_at, business, name, cups FROM orders WHERE status = 'paid' AND proof_approved_at IS NOT NULL AND completed_at IS NULL ORDER BY proof_approved_at ASC LIMIT 50`).all()).results,
  };
  const recent = (await q(`SELECT o.ref, o.created_at, o.paid_at, o.status, o.business, o.name, o.email, o.phone, o.cups, o.total_cents, o.paid_cents, o.fee_cents, o.refunded_cents, o.resale_received_at, o.logo_received_at, o.proof_approved_at, o.completed_at, o.tax_invoiced_at, o.admin_notes,
      (SELECT GROUP_CONCAT(qty || ' x ' || size || 'oz ' || finish || ' ' || color || ' (' || lid || ')', '; ') FROM order_lines l WHERE l.ref = o.ref) items
      FROM orders o ORDER BY o.created_at DESC LIMIT 100`).all()).results;
  const lastSync = await q(`SELECT v FROM meta WHERE k = 'last_sync'`).first();
  const lifetime = await q(`SELECT COUNT(*) orders, COALESCE(SUM(paid_cents - refunded_cents),0) revenue, COALESCE(SUM(cups),0) cups FROM orders WHERE status IN ('paid','refunded')`).first();

  return {
    range: { from: fromIso, to: toIso, prev_from: prevFrom, prev_to: prevTo },
    sales, prev, lifetime,
    product: { by_size: await mix("size"), by_finish: await mix("finish"), by_lid: await mix("lid"), by_color: await mix("color"), tiers },
    funnel,
    financial: { gross_cents: fin.gross, fees_cents: fin.fees, refunded_cents: fin.refunded, net_cents: fin.gross - fin.fees - fin.refunded, payments: fin.n, other_square_gross_cents: fin.other_gross, web_gross_cents: fin.gross - fin.other_gross, tax_rate: taxRate, tax_exposure_orders: taxDue.n, tax_exposure_cents: Math.round(taxDue.base * taxRate), by_card: cards, by_month: months, top_items: topItems },
    attention, recent,
    last_sync: lastSync ? lastSync.v : null,
  };
}

async function updateOrder(env, ref, body) {
  const fields = ["logo_received_at", "proof_approved_at", "completed_at", "tax_invoiced_at", "resale_received_at"];
  const sets = [], args = [];
  for (const f of fields) if (f in body) { sets.push(`${f} = ?`); args.push(body[f] ? new Date().toISOString() : null); }
  if ("admin_notes" in body) { sets.push("admin_notes = ?"); args.push(String(body.admin_notes || "").slice(0, 2000)); }
  if ("status" in body && ["paid", "pay_later", "checkout_started", "refunded", "cancelled"].includes(body.status)) { sets.push("status = ?"); args.push(body.status); }
  if (!sets.length) return { ok: false, error: "Nothing to update" };
  args.push(ref);
  const r = await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE ref = ?`).bind(...args).run();
  return { ok: true, updated: r.meta ? r.meta.changes : undefined };
}

async function ordersCsv(env) {
  const rows = (await env.DB.prepare(`SELECT o.*, (SELECT GROUP_CONCAT(qty || ' x ' || size || 'oz ' || finish || ' ' || color || ' (' || lid || ')', '; ') FROM order_lines l WHERE l.ref = o.ref) items FROM orders o ORDER BY created_at DESC`).all()).results;
  const cols = ["ref", "created_at", "status", "paid_at", "business", "name", "email", "phone", "cups", "items", "cups_subtotal_cents", "setup_fee_cents", "total_cents", "paid_cents", "fee_cents", "refunded_cents", "resale_permit", "resale_received_at", "logo_received_at", "proof_approved_at", "completed_at", "tax_invoiced_at", "square_order_id", "square_payment_id", "text_consent", "notes", "admin_notes"];
  const esc = (v) => v == null ? "" : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const csv = [cols.join(",")].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(","))).join("\n");
  return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="hdlaser-orders-${new Date().toISOString().slice(0, 10)}.csv"` } });
}

// ---------------------------------------------------------------- weekly digest
async function sendDigest(env) {
  if (!env.DB) return { ok: false, reason: "no db" };
  const to = new Date(), from = new Date(Date.now() - 7 * 86400000);
  const k = await kpis(env, from.toISOString(), to.toISOString());
  const $ = (c) => "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  const pct = (a, b) => b ? Math.round(((a - b) / b) * 100) : (a ? 100 : 0);
  const lines = [
    `HD Laser weekly numbers, ${from.toLocaleDateString("en-US")} to ${to.toLocaleDateString("en-US")}`,
    ``,
    `SALES (web cup orders)`,
    `Revenue ${$(k.sales.revenue_cents)} (${pct(k.sales.revenue_cents, k.prev.revenue_cents)}% vs prior week)`,
    `Orders ${k.sales.orders} | Cups ${k.sales.cups} | Avg order ${$(k.sales.aov_cents)} | Repeat orders ${k.sales.repeat_orders}`,
    `Funnel: ${k.funnel.calc_view} calculator views -> ${k.funnel.checkout_click} checkout clicks -> ${k.funnel.details_submitted} details -> ${k.funnel.paid} paid (${k.funnel.conversion_pct}%)`,
    ``,
    `PRODUCT`,
    `Sizes: ${k.product.by_size.map((r) => `${r.k} oz ${r.cups}`).join(", ") || "none"}`,
    `Finish: ${k.product.by_finish.map((r) => `${r.k} ${r.cups}`).join(", ") || "none"}`,
    `Top colors: ${k.product.by_color.slice(0, 5).map((r) => `${r.k} ${r.cups}`).join(", ") || "none"}`,
    `Tiers: ${k.product.tiers.map((r) => `${r.tier}: ${r.orders}`).join(", ") || "none"}`,
    ``,
    `FINANCIAL (all Square)`,
    `Gross ${$(k.financial.gross_cents)} | Fees ${$(k.financial.fees_cents)} | Refunds ${$(k.financial.refunded_cents)} | Net ${$(k.financial.net_cents)}`,
    `Web orders ${$(k.financial.web_gross_cents)} | Other Square sales ${$(k.financial.other_square_gross_cents)}`,
    `Tax exposure: ${k.financial.tax_exposure_orders} paid orders without a resale certificate, est. ${$(k.financial.tax_exposure_cents)} sales tax to invoice`,
    ``,
    `NEEDS ATTENTION`,
    `Unpaid checkouts ${k.attention.unpaid.length} | Missing logo ${k.attention.missing_logo.length} | Tax to invoice ${k.attention.tax_due.length} | In production ${k.attention.in_production.length}`,
    ``,
    `Dashboard: ${env.WORKER_URL || ""}/admin`,
  ];
  const text = lines.join("\n");
  if (!env.FORMSPREE_ENDPOINT) return { ok: false, reason: "no FORMSPREE_ENDPOINT", text };
  const res = await fetch(env.FORMSPREE_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" }, body: JSON.stringify({ _subject: `HD Laser weekly numbers: ${$(k.sales.revenue_cents)} from ${k.sales.orders} orders`, message: text, email: env.SUPPORT_EMAIL || "" }) });
  return { ok: res.ok, status: res.status, text };
}

// ---------------------------------------------------------------- dashboard
function dashboardHtml(env) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HD Laser numbers</title>
<style>
:root{--bg:#F6F4EF;--ink:#15191E;--muted:#545B63;--red:#C8372A;--line:#E4E0D8;--card:#fff;--green:#2F6B4F;--gold:#F2B63D}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 Figtree,"Helvetica Neue",Arial,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);background:#fff}
h1{font-size:20px;margin:0}h2{font-size:17px;margin:22px 0 10px}main{max-width:1200px;margin:0 auto;padding:16px 20px 60px}
.ranges{display:flex;gap:6px;flex-wrap:wrap}.ranges button,.act,.ranges input{font:inherit;padding:7px 12px;border:1px solid var(--line);background:#fff;border-radius:999px;cursor:pointer}
.ranges button.on{background:var(--ink);color:#fff;border-color:var(--ink)}.act.red{background:var(--red);color:#fff;border-color:var(--red)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px}.tile .l{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.tile .n{font-size:26px;font-weight:700;margin-top:4px}.tile .d{font-size:12px;color:var(--muted);margin-top:2px}.up{color:var(--green)}.down{color:var(--red)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;overflow:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #EDE8DF;vertical-align:top}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}td.num,th.num{text-align:right;white-space:nowrap}
.pill{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#EDE8DF}.pill.paid{background:#E7F2EC;color:var(--green)}.pill.refunded,.pill.pay_later{background:#FBE9E6;color:var(--red)}.pill.checkout_started{background:#FBF3D6}
.small{font-size:12px;color:var(--muted)}.btn{font:inherit;font-size:12px;padding:4px 9px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;margin:2px 2px 2px 0}.btn.done{background:#E7F2EC;border-color:#BFDCCB;color:var(--green)}
.empty{color:var(--muted);font-style:italic}#err{background:#FBE9E6;color:var(--red);padding:10px 14px;border-radius:10px;margin:12px 0;display:none}
</style></head><body>
<header><h1>HD Laser numbers</h1>
<div class="ranges" id="ranges"><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button><button data-d="90">90 days</button><button data-d="365">12 months</button><input type="date" id="from"><input type="date" id="to"><button id="go">Apply</button></div>
<div><button class="act" id="sync">Sync Square now</button> <button class="act" id="backfill">Import 2 years of history</button> <a class="act" href="/api/orders.csv" style="text-decoration:none;color:inherit">Download CSV</a> <button class="act" id="digest">Email digest</button></div></header>
<main>
<div id="err"></div>
<p class="small" id="meta"></p>
<h2>Sales, web cup orders</h2><div class="tiles" id="sales"></div>
<h2>Financial, all Square payments</h2><div class="tiles" id="fin"></div>
<div class="grid" id="fin2" style="margin-top:14px"></div>
<h2>Funnel</h2><div class="tiles" id="funnel"></div>
<h2>Product mix</h2><div class="grid" id="product"></div>
<h2>Needs attention</h2><div class="grid" id="attention"></div>
<h2>Recent orders</h2><div class="card"><table id="orders"></table></div>
</main>
<script>
const $=s=>document.querySelector(s), money=c=>'$'+((c||0)/100).toLocaleString('en-US',{maximumFractionDigits:0}), esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtDate=s=>s?new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
let days=30, from=null, to=null;
function delta(a,b){ if(!b) return a?'<span class="up">new</span>':''; const p=Math.round((a-b)/b*100); return '<span class="'+(p>=0?'up':'down')+'">'+(p>=0?'+':'')+p+'% vs prior</span>'; }
function tile(l,n,d){ return '<div class="tile"><div class="l">'+l+'</div><div class="n">'+n+'</div><div class="d">'+(d||'')+'</div></div>'; }
function mixTable(title, rows, label){ if(!rows.length) return '<div class="card"><h3 style="margin:0 0 6px">'+title+'</h3><p class="empty">No paid orders in range</p></div>'; const tot=rows.reduce((a,r)=>a+r.cups,0); return '<div class="card"><h3 style="margin:0 0 6px">'+title+'</h3><table><tr><th>'+label+'</th><th class="num">Cups</th><th class="num">Share</th><th class="num">Revenue</th></tr>'+rows.map(r=>'<tr><td>'+esc(r.k||r.tier)+'</td><td class="num">'+r.cups+'</td><td class="num">'+Math.round(r.cups/tot*100)+'%</td><td class="num">'+money(r.revenue)+'</td></tr>').join('')+'</table></div>'; }
function who(r){ return esc(r.business||r.name||'')+'<div class="small">'+esc(r.email||'')+(r.phone?' · '+esc(r.phone):'')+'</div>'; }
function flag(ref, field, val, label){ return '<button class="btn '+(val?'done':'')+'" data-ref="'+ref+'" data-field="'+field+'" data-val="'+(val?0:1)+'">'+(val?'✓ ':'')+label+'</button>'; }
async function load(){
  $('#err').style.display='none';
  const q=new URLSearchParams(); if(from){q.set('from',from);} if(to){q.set('to',to);} if(!from){q.set('from',new Date(Date.now()-days*864e5).toISOString());}
  const r=await fetch('/api/kpis?'+q); if(!r.ok){ $('#err').textContent='Could not load: '+r.status; $('#err').style.display='block'; return; }
  const k=await r.json(); if(k.error){ $('#err').textContent=k.error; $('#err').style.display='block'; return; }
  $('#meta').textContent='Range '+fmtDate(k.range.from)+' to '+fmtDate(k.range.to)+' · Last Square sync '+(k.last_sync?new Date(k.last_sync).toLocaleString():'never')+' · Lifetime: '+k.lifetime.orders+' orders, '+k.lifetime.cups+' cups, '+money(k.lifetime.revenue);
  const s=k.sales,p=k.prev;
  $('#sales').innerHTML=tile('Revenue',money(s.revenue_cents),delta(s.revenue_cents,p.revenue_cents))+tile('Orders',s.orders,delta(s.orders,p.orders))+tile('Cups sold',s.cups,delta(s.cups,p.cups))+tile('Avg order',money(s.aov_cents),delta(s.aov_cents,p.aov_cents))+tile('Cups per order',s.cups_per_order,'')+tile('Customers',s.customers,s.repeat_orders+' repeat orders')+tile('Setup fees',money(s.setup_fees_cents),'first orders');
  const f=k.financial;
  $('#fin').innerHTML=tile('Gross',money(f.gross_cents),f.payments+' payments')+tile('Square fees',money(f.fees_cents),f.gross_cents?(f.fees_cents/f.gross_cents*100).toFixed(1)+'% of gross':'')+tile('Refunds',money(f.refunded_cents),'')+tile('Net',money(f.net_cents),'after fees and refunds')+tile('Web orders',money(f.web_gross_cents),'')+tile('Other Square sales',money(f.other_square_gross_cents),'in-store, invoices')+tile('Tax exposure',money(f.tax_exposure_cents),f.tax_exposure_orders+' paid orders, no resale cert');
  $('#fin2').innerHTML=(f.by_month.length?'<div class="card"><h3 style="margin:0 0 6px">By month</h3><table><tr><th>Month</th><th class="num">Payments</th><th class="num">Gross</th><th class="num">Fees</th><th class="num">Refunds</th><th class="num">Net</th></tr>'+f.by_month.map(m=>'<tr><td>'+m.month+'</td><td class="num">'+m.payments+'</td><td class="num">'+money(m.gross)+'</td><td class="num">'+money(m.fees)+'</td><td class="num">'+money(m.refunded)+'</td><td class="num"><b>'+money(m.gross-m.fees-m.refunded)+'</b></td></tr>').join('')+'</table></div>':'')
    +(f.top_items.length?'<div class="card"><h3 style="margin:0 0 6px">Top items sold in Square</h3><table><tr><th>Item</th><th class="num">Qty</th><th class="num">Orders</th><th class="num">Revenue</th></tr>'+f.top_items.map(t=>'<tr><td>'+esc(t.k)+'</td><td class="num">'+(+t.qty).toLocaleString()+'</td><td class="num">'+t.orders+'</td><td class="num">'+money(t.revenue)+'</td></tr>').join('')+'</table></div>':'<div class="card"><h3 style="margin:0 0 6px">Top items sold in Square</h3><p class="empty">No itemised Square orders in range. Click "Import 2 years of history" to pull them in.</p></div>');
  const u=k.funnel;
  $('#funnel').innerHTML=tile('Calculator views',u.calc_view,'')+tile('Lines added',u.add_line,'')+tile('Checkout clicks',u.checkout_click,'')+tile('Details submitted',u.details_submitted,'')+tile('Paid',u.paid,'')+tile('Conversion',u.conversion_pct+'%','views to paid')+tile('Quote requests',u.quote_request,'non-cup form');
  $('#product').innerHTML=mixTable('By size',k.product.by_size,'Size')+mixTable('By finish',k.product.by_finish,'Finish')+mixTable('By lid',k.product.by_lid,'Lid')+mixTable('By color',k.product.by_color,'Color')+mixTable('By order size tier',k.product.tiers.map(t=>({k:t.tier,cups:t.cups,revenue:t.revenue})),'Tier');
  const a=k.attention;
  const list=(title,rows,fn)=>'<div class="card"><h3 style="margin:0 0 6px">'+title+' <span class="pill">'+rows.length+'</span></h3>'+(rows.length?'<table>'+rows.map(fn).join('')+'</table>':'<p class="empty">Nothing here</p>')+'</div>';
  $('#attention').innerHTML=
    list('Unpaid checkouts',a.unpaid,r=>'<tr><td><b>'+r.ref+'</b><div class="small">'+fmtDate(r.created_at)+' · '+esc(r.status)+'</div></td><td>'+who(r)+'</td><td class="num">'+money(r.total_cents)+'</td></tr>')+
    list('Missing logo',a.missing_logo,r=>'<tr><td><b>'+r.ref+'</b><div class="small">paid '+fmtDate(r.paid_at)+'</div></td><td>'+who(r)+'</td><td>'+flag(r.ref,'logo_received_at',0,'Logo received')+'</td></tr>')+
    list('Sales tax to invoice',a.tax_due,r=>'<tr><td><b>'+r.ref+'</b><div class="small">paid '+fmtDate(r.paid_at)+'</div></td><td>'+who(r)+'</td><td class="num">'+money(r.tax_cents)+'<div class="small">on '+money(r.base_cents)+'</div></td><td>'+flag(r.ref,'tax_invoiced_at',0,'Invoiced')+flag(r.ref,'resale_received_at',0,'Cert received')+'</td></tr>')+
    list('In production',a.in_production,r=>'<tr><td><b>'+r.ref+'</b><div class="small">approved '+fmtDate(r.proof_approved_at)+'</div></td><td>'+esc(r.business||r.name)+'<div class="small">'+r.cups+' cups</div></td><td>'+flag(r.ref,'completed_at',0,'Done')+'</td></tr>');
  $('#orders').innerHTML='<tr><th>Ref</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Progress</th></tr>'+k.recent.map(r=>'<tr><td><b>'+r.ref+'</b><div class="small">'+fmtDate(r.created_at)+'</div></td><td>'+who(r)+'</td><td class="small">'+esc(r.items||'')+'</td><td class="num">'+money(r.total_cents)+(r.refunded_cents?'<div class="small">refunded '+money(r.refunded_cents)+'</div>':'')+(r.fee_cents?'<div class="small">fee '+money(r.fee_cents)+'</div>':'')+'</td><td><span class="pill '+r.status+'">'+r.status.replace('_',' ')+'</span></td><td>'+flag(r.ref,'logo_received_at',r.logo_received_at,'Logo')+flag(r.ref,'proof_approved_at',r.proof_approved_at,'Proof OK')+flag(r.ref,'completed_at',r.completed_at,'Done')+flag(r.ref,'resale_received_at',r.resale_received_at,'Resale cert')+flag(r.ref,'tax_invoiced_at',r.tax_invoiced_at,'Tax invoiced')+'</td></tr>').join('');
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-ref]'); if(b){ const body={}; body[b.dataset.field]=b.dataset.val==='1'; await fetch('/api/orders/'+b.dataset.ref,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); load(); return; }
  const rb=e.target.closest('#ranges button[data-d]'); if(rb){ document.querySelectorAll('#ranges button').forEach(x=>x.classList.remove('on')); rb.classList.add('on'); days=+rb.dataset.d; from=to=null; $('#from').value=''; $('#to').value=''; load(); }
});
$('#go').onclick=()=>{ from=$('#from').value?new Date($('#from').value).toISOString():null; to=$('#to').value?new Date(new Date($('#to').value).getTime()+864e5).toISOString():null; document.querySelectorAll('#ranges button').forEach(x=>x.classList.remove('on')); load(); };
async function runSync(days,btn,label){ btn.disabled=true; btn.textContent='Working, this can take a minute…'; try{ const r=await fetch('/api/sync?days='+days,{method:'POST'}); const j=await r.json(); alert((j.ok?'Done. ':'Finished with problems. ')+'Payments '+(j.payments||0)+', refunds '+(j.refunds||0)+', itemised orders '+(j.orders||0)+' across '+(j.locations||0)+' location(s).'+(j.errors&&j.errors.length?'\\n\\nSquare said: '+j.errors.join(' | '):'')+(j.reason?'\\n'+j.reason:'')); }catch(e){ alert('Request failed: '+e.message); } btn.disabled=false; btn.textContent=label; load(); }
$('#sync').onclick=()=>runSync(30,$('#sync'),'Sync Square now');
$('#backfill').onclick=()=>{ if(confirm('Pull two years of Square payments, refunds and itemised orders? Safe to run more than once.')) runSync(730,$('#backfill'),'Import 2 years of history'); };
$('#digest').onclick=async()=>{ if(!confirm('Email the weekly digest to '+${JSON.stringify(env.SUPPORT_EMAIL || "the support inbox")}+' now?')) return; const r=await fetch('/api/digest',{method:'POST'}); const j=await r.json(); alert(j.ok?'Sent.':'Not sent: '+(j.reason||j.status)); };
load();
</script></body></html>`;
}

// ---------------------------------------------------------------- helpers
function requireOrigin(cors) { return cors["Access-Control-Allow-Origin"] ? null : json({ error: "Origin not allowed" }, 403, cors); }
function requireAdmin(request, env) {
  const unauthorized = () => new Response("Sign in with any username and the admin password.", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="HD Laser numbers", charset="UTF-8"' } });
  if (!env.ADMIN_KEY) return new Response("ADMIN_KEY is not set on the worker.", { status: 503 });
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Basic ")) return unauthorized();
  let decoded = ""; try { decoded = atob(h.slice(6)); } catch { return unauthorized(); }
  const pass = decoded.slice(decoded.indexOf(":") + 1);
  return timingSafeEqual(pass, env.ADMIN_KEY) ? null : unauthorized();
}
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function squareFetch(env, path, init = {}) {
  const host = env.SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com";
  return fetch(host + path, { ...init, headers: { "Authorization": `Bearer ${env.SQUARE_ACCESS_TOKEN}`, "Square-Version": "2025-01-23", "Content-Type": "application/json", ...(init.headers || {}) } });
}
async function hmacBase64(key, msg) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h = { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...(headers || {}) } }); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function money(m) { return m && typeof m.amount === "number" ? m.amount : 0; }
function e164(phone) { const d = String(phone || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return undefined; }
