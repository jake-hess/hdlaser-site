// HD Laser worker: Square checkout, order ledger, Square sync, KPI dashboard, weekly digest.
// Card details never touch this code; Square collects them on its hosted page.
//
// Routes
//   POST /checkout            create a Square checkout for a calculator order (called by the website)
//   POST /event               funnel beacon from the website (cookieless)
//   POST /submit              quote / order-details form from the website: stores it, emails Hugh and the customer (Resend)
//   ALERT_TO (optional)       extra addresses that get a one-line text alert on new orders, payments and permits
//   NTFY_TOPIC (optional)     ntfy.sh topic that gets the same one-line alert as a phone push notification
//   TWILIO_* + ALERT_SMS_TO   (optional) real SMS alerts through Twilio; see README
//   /staff/*                  employee portal API (login, clock, checklist, jobs, team KPIs); site page at /staff/
//   POST /webhooks/twilio     inbound texts (owner replies 1/2 to the staffing alert)
//   STAFF_ALERTS (optional)   which staff events text the owner: clockin,clockout,noshow (default all)
//   GET  /admin/money         P&L, bank ledger, reconciliation, unit economics, 13-week cash forecast (Basic auth)
//   /api/money, /api/bank/*   data behind it; bank statements are imported as CSV rows from the page
//   /api/plaid/*              live bank feed (PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV); synced hourly with the Square job
//   POST /resale              resale permit info from the thank-you page
//   POST /webhooks/square     Square webhook (payment.*, refund.*), verified with the signature key
//   GET  /pricing              the price book the order builder uses (public); POST /order/checkout places a priced custom order
//   /api/pricing*             price book, weekly pricing review suggestions (approve/deny), edit history (Basic auth)
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
const EVENT_NAMES = ["calc_view", "add_line", "checkout_click", "details_submitted", "payment_started", "quote_request", "paid_return", "order_view", "spec_view", "order_attested", "order_checkout"];

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
CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, name TEXT, business TEXT, email TEXT, phone TEXT, fields TEXT, emailed INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS inquiries_created ON inquiries(created_at);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, product TEXT, material TEXT, service TEXT, inches REAL, qty INTEGER, work_unit_cents INTEGER, blank_unit_cents INTEGER, discount_pct REAL, line_cents INTEGER);
CREATE TABLE IF NOT EXISTS order_assets (id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL, created_at TEXT, name TEXT, type TEXT, bytes INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS price_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', rule TEXT, target TEXT NOT NULL, current_cents INTEGER, proposed_cents INTEGER, reason TEXT, evidence TEXT, decided_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS price_history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, target TEXT NOT NULL, from_cents INTEGER, to_cents INTEGER, source TEXT, suggestion_id INTEGER, note TEXT);
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', phone TEXT DEFAULT '', email TEXT DEFAULT '', pin_hash TEXT, pin_salt TEXT, on_call INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff_sessions (token TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, created_at TEXT, expires_at TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, in_at TEXT NOT NULL, out_at TEXT, minutes INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS shifts_in ON shifts(in_at);
CREATE TABLE IF NOT EXISTS checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, shift_id INTEGER NOT NULL, kind TEXT NOT NULL, step INTEGER NOT NULL, done_at TEXT, UNIQUE(shift_id, kind, step));
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, staff_id INTEGER, customer TEXT, phone TEXT, product TEXT NOT NULL, qty INTEGER DEFAULT 1, minutes INTEGER, amount_cents INTEGER DEFAULT 0, due_at TEXT, status TEXT DEFAULT 'queued', started_at TEXT, done_at TEXT, done_by INTEGER, note TEXT, ref TEXT);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS staff_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, staff_id INTEGER, action TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS staff_log_ts ON staff_log(ts);
CREATE TABLE IF NOT EXISTS bank_txns (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE, source TEXT, posted_at TEXT NOT NULL, amount_cents INTEGER NOT NULL, description TEXT, category TEXT DEFAULT 'uncategorized', vendor TEXT, memo TEXT, matched_payout_id TEXT, balance_cents INTEGER, imported_at TEXT);
CREATE INDEX IF NOT EXISTS bank_txns_posted ON bank_txns(posted_at);
CREATE INDEX IF NOT EXISTS bank_txns_cat ON bank_txns(category);
CREATE TABLE IF NOT EXISTS bank_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT NOT NULL, category TEXT NOT NULL, vendor TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS payouts (payout_id TEXT PRIMARY KEY, created_at TEXT, arrival_date TEXT, status TEXT, amount_cents INTEGER DEFAULT 0, location_id TEXT, type TEXT, matched_txn_id INTEGER);
CREATE TABLE IF NOT EXISTS plaid_items (item_id TEXT PRIMARY KEY, access_token TEXT NOT NULL, institution TEXT, accounts TEXT, balances TEXT, cursor TEXT, status TEXT, last_error TEXT, synced_at TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS coffee_orders (ref TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, name TEXT, phone TEXT, email TEXT, items TEXT, summary TEXT, total_cents INTEGER, pickup TEXT, note TEXT, text_consent INTEGER DEFAULT 0, square_order_id TEXT, square_payment_id TEXT, paid_at TEXT, paid_cents INTEGER DEFAULT 0, tip_cents INTEGER DEFAULT 0, notified_at TEXT, ready_at TEXT, picked_up_at TEXT);
CREATE INDEX IF NOT EXISTS coffee_created ON coffee_orders(created_at);`;
// Columns added after the first release. Each ALTER is tried once and ignored if the column already exists.
const ALTERS = ["ALTER TABLE events ADD COLUMN detail TEXT", "ALTER TABLE orders ADD COLUMN kind TEXT DEFAULT 'cups'", "ALTER TABLE orders ADD COLUMN spec TEXT", "ALTER TABLE orders ADD COLUMN needed_by TEXT", "ALTER TABLE orders ADD COLUMN rush INTEGER DEFAULT 0", "ALTER TABLE orders ADD COLUMN taken_by TEXT", "ALTER TABLE orders ADD COLUMN tax_cents INTEGER DEFAULT 0", "ALTER TABLE orders ADD COLUMN attest_initials TEXT", "ALTER TABLE orders ADD COLUMN attest_text TEXT", "ALTER TABLE orders ADD COLUMN attest_at TEXT", "ALTER TABLE orders ADD COLUMN attest_ip TEXT", "ALTER TABLE orders ADD COLUMN attest_ua TEXT", "ALTER TABLE orders ADD COLUMN attest_hash TEXT", "ALTER TABLE orders ADD COLUMN logo_asset_id INTEGER", "ALTER TABLE staff ADD COLUMN sms_consent_at TEXT", "ALTER TABLE orders ADD COLUMN notified_paid_at TEXT", "ALTER TABLE payments ADD COLUMN team_member_id TEXT", "ALTER TABLE staff ADD COLUMN hourly_rate_cents INTEGER DEFAULT 0", "ALTER TABLE staff ADD COLUMN commission_pct REAL DEFAULT 0"];

let migrated = false;
async function ensureSchema(env) {
  if (migrated || !env.DB) return;
  const stmts = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean);
  await env.DB.batch(stmts.map((s) => env.DB.prepare(s)));
  for (const a of ALTERS) { try { await env.DB.prepare(a).run(); } catch (e) { /* already applied */ } }
  migrated = true;
}

function cleanEnv(env) {
  // Dashboard-pasted values sometimes carry a trailing space or line break; strip them from every string setting.
  const out = {};
  for (const k of Object.keys(env)) { const v = env[k]; out[k] = typeof v === "string" ? v.trim() : v; }
  return out;
}

export default {
  async fetch(request, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
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
      if (path === "/submit" && request.method === "POST") return requireOrigin(cors) || submitInquiry(request, env, cors);
      if (path === "/resale" && request.method === "POST") return requireOrigin(cors) || recordResale(request, env, cors);
      if (path === "/pricing") return json({ book: publicBook(await priceBook(env)), tax_rate: parseFloat(env.TAX_RATE || "0.0775") || 0, attest_version: ATTEST_VERSION }, 200, { ...cors, "Cache-Control": "public, max-age=120" });
      if (path === "/order/checkout" && request.method === "POST") return requireOrigin(cors) || orderCheckout(request, env, cors);
      // ---- Boards n' Beans coffee counter (order ahead, pay through Square, the bar gets a text) ----
      if (path === "/coffee/menu") return json({ menu: COFFEE.menu, milks: COFFEE.milks, extras: COFFEE.extras, shop: COFFEE.shop }, 200, { ...cors, "Cache-Control": "public, max-age=300" });
      if (path === "/coffee/checkout" && request.method === "POST") return requireOrigin(cors) || coffeeCheckout(request, env, cors);
      if (path === "/coffee/status") return requireOrigin(cors) || coffeeStatus(env, url.searchParams.get("ref"), cors);
      if (path === "/webhooks/square" && request.method === "POST") return squareWebhook(request, env);
      if (path === "/webhooks/twilio" && request.method === "POST") return twilioInbound(request, env);
      // ---- staff portal (per-employee sign-in, Bearer token) ----
      if (path.startsWith("/staff/")) return requireOrigin(cors) || staffRoutes(request, env, cors, path, url);

      // ---- admin ----
      if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/")) {
        const denied = requireAdmin(request, env);
        if (denied) return denied;
        if (path === "/admin") return new Response(dashboardHtml(env), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        if (path === "/api/kpis") return json(await kpis(env, url.searchParams.get("from"), url.searchParams.get("to")), 200, { "Cache-Control": "no-store" });
        if (path === "/api/orders.csv") return ordersCsv(env);
        if (path === "/api/sync" && request.method === "POST") {
          const days = clamp(parseInt(url.searchParams.get("days") || "30", 10) || 30, 1, 1095);
          const from = url.searchParams.get("from"), to = url.searchParams.get("to");
          return json(await syncSquare(env, days, from, to), 200);
        }
        if (path === "/api/whoami") return json(await whoami(env), 200);
        if (path === "/api/pricing") return json(await pricingAdmin(env), 200, { "Cache-Control": "no-store" });
        if (path === "/api/pricing/analyze" && request.method === "POST") return json(await analyzePricing(env), 200);
        if (path === "/api/pricing/book" && request.method === "POST") { const r = await editBook(env, await request.json()); return json(r, r.ok ? 200 : 400); }
        const ps = path.match(/^\/api\/pricing\/suggestions\/(\d+)$/);
        if (ps && request.method === "POST") { const r = await decideSuggestion(env, +ps[1], await request.json()); return json(r, r.ok ? 200 : 400); }
        const am = path.match(/^\/api\/assets\/(\d+)$/);
        if (am) return assetResponse(env, +am[1]);
        if (path === "/admin/money") return new Response(moneyHtml(env), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
        if (path === "/api/money/yoy") return json(await yearOverYear(env), 200, { "Cache-Control": "no-store" });
        if (path === "/api/money/trends") return json(await trends(env), 200, { "Cache-Control": "no-store" });
        if (path === "/api/money/trends.csv") return trendsCsv(await trends(env));
        if (path === "/api/money") return json(await moneyReport(env, url.searchParams.get("from"), url.searchParams.get("to"), Object.fromEntries(url.searchParams)), 200, { "Cache-Control": "no-store" });
        if (path === "/api/money/settings" && request.method === "POST") return json({ ok: true, settings: await saveFinSettings(env, await request.json()) }, 200);
        if (path === "/api/bank/import" && request.method === "POST") return json(await importBank(env, await request.json()), 200);
        if (path === "/api/bank/txns") return json(await txnsFor(env, url.searchParams.get("month"), url.searchParams.get("category")), 200, { "Cache-Control": "no-store" });
        if (path === "/api/bank/export.csv") return bankCsv(env);
        if (path === "/api/bank/sources" && request.method === "GET") return json({ sources: await bankSources(env) }, 200, { "Cache-Control": "no-store" });
        if (path === "/api/bank/sources" && request.method === "DELETE") return json(await deleteSource(env, url.searchParams.get("source")), 200);
        if (path === "/api/bank/recategorize" && request.method === "POST") return json(await recategorizeAll(env), 200);
        if (path === "/api/plaid/link-token" && request.method === "POST") { const b = await request.json().catch(() => ({})); return json(await plaidLinkToken(env, b.item_id), 200); }
        if (path === "/api/plaid/exchange" && request.method === "POST") return json(await plaidExchange(env, await request.json()), 200);
        if (path === "/api/plaid/sync" && request.method === "POST") return json(await plaidSync(env), 200);
        if (path === "/api/plaid/items") return json({ items: await plaidItems(env), configured: !!(env.PLAID_CLIENT_ID && env.PLAID_SECRET), env: env.PLAID_ENV || "sandbox" }, 200, { "Cache-Control": "no-store" });
        const pm = path.match(/^\/api\/plaid\/items\/([\w-]+)$/);
        if (pm && request.method === "DELETE") return json(await plaidRemove(env, pm[1]), 200);
        const pd = path.match(/^\/api\/plaid\/items\/([\w-]+)\/details$/);
        if (pd) return json(await plaidItemDetails(env, pd[1]), 200, { "Cache-Control": "no-store" });
        const pa = path.match(/^\/api\/plaid\/items\/([\w-]+)\/accounts\/([\w-]+)$/);
        if (pa && request.method === "POST") { const r = await plaidAccountFlag(env, pa[1], pa[2], await request.json()); return json(r, r.ok ? 200 : 400); }
        const bm = path.match(/^\/api\/bank\/txns\/(\d+)$/);
        if (bm && request.method === "POST") { const r = await categorize(env, +bm[1], await request.json()); return json(r, r.ok ? 200 : 400); }
        if (path === "/api/team") return json(await teamKpis(env, url.searchParams.get("from"), url.searchParams.get("to")), 200, { "Cache-Control": "no-store" });
        if (path === "/api/staff" && request.method === "POST") { const r = await upsertStaff(env, await request.json()); await staffLog(env, null, "team_update_admin", JSON.stringify({ id: r.id })); return json(r, r.ok ? 200 : 400); }
        if (path === "/api/noshow-check" && request.method === "POST") return json(await noShowCheck(env), 200);
        if (path === "/api/coffee") return json(await coffeeOrders(env), 200, { "Cache-Control": "no-store" });
        const cm = path.match(/^\/api\/coffee\/(BB-[A-Z0-9]+)$/);
        if (cm && request.method === "POST") return json(await coffeeUpdate(env, cm[1], await request.json()), 200);
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

  async scheduled(event, rawEnv, ctx) {
    const env = cleanEnv(rawEnv);
    await ensureSchema(env);
    ctx.waitUntil((async () => {
      const d = new Date(event.scheduledTime || Date.now());
      await noShowCheck(env);                                              // staffing watchdog: every tick during open hours
      if (d.getUTCMinutes() >= 10) return;                                 // the :15 crons exist only for the 10:15 check
      await syncSquare(env, 3);
      if (env.PLAID_CLIENT_ID) await plaidSync(env, null, 12);
      if (d.getUTCDay() === 1 && d.getUTCHours() === 15) { await analyzePricing(env).catch((e) => console.error("pricing review", e)); await sendDigest(env); }
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
  const detail = b.detail && typeof b.detail === "object" ? JSON.stringify(b.detail).slice(0, 300) : null;
  await env.DB.prepare(`INSERT INTO events (ts, name, session, ref, path, detail) VALUES (?,?,?,?,?,?)`).bind(new Date().toISOString(), name, session, ref, path, detail).run();
  return json({ ok: true }, 200, cors);
}

const RATE = new Map(); // ip -> [timestamps], per isolate; a light brake on form spam
function rateLimited(ip, limit = 8, windowMs = 600000) {
  const now = Date.now(), arr = (RATE.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now); RATE.set(ip, arr); return arr.length > limit;
}

async function submitInquiry(request, env, cors) {
  if (!env.DB) return json({ error: "No database" }, 503, cors);
  if (!env.RESEND_API_KEY) return json({ error: "Email not configured" }, 503, cors); // site falls back to Formspree
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  if (String(b._gotcha || "").trim()) return json({ ok: true, ref: null }, 200, cors); // honeypot: pretend success
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (rateLimited(ip)) return json({ error: "Too many requests, please try again in a few minutes" }, 429, cors);

  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Valid email required" }, 400, cors);
  const name = String(b.Name || b.name || "").trim().slice(0, 80), business = String(b.Business || b.business || "").trim().slice(0, 120), phone = String(b.Phone || b.phone || "").trim().slice(0, 40);
  const refIn = String(b.Reference || b.ref || ""); const ref = /^HD-[A-Z0-9]{4,12}$/.test(refIn) ? refIn : null;
  const kind = b.Order ? "order" : "quote";
  // keep every human-readable field, drop form plumbing
  const fields = {};
  for (const [k, v] of Object.entries(b)) { if (k.startsWith("_") || ["email", "Reference", "Payment"].includes(k)) continue; const val = String(v == null ? "" : v).trim().slice(0, 4000); if (val) fields[k] = val; }
  const now = new Date().toISOString();
  const ins = await env.DB.prepare(`INSERT INTO inquiries (created_at, kind, ref, name, business, email, phone, fields) VALUES (?,?,?,?,?,?,?,?)`).bind(now, kind, ref, name, business, email, phone, JSON.stringify(fields)).run();

  const who = business ? `${business} (${name})` : name || email;
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  const subject = kind === "order" ? `Cup order ${ref || ""} from ${who}`.replace("  ", " ") : `Quote request from ${who}`;
  const toHugh = `${kind === "order" ? "New cup order details" : "New quote request"} via hdlaser.net\n\nFrom: ${name}${business ? ", " + business : ""}\nEmail: ${email}\nPhone: ${phone || "-"}\n${ref ? "Reference: " + ref + "\n" : ""}${b.Payment ? "Payment: " + b.Payment + "\n" : ""}\n${lines}\n\nReply to this email to answer them directly.`;
  const r1 = await sendEmail(env, { to: env.SUPPORT_EMAIL, replyTo: email, subject, text: toHugh });
  await sendAlert(env, kind === "order" ? `New cup order ${ref || ""}: ${who}, ${fields["Order"] || ""}. Watch for payment.`.replace(/\s+/g, " ") : `Quote request from ${who}. ${phone ? "Ph " + phone + ". " : ""}Details in ${env.SUPPORT_EMAIL}.`);

  const first = name.split(" ")[0] || "there";
  const toCustomer = kind === "order"
    ? `Hi ${first},\n\nWe've got your cup order details${ref ? " (reference " + ref + ")" : ""}. If you completed payment, you're all set: email your logo to ${env.SUPPORT_EMAIL} or text it to (858) 373-9866 and we'll start your proof. If the payment page didn't open, we'll send you a secure payment link shortly.\n\nWhat happens next:\n1. Digital proof by email within 1-2 business days.\n2. You approve it (unlimited revisions).\n3. Cups ready 10-15 business days after approval.\n\nThanks for putting your name on the counter.\n\nHD Laser Studio\n759 Turquoise St, Pacific Beach\n(858) 373-9866 · hdlaser.net`
    : `Hi ${first},\n\nThanks for reaching out to HD Laser Studio. We've got your request and will email you a price and a digital proof within 1-2 business days. If you have a logo or artwork file, just reply to this email and attach it.\n\nQuick question in the meantime? Call or text (858) 373-9866.\n\nHD Laser Studio\n759 Turquoise St, Pacific Beach\nhdlaser.net`;
  const r2 = await sendEmail(env, { to: email, subject: kind === "order" ? `We've got your order${ref ? " " + ref : ""}` : "We've got your request", text: toCustomer });
  await env.DB.prepare(`UPDATE inquiries SET emailed = ? WHERE id = ?`).bind((r1.ok ? 1 : 0) + (r2.ok ? 2 : 0), ins.meta && ins.meta.last_row_id).run().catch(() => {});
  if (!r1.ok) console.error("email to shop failed", r1.error);
  return json({ ok: r1.ok, ref, emailed_customer: r2.ok, error: r1.ok ? undefined : r1.error }, r1.ok ? 200 : 502, cors);
}

async function sendEmail(env, { to, subject, text, html, replyTo }) {
  if (!env.RESEND_API_KEY) return { ok: false, error: "RESEND_API_KEY not set" };
  const from = env.FROM_EMAIL || `HD Laser Studio <contact@hdlaser.net>`;
  const body = { from, to: Array.isArray(to) ? to : [to], subject, text };
  if (html) body.html = html;
  // Replies always land in a real inbox: the customer's address when we're emailing the shop, otherwise contact@.
  const fallbackReply = env.SUPPORT_EMAIL || "contact@hdlaser.net";
  body.reply_to = replyTo || fallbackReply;
  try {
    const res = await fetch("https://api.resend.com/emails", { method: "POST", headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("resend", res.status, JSON.stringify(data).slice(0, 400)); return { ok: false, error: (data && data.message) || ("Resend " + res.status) }; }
    return { ok: true, id: data.id };
  } catch (e) { return { ok: false, error: "exception: " + (e && e.message || e) }; }
}

// Short text-only alerts to extra addresses (ALERT_TO, comma-separated). Works with carrier email-to-text
// gateways such as 5551234567@vtext.com, so a phone gets a text the moment something happens.
// NTFY_TOPIC (optional) also pushes the same line to the free ntfy phone app: https://ntfy.sh/<topic>
// opts.emailShop: also email SUPPORT_EMAIL when no ALERT_TO is set (used for staff alerts, which have no other email path)
async function sendAlert(env, text, opts = {}) {
  const msg = String(text).slice(0, 300);
  const jobs = [];
  let to = String(env.ALERT_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!to.length && opts.emailShop && env.SUPPORT_EMAIL) to = [env.SUPPORT_EMAIL];
  if (to.length && env.RESEND_API_KEY) jobs.push(sendEmail(env, { to, subject: "HD Laser: " + msg.slice(0, 60), text: msg }));
  if (env.NTFY_TOPIC) jobs.push(fetch("https://ntfy.sh/" + encodeURIComponent(env.NTFY_TOPIC), { method: "POST", headers: { "Title": "HD Laser", "Priority": "high", "Tags": "moneybag" }, body: msg }).then((r) => ({ ok: r.ok })).catch((e) => ({ ok: false, error: String(e) })));
  // Real SMS through Twilio (see sendSms): ALERT_SMS_TO = comma-separated phones
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM && env.ALERT_SMS_TO)
    for (const raw of String(env.ALERT_SMS_TO).split(",")) if (e164(raw)) jobs.push(sendSms(env, raw, "HD Laser: " + msg.slice(0, 140)));
  if (!jobs.length) return { ok: false, skipped: true };
  const results = await Promise.all(jobs);
  return { ok: results.some((r) => r && r.ok) };
}

async function recordResale(request, env, cors) {
  if (!env.DB) return json({ ok: false }, 200, cors);
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const ref = /^HD-[A-Z0-9]{4,12}$/.test(String(b.ref || "")) ? b.ref : null;
  if (!ref) return json({ error: "Bad ref" }, 400, cors);
  const permit = String(b.permit || "").trim().slice(0, 40), business = String(b.business || "").trim().slice(0, 120);
  if (!permit) return json({ error: "Permit required" }, 400, cors);
  const r = await env.DB.prepare(`UPDATE orders SET resale_permit = ?, resale_business = ?, resale_received_at = ? WHERE ref = ?`).bind(permit, business, new Date().toISOString(), ref).run();
  const o = await env.DB.prepare(`SELECT name, email, phone FROM orders WHERE ref = ?`).bind(ref).first();
  await sendAlert(env, `Resale permit received for ${ref} (${business}).`);
  if (env.RESEND_API_KEY) await sendEmail(env, { to: env.SUPPORT_EMAIL, replyTo: o && o.email || undefined, subject: `Resale permit for order ${ref}: ${business}`, text: `Order ${ref}
Business on permit: ${business}
CA seller's permit: ${permit}
Customer: ${o ? [o.name, o.email, o.phone].filter(Boolean).join(" · ") : "-"}

Next: email them the CDTFA-230 resale certificate to sign, then click "Resale cert" on the dashboard when it comes back.` });
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

async function syncSquare(env, days, fromIso, toIso) {
  if (!env.DB) return { ok: false, reason: "No database bound (DB)", errors: ["no DB binding"] };
  if (!env.SQUARE_ACCESS_TOKEN) return { ok: false, reason: "SQUARE_ACCESS_TOKEN is not set", errors: ["no token"] };
  const begin = fromIso && !isNaN(Date.parse(fromIso)) ? new Date(fromIso).toISOString() : new Date(Date.now() - days * 86400000).toISOString();
  const end = toIso && !isNaN(Date.parse(toIso)) ? new Date(toIso).toISOString() : null;
  const errors = [];
  let payments = 0, refunds = 0, orders = 0, items = 0, locations = [], payoutsN = 0, payoutError = null;
  try {
    const res = await squareFetch(env, "/v2/locations");
    const data = await res.json().catch(() => ({}));
    if (res.ok) locations = (data.locations || []).map((l) => l.id);
    else errors.push("locations " + res.status + " " + squareErr(data));

    const page = async (pathBase, key, handler) => {
      let cursor = "", pages = 0;
      do {
        const q = new URLSearchParams({ begin_time: begin, sort_order: "ASC", limit: "100" });
        if (end) q.set("end_time", end);
        if (cursor) q.set("cursor", cursor);
        const res = await squareFetch(env, `${pathBase}?${q}`);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { errors.push(`${key} ${res.status} ${squareErr(data)}`); break; }
        for (const row of data[key] || []) await handler(row);
        cursor = data.cursor || "";
        if (++pages >= 12) { if (cursor) errors.push(`${key}: window too large, stopped after ${pages} pages; run a shorter window`); break; }
      } while (cursor);
    };
    await page("/v2/payments", "payments", async (p) => { await upsertPayment(env, p); payments++; });
    await page("/v2/refunds", "refunds", async (r) => { await upsertRefund(env, r); refunds++; });
    try {
      const pq = new URLSearchParams({ begin_time: begin, sort_order: "ASC", limit: "100" }); if (end) pq.set("end_time", end);
      let cursor = "", pages = 0;
      do { if (cursor) pq.set("cursor", cursor); const res = await squareFetch(env, `/v2/payouts?${pq}`); const data = await res.json().catch(() => ({}));
        if (!res.ok) { payoutError = `${res.status} ${squareErr(data)}`; break; }
        for (const po of data.payouts || []) { await upsertPayout(env, po); payoutsN++; }
        cursor = data.cursor || ""; } while (cursor && ++pages < 12);
      await reconcile(env);
    } catch (e) { payoutError = String(e && e.message || e); }

    if (locations.length) {
      let cursor = "", pages = 0;
      do {
        const closed = { start_at: begin }; if (end) closed.end_at = end;
        const body = { location_ids: locations.slice(0, 10), limit: 500, query: { filter: { state_filter: { states: ["COMPLETED"] }, date_time_filter: { closed_at: closed } }, sort: { sort_field: "CLOSED_AT", sort_order: "ASC" } } };
        if (cursor) body.cursor = cursor;
        const res = await squareFetch(env, "/v2/orders/search", { method: "POST", body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { errors.push("orders " + res.status + " " + squareErr(data)); break; }
        for (const o of data.orders || []) {
          const lines = o.line_items || [];
          if (!lines.length) continue;
          const stmts = [env.DB.prepare(`DELETE FROM square_items WHERE order_id = ?`).bind(o.id)];
          for (const li of lines) stmts.push(env.DB.prepare(`INSERT INTO square_items (order_id, created_at, location_id, name, variation, qty, gross_cents, source) VALUES (?,?,?,?,?,?,?,?)`)
            .bind(o.id, o.closed_at || o.created_at || null, o.location_id || null, String(li.name || "Custom amount").slice(0, 120), String(li.variation_name || "").slice(0, 120), parseFloat(li.quantity || "1") || 1, money(li.gross_sales_money) || money(li.total_money), (o.source && o.source.name) || null));
          await env.DB.batch(stmts);
          orders++; items += lines.length;
        }
        cursor = data.cursor || "";
        if (++pages >= 6) { if (cursor) errors.push(`orders: window too large, stopped after ${pages} pages; run a shorter window`); break; }
      } while (cursor);
    }
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('last_sync', ?)`).bind(new Date().toISOString()).run();
  } catch (e) {
    console.error("sync exception", e && e.stack || e);
    errors.push("exception: " + (e && e.message || String(e)));
  }
  return { ok: errors.length === 0, payments, refunds, orders, items, payouts: payoutsN, payout_error: payoutError, locations: locations.length, since: begin, until: end, errors };
}

async function whoami(env) {
  const out = { env: env.SQUARE_ENV, has_token: !!env.SQUARE_ACCESS_TOKEN, has_db: !!env.DB, location_setting: env.SQUARE_LOCATION_ID || null };
  try {
    const m = await squareFetch(env, "/v2/merchants/me"); const md = await m.json().catch(() => ({}));
    out.merchant = m.ok ? { name: md.merchant && md.merchant.business_name, id: md.merchant && md.merchant.id, country: md.merchant && md.merchant.country } : { error: m.status + " " + squareErr(md) };
    const l = await squareFetch(env, "/v2/locations"); const ld = await l.json().catch(() => ({}));
    out.locations = l.ok ? (ld.locations || []).map((x) => ({ id: x.id, name: x.name, status: x.status, created_at: x.created_at })) : { error: l.status + " " + squareErr(ld) };
  } catch (e) { out.error = "exception: " + (e && e.message || e); }
  return out;
}

function squareErr(data) { return (data && data.errors && data.errors[0] && (data.errors[0].detail || data.errors[0].code)) || ""; }

async function upsertPayment(env, p) {
  const amount = money(p.amount_money), fee = (p.processing_fee || []).reduce((a, f) => a + money(f.amount_money), 0), refunded = money(p.refunded_money);
  const brand = p.card_details && p.card_details.card && p.card_details.card.card_brand || null;
  const orderRow = p.order_id ? await env.DB.prepare(`SELECT ref FROM orders WHERE square_order_id = ?`).bind(p.order_id).first() : null;
  const coffeeRow = !orderRow && p.order_id ? await env.DB.prepare(`SELECT ref FROM coffee_orders WHERE square_order_id = ?`).bind(p.order_id).first() : null;
  const ref = orderRow ? orderRow.ref : (coffeeRow ? coffeeRow.ref : null);
  await env.DB.prepare(`INSERT INTO payments (payment_id, created_at, updated_at, status, amount_cents, fee_cents, refunded_cents, square_order_id, ref, source, card_brand) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(payment_id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, amount_cents=excluded.amount_cents, fee_cents=excluded.fee_cents, refunded_cents=excluded.refunded_cents, ref=COALESCE(excluded.ref, payments.ref), card_brand=COALESCE(excluded.card_brand, payments.card_brand)`)
    .bind(p.id, p.created_at || null, p.updated_at || null, p.status || null, amount, fee, refunded, p.order_id || null, ref, p.source_type || null, brand).run();
  if (p.team_member_id) await env.DB.prepare(`UPDATE payments SET team_member_id = ? WHERE payment_id = ?`).bind(p.team_member_id, p.id).run().catch(() => {});
  if (coffeeRow && p.status === "COMPLETED") {
    const tip = money(p.tip_money);
    await env.DB.prepare(`UPDATE coffee_orders SET status = CASE WHEN ? >= total_cents AND ? > 0 THEN 'refunded' ELSE (CASE WHEN status IN ('ready','picked_up') THEN status ELSE 'paid' END) END, square_payment_id = ?, paid_at = COALESCE(paid_at, ?), paid_cents = ?, tip_cents = ? WHERE ref = ?`)
      .bind(refunded, refunded, p.id, p.created_at || new Date().toISOString(), amount, tip, ref).run();
    await notifyCoffee(env, ref);
    return;
  }
  if (ref && p.status === "COMPLETED") {
    await env.DB.prepare(`UPDATE orders SET status = CASE WHEN ? >= total_cents AND ? > 0 THEN 'refunded' ELSE 'paid' END, square_payment_id = ?, paid_at = COALESCE(paid_at, ?), paid_cents = ?, fee_cents = ?, refunded_cents = ? WHERE ref = ?`)
      .bind(refunded, refunded, p.id, p.created_at || new Date().toISOString(), amount, fee, refunded, ref).run();
    await notifyPaid(env, ref);
  }
}

async function notifyPaid(env, ref) {
  if (!env.RESEND_API_KEY) return;
  const o = await env.DB.prepare(`SELECT * FROM orders WHERE ref = ? AND status = 'paid' AND notified_paid_at IS NULL`).bind(ref).first();
  if (!o) return;
  if (o.kind === "custom") return notifyPaidCustom(env, o);
  const lines = (await env.DB.prepare(`SELECT qty, size, finish, color, lid, unit_cents FROM order_lines WHERE ref = ?`).bind(ref).all()).results;
  const items = lines.map((l) => `- ${l.qty} x ${l.size} oz ${l.finish === "printed" ? "UV printed" : "laser engraved"}, ${l.color}, ${l.lid} lid @ $${l.unit_cents / 100}`).join("\n");
  const total = "$" + (o.paid_cents / 100).toLocaleString("en-US");
  const first = (o.name || "").split(" ")[0] || "there";
  await sendEmail(env, { to: o.email, subject: `You're in. Order ${ref} is confirmed`, text:
`Hi ${first},

Payment received, ${total}. Thank you for putting your name on the counter.

Your order (${ref}):
${items}
One-time setup: $${o.setup_fee_cents / 100}

Two quick things so we can start your proof:
1. Email your logo or artwork to ${env.SUPPORT_EMAIL} (vector AI/EPS/SVG/PDF is best; a clean PNG works too), or text it to (858) 373-9866.
2. If you're reselling the cups, send your California seller's permit number so we can keep the order tax-exempt: ${env.SITE_URL}/thanks/?paid=1&ref=${ref}

What happens next:
- Digital proof by email within 1-2 business days. Unlimited revisions until it's right.
- Once approved, your cups are ready in 10-15 business days. Pick up in Pacific Beach or we'll arrange delivery.

HD Laser Studio
759 Turquoise St, Pacific Beach
(858) 373-9866 · hdlaser.net` });
  await sendEmail(env, { to: env.SUPPORT_EMAIL, replyTo: o.email || undefined, subject: `PAID ${total}: ${o.business || o.name} (${ref})`, text: `Order ${ref} is paid.\n\nCustomer: ${[o.name, o.business, o.email, o.phone].filter(Boolean).join(" · ")}\n${items}\nTotal paid: ${total}\nResale permit: ${o.resale_permit || "not yet"}\n\nNext: watch for their logo, then send the proof. Dashboard: ${env.WORKER_URL || ""}/admin` });
  await sendAlert(env, `PAID ${total} by ${o.business || o.name} (${ref}). ${lines.reduce((n, l) => n + l.qty, 0)} cups. Logo + proof next.`);
  await env.DB.prepare(`UPDATE orders SET notified_paid_at = ? WHERE ref = ?`).bind(new Date().toISOString(), ref).run();
}

async function notifyPaidCustom(env, o) {
  let spec = {}; try { spec = JSON.parse(o.spec || "{}"); } catch {}
  const total = "$" + (o.paid_cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });
  const first = (o.name || "").split(" ")[0] || "there";
  await sendEmail(env, { to: o.email, subject: `Paid. Order ${o.ref} is confirmed`, text:
`Hi ${first},

Payment received, ${total}. Thank you.

Your order (${o.ref}): ${spec.summary || ""}
${o.logo_asset_id ? "We have your logo file." : "If you haven't yet, send your logo or artwork to " + env.SUPPORT_EMAIL + " or text it to (858) 373-9866."}

What happens next:
- Digital proof by email within 1-2 business days. Unlimited revisions until it's right.
- Once you approve it we make it${o.rush ? " on the rush schedule" : ""} and text you when it's ready for pickup in Pacific Beach.

Reminder of what you initialed (${o.attest_initials}): we make exactly what you specified, and changes after approval are at your expense.

HD Laser Studio
759 Turquoise St, Pacific Beach
(858) 373-9866 · hdlaser.net` });
  await sendEmail(env, { to: env.SUPPORT_EMAIL, replyTo: o.email || undefined, subject: `PAID ${total}: ${o.business || o.name} (${o.ref})`, text: `Order ${o.ref} is paid.\n\nCustomer: ${[o.name, o.business, o.email, o.phone].filter(Boolean).join(" · ")}\n${spec.summary || ""}\n${o.needed_by ? "Needed by " + o.needed_by + "\n" : ""}Logo: ${o.logo_asset_id ? "on the order in the dashboard" : "not uploaded yet"}\nInitialed ${o.attest_initials} at ${o.attest_at}\n\nNext: proof, then make it. Dashboard: ${env.WORKER_URL || ""}/admin` });
  await sendAlert(env, `PAID ${total} by ${o.business || o.name} (${o.ref}): ${spec.summary || "custom order"}. Proof next.`);
  await env.DB.prepare(`UPDATE orders SET notified_paid_at = ? WHERE ref = ?`).bind(new Date().toISOString(), o.ref).run();
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
      o.kind, o.spec, o.attest_initials, o.attest_at, o.logo_asset_id, o.taken_by, o.needed_by, o.rush,
      COALESCE((SELECT GROUP_CONCAT(qty || ' x ' || size || 'oz ' || finish || ' ' || color || ' (' || lid || ')', '; ') FROM order_lines l WHERE l.ref = o.ref), (SELECT GROUP_CONCAT(qty || ' x ' || service || ' ' || inches || 'in on ' || product, '; ') FROM order_items i WHERE i.ref = o.ref)) items
      FROM orders o ORDER BY o.created_at DESC LIMIT 100`).all()).results;
  const lastSync = await q(`SELECT v FROM meta WHERE k = 'last_sync'`).first();
  const inqCount = await q(`SELECT COUNT(*) n FROM inquiries WHERE kind = 'quote' AND created_at >= ? AND created_at < ?`, fromIso, toIso).first();
  const inquiries = (await q(`SELECT id, created_at, kind, ref, name, business, email, phone, fields, emailed FROM inquiries ORDER BY created_at DESC LIMIT 50`).all()).results.map((r) => { let f = {}; try { f = JSON.parse(r.fields || "{}"); } catch {} return { ...r, fields: f }; });
  funnel.quote_request = Math.max(funnel.quote_request, inqCount.n);
  const lifetime = await q(`SELECT COUNT(*) orders, COALESCE(SUM(paid_cents - refunded_cents),0) revenue, COALESCE(SUM(cups),0) cups FROM orders WHERE status IN ('paid','refunded')`).first();

  return {
    range: { from: fromIso, to: toIso, prev_from: prevFrom, prev_to: prevTo },
    sales, prev, lifetime,
    product: { by_size: await mix("size"), by_finish: await mix("finish"), by_lid: await mix("lid"), by_color: await mix("color"), tiers },
    funnel,
    financial: { gross_cents: fin.gross, fees_cents: fin.fees, refunded_cents: fin.refunded, net_cents: fin.gross - fin.fees - fin.refunded, payments: fin.n, other_square_gross_cents: fin.other_gross, web_gross_cents: fin.gross - fin.other_gross, tax_rate: taxRate, tax_exposure_orders: taxDue.n, tax_exposure_cents: Math.round(taxDue.base * taxRate), by_card: cards, by_month: months, top_items: topItems },
    attention, recent, inquiries,
    last_sync: lastSync ? lastSync.v : null,
    email_configured: !!env.RESEND_API_KEY,
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
  const pend = await env.DB.prepare(`SELECT COUNT(*) n FROM price_suggestions WHERE status = 'pending'`).first().catch(() => ({ n: 0 }));
  if (pend && pend.n) lines.splice(lines.length - 1, 0, `PRICING: ${pend.n} suggested price change${pend.n === 1 ? "" : "s"} waiting for your approve/deny, with the reasoning, at the top of ${env.WORKER_URL || ""}/admin/money`, ``);
  const text = lines.join("\n");
  if (env.RESEND_API_KEY) {
    const r = await sendEmail(env, { to: env.SUPPORT_EMAIL, subject: `HD Laser weekly numbers: ${$(k.sales.revenue_cents)} from ${k.sales.orders} orders`, text });
    return { ok: r.ok, via: "resend", error: r.error, text };
  }
  if (!env.FORMSPREE_ENDPOINT) return { ok: false, reason: "no FORMSPREE_ENDPOINT or RESEND_API_KEY", text };
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
<div><a class="act" href="/admin/money" style="text-decoration:none;color:inherit;background:var(--ink);color:#fff;border-color:var(--ink)">Money</a> <button class="act" id="sync">Sync Square now</button> <button class="act" id="backfill">Import 2 years of history</button> <a class="act" href="/api/orders.csv" style="text-decoration:none;color:inherit">Download CSV</a> <button class="act" id="digest">Email digest</button></div></header>
<main>
<div id="err"></div>
<p class="small" id="meta"></p>
<p class="small" id="who"></p>
<h2>Sales, web cup orders</h2><div class="tiles" id="sales"></div>
<h2>Financial, all Square payments</h2><div class="tiles" id="fin"></div>
<div class="grid" id="fin2" style="margin-top:14px"></div>
<h2>Funnel</h2><div class="tiles" id="funnel"></div>
<h2>Product mix</h2><div class="grid" id="product"></div>
<h2>Needs attention</h2><div class="grid" id="attention"></div>
<h2>Recent orders</h2><div class="card"><table id="orders"></table></div>
<h2>Quote requests &amp; form submissions</h2><div class="card"><table id="inq"></table></div>
<h2>Team</h2>
<div class="grid" id="team"></div>
<div class="card" style="margin-top:14px"><h3 style="margin:0 0 6px">Add a team member</h3>
<form id="addstaff" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
<input name="name" placeholder="Name (e.g. Sam R.)" required style="font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px">
<select name="role" style="font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px"><option value="staff">Staff</option><option value="manager">Manager</option><option value="owner">Owner</option></select>
<input name="phone" placeholder="Cell (for on-call texts)" style="font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px">
<input name="pin" placeholder="PIN, 4-8 digits" inputmode="numeric" pattern="\\d{4,8}" required style="font:inherit;padding:7px 10px;border:1px solid var(--line);border-radius:8px">
<label class="small"><input type="checkbox" name="on_call"> On call</label>
<button class="act" type="submit">Add</button><span class="small" id="addmsg"></span></form>
<p class="small" style="margin:8px 0 0">Employees sign in at <b>hdlaser.net/staff</b> with their name and PIN. Managers and owners can edit the team there too.</p></div>
</main>
<script>
const $=s=>document.querySelector(s), money=c=>'$'+((c||0)/100).toLocaleString('en-US',{maximumFractionDigits:0}), esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtDate=s=>s?new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
const fmtLong=s=>s?new Date(s).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'';
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
  $('#meta').textContent='Range '+fmtLong(k.range.from)+' to '+fmtLong(k.range.to)+' · Last Square sync '+(k.last_sync?new Date(k.last_sync).toLocaleString():'never')+' · Lifetime: '+k.lifetime.orders+' orders, '+k.lifetime.cups+' cups, '+money(k.lifetime.revenue);
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
  $('#orders').innerHTML='<tr><th>Ref</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Progress</th></tr>'+k.recent.map(r=>'<tr><td><b>'+r.ref+'</b><div class="small">'+fmtDate(r.created_at)+'</div></td><td>'+who(r)+'</td><td class="small">'+esc(r.items||'')+(r.kind==='custom'?'<div>'+(r.attest_initials?'<span class="pill" style="background:#FBE9E6;color:var(--red)">initialed '+esc(r.attest_initials)+'</span> ':'')+(r.logo_asset_id?'<a href="/api/assets/'+r.logo_asset_id+'" target="_blank">logo file</a> ':'')+(r.taken_by?'at the counter by '+esc(r.taken_by)+' ':'')+(r.needed_by?'· needed by '+esc(r.needed_by):'')+(r.rush?' · <b>RUSH</b>':'')+'</div>':'')+'</td><td class="num">'+money(r.total_cents)+(r.refunded_cents?'<div class="small">refunded '+money(r.refunded_cents)+'</div>':'')+(r.fee_cents?'<div class="small">fee '+money(r.fee_cents)+'</div>':'')+'</td><td><span class="pill '+r.status+'">'+r.status.replace('_',' ')+'</span></td><td>'+flag(r.ref,'logo_received_at',r.logo_received_at,'Logo')+flag(r.ref,'proof_approved_at',r.proof_approved_at,'Proof OK')+flag(r.ref,'completed_at',r.completed_at,'Done')+flag(r.ref,'resale_received_at',r.resale_received_at,'Resale cert')+flag(r.ref,'tax_invoiced_at',r.tax_invoiced_at,'Tax invoiced')+'</td></tr>').join('');
  loadTeam();
  $('#inq').innerHTML=k.inquiries.length?'<tr><th>When</th><th>Type</th><th>Who</th><th>Details</th><th>Sent</th></tr>'+k.inquiries.map(i=>'<tr><td class="small">'+fmtDate(i.created_at)+'</td><td><span class="pill">'+esc(i.kind)+(i.ref?' '+i.ref:'')+'</span></td><td>'+who(i)+'</td><td class="small">'+esc(Object.entries(i.fields).filter(([k])=>!['Name','Business','Phone','Agreed to Terms of Sale','Terms version','Text message consent'].includes(k)).map(([k,v])=>k+': '+v).join(' · ')).slice(0,400)+'</td><td class="small">'+(i.emailed&1?'shop ✓ ':'')+(i.emailed&2?'customer ✓':'')+'</td></tr>').join(''):'<tr><td class="empty">'+(k.email_configured?'No submissions yet.':'Forms still go through Formspree until RESEND_API_KEY is set on the worker.')+'</td></tr>';
}
async function loadTeam(){ const q=new URLSearchParams(); if(from){q.set('from',from);} if(to){q.set('to',to);} if(!from){q.set('from',new Date(Date.now()-days*864e5).toISOString());}
  const r=await fetch('/api/team?'+q); if(!r.ok) return; const t=await r.json(); const a=t.aggregate;
  const rows=t.team.map(p=>'<tr><td><b>'+esc(p.name)+'</b><div class="small">'+esc(p.role)+(p.on_call?' · on call':'')+(p.active?'':' · inactive')+'</div></td><td class="num">'+p.shifts+'</td><td class="num">'+p.hours+'</td><td class="num">'+(p.opens?p.on_time_opens+'/'+p.opens:'-')+'</td><td class="num">'+(p.checklist_pct==null?'-':p.checklist_pct+'%')+'</td><td class="num">'+p.jobs_done+'</td><td class="num">'+money(p.jobs_done_amount_cents)+'</td></tr>').join('');
  $('#team').innerHTML='<div class="card"><h3 style="margin:0 0 6px">Team KPIs</h3>'+(t.team.length?'<table><tr><th>Person</th><th class="num">Shifts</th><th class="num">Hours</th><th class="num">On-time opens</th><th class="num">Checklist</th><th class="num">Jobs done</th><th class="num">Job value</th></tr>'+rows+'<tr><td><b>Everyone</b></td><td class="num">'+a.shifts+'</td><td class="num">'+a.hours+'</td><td class="num">'+(a.opens?a.on_time_opens+'/'+a.opens:'-')+'</td><td></td><td class="num">'+a.jobs_done+'</td><td class="num">'+money(a.jobs_done_amount_cents)+'</td></tr></table>':'<p class="empty">No team members yet. Add the first one below.</p>')+'</div>'
    +'<div class="card"><h3 style="margin:0 0 6px">Recent shifts</h3>'+(t.shifts.length?'<table>'+t.shifts.slice(0,20).map(s=>'<tr><td>'+esc(s.name)+'</td><td class="small">'+new Date(s.in_at).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+(s.out_at?' – '+new Date(s.out_at).toLocaleTimeString('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}):' (open)')+'</td><td class="num">'+(s.minutes?(s.minutes/60).toFixed(1)+' h':'')+'</td></tr>').join('')+'</table>':'<p class="empty">No shifts yet</p>')+'</div>'
    +'<div class="card"><h3 style="margin:0 0 6px">Activity log</h3>'+(t.log.length?'<table>'+t.log.slice(0,25).map(l=>'<tr><td class="small">'+new Date(l.ts).toLocaleString('en-US',{timeZone:'America/Los_Angeles',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+'</td><td>'+esc(l.name||'')+'</td><td class="small">'+esc(l.action)+' '+esc(l.detail||'')+'</td></tr>').join('')+'</table>':'<p class="empty">Nothing yet</p>')+'</div>'; }
$('#addstaff').onsubmit=async e=>{ e.preventDefault(); const f=e.target; const body={name:f.name.value,role:f.role.value,phone:f.phone.value,pin:f.pin.value,on_call:f.on_call.checked}; const r=await fetch('/api/staff',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const j=await r.json(); $('#addmsg').textContent=j.ok?'Added. They can sign in now.':(j.error||'Failed'); if(j.ok){ f.reset(); loadTeam(); } };
document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-ref]'); if(b){ const body={}; body[b.dataset.field]=b.dataset.val==='1'; await fetch('/api/orders/'+b.dataset.ref,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); load(); return; }
  const rb=e.target.closest('#ranges button[data-d]'); if(rb){ document.querySelectorAll('#ranges button').forEach(x=>x.classList.remove('on')); rb.classList.add('on'); days=+rb.dataset.d; from=to=null; $('#from').value=''; $('#to').value=''; load(); }
});
$('#go').onclick=()=>{ from=$('#from').value?new Date($('#from').value).toISOString():null; to=$('#to').value?new Date(new Date($('#to').value).getTime()+864e5).toISOString():null; document.querySelectorAll('#ranges button').forEach(x=>x.classList.remove('on')); load(); };
function syncSummary(j){ return 'Payments '+(j.payments||0)+', refunds '+(j.refunds||0)+', itemised orders '+(j.orders||0)+', locations '+(j.locations||0)+'.'+(j.errors&&j.errors.length?'\\n\\nProblems: '+j.errors.join(' | '):'')+(j.error?'\\n\\nError: '+j.error:'')+(j.reason?'\\n'+j.reason:''); }
async function runSync(days,btn,label){ btn.disabled=true; btn.textContent='Working…'; try{ const r=await fetch('/api/sync?days='+days,{method:'POST'}); const j=await r.json(); alert((j.ok?'Done. ':'Finished with problems. ')+syncSummary(j)); }catch(e){ alert('Request failed: '+e.message); } btn.disabled=false; btn.textContent=label; load(); }
async function backfill(btn){ btn.disabled=true; const step=45*864e5, now=Date.now(), start=now-730*864e5; let t=start, n=0, tot={payments:0,refunds:0,orders:0,locations:0}, probs=[]; const steps=Math.ceil((now-start)/step);
  for(; t<now; t+=step){ n++; btn.textContent='Importing '+n+' of '+steps+'…'; try{ const r=await fetch('/api/sync?from='+new Date(t).toISOString()+'&to='+new Date(Math.min(t+step,now)).toISOString(),{method:'POST'}); const j=await r.json(); tot.payments+=j.payments||0; tot.refunds+=j.refunds||0; tot.orders+=j.orders||0; tot.locations=j.locations||tot.locations; if(j.errors&&j.errors.length) probs.push(new Date(t).toLocaleDateString()+': '+j.errors.join(' | ')); if(j.error) probs.push('Error: '+j.error); if(probs.length>=3) break; }catch(e){ probs.push('Request failed: '+e.message); break; } }
  alert((probs.length?'Finished with problems. ':'Done. ')+'Payments '+tot.payments+', refunds '+tot.refunds+', itemised orders '+tot.orders+', locations '+tot.locations+'.'+(probs.length?'\\n\\n'+probs.join('\\n'):'')); btn.disabled=false; btn.textContent='Import 2 years of history'; load(); }
$('#backfill').onclick=()=>{ if(confirm('Pull two years of Square payments, refunds and itemised orders? Runs in 45-day chunks and is safe to repeat.')) backfill($('#backfill')); };
$('#digest').onclick=async()=>{ if(!confirm('Email the weekly digest to '+${JSON.stringify(env.SUPPORT_EMAIL || "the support inbox")}+' now?')) return; const r=await fetch('/api/digest',{method:'POST'}); const j=await r.json(); alert(j.ok?'Sent.':'Not sent: '+(j.reason||j.status)); };
load();
fetch('/api/whoami').then(r=>r.json()).then(w=>{ const locs=Array.isArray(w.locations)?w.locations.map(l=>l.name+(l.status&&l.status!=='ACTIVE'?' ('+l.status.toLowerCase()+')':'')).join(', '):(w.locations&&w.locations.error)||'?'; const m=w.merchant&&w.merchant.name?w.merchant.name:(w.merchant&&w.merchant.error)||'?'; $('#who').textContent='Square '+(w.env||'')+' account: '+m+' · Locations: '+locs+(w.error?' · '+w.error:''); }).catch(()=>{});
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
  const h = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Vary": "Origin" };
  if (allowed.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...(headers || {}) } }); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function money(m) { return m && typeof m.amount === "number" ? m.amount : 0; }
function e164(phone) { const d = String(phone || "").replace(/\D/g, ""); if (d.length === 10) return "+1" + d; if (d.length === 11 && d[0] === "1") return "+" + d; return undefined; }

// ================================================================ staff portal
// Every employee signs in with their own name + PIN (no shared account). Sessions last one shift (14 h).
// Owner/manager create staff from the /admin dashboard or from the portal's Team tab.

const TZ = "America/Los_Angeles";
const OPEN_HOUR = 10;                                   // shop opens 10:00 every day
const CLOSE_HOUR = (dow) => (dow === 0 ? 15 : 17);      // Sunday closes 3 PM, otherwise 5 PM
const OPEN_STEPS = [
  "Unlock front door, turn off alarm",
  "Clock in on this page",
  "Open back door, lights on",
  "Turn on lasers, UV printer and exhaust; let them warm up",
  "Check contact@hdlaser.net and the shop phone for new orders and messages",
  "Review today's work queue below and plan the day",
  "Count the cash drawer, open Square Point of Sale with your own passcode",
  "Wipe counters, restock cups and samples at the front",
];
const CLOSE_STEPS = [
  "Finish or safely pause every job that's running; mark done jobs below",
  "Reply to any customer waiting on a proof or a pickup time",
  "Close out Square: count the drawer, note any overage/shortage",
  "Clean laser beds, empty scrap, wipe the UV printer",
  "Turn off machines, exhaust and compressor",
  "Lock back door, lights off, set alarm",
  "Clock out on this page",
  "Lock the front door",
];
// Time value per product. Minutes = setup + each × quantity. Override with PRODUCT_MINUTES (JSON array) in Cloudflare.
const PRODUCTS = [
  { key: "cup_engraved", name: "Logo cups, laser engraved", setup: 20, each: 2.5 },
  { key: "cup_printed", name: "Logo cups, UV printed", setup: 30, each: 3 },
  { key: "tumbler", name: "Tumbler or bottle engraving", setup: 10, each: 12 },
  { key: "uv_small", name: "UV print, small item", setup: 10, each: 8 },
  { key: "award", name: "Plaque, award or trophy", setup: 15, each: 25 },
  { key: "board", name: "Cutting board or wood engraving", setup: 10, each: 20 },
  { key: "glass", name: "Glassware engraving", setup: 10, each: 10 },
  { key: "tags", name: "Metal tags or plates", setup: 10, each: 3 },
  { key: "cut", name: "Laser cut or layered art", setup: 20, each: 45 },
  { key: "other", name: "Other or custom", setup: 15, each: 20 },
];
const WALKIN_MINUTES = 30;       // planning size of a typical same-day walk-in job
const UTILIZATION = 0.7;         // share of a shift that is real machine time; the rest is customers, cleanup, breaks
const ON_TIME_GRACE_MIN = 5;     // clock-in by 10:05 counts as on time

function products(env) {
  if (env.PRODUCT_MINUTES) { try { const p = JSON.parse(env.PRODUCT_MINUTES); if (Array.isArray(p) && p.length) return p; } catch {} }
  return PRODUCTS;
}
function productMinutes(env, key, qty) {
  const p = products(env).find((x) => x.key === key) || PRODUCTS[PRODUCTS.length - 1];
  return Math.round(p.setup + p.each * Math.max(1, qty || 1));
}
// Local (Pacific) time parts for a Date, so shifts and opening times follow the shop clock, not UTC.
function local(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday);
  return { date: `${o.year}-${o.month}-${o.day}`, hour: +o.hour % 24, minute: +o.minute, dow, minutes: (+o.hour % 24) * 60 + (+o.minute) };
}
function fmtLocal(iso) { return iso ? new Date(iso).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : ""; }
// Minutes to add to UTC to get shop-local time (negative in California).
function tzOffsetMin(d) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return Math.round((Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second) - d.getTime()) / 60000);
}
// ISO range covering one shop-local calendar day.
function localDayRange(dateStr) {
  const off = tzOffsetMin(new Date(dateStr + "T12:00:00Z"));
  const start = new Date(Date.parse(dateStr + "T00:00:00Z") - off * 60000);
  return { from: start.toISOString(), to: new Date(start.getTime() + 86400000).toISOString() };
}

async function pbkdf(pin, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000 }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(n) { return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
const ROLE_RANK = { staff: 1, manager: 2, owner: 3 };

async function staffSession(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return null;
  const token = h.slice(7).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const row = await env.DB.prepare(`SELECT s.token, s.expires_at, p.* FROM staff_sessions s JOIN staff p ON p.id = s.staff_id WHERE s.token = ? AND p.active = 1`).bind(token).first();
  if (!row || new Date(row.expires_at) < new Date()) return null;
  return row;
}
async function staffLog(env, staffId, action, detail) {
  await env.DB.prepare(`INSERT INTO staff_log (ts, staff_id, action, detail) VALUES (?,?,?,?)`).bind(new Date().toISOString(), staffId || null, action, detail ? String(detail).slice(0, 500) : null).run();
}
function staffAlertsOn(env, kind) { return String(env.STAFF_ALERTS || "clockin,clockout,noshow").split(",").map((s) => s.trim()).includes(kind); }

async function staffRoutes(request, env, cors, path, url) {
  if (!env.DB) return json({ error: "No database" }, 503, cors);
  const now = new Date().toISOString();

  if (path === "/staff/login" && request.method === "POST") {
    const ip = request.headers.get("CF-Connecting-IP") || "";
    if (rateLimited("login:" + ip, 12, 600000)) return json({ error: "Too many attempts. Wait 10 minutes." }, 429, cors);
    let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
    const name = String(b.name || "").trim(), pin = String(b.pin || "").trim();
    if (!name || !/^\d{4,8}$/.test(pin)) return json({ error: "Enter your name and your PIN" }, 400, cors);
    const p = await env.DB.prepare(`SELECT * FROM staff WHERE lower(name) = lower(?) AND active = 1`).bind(name).first();
    if (!p || !p.pin_hash || !timingSafeEqual(await pbkdf(pin, p.pin_salt), p.pin_hash)) { await staffLog(env, p && p.id, "login_failed", name); return json({ error: "Name or PIN doesn't match" }, 401, cors); }
    const token = randomHex(32);
    await env.DB.prepare(`INSERT INTO staff_sessions (token, staff_id, created_at, expires_at, ip) VALUES (?,?,?,?,?)`).bind(token, p.id, now, new Date(Date.now() + 14 * 3600000).toISOString(), ip).run();
    if (b.smsConsent === true && !p.sms_consent_at) { await env.DB.prepare(`UPDATE staff SET sms_consent_at = ? WHERE id = ?`).bind(now, p.id).run(); await staffLog(env, p.id, "sms_consent", ip); p.sms_consent_at = now; }
    await staffLog(env, p.id, "login", ip);
    return json({ ok: true, token, me: pub(p) }, 200, cors);
  }

  const me = await staffSession(request, env);
  if (!me) return json({ error: "Please sign in" }, 401, cors);
  const isMgr = ROLE_RANK[me.role] >= 2;

  if (path === "/staff/logout" && request.method === "POST") { await env.DB.prepare(`DELETE FROM staff_sessions WHERE token = ?`).bind(me.token).run(); return json({ ok: true }, 200, cors); }

  if (path === "/staff/me") return json(await staffHome(env, me), 200, { ...cors, "Cache-Control": "no-store" });

  if (path === "/staff/clock" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const open = await env.DB.prepare(`SELECT * FROM shifts WHERE staff_id = ? AND out_at IS NULL ORDER BY in_at DESC LIMIT 1`).bind(me.id).first();
    if (b.action === "in") {
      if (open) return json({ ok: true, shift: open, note: "Already clocked in" }, 200, cors);
      const r = await env.DB.prepare(`INSERT INTO shifts (staff_id, in_at) VALUES (?,?)`).bind(me.id, now).run();
      await staffLog(env, me.id, "clock_in", "");
      const l = local();
      const first = await env.DB.prepare(`SELECT COUNT(*) n FROM shifts WHERE in_at >= ? AND in_at < ?`).bind(localDayRange(l.date).from, now).first();
      if (staffAlertsOn(env, "clockin")) await sendAlert(env, `${me.name} clocked in at ${fmtLocal(now)}${first.n === 0 ? " (first in today)" : ""}.`, { emailShop: true });
      await env.DB.prepare(`DELETE FROM meta WHERE k = 'noshow_pending'`).run();
      return json({ ok: true, shift: { id: r.meta && r.meta.last_row_id, in_at: now } }, 200, cors);
    }
    if (b.action === "out") {
      if (!open) return json({ error: "You're not clocked in" }, 400, cors);
      const mins = Math.max(1, Math.round((Date.now() - new Date(open.in_at)) / 60000));
      await env.DB.prepare(`UPDATE shifts SET out_at = ?, minutes = ?, note = ? WHERE id = ?`).bind(now, mins, String(b.note || "").slice(0, 500) || null, open.id).run();
      await staffLog(env, me.id, "clock_out", mins + " min");
      if (staffAlertsOn(env, "clockout")) await sendAlert(env, `${me.name} clocked out at ${fmtLocal(now)} (${(mins / 60).toFixed(1)} h).`, { emailShop: true });
      return json({ ok: true, minutes: mins }, 200, cors);
    }
    return json({ error: "action must be in or out" }, 400, cors);
  }

  if (path === "/staff/checklist" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const kind = b.kind === "close" ? "close" : "open";
    const steps = kind === "open" ? OPEN_STEPS : CLOSE_STEPS;
    const idx = parseInt(b.step, 10);
    if (!(idx >= 0 && idx < steps.length)) return json({ error: "Bad step" }, 400, cors);
    const shift = await env.DB.prepare(`SELECT id FROM shifts WHERE staff_id = ? AND out_at IS NULL ORDER BY in_at DESC LIMIT 1`).bind(me.id).first();
    if (!shift) return json({ error: "Clock in first" }, 400, cors);
    if (b.done === false) await env.DB.prepare(`DELETE FROM checklist WHERE shift_id = ? AND kind = ? AND step = ?`).bind(shift.id, kind, idx).run();
    else await env.DB.prepare(`INSERT OR IGNORE INTO checklist (shift_id, kind, step, done_at) VALUES (?,?,?,?)`).bind(shift.id, kind, idx, now).run();
    return json({ ok: true }, 200, cors);
  }

  if (path === "/staff/jobs" && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const product = String(b.product || "other"), qty = clamp(parseInt(b.qty, 10) || 1, 1, 10000);
    const minutes = clamp(parseInt(b.minutes, 10) || productMinutes(env, product, qty), 1, 100000);
    const amount = Math.round((parseFloat(b.amount) || 0) * 100);
    const due = b.due ? new Date(b.due) : null;
    const r = await env.DB.prepare(`INSERT INTO jobs (created_at, staff_id, customer, phone, product, qty, minutes, amount_cents, due_at, status, note) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(now, me.id, String(b.customer || "").slice(0, 120), String(b.phone || "").slice(0, 40), product, qty, minutes, amount, due && !isNaN(due) ? due.toISOString() : null, "queued", String(b.note || "").slice(0, 500)).run();
    await staffLog(env, me.id, "job_new", `${product} x${qty} ${minutes}m $${amount / 100}`);
    return json({ ok: true, id: r.meta && r.meta.last_row_id, minutes }, 200, cors);
  }
  let m = path.match(/^\/staff\/jobs\/(\d+)$/);
  if (m && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const id = +m[1];
    if (b.status === "started") await env.DB.prepare(`UPDATE jobs SET status = 'started', started_at = COALESCE(started_at, ?) WHERE id = ?`).bind(now, id).run();
    else if (b.status === "done") await env.DB.prepare(`UPDATE jobs SET status = 'done', done_at = ?, done_by = ? WHERE id = ?`).bind(now, me.id, id).run();
    else if (b.status === "queued") await env.DB.prepare(`UPDATE jobs SET status = 'queued', done_at = NULL, done_by = NULL WHERE id = ?`).bind(id).run();
    else if (b.status === "cancelled") await env.DB.prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).bind(id).run();
    else return json({ error: "Bad status" }, 400, cors);
    await staffLog(env, me.id, "job_" + b.status, String(id));
    return json({ ok: true }, 200, cors);
  }
  m = path.match(/^\/staff\/orders\/(HD-[A-Z0-9]+)$/);
  if (m && request.method === "POST") {
    const b = await request.json().catch(() => ({}));
    const allowed = {}; for (const k of ["logo_received_at", "proof_approved_at", "completed_at"]) if (k in b) allowed[k] = b[k];
    const r = await updateOrder(env, m[1], allowed);
    await staffLog(env, me.id, "order_update", m[1] + " " + Object.keys(allowed).join(","));
    return json(r, 200, cors);
  }

  // ---- managers and owner ----
  if (path === "/staff/team") {
    if (!isMgr) return json({ error: "Managers only" }, 403, cors);
    if (request.method === "GET") return json(await teamKpis(env, url.searchParams.get("from"), url.searchParams.get("to")), 200, { ...cors, "Cache-Control": "no-store" });
    if (request.method === "POST") {
      const b = await request.json().catch(() => ({}));
      if (b.role && ROLE_RANK[b.role] > ROLE_RANK[me.role]) return json({ error: "You can't grant a role above your own" }, 403, cors);
      const r = await upsertStaff(env, b);
      await staffLog(env, me.id, "team_update", (b.id ? "edit " : "add ") + (b.name || b.id));
      return json(r, r.ok ? 200 : 400, cors);
    }
  }
  return json({ error: "Not found" }, 404, cors);
}
function pub(p) { return { id: p.id, name: p.name, role: p.role, phone: p.phone || "", email: p.email || "", on_call: !!p.on_call, active: p.active !== 0, hourly_rate_cents: p.hourly_rate_cents || 0, commission_pct: p.commission_pct || 0, sms_consent_at: p.sms_consent_at || null }; }

async function upsertStaff(env, b) {
  const name = String(b.name || "").trim().slice(0, 60);
  const role = ["staff", "manager", "owner"].includes(b.role) ? b.role : "staff";
  if (b.id) {
    const sets = [], args = [];
    if (name) { sets.push("name = ?"); args.push(name); }
    if (b.role) { sets.push("role = ?"); args.push(role); }
    for (const k of ["phone", "email"]) if (k in b) { sets.push(`${k} = ?`); args.push(String(b[k] || "").slice(0, 120)); }
    if ("hourly_rate_cents" in b) { sets.push("hourly_rate_cents = ?"); args.push(Math.max(0, Math.round(+b.hourly_rate_cents || 0))); }
    if ("commission_pct" in b) { sets.push("commission_pct = ?"); args.push(Math.max(0, Math.min(100, +b.commission_pct || 0))); }
    if ("on_call" in b) { sets.push("on_call = ?"); args.push(b.on_call ? 1 : 0); }
    if ("active" in b) { sets.push("active = ?"); args.push(b.active ? 1 : 0); if (!b.active) await env.DB.prepare(`DELETE FROM staff_sessions WHERE staff_id = ?`).bind(+b.id).run(); }
    if (b.pin) { if (!/^\d{4,8}$/.test(String(b.pin))) return { ok: false, error: "PIN must be 4 to 8 digits" }; const salt = randomHex(16); sets.push("pin_salt = ?", "pin_hash = ?"); args.push(salt, await pbkdf(String(b.pin), salt)); }
    if (!sets.length) return { ok: false, error: "Nothing to update" };
    args.push(+b.id);
    await env.DB.prepare(`UPDATE staff SET ${sets.join(", ")} WHERE id = ?`).bind(...args).run();
    return { ok: true, id: +b.id };
  }
  if (!name) return { ok: false, error: "Name required" };
  if (!/^\d{4,8}$/.test(String(b.pin || ""))) return { ok: false, error: "PIN must be 4 to 8 digits" };
  const dup = await env.DB.prepare(`SELECT id FROM staff WHERE lower(name) = lower(?)`).bind(name).first();
  if (dup) return { ok: false, error: "That name is already on the team. Use a last initial." };
  const salt = randomHex(16);
  const r = await env.DB.prepare(`INSERT INTO staff (name, role, phone, email, pin_hash, pin_salt, on_call, active, created_at, hourly_rate_cents, commission_pct) VALUES (?,?,?,?,?,?,?,1,?,?,?)`)
    .bind(name, role, String(b.phone || "").slice(0, 40), String(b.email || "").slice(0, 120), await pbkdf(String(b.pin), salt), salt, b.on_call ? 1 : 0, new Date().toISOString(), Math.max(0, Math.round(+b.hourly_rate_cents || 0)), Math.max(0, Math.min(100, +b.commission_pct || 0))).run();
  return { ok: true, id: r.meta && r.meta.last_row_id };
}

// What one employee sees when they open the portal.
async function staffHome(env, me) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const l = local(); const day = localDayRange(l.date);
  const shift = await q(`SELECT * FROM shifts WHERE staff_id = ? AND out_at IS NULL ORDER BY in_at DESC LIMIT 1`, me.id).first();
  const done = shift ? (await q(`SELECT kind, step FROM checklist WHERE shift_id = ?`, shift.id).all()).results : [];
  const onToday = (await q(`SELECT s.in_at, s.out_at, p.name FROM shifts s JOIN staff p ON p.id = s.staff_id WHERE s.in_at >= ? AND s.in_at < ? ORDER BY s.in_at`, day.from, day.to).all()).results;
  const queue = await workQueue(env);
  const cap = capacity(l, queue);
  const week = weekRange(l.date);
  const mine = await staffStats(env, me.id, week.from, week.to);
  return {
    me: pub(me), now: new Date().toISOString(), local: l,
    shift: shift ? { id: shift.id, in_at: shift.in_at, minutes: Math.round((Date.now() - new Date(shift.in_at)) / 60000) } : null,
    checklist: { open: OPEN_STEPS.map((s, i) => ({ step: s, done: done.some((d) => d.kind === "open" && d.step === i) })), close: CLOSE_STEPS.map((s, i) => ({ step: s, done: done.some((d) => d.kind === "close" && d.step === i) })) },
    on_today: onToday.map((r) => ({ name: r.name, in_at: r.in_at, out_at: r.out_at })),
    queue, capacity: cap, products: products(env), week: mine, pay: await staffPay(env, me),
    is_manager: ROLE_RANK[me.role] >= 2,
  };
}

// Everything waiting to be made, scored so the most urgent and valuable work sits on top.
async function workQueue(env) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const items = [];
  const jobs = (await q(`SELECT j.*, p.name staff_name FROM jobs j LEFT JOIN staff p ON p.id = j.staff_id WHERE j.status IN ('queued','started') ORDER BY j.created_at`).all()).results;
  for (const j of jobs) items.push({ kind: "job", id: j.id, title: `${j.customer || "Walk-in"}: ${prodName(env, j.product)} x${j.qty}`, note: j.note, phone: j.phone, minutes: j.minutes, amount_cents: j.amount_cents, due_at: j.due_at, created_at: j.created_at, status: j.status, by: j.staff_name });
  const orders = (await q(`SELECT o.ref, o.business, o.name, o.phone, o.cups, o.paid_at, o.paid_cents, o.logo_received_at, o.proof_approved_at, o.kind, o.spec, o.needed_by, o.rush, o.logo_asset_id, o.attest_initials,
      (SELECT SUM(CASE WHEN finish='printed' THEN qty*3+30 ELSE qty*2.5+20 END) FROM order_lines l WHERE l.ref=o.ref) minutes,
      (SELECT SUM(qty * (CASE WHEN service='uv' THEN 3 + inches*1.5 ELSE 4 + inches*2 END)) + 10 FROM order_items i WHERE i.ref=o.ref) cminutes,
      (SELECT GROUP_CONCAT(qty || ' x ' || size || 'oz ' || finish || ' ' || color || ' (' || lid || ')', '; ') FROM order_lines l WHERE l.ref = o.ref) items
      FROM orders o WHERE o.status = 'paid' AND o.completed_at IS NULL ORDER BY o.paid_at`).all()).results;
  for (const o of orders) {
    const custom = o.kind === "custom"; let spec = {}; if (custom) { try { spec = JSON.parse(o.spec || "{}"); } catch {} if (o.logo_asset_id && !o.logo_received_at) o.logo_received_at = o.paid_at; o.minutes = o.cminutes; }
    const stage = !o.logo_received_at ? "waiting for logo" : !o.proof_approved_at ? "send proof" : "in production";
    const wait = custom ? (o.rush ? 3 : 7) : 21;
    let due = o.proof_approved_at ? new Date(new Date(o.proof_approved_at).getTime() + wait * 86400000).toISOString() : (o.logo_received_at ? new Date(new Date(o.logo_received_at).getTime() + 2 * 86400000).toISOString() : null);
    if (custom && o.needed_by && (!due || o.needed_by + "T23:00:00Z" < due)) due = o.needed_by + "T23:00:00Z";
    items.push({ kind: "order", id: o.ref, title: custom ? `${o.business || o.name}: ${spec.summary || "custom order"}` : `${o.business || o.name}: ${o.cups} logo cups`, note: custom ? `Initialed ${o.attest_initials || "?"}${o.logo_asset_id ? " · logo on file" : ""}` : o.items, phone: o.phone, minutes: stage === "in production" ? Math.round(o.minutes || 0) : stage === "send proof" ? 20 : 0, amount_cents: o.paid_cents, due_at: due, created_at: o.paid_at, status: stage, stage, logo: !!o.logo_received_at, proof: !!o.proof_approved_at });
  }
  const now = Date.now();
  for (const it of items) {
    let s = 40;
    if (it.due_at) { const d = (new Date(it.due_at) - now) / 86400000; s = d < 0 ? 100 : d < 1 ? 80 : d < 2 ? 65 : Math.max(20, 55 - Math.round(d * 3)); }
    if (it.status === "waiting for logo") s = 10;
    s += Math.min(20, Math.round((it.amount_cents || 0) / 10000));
    s += Math.min(10, Math.round((now - new Date(it.created_at)) / 86400000));
    if (it.status === "started") s += 5;
    it.score = s;
  }
  items.sort((a, b) => b.score - a.score);
  return items;
}
function prodName(env, key) { const p = products(env).find((x) => x.key === key); return p ? p.name : key; }
// How much same-day work the shop can still take today.
function capacity(l, queue) {
  const closeMin = CLOSE_HOUR(l.dow) * 60;
  const left = Math.max(0, closeMin - Math.max(l.minutes, OPEN_HOUR * 60));
  const workable = Math.round(left * UTILIZATION);
  const committed = queue.filter((i) => i.status !== "waiting for logo" && (!i.due_at || new Date(i.due_at) <= new Date(new Date().getTime() + 86400000))).reduce((n, i) => n + (i.minutes || 0), 0);
  const free = Math.max(0, workable - committed);
  return { minutes_left_today: left, workable_minutes: workable, committed_minutes: committed, free_minutes: free, walkins_today: Math.floor(free / WALKIN_MINUTES), walkin_minutes: WALKIN_MINUTES, closes_at: CLOSE_HOUR(l.dow) };
}
function weekRange(dateStr) {
  const d = new Date(dateStr + "T12:00:00Z"); const dow = d.getUTCDay();
  const mon = new Date(d.getTime() - ((dow + 6) % 7) * 86400000);
  const from = localDayRange(mon.toISOString().slice(0, 10)).from;
  return { from, to: new Date(new Date(from).getTime() + 7 * 86400000).toISOString() };
}
async function staffStats(env, staffId, fromIso, toIso) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const shifts = (await q(`SELECT * FROM shifts WHERE staff_id = ? AND in_at >= ? AND in_at < ? ORDER BY in_at`, staffId, fromIso, toIso).all()).results;
  let minutes = 0, onTime = 0, openers = 0, expected = 0;
  for (const s of shifts) {
    minutes += s.minutes || (s.out_at ? 0 : Math.round((Date.now() - new Date(s.in_at)) / 60000));
    const li = local(new Date(s.in_at));
    if (li.minutes <= OPEN_HOUR * 60 + 60) { // an opening shift
      const first = await q(`SELECT MIN(in_at) m FROM shifts WHERE in_at >= ? AND in_at < ?`, localDayRange(li.date).from, localDayRange(li.date).to).first();
      if (first.m === s.in_at) { openers++; if (li.minutes <= OPEN_HOUR * 60 + ON_TIME_GRACE_MIN) onTime++; }
      expected += OPEN_STEPS.length;
    }
    if (s.out_at && local(new Date(s.out_at)).minutes >= CLOSE_HOUR(li.dow) * 60 - 90) expected += CLOSE_STEPS.length;
  }
  const ids = shifts.map((s) => s.id);
  const doneSteps = ids.length ? (await q(`SELECT COUNT(*) n FROM checklist WHERE shift_id IN (${ids.map(() => "?").join(",")})`, ...ids).first()).n : 0;
  const jobs = await q(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) amount, COALESCE(SUM(minutes),0) minutes FROM jobs WHERE done_by = ? AND done_at >= ? AND done_at < ?`, staffId, fromIso, toIso).first();
  const logged = await q(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) amount FROM jobs WHERE staff_id = ? AND created_at >= ? AND created_at < ? AND status != 'cancelled'`, staffId, fromIso, toIso).first();
  const orders = await q(`SELECT COUNT(*) n FROM staff_log WHERE staff_id = ? AND action = 'order_update' AND ts >= ? AND ts < ?`, staffId, fromIso, toIso).first();
  return { shifts: shifts.length, hours: +(minutes / 60).toFixed(1), on_time_opens: onTime, opens: openers, checklist_pct: expected ? Math.min(100, Math.round(doneSteps / expected * 100)) : null, jobs_done: jobs.n, jobs_done_minutes: jobs.minutes, jobs_done_amount_cents: jobs.amount, jobs_logged: logged.n, jobs_logged_amount_cents: logged.amount, order_updates: orders.n };
}
async function teamKpis(env, from, to) {
  const toIso = to ? new Date(to).toISOString() : new Date().toISOString();
  const fromIso = from ? new Date(from).toISOString() : new Date(Date.now() - 30 * 86400000).toISOString();
  const team = (await env.DB.prepare(`SELECT * FROM staff ORDER BY active DESC, role DESC, name`).all()).results;
  const rows = [];
  for (const p of team) rows.push({ ...pub(p), ...(await staffStats(env, p.id, fromIso, toIso)) });
  const agg = rows.reduce((a, r) => ({ shifts: a.shifts + r.shifts, hours: +(a.hours + r.hours).toFixed(1), on_time_opens: a.on_time_opens + r.on_time_opens, opens: a.opens + r.opens, jobs_done: a.jobs_done + r.jobs_done, jobs_done_amount_cents: a.jobs_done_amount_cents + r.jobs_done_amount_cents, jobs_logged_amount_cents: a.jobs_logged_amount_cents + r.jobs_logged_amount_cents }), { shifts: 0, hours: 0, on_time_opens: 0, opens: 0, jobs_done: 0, jobs_done_amount_cents: 0, jobs_logged_amount_cents: 0 });
  const recentLog = (await env.DB.prepare(`SELECT l.ts, l.action, l.detail, p.name FROM staff_log l LEFT JOIN staff p ON p.id = l.staff_id ORDER BY l.ts DESC LIMIT 60`).all()).results;
  const shiftsList = (await env.DB.prepare(`SELECT s.in_at, s.out_at, s.minutes, p.name FROM shifts s JOIN staff p ON p.id = s.staff_id WHERE s.in_at >= ? AND s.in_at < ? ORDER BY s.in_at DESC LIMIT 100`).bind(fromIso, toIso).all()).results;
  return { range: { from: fromIso, to: toIso }, team: rows, aggregate: agg, log: recentLog, shifts: shiftsList, open_steps: OPEN_STEPS.length, close_steps: CLOSE_STEPS.length };
}

// Staffing watchdog, runs on every cron tick. During open hours (10 AM to closing), if nobody is clocked in:
// first alert of the day texts the on-call employee and the owner; then the owner gets one reminder per hour until
// someone clocks in or the owner replies 2. Clocking in clears it.
async function noShowCheck(env) {
  const l = local();
  if (l.hour < OPEN_HOUR || l.hour >= CLOSE_HOUR(l.dow)) return { skipped: "outside open hours" };
  if (l.hour === OPEN_HOUR && l.minute < 10) return { skipped: "before 10:10, opener may still be walking in" };
  const day = localDayRange(l.date);
  const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM shifts WHERE in_at >= ? AND in_at < ? AND out_at IS NULL`).bind(day.from, day.to).first()).n;
  if (n > 0) { await env.DB.prepare(`DELETE FROM meta WHERE k = 'noshow_pending'`).run(); return { ok: true, clocked_in: n }; }
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'noshow_pending'`).first();
  let p = row ? JSON.parse(row.v) : null;
  if (p && p.date !== l.date) p = null;
  const hourLabel = new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
  if (!p) {
    const onCall = await env.DB.prepare(`SELECT * FROM staff WHERE active = 1 AND on_call = 1 AND phone != '' AND sms_consent_at IS NOT NULL ORDER BY role, name LIMIT 1`).first();
    let sentToOnCall = false;
    if (onCall && onCall.phone) sentToOnCall = (await sendSms(env, onCall.phone, `HD Laser: nobody has clocked in and the shop should be open. Are you on your way? Reply 1 for yes, 2 if you can't make it.`)).ok;
    p = { date: l.date, on_call_id: onCall ? onCall.id : null, on_call_name: onCall ? onCall.name : null, last_hour: l.hour, muted: false };
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('noshow_pending', ?)`).bind(JSON.stringify(p)).run();
    if (staffAlertsOn(env, "noshow")) await sendAlert(env, `No employee is clocked in at ${hourLabel}.${onCall ? ` I texted ${onCall.name} (on call)${sentToOnCall ? "" : ", but the text failed"} asking for confirmation.` : " No on-call employee is set."} Reply 1 to text everyone else on the team, 2 to stop today's reminders.`, { emailShop: true });
    return { ok: true, alerted: "first", on_call: onCall ? onCall.name : null };
  }
  if (p.muted || p.last_hour === l.hour) return { ok: true, already_alerted: true };
  p.last_hour = l.hour;
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('noshow_pending', ?)`).bind(JSON.stringify(p)).run();
  if (staffAlertsOn(env, "noshow")) await sendAlert(env, `Still nobody clocked in at ${hourLabel}. Reply 1 to text the team, 2 to stop today's reminders.`, { emailShop: true });
  return { ok: true, alerted: "reminder" };
}

// Twilio posts here when someone texts the shop's Twilio number. Owner replies 1/2 to the no-show alert; the on-call employee replies 1/2 too.
async function twilioInbound(request, env) {
  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw));
  if (env.TWILIO_AUTH_TOKEN) {
    const sig = request.headers.get("X-Twilio-Signature") || "";
    const url = env.WORKER_URL ? env.WORKER_URL.replace(/\/$/, "") + "/webhooks/twilio" : request.url;
    const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.TWILIO_AUTH_TOKEN), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    const expected = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)))));
    if (!timingSafeEqual(sig, expected)) return new Response("Bad signature", { status: 403 });
  }
  const from = e164(params.From || "") || params.From || "", body = String(params.Body || "").trim();
  const twiml = (msg) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${msg.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</Message>` : ""}</Response>`, { headers: { "Content-Type": "text/xml" } });
  const owners = String(env.ALERT_SMS_TO || "").split(",").map((s) => e164(s.trim())).filter(Boolean);
  const pending = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'noshow_pending'`).first();
  const p = pending ? JSON.parse(pending.v) : null;
  const staffRow = await env.DB.prepare(`SELECT * FROM staff WHERE active = 1 AND phone != ''`).all();
  const sender = staffRow.results.find((s) => e164(s.phone) === from);
  await staffLog(env, sender ? sender.id : null, "sms_in", `${from}: ${body.slice(0, 120)}`);

  if (owners.includes(from)) {
    if (!p) return twiml("HD Laser: nothing is waiting on a reply right now.");
    if (body === "1") {
      const others = staffRow.results.filter((s) => s.id !== p.on_call_id && !owners.includes(e164(s.phone)) && s.sms_consent_at);
      let n = 0; for (const s of others) if ((await sendSms(env, s.phone, `HD Laser: nobody has opened the shop yet. Can you come in? Reply 1 for yes.`)).ok) n++;
      return twiml(`Texted ${n} team member${n === 1 ? "" : "s"}. I'll tell you who replies.`);
    }
    if (body === "2") { p.muted = true; await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('noshow_pending', ?)`).bind(JSON.stringify(p)).run(); return twiml("OK, no more reminders today. I'll still tell you when someone clocks in."); }
    return twiml("Reply 1 to text the rest of the team, or 2 to ignore.");
  }
  if (sender) {
    if (body === "1") { await sendAlert(env, `${sender.name} replied: on the way.`, { emailShop: true }); return twiml(`Thanks ${sender.name.split(" ")[0]}, see you soon. Remember to clock in at hdlaser.net/staff.`); }
    if (body === "2") { await sendAlert(env, `${sender.name} replied: can't make it. Reply 1 to text the rest of the team.`, { emailShop: true }); return twiml("Got it, I've let the owner know."); }
    await sendAlert(env, `Text from ${sender.name}: ${body.slice(0, 200)}`, { emailShop: true });
    return twiml();
  }
  // Anyone else: forward to the owner, no auto-reply beyond Twilio's STOP/HELP handling.
  await sendAlert(env, `Text from ${from}: ${body.slice(0, 200)}`, { emailShop: true });
  return twiml();
}

async function sendSms(env, to, body) {
  const num = e164(to);
  if (!num || !env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM) return { ok: false, skipped: true };
  const auth = "Basic " + btoa(env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN);
  const form = new URLSearchParams({ To: num, From: e164(env.TWILIO_FROM) || env.TWILIO_FROM, Body: String(body).slice(0, 320) });
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, { method: "POST", headers: { "Authorization": auth, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (!r.ok) console.error("twilio", r.status, (await r.text()).slice(0, 300));
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ================================================================ Boards n' Beans coffee counter
// Order-ahead drinks sold through the same Square account. Prices live here so the site and the worker always agree.
// COFFEE_SMS_TO (optional env) overrides the number the bar is texted at when a drink is paid for.
const COFFEE = {
  shop: { name: "Boards n' Beans", tagline: "Where coffee and community coexist", city: "Pacific Beach, CA", smsTo: "8583493522", pickupMinutes: 10 },
  // price_cents: [12 oz, 16 oz]; a null 16 oz means one size only. iced: can be ordered iced. milk: takes a milk choice.
  menu: [
    { key: "drip",       name: "Drip coffee",         desc: "House roast, brewed fresh all morning.",                        price_cents: [325, 375], iced: true,  milk: false },
    { key: "coldbrew",   name: "Cold brew",           desc: "Steeped 18 hours. Smooth, strong, never bitter.",               price_cents: [475, 525], iced: true,  milk: false, alwaysIced: true },
    { key: "americano",  name: "Americano",           desc: "Double shot, hot water, nothing to hide behind.",               price_cents: [375, 425], iced: true,  milk: false },
    { key: "latte",      name: "Latte",               desc: "Double shot and steamed milk. Our most-ordered drink.",         price_cents: [500, 575], iced: true,  milk: true },
    { key: "cappuccino", name: "Cappuccino",          desc: "Equal parts espresso, milk, and foam. 12 oz only.",             price_cents: [475, null], iced: false, milk: true },
    { key: "mocha",      name: "Mocha",               desc: "Espresso, dark chocolate, steamed milk, a little whip.",        price_cents: [550, 625], iced: true,  milk: true },
    { key: "longboard",  name: "The Longboard",       desc: "Honey-cinnamon latte. The house signature since day one.",      price_cents: [575, 650], iced: true,  milk: true },
    { key: "dawnpatrol", name: "Dawn Patrol",         desc: "Cold brew with vanilla sweet cream. Built for 6 a.m. sessions.",price_cents: [550, 625], iced: true,  milk: false, alwaysIced: true },
    { key: "matcha",     name: "Matcha latte",        desc: "Ceremonial-grade matcha whisked into steamed milk.",            price_cents: [550, 625], iced: true,  milk: true },
    { key: "chai",       name: "Chai latte",          desc: "Spiced black tea concentrate and steamed milk.",                price_cents: [500, 575], iced: true,  milk: true },
    { key: "cocoa",      name: "Hot chocolate",       desc: "Dark chocolate and steamed milk. Kid-approved.",                price_cents: [425, 475], iced: false, milk: true },
  ],
  milks: [{ key: "whole", name: "Whole", add_cents: 0 }, { key: "nonfat", name: "Nonfat", add_cents: 0 }, { key: "oat", name: "Oat", add_cents: 75 }, { key: "almond", name: "Almond", add_cents: 75 }],
  extras: [{ key: "shot", name: "Extra shot", add_cents: 100 }, { key: "vanilla", name: "Vanilla", add_cents: 50 }, { key: "caramel", name: "Caramel", add_cents: 50 }, { key: "decaf", name: "Decaf", add_cents: 0 }],
  pickups: ["ASAP", "15 min", "30 min", "45 min", "1 hour"],
};
const COFFEE_ITEM = Object.fromEntries(COFFEE.menu.map((m) => [m.key, m]));

// Turns the browser's cart into priced, validated lines. Returns { error } or { lines, totalCents, summary }.
function coffeePrice(items) {
  if (!Array.isArray(items) || !items.length || items.length > 20) return { error: "Add at least one drink" };
  const lines = []; let total = 0;
  for (const it of items) {
    const m = COFFEE_ITEM[String(it.key)]; if (!m) return { error: "Unknown drink" };
    const size = String(it.size) === "16" ? "16" : "12";
    const base = m.price_cents[size === "16" ? 1 : 0]; if (base == null) return { error: `${m.name} comes in 12 oz only` };
    const qty = parseInt(it.qty, 10); if (!(qty >= 1 && qty <= 12)) return { error: "Bad quantity" };
    const iced = m.alwaysIced || (m.iced && !!it.iced);
    let unit = base; const mods = [];
    if (m.milk) { const milk = COFFEE.milks.find((x) => x.key === String(it.milk || "whole")); if (!milk) return { error: "Bad milk choice" }; unit += milk.add_cents; if (milk.key !== "whole") mods.push(milk.name.toLowerCase() + " milk"); }
    const extras = Array.isArray(it.extras) ? it.extras.slice(0, 4) : [];
    for (const e of extras) { const x = COFFEE.extras.find((y) => y.key === String(e)); if (!x) return { error: "Bad extra" }; unit += x.add_cents; mods.push(x.name.toLowerCase()); }
    const label = `${size} oz ${iced ? "iced " : ""}${m.name}${mods.length ? " (" + mods.join(", ") + ")" : ""}`;
    lines.push({ key: m.key, name: m.name, size, iced, milk: m.milk ? String(it.milk || "whole") : null, extras, qty, unit_cents: unit, label });
    total += unit * qty;
  }
  return { lines, totalCents: total, summary: lines.map((l) => `${l.qty} x ${l.label}`).join("; ") };
}

async function coffeeCheckout(request, env, cors) {
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (rateLimited(ip, 12)) return json({ error: "Too many orders from this connection. Try again in a few minutes." }, 429, cors);
  const priced = coffeePrice(b.items);
  if (priced.error) return json({ error: priced.error }, 400, cors);
  const name = String(b.name || "").trim().slice(0, 60); if (name.length < 2) return json({ error: "Tell us a name for the cup" }, 400, cors);
  const phone = String(b.phone || "").trim().slice(0, 40); if (!e164(phone)) return json({ error: "A mobile number we can text when it's ready" }, 400, cors);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 120); if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email doesn't look right" }, 400, cors);
  const pickup = COFFEE.pickups.includes(String(b.pickup)) ? String(b.pickup) : "ASAP";
  const note = String(b.note || "").trim().slice(0, 300);
  const textConsent = !!b.textConsent;
  const ref = "BB-" + Date.now().toString(36).toUpperCase().slice(-6) + randomHex(1).toUpperCase();
  const order = { location_id: env.SQUARE_LOCATION_ID, reference_id: ref, line_items: priced.lines.map((l) => ({ name: `${COFFEE.shop.name}: ${l.label}`, quantity: String(l.qty), base_price_money: { amount: l.unit_cents, currency: "USD" } })) };
  const payload = {
    idempotency_key: `${ref}-${Date.now()}`, order,
    checkout_options: { redirect_url: `${env.SITE_URL}/coffee/?paid=1&ref=${encodeURIComponent(ref)}`, ask_for_shipping_address: false, merchant_support_email: env.SUPPORT_EMAIL, allow_tipping: true },
    pre_populated_data: { buyer_email: email || undefined, buyer_phone_number: e164(phone) },
    payment_note: `${COFFEE.shop.name} order ${ref} for ${name}, pickup ${pickup}${note ? " | " + note : ""}`.slice(0, 500),
  };
  const res = await squareFetch(env, "/v2/online-checkout/payment-links", { method: "POST", body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  const linkOk = res.ok && data.payment_link;
  if (!linkOk) console.error("Square coffee error", res.status, JSON.stringify(data).slice(0, 600));
  if (env.DB) await env.DB.prepare(`INSERT INTO coffee_orders (ref, created_at, status, name, phone, email, items, summary, total_cents, pickup, note, text_consent, square_order_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(ref, new Date().toISOString(), linkOk ? "checkout_started" : "failed", name, phone, email || null, JSON.stringify(priced.lines), priced.summary, priced.totalCents, pickup, note, textConsent ? 1 : 0, linkOk ? (data.payment_link.order_id || null) : null).run();
  if (!linkOk) return json({ error: squareErr(data) || "Square did not return a checkout link" }, 502, cors);
  return json({ ok: true, url: data.payment_link.url, ref, total_cents: priced.totalCents, summary: priced.summary }, 200, cors);
}

// The customer's return page polls this until the payment webhook has marked the order paid.
async function coffeeStatus(env, ref, cors) {
  if (!env.DB || !/^BB-[A-Z0-9]{4,12}$/.test(String(ref || ""))) return json({ error: "Not found" }, 404, cors);
  let o = await env.DB.prepare(`SELECT ref, status, name, summary, total_cents, paid_cents, tip_cents, pickup, paid_at, ready_at, square_order_id, created_at FROM coffee_orders WHERE ref = ?`).bind(ref).first();
  if (!o) return json({ error: "Not found" }, 404, cors);
  // Still unpaid on our side while the customer is back from Square? Ask Square directly, so the bar's text does not wait for the webhook.
  if (o.status === "checkout_started" && o.square_order_id && Date.now() - Date.parse(o.created_at) < 3 * 3600000) {
    if (await coffeePullPayment(env, o.square_order_id)) o = await env.DB.prepare(`SELECT ref, status, name, summary, total_cents, paid_cents, tip_cents, pickup, paid_at, ready_at FROM coffee_orders WHERE ref = ?`).bind(ref).first();
  }
  return json({ ref: o.ref, status: o.status, name: (o.name || "").split(" ")[0], summary: o.summary, total_cents: o.total_cents, paid_cents: o.paid_cents, tip_cents: o.tip_cents, pickup: o.pickup, paid_at: o.paid_at, ready_at: o.ready_at, pickup_minutes: COFFEE.shop.pickupMinutes }, 200, { ...cors, "Cache-Control": "no-store" });
}

// Looks a Square order up and, if it has a completed payment, runs it through the normal payment path. Returns true when something was recorded.
async function coffeePullPayment(env, squareOrderId) {
  try {
    const r = await squareFetch(env, `/v2/orders/${encodeURIComponent(squareOrderId)}`);
    const d = await r.json().catch(() => ({}));
    const tenders = (d.order && d.order.tenders) || [];
    let did = false;
    for (const t of tenders) {
      if (!t.payment_id) continue;
      const pr = await squareFetch(env, `/v2/payments/${encodeURIComponent(t.payment_id)}`);
      const pd = await pr.json().catch(() => ({}));
      if (pd.payment && pd.payment.status === "COMPLETED") { await upsertPayment(env, pd.payment); did = true; }
    }
    return did;
  } catch (e) { console.error("coffee pull", e && e.message || e); return false; }
}

// Paid drink: text the bar, email the shop, confirm to the customer. Runs once per order.
async function notifyCoffee(env, ref) {
  const o = await env.DB.prepare(`SELECT * FROM coffee_orders WHERE ref = ? AND status IN ('paid','ready','picked_up') AND notified_at IS NULL`).bind(ref).first();
  if (!o) return { ok: false, skipped: true };
  await env.DB.prepare(`UPDATE coffee_orders SET notified_at = ? WHERE ref = ?`).bind(new Date().toISOString(), ref).run();
  const total = "$" + (o.paid_cents / 100).toFixed(2), tip = o.tip_cents ? ` (+$${(o.tip_cents / 100).toFixed(2)} tip)` : "";
  const when = o.pickup === "ASAP" ? "ASAP" : "in " + o.pickup;
  const barText = `${COFFEE.shop.name} order ${ref}: ${o.summary}. For ${o.name}, ${o.phone}. Pickup ${when}. Paid ${total}${tip}.${o.note ? " Note: " + o.note : ""}`;
  const jobs = [];
  const barNumbers = String(env.COFFEE_SMS_TO || COFFEE.shop.smsTo).split(",").map((x) => x.trim()).filter(e164);
  for (const n of barNumbers) jobs.push(sendSms(env, n, barText));
  if (env.SUPPORT_EMAIL) jobs.push(sendEmail(env, { to: env.SUPPORT_EMAIL, subject: `Coffee ${total}: ${o.name} (${ref})`, text: barText + `\n\nDashboard: ${env.WORKER_URL || ""}/admin` }));
  if (o.text_consent) jobs.push(sendSms(env, o.phone, `${COFFEE.shop.name}: got it, ${(o.name || "").split(" ")[0]}! ${o.summary}. Ready ${o.pickup === "ASAP" ? "in about " + COFFEE.shop.pickupMinutes + " min" : when} at the counter. Order ${ref}. Reply STOP to opt out.`));
  if (o.email) jobs.push(sendEmail(env, { to: o.email, subject: `Your ${COFFEE.shop.name} order ${ref}`, text: `Hi ${(o.name || "").split(" ")[0]},\n\nPaid ${total}${tip}. The bar has your order:\n${o.summary}\n\nPickup ${when} at the counter in Pacific Beach. Give them the name on the order.\n\n${COFFEE.shop.name}\n${COFFEE.shop.tagline}\n\nOrdered through hdlaser.net.` }));
  const results = await Promise.all(jobs);
  return { ok: results.some((r) => r && r.ok), sms: results[0] };
}

async function coffeeOrders(env) {
  const rows = (await env.DB.prepare(`SELECT ref, created_at, status, name, phone, summary, total_cents, paid_cents, tip_cents, pickup, note, paid_at, ready_at, picked_up_at, notified_at FROM coffee_orders ORDER BY created_at DESC LIMIT 60`).all()).results;
  const today = localDayRange(local().date);
  const t = await env.DB.prepare(`SELECT COUNT(*) n, COALESCE(SUM(paid_cents),0) c, COALESCE(SUM(tip_cents),0) tips FROM coffee_orders WHERE paid_at >= ? AND paid_at < ? AND status != 'refunded'`).bind(today.from, today.to).first();
  return { orders: rows, today: { orders: t.n, revenue_cents: t.c, tips_cents: t.tips }, sms_to: String(env.COFFEE_SMS_TO || COFFEE.shop.smsTo) };
}

async function coffeeUpdate(env, ref, body) {
  const action = String(body.action || "");
  const now = new Date().toISOString();
  if (action === "ready") await env.DB.prepare(`UPDATE coffee_orders SET status = 'ready', ready_at = COALESCE(ready_at, ?) WHERE ref = ? AND status IN ('paid','ready')`).bind(now, ref).run();
  else if (action === "picked_up") await env.DB.prepare(`UPDATE coffee_orders SET status = 'picked_up', picked_up_at = COALESCE(picked_up_at, ?) WHERE ref = ? AND status IN ('paid','ready','picked_up')`).bind(now, ref).run();
  else if (action === "resend") { await env.DB.prepare(`UPDATE coffee_orders SET notified_at = NULL WHERE ref = ?`).bind(ref).run(); return { ok: true, ...(await notifyCoffee(env, ref)) }; }
  else return { ok: false, error: "Unknown action" };
  return { ok: true };
}

// ================================================================ money: bank ledger, P&L, reconciliation, forecast
// Chart of accounts. group: income | cogs | opex | excluded (not part of EBITDA). target: rough share of net sales to aim under.
const CATEGORIES = [
  { key: "square_payout", name: "Square deposits", group: "income" },
  { key: "other_income", name: "Other income", group: "income" },
  { key: "blanks", name: "Cups, tumblers & blanks", group: "cogs", target: 0.22 },
  { key: "ink", name: "Ink & consumables", group: "cogs", target: 0.04 },
  { key: "packaging", name: "Packaging", group: "cogs", target: 0.02 },
  { key: "shipping_in", name: "Freight & shipping", group: "cogs", target: 0.02 },
  { key: "rent", name: "Rent", group: "opex", target: 0.12 },
  { key: "utilities", name: "Utilities", group: "opex", target: 0.02 },
  { key: "payroll", name: "Payroll", group: "opex", target: 0.25 },
  { key: "contractors", name: "Contractors", group: "opex", target: 0.03 },
  { key: "software", name: "Software & subscriptions", group: "opex", target: 0.02 },
  { key: "marketing", name: "Marketing", group: "opex", target: 0.05 },
  { key: "insurance", name: "Insurance", group: "opex", target: 0.02 },
  { key: "supplies", name: "Shop supplies", group: "opex", target: 0.03 },
  { key: "repairs", name: "Repairs & maintenance", group: "opex", target: 0.02 },
  { key: "vehicle", name: "Vehicle & delivery", group: "opex", target: 0.01 },
  { key: "professional", name: "Legal & accounting", group: "opex", target: 0.02 },
  { key: "bank_fees", name: "Bank & card fees", group: "opex", target: 0.01 },
  { key: "taxes_licenses", name: "Taxes & licenses", group: "opex", target: 0.02 },
  { key: "meals", name: "Meals", group: "opex", target: 0.01 },
  { key: "travel", name: "Travel", group: "opex", target: 0.01 },
  { key: "other_opex", name: "Other expenses", group: "opex", target: 0.03 },
  { key: "cash_deposit", name: "Cash deposit (already counted in Square)", group: "excluded" },
  { key: "transfer", name: "Transfer between accounts", group: "excluded" },
  { key: "owner_draw", name: "Owner draw / contribution", group: "excluded" },
  { key: "loan", name: "Loan principal", group: "excluded" },
  { key: "credit_card_payment", name: "Credit card payment", group: "excluded" },
  { key: "equipment", name: "Equipment purchase (capital)", group: "excluded" },
  { key: "personal", name: "Personal (not a business expense)", group: "excluded" },
  { key: "owner_paid", name: "Business expense paid personally (reimbursable)", group: "opex", target: 0.02 },
  { key: "uncategorized", name: "Uncategorized", group: "excluded" },
];
const CAT = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const DEFAULT_RULES = [
  ["SQUARE INC", "square_payout"], ["SQUARE ", "square_payout"], ["SQ *", "square_payout"],
  // card payments and statement credits seen on the card side (money in on a card is never income)
  ["MOBILE PAYMENT - THANK YOU", "credit_card_payment"], ["ELECTRONIC PAYMENT RECEIVED", "credit_card_payment"], ["AUTOMATIC PAYMENT - THANK", "credit_card_payment"], ["PAYMENT TO CHASE CARD", "credit_card_payment"],
  ["ORIG CO NAME:AMERICAN EXPRESS", "credit_card_payment"], ["ORIG CO NAME:CITI CARD", "credit_card_payment"], ["ORIG CO NAME:DISCOVER", "credit_card_payment"], ["ORIG CO NAME:CHASE CARD", "credit_card_payment"],
  ["POINTS FOR STATEMENT CREDIT", "other_income"], ["CASH REWARD", "other_income"], ["INTEREST CHARGE", "bank_fees"], ["RENEWAL MEMBERSHIP FEE", "bank_fees"], ["ANNUAL FEE", "bank_fees"], ["LATE FEE", "bank_fees"],
  // money movement
  ["ZELLE PAYMENT FROM", "other_income"], ["ATM CHECK DEPOSIT", "other_income"], ["MOBILE CHECK DEPOSIT", "other_income"], ["WITHDRAWAL", "owner_draw"], ["ATM WITHDRAWAL", "owner_draw"],
  // travel
  ["AIRLINES", "travel"], ["AIRWAYS", "travel"], ["AIR LINES", "travel"], ["AEROMEXICO", "travel"], ["VIVA AEROBUS", "travel"], ["TURKISH AIR", "travel"], ["SIXT", "travel"], ["AVIS", "travel"], ["BUDGET CAR", "travel"], ["BUDGET MERKEZ", "travel"], ["ALAMO RENT", "travel"], ["HERTZ", "travel"], ["ENTERPRISE RENT", "travel"], ["HOTEL", "travel"], ["MARRIOTT", "travel"], ["HILTON", "travel"], ["AIRBNB", "travel"], ["EXPEDIA", "travel"], ["PEMEX", "travel"], ["UBER", "travel"], ["LYFT", "travel"],
  // personal by nature: groceries, clothing, convenience, entertainment
  ["VONS", "personal"], ["GELSON", "personal"], ["TRADER JOE", "personal"], ["STATER BROS", "personal"], ["RALPHS", "personal"], ["SPROUTS", "personal"], ["WHOLE FOODS", "personal"], ["ALBERTSONS", "personal"], ["7-ELEVEN", "personal"],
  ["NORDSTROM", "personal"], ["MARSHALLS", "personal"], ["ZAPPOS", "personal"], ["TJ MAXX", "personal"], ["ROSS DRESS", "personal"], ["SEPHORA", "personal"], ["SMOKE SHOP", "personal"], ["DUOLINGO", "personal"], ["NETFLIX", "personal"], ["SPOTIFY", "personal"], ["HULU", "personal"], ["DISNEY PLUS", "personal"],
  // vehicle
  ["GM FINANCIAL", "vehicle"], ["JIFFY LUBE", "vehicle"], ["CAR WASH", "vehicle"], ["AAA MEMBERSHIP", "vehicle"], ["TOWING", "vehicle"], ["DEPARTMENT OF MOTOR", "vehicle"], ["AUTOZONE", "vehicle"], ["O'REILLY", "vehicle"], ["VALERO", "vehicle"], ["EXXON", "vehicle"], ["CIRCLE K", "vehicle"], ["SPEEDWAY", "vehicle"], ["LOVE'S", "vehicle"],
  // shop suppliers and tools
  ["MARCO AWARDS", "blanks"], ["STULLER", "blanks"], ["JPPLUS", "blanks"], ["LASERBITS", "blanks"], ["ANKERMAKE", "equipment"], ["CLICKLEASE", "other_opex"],
  ["APPLE.COM", "software"], ["APPLE", "software"], ["ORACLE", "software"], ["FIREVIBE", "software"], ["VECTORIZER", "software"], ["OPENAI", "software"], ["CHATGPT", "software"], ["CANVA", "software"], ["DROPBOX", "software"], ["ZOOM.US", "software"],
  ["SDG&E", "utilities"], ["SAN DIEGO GAS", "utilities"], ["COX COMM", "utilities"], ["SPECTRUM", "utilities"], ["AT&T", "utilities"], ["T-MOBILE", "utilities"], ["VERIZON", "utilities"],
  ["ADOBE", "software"], ["GOOGLE *", "software"], ["GOOGLE WORKSPACE", "software"], ["CLOUDFLARE", "software"], ["TWILIO", "software"], ["RESEND", "software"], ["FORMSPREE", "software"], ["GODADDY", "software"], ["INTUIT", "software"], ["QUICKBOOKS", "software"], ["CANVA", "software"], ["DROPBOX", "software"], ["MICROSOFT", "software"], ["OPENAI", "software"], ["ANTHROPIC", "software"], ["LIGHTBURN", "software"],
  ["ULINE", "packaging"], ["PAPER MART", "packaging"],
  ["UPS", "shipping_in"], ["FEDEX", "shipping_in"], ["USPS", "shipping_in"], ["DHL", "shipping_in"],
  ["GUSTO", "payroll"], ["ADP", "payroll"], ["PAYCHEX", "payroll"], ["SQUARE PAYROLL", "payroll"],
  ["STATE FARM", "insurance"], ["HARTFORD", "insurance"], ["NEXT INSURANCE", "insurance"], ["HISCOX", "insurance"], ["GEICO", "insurance"], ["PROGRESSIVE", "insurance"],
  ["FRANCHISE TAX", "taxes_licenses"], ["IRS ", "taxes_licenses"], ["CDTFA", "taxes_licenses"], ["CITY OF SAN DIEGO", "taxes_licenses"], ["EDD ", "taxes_licenses"],
  ["FACEBK", "marketing"], ["META PLATFORMS", "marketing"], ["GOOGLE ADS", "marketing"], ["YELP", "marketing"], ["NEXTDOOR", "marketing"], ["VISTAPRINT", "marketing"],
  ["ONLINE TRANSFER", "transfer"], ["TRANSFER TO", "transfer"], ["TRANSFER FROM", "transfer"], ["ZELLE", "transfer"], ["VENMO", "transfer"],
  ["PAYMENT THANK YOU", "credit_card_payment"], ["AUTOPAY", "credit_card_payment"], ["CHASE CARD", "credit_card_payment"], ["AMEX EPAYMENT", "credit_card_payment"], ["CAPITAL ONE", "credit_card_payment"],
  ["COSTCO", "supplies"], ["HOME DEPOT", "supplies"], ["LOWES", "supplies"], ["HARBOR FREIGHT", "supplies"], ["MCMASTER", "supplies"], ["AMAZON", "supplies"], ["AMZN", "supplies"], ["STAPLES", "supplies"], ["OFFICE DEPOT", "supplies"],
  ["JDS INDUSTRIES", "blanks"], ["JDS ", "blanks"], ["ROWMARK", "blanks"], ["JOHNSON PLASTICS", "blanks"], ["YETI", "blanks"], ["POLAR CAMEL", "blanks"], ["ALIBABA", "blanks"], ["ALIEXPRESS", "blanks"], ["DHGATE", "blanks"], ["LASERBITS", "blanks"], ["INVENTABLES", "blanks"],
  ["ROLAND", "ink"], ["MIMAKI", "ink"], ["EPSON", "ink"], ["INKJET", "ink"], ["MUTOH", "ink"],
  ["CASH DEPOSIT", "cash_deposit"], ["ATM DEPOSIT", "cash_deposit"],
  ["MONTHLY SERVICE FEE", "bank_fees"], ["WIRE FEE", "bank_fees"], ["OVERDRAFT", "bank_fees"],
  ["LEGALZOOM", "professional"], ["CPA", "professional"], ["H&R BLOCK", "professional"],
  ["SHELL", "vehicle"], ["CHEVRON", "vehicle"], ["ARCO", "vehicle"], ["76 ", "vehicle"], ["MOBIL", "vehicle"],
  ["STARBUCKS", "meals"], ["DOORDASH", "meals"], ["UBER EATS", "meals"],
  // generic words, matched last because shorter patterns sort after longer ones
  ["PROPERTY MGMT", "rent"], ["PROPERTY MANAGEMENT", "rent"], [" RENT", "rent"], ["PAYROLL", "payroll"], ["INSURANCE", "insurance"], ["TAX PMT", "taxes_licenses"], ["INTEREST", "other_income"], ["DEPOSIT", "other_income"],
];
const DEFAULT_SETTINGS = {
  cash_balance_cents: 0, cash_as_of: null, reserve_months: 1, pay_period_days: 14, pay_period_anchor: "2026-09-14",
  monthly_fixed_costs_cents: 0, // fallback when no bank data yet
  unit: { cup12_blank: 450, cup16_blank: 525, ink12: 35, ink16: 45, engrave_consumable: 8, packaging: 30, labor_rate_hour: 2200, minutes_engraved: 2.5, minutes_printed: 3 },
};
async function finSettings(env) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'fin_settings'`).first();
  const s = row ? JSON.parse(row.v) : {};
  return { ...DEFAULT_SETTINGS, ...s, unit: { ...DEFAULT_SETTINGS.unit, ...(s.unit || {}) } };
}
async function saveFinSettings(env, patch) {
  const cur = await finSettings(env);
  const next = { ...cur, ...patch, unit: { ...cur.unit, ...(patch.unit || {}) } };
  for (const k of Object.keys(next.unit)) next.unit[k] = +next.unit[k] || 0;
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('fin_settings', ?)`).bind(JSON.stringify(next)).run();
  return next;
}
async function sha256hex(s) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join(""); }
function parseAmount(v) { if (v == null) return NaN; const s = String(v).replace(/[$,\s]/g, ""); if (!s) return NaN; const neg = /^\(.*\)$/.test(s) || s.startsWith("-"); const n = parseFloat(s.replace(/[()\-+]/g, "")); return isNaN(n) ? NaN : (neg ? -n : n); }
function parseDate(v) {
  const s = String(v || "").trim(); let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) { const y = m[3].length === 2 ? "20" + m[3] : m[3]; return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
async function rulesFor(env) {
  const rows = (await env.DB.prepare(`SELECT id, pattern, category, vendor FROM bank_rules ORDER BY length(pattern) DESC`).all()).results;
  return rows.map((r) => ({ ...r, up: r.pattern.toUpperCase() })).concat(DEFAULT_RULES.map(([p, c]) => ({ id: 0, pattern: p, category: c, vendor: null, up: p.toUpperCase() })).sort((a, b) => b.up.length - a.up.length));
}
function applyRules(rules, desc) { const u = String(desc || "").toUpperCase(); for (const r of rules) if (u.includes(r.up)) return r; return null; }

// Bank CSV rows come already split by the dashboard: [{date, description, amount, balance?}]
async function importBank(env, body) {
  const source = String(body.source || "bank").slice(0, 40);
  const rows = Array.isArray(body.rows) ? body.rows.slice(0, 5000) : [];
  const rules = await rulesFor(env);
  let added = 0, dupes = 0, bad = 0, lastBal = null, lastDate = null;
  const now = new Date().toISOString();
  for (const r of rows) {
    const date = parseDate(r.date); let amt = parseAmount(r.amount);
    if (isNaN(amt) && (r.debit != null || r.credit != null)) { const d = parseAmount(r.debit), c = parseAmount(r.credit); amt = (isNaN(c) ? 0 : Math.abs(c)) - (isNaN(d) ? 0 : Math.abs(d)); }
    const desc = String(r.description || "").trim().slice(0, 200);
    if (!date || isNaN(amt) || !desc) { bad++; continue; }
    const cents = Math.round(amt * 100);
    const hash = await sha256hex(`${source}|${date}|${desc}|${cents}`);
    const rule = applyRules(rules, desc);
    const bal = r.balance != null && r.balance !== "" ? Math.round(parseAmount(r.balance) * 100) : null;
    const res = await env.DB.prepare(`INSERT OR IGNORE INTO bank_txns (hash, source, posted_at, amount_cents, description, category, vendor, balance_cents, imported_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(hash, source, date, cents, desc, rule ? rule.category : "uncategorized", rule && rule.vendor || null, isNaN(bal) ? null : bal, now).run();
    if (res.meta && res.meta.changes) added++; else dupes++;
    if (bal != null && !isNaN(bal) && (!lastDate || date >= lastDate)) { lastDate = date; lastBal = bal; }
  }
  if (lastBal != null) await saveFinSettings(env, { cash_balance_cents: lastBal, cash_as_of: lastDate });
  await reconcile(env);
  return { ok: true, added, duplicates: dupes, skipped: bad, balance_cents: lastBal, balance_as_of: lastDate };
}
async function categorize(env, id, body) {
  const cat = CAT[body.category] ? body.category : null;
  if (!cat) return { ok: false, error: "Unknown category" };
  const t = await env.DB.prepare(`SELECT * FROM bank_txns WHERE id = ?`).bind(id).first();
  if (!t) return { ok: false, error: "Not found" };
  await env.DB.prepare(`UPDATE bank_txns SET category = ?, vendor = COALESCE(?, vendor), memo = COALESCE(?, memo) WHERE id = ?`).bind(cat, body.vendor ? String(body.vendor).slice(0, 80) : null, body.memo != null ? String(body.memo).slice(0, 300) : null, id).run();
  let applied = 0;
  if (body.make_rule) {
    const pattern = String(body.pattern || t.description.replace(/\d{3,}/g, " ").split(/\s+/).slice(0, 2).join(" ")).trim().slice(0, 60);
    if (pattern.length >= 3) {
      await env.DB.prepare(`INSERT INTO bank_rules (pattern, category, vendor, created_at) VALUES (?,?,?,?)`).bind(pattern, cat, body.vendor || null, new Date().toISOString()).run();
      const r = await env.DB.prepare(`UPDATE bank_txns SET category = ? WHERE category = 'uncategorized' AND upper(description) LIKE ?`).bind(cat, "%" + pattern.toUpperCase() + "%").run();
      applied = r.meta ? r.meta.changes : 0;
    }
  }
  return { ok: true, applied };
}

// Square payouts (money Square sent to the bank). Matched against bank deposits within 5 days.
async function upsertPayout(env, p) {
  await env.DB.prepare(`INSERT INTO payouts (payout_id, created_at, arrival_date, status, amount_cents, location_id, type) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(payout_id) DO UPDATE SET status = excluded.status, amount_cents = excluded.amount_cents, arrival_date = excluded.arrival_date`)
    .bind(p.id, p.created_at || null, p.arrival_date || (p.end_time ? String(p.end_time).slice(0, 10) : null), p.status || null, money(p.amount_money), p.location_id || null, p.type || null).run();
}
async function reconcile(env) {
  const payouts = (await env.DB.prepare(`SELECT * FROM payouts WHERE matched_txn_id IS NULL AND status IN ('PAID','SENT') AND amount_cents > 0`).all()).results;
  let matched = 0;
  for (const p of payouts) {
    const day = (p.arrival_date || p.created_at || "").slice(0, 10); if (!day) continue;
    const lo = new Date(new Date(day).getTime() - 2 * 86400000).toISOString().slice(0, 10), hi = new Date(new Date(day).getTime() + 6 * 86400000).toISOString().slice(0, 10);
    const t = await env.DB.prepare(`SELECT id FROM bank_txns WHERE matched_payout_id IS NULL AND amount_cents = ? AND posted_at BETWEEN ? AND ? AND category IN ('square_payout','uncategorized') ORDER BY posted_at LIMIT 1`).bind(p.amount_cents, lo, hi).first();
    if (t) { await env.DB.batch([env.DB.prepare(`UPDATE payouts SET matched_txn_id = ? WHERE payout_id = ?`).bind(t.id, p.payout_id), env.DB.prepare(`UPDATE bank_txns SET matched_payout_id = ?, category = 'square_payout' WHERE id = ?`).bind(p.payout_id, t.id)]); matched++; }
  }
  return { matched };
}

function monthKey(iso) { return String(iso || "").slice(0, 7); }
function monthsBetween(fromIso, toIso) { const out = []; let d = new Date(fromIso.slice(0, 7) + "-01T00:00:00Z"); const end = new Date(toIso); while (d <= end) { out.push(d.toISOString().slice(0, 7)); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)); } return out; }

// Everything the money page needs.
// This year against last year, month by month, from two angles: Square net sales (what was sold) and money that reached
// the bank (Square deposits plus Zelle/check income). Projection: this year's year-to-date scaled by the share of last
// year that had arrived by the same point, so a heavy fourth quarter is respected. Falls back to a straight run-rate.
async function yearOverYear(env) {
  const now = new Date(); const y = now.getUTCFullYear(), py = y - 1, mNow = now.getUTCMonth() + 1;
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const rows = {};
  const put = (m, k, v) => { if (!m) return; rows[m] = rows[m] || { month: m, square_net_cents: 0, deposits_cents: 0, other_income_cents: 0 }; rows[m][k] += v || 0; };
  for (const r of (await q(`SELECT substr(created_at,1,7) m, SUM(amount_cents - fee_cents - refunded_cents) net FROM payments WHERE status='COMPLETED' AND created_at >= ? GROUP BY m`, `${py}-01-01`).all()).results) put(r.m, "square_net_cents", r.net);
  for (const r of (await q(`SELECT substr(posted_at,1,7) m, SUM(CASE WHEN category='square_payout' AND amount_cents > 0 THEN amount_cents ELSE 0 END) dep, SUM(CASE WHEN category='other_income' AND amount_cents > 0 THEN amount_cents ELSE 0 END) oth FROM bank_txns WHERE posted_at >= ? GROUP BY m`, `${py}-01-01`).all()).results) { put(r.m, "deposits_cents", r.dep); put(r.m, "other_income_cents", r.oth); }
  const months = []; for (let i = 1; i <= 12; i++) { const mm = String(i).padStart(2, "0"); const a = rows[`${py}-${mm}`] || {}, b = rows[`${y}-${mm}`] || {}; months.push({ month: mm, last: { square_net_cents: a.square_net_cents || 0, deposits_cents: a.deposits_cents || 0, other_income_cents: a.other_income_cents || 0 }, this: { square_net_cents: b.square_net_cents || 0, deposits_cents: b.deposits_cents || 0, other_income_cents: b.other_income_cents || 0 } }); }
  const sum = (arr, side, k, upto) => arr.filter((x) => +x.month <= upto).reduce((t, x) => t + x[side][k], 0);
  const out = { year: y, prev_year: py, through_month: mNow, months, metrics: {} };
  for (const k of ["square_net_cents", "deposits_cents"]) {
    const lastYtd = sum(months, "last", k, mNow), thisYtd = sum(months, "this", k, mNow), lastFull = sum(months, "last", k, 12);
    const growth = lastYtd ? Math.round((thisYtd - lastYtd) / lastYtd * 100) : null;
    const share = lastFull ? lastYtd / lastFull : 0;
    const proj = share > 0.2 && share < 1 ? Math.round(thisYtd / share) : Math.round(thisYtd / Math.max(1, mNow) * 12);
    const runRate = Math.round(thisYtd / Math.max(1, mNow) * 12);
    out.metrics[k] = { last_ytd: lastYtd, this_ytd: thisYtd, last_full: lastFull, growth_pct: growth, projected_full: proj, run_rate_full: runRate, method: share > 0.2 && share < 1 ? "seasonal" : "run_rate", last_q4_share_pct: lastFull ? Math.round(sum(months, "last", k, 12) - sum(months, "last", k, 9)) / lastFull * 100 : null };
    if (out.metrics[k].last_q4_share_pct != null) out.metrics[k].last_q4_share_pct = Math.round(out.metrics[k].last_q4_share_pct);
  }
  return out;
}

// Everything needed to judge the business over two years, month by month: what was sold, what reached the bank, what it
// cost, what was left, how many tickets and the average ticket, plus spend by category and by vendor for the last 12 months
// against the 12 before. Categories in the 'excluded' group (transfers, personal, owner draws) never enter these numbers.
async function trends(env) {
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b);
  const now = new Date(); const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 23, 1)).toISOString().slice(0, 10);
  const months = monthsBetween(start, now.toISOString());
  const byM = Object.fromEntries(months.map((m) => [m, { month: m, square_net_cents: 0, payments: 0, avg_ticket_cents: 0, deposits_cents: 0, other_income_cents: 0, cogs_cents: 0, opex_cents: 0, ebitda_cents: 0, margin_pct: null, personal_cents: 0, owner_draw_cents: 0, uncategorized_cents: 0 }]));
  for (const r of (await q(`SELECT substr(created_at,1,7) m, COUNT(*) n, SUM(amount_cents - fee_cents - refunded_cents) net FROM payments WHERE status='COMPLETED' AND created_at >= ? GROUP BY m`, start).all()).results) if (byM[r.m]) { byM[r.m].square_net_cents = r.net || 0; byM[r.m].payments = r.n; byM[r.m].avg_ticket_cents = r.n ? Math.round((r.net || 0) / r.n) : 0; }
  const cats = (await q(`SELECT substr(posted_at,1,7) m, category, SUM(amount_cents) c FROM bank_txns WHERE posted_at >= ? GROUP BY m, category`, start).all()).results;
  for (const r of cats) { const row = byM[r.m]; if (!row) continue; const g = CAT[r.category] ? CAT[r.category].group : "excluded";
    if (r.category === "square_payout") row.deposits_cents += Math.max(0, r.c);
    else if (r.category === "other_income") row.other_income_cents += Math.max(0, r.c);
    else if (g === "cogs") row.cogs_cents += r.c; else if (g === "opex") row.opex_cents += r.c;
    else if (r.category === "personal") row.personal_cents += r.c; else if (r.category === "owner_draw") row.owner_draw_cents += r.c; else if (r.category === "uncategorized") row.uncategorized_cents += r.c; }
  for (const row of Object.values(byM)) { const rev = row.square_net_cents + row.other_income_cents; row.ebitda_cents = rev + row.cogs_cents + row.opex_cents; row.margin_pct = rev ? Math.round(row.ebitda_cents / rev * 100) : null; }
  // last 12 months vs the 12 before, by category and by vendor
  const cut12 = months[Math.max(0, months.length - 12)] + "-01", cut24 = start;
  const catRows = (await q(`SELECT category, SUM(CASE WHEN posted_at >= ? THEN amount_cents ELSE 0 END) recent, SUM(CASE WHEN posted_at < ? THEN amount_cents ELSE 0 END) prior, COUNT(*) n FROM bank_txns WHERE posted_at >= ? GROUP BY category`, cut12, cut12, cut24).all()).results;
  const revRecent = Object.values(byM).filter((r) => r.month + "-01" >= cut12).reduce((t, r) => t + r.square_net_cents + r.other_income_cents, 0);
  const categories = catRows.map((r) => ({ key: r.category, name: CAT[r.category] ? CAT[r.category].name : r.category, group: CAT[r.category] ? CAT[r.category].group : "excluded", recent_cents: r.recent, prior_cents: r.prior, change_pct: r.prior ? Math.round((r.recent - r.prior) / Math.abs(r.prior) * 100) : null, share_of_sales_pct: revRecent && r.recent < 0 ? Math.round(-r.recent / revRecent * 1000) / 10 : null, target_pct: CAT[r.category] && CAT[r.category].target ? Math.round(CAT[r.category].target * 1000) / 10 : null, rows: r.n })).sort((a, b) => a.recent_cents - b.recent_cents);
  const vendors = (await q(`SELECT COALESCE(NULLIF(vendor,''), description) k, category, COUNT(*) n, SUM(amount_cents) c FROM bank_txns WHERE posted_at >= ? AND amount_cents < 0 AND category NOT IN ('personal','transfer','credit_card_payment','owner_draw','loan','cash_deposit') GROUP BY k, category ORDER BY c ASC LIMIT 40`, cut12).all()).results.map((r) => ({ vendor: r.k, category: r.category, category_name: CAT[r.category] ? CAT[r.category].name : r.category, rows: r.n, total_cents: r.c, share_of_sales_pct: revRecent ? Math.round(-r.c / revRecent * 1000) / 10 : null }));
  const items = (await q(`SELECT name k, SUM(qty) qty, SUM(gross_cents) c, COUNT(DISTINCT order_id) orders FROM square_items WHERE created_at >= ? GROUP BY name ORDER BY c DESC LIMIT 25`, cut12).all()).results;
  const customers = (await q(`SELECT COALESCE(NULLIF(business,''), name, email) k, COUNT(*) orders, SUM(paid_cents) paid FROM orders WHERE status IN ('paid','refunded') AND paid_at >= ? GROUP BY k ORDER BY paid DESC LIMIT 15`, cut12).all()).results;
  return { start, months: Object.values(byM), recent_from: cut12, revenue_recent_cents: revRecent, categories, vendors, items, customers };
}
function trendsCsv(t) {
  const h = ["month", "square_net_sales", "payments", "avg_ticket", "bank_deposits", "other_income", "cogs", "opex", "ebitda", "margin_pct", "personal", "owner_draws", "uncategorized"];
  const money = (c) => (c / 100).toFixed(2);
  const lines = [h.join(",")].concat(t.months.map((m) => [m.month, money(m.square_net_cents), m.payments, money(m.avg_ticket_cents), money(m.deposits_cents), money(m.other_income_cents), money(m.cogs_cents), money(m.opex_cents), money(m.ebitda_cents), m.margin_pct == null ? "" : m.margin_pct, money(m.personal_cents), money(m.owner_draw_cents), money(m.uncategorized_cents)].join(",")));
  return new Response(lines.join("\n"), { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=hdlaser-trends.csv" } });
}

async function moneyReport(env, fromIn, toIn, whatIf = {}) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const toIso = toIn ? new Date(toIn).toISOString() : new Date().toISOString();
  const fromIso = fromIn ? new Date(fromIn).toISOString() : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 5, 1)).toISOString();
  const months = monthsBetween(fromIso, toIso);
  const settings = await finSettings(env);
  const fromDay = fromIso.slice(0, 10), toDay = toIso.slice(0, 10);

  // Square side per month
  const sq = {}; for (const m of months) sq[m] = { gross: 0, fees: 0, refunds: 0, payments: 0, cash: 0, web: 0 };
  for (const r of (await q(`SELECT substr(created_at,1,7) m, COUNT(*) n, SUM(amount_cents) gross, SUM(fee_cents) fees, SUM(CASE WHEN source='CASH' THEN amount_cents ELSE 0 END) cash, SUM(CASE WHEN ref IS NOT NULL THEN amount_cents ELSE 0 END) web FROM payments WHERE status='COMPLETED' AND created_at >= ? AND created_at < ? GROUP BY m`, fromIso, toIso).all()).results) if (sq[r.m]) Object.assign(sq[r.m], { gross: r.gross, fees: r.fees, payments: r.n, cash: r.cash, web: r.web });
  for (const r of (await q(`SELECT substr(created_at,1,7) m, SUM(amount_cents) refunds FROM refunds WHERE status='COMPLETED' AND created_at >= ? AND created_at < ? GROUP BY m`, fromIso, toIso).all()).results) if (sq[r.m]) sq[r.m].refunds = r.refunds;
  // Bank side per month per category
  const bank = {}; for (const m of months) bank[m] = {};
  for (const r of (await q(`SELECT substr(posted_at,1,7) m, category, SUM(amount_cents) amt, COUNT(*) n FROM bank_txns WHERE posted_at >= ? AND posted_at <= ? GROUP BY m, category`, fromDay, toDay).all()).results) if (bank[r.m]) bank[r.m][r.category] = { amount_cents: r.amt, n: r.n };
  const bankRows = (await q(`SELECT COUNT(*) n, MIN(posted_at) first, MAX(posted_at) last FROM bank_txns`).first());
  const hasBank = bankRows.n > 0;

  const pnl = months.map((m) => {
    const s = sq[m], b = bank[m];
    const cat = (k) => Math.abs((b[k] && b[k].amount_cents) || 0);
    const grp = (g) => CATEGORIES.filter((c) => c.group === g).reduce((n, c) => n + cat(c.key), 0);
    const net = s.gross - s.refunds - s.fees;
    const cogs = grp("cogs"), opex = grp("opex");
    const ebitda = net - cogs - opex;
    const bankIncome = (b.square_payout && b.square_payout.amount_cents || 0) + (b.other_income && b.other_income.amount_cents || 0);
    return { month: m, gross_cents: s.gross, refunds_cents: s.refunds, square_fees_cents: s.fees, net_sales_cents: net, web_cents: s.web, cash_cents: s.cash, payments: s.payments,
      cogs_cents: cogs, opex_cents: opex, ebitda_cents: ebitda, ebitda_pct: net ? +((ebitda / net) * 100).toFixed(1) : null, gross_margin_pct: net ? +(((net - cogs) / net) * 100).toFixed(1) : null,
      bank_income_cents: bankIncome, bank_vs_square_cents: bankIncome - net, uncategorized_cents: cat("uncategorized"), excluded_cents: grp("excluded") - cat("uncategorized"),
      categories: Object.fromEntries(CATEGORIES.map((c) => [c.key, cat(c.key)])) };
  });
  const tot = pnl.reduce((a, r) => { for (const k of ["gross_cents", "refunds_cents", "square_fees_cents", "net_sales_cents", "cogs_cents", "opex_cents", "ebitda_cents", "web_cents", "cash_cents", "bank_income_cents", "uncategorized_cents"]) a[k] = (a[k] || 0) + r[k]; return a; }, {});
  tot.ebitda_pct = tot.net_sales_cents ? +((tot.ebitda_cents / tot.net_sales_cents) * 100).toFixed(1) : null;
  tot.categories = Object.fromEntries(CATEGORIES.map((c) => [c.key, pnl.reduce((n, r) => n + r.categories[c.key], 0)]));
  const catRows = CATEGORIES.map((c) => ({ ...c, total_cents: tot.categories[c.key], pct_of_net: tot.net_sales_cents ? +((tot.categories[c.key] / tot.net_sales_cents) * 100).toFixed(1) : null, status: c.target == null || !tot.net_sales_cents ? null : (tot.categories[c.key] / tot.net_sales_cents <= c.target ? "good" : tot.categories[c.key] / tot.net_sales_cents <= c.target * 1.3 ? "warn" : "over") }));

  // Reconciliation
  const unmatchedPayouts = (await q(`SELECT payout_id, created_at, arrival_date, amount_cents, status FROM payouts WHERE matched_txn_id IS NULL AND status IN ('PAID','SENT') AND created_at >= ? ORDER BY created_at DESC LIMIT 50`, fromIso).all()).results;
  const unmatchedDeposits = hasBank ? (await q(`SELECT id, posted_at, amount_cents, description FROM bank_txns WHERE category = 'square_payout' AND matched_payout_id IS NULL AND posted_at >= ? ORDER BY posted_at DESC LIMIT 50`, fromDay).all()).results : [];
  const payoutTotals = await q(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) amt, SUM(CASE WHEN matched_txn_id IS NOT NULL THEN 1 ELSE 0 END) matched FROM payouts WHERE status IN ('PAID','SENT') AND created_at >= ? AND created_at < ?`, fromIso, toIso).first();
  const cashDeposits = hasBank ? Math.abs((await q(`SELECT COALESCE(SUM(amount_cents),0) a FROM bank_txns WHERE category = 'cash_deposit' AND posted_at >= ? AND posted_at <= ?`, fromDay, toDay).first()).a) : 0;
  const uncategorized = hasBank ? (await q(`SELECT id, posted_at, amount_cents, description FROM bank_txns WHERE category = 'uncategorized' ORDER BY posted_at DESC LIMIT 200`).all()).results : [];
  const unpaid = (await q(`SELECT COUNT(*) n, COALESCE(SUM(total_cents),0) amt FROM orders WHERE status IN ('pay_later','checkout_started') AND created_at >= ?`, new Date(Date.now() - 60 * 86400000).toISOString()).first());
  const lastPayout = await q(`SELECT MAX(created_at) t FROM payouts`).first();
  const inTransit = await q(`SELECT COALESCE(SUM(amount_cents - fee_cents - refunded_cents),0) a FROM payments WHERE status='COMPLETED' AND source != 'CASH' AND created_at > ?`, lastPayout.t || new Date(Date.now() - 3 * 86400000).toISOString()).first();

  // Unit economics for cups (modeled, from settings)
  const u = settings.unit; const lab = (min) => Math.round(u.labor_rate_hour * min / 60);
  const unitRows = [
    { product: "12 oz engraved", price_cents: 1500, cost_cents: u.cup12_blank + u.engrave_consumable + u.packaging + lab(u.minutes_engraved) },
    { product: "12 oz printed", price_cents: 1700, cost_cents: u.cup12_blank + u.ink12 + u.packaging + lab(u.minutes_printed) },
    { product: "16 oz engraved", price_cents: 1700, cost_cents: u.cup16_blank + u.engrave_consumable + u.packaging + lab(u.minutes_engraved) },
    { product: "16 oz printed", price_cents: 1900, cost_cents: u.cup16_blank + u.ink16 + u.packaging + lab(u.minutes_printed) },
  ].map((r) => ({ ...r, margin_cents: r.price_cents - r.cost_cents, margin_pct: +(((r.price_cents - r.cost_cents) / r.price_cents) * 100).toFixed(1) }));
  const cupsSold = (await q(`SELECT l.size, l.finish, SUM(l.qty) qty, SUM(l.qty*l.unit_cents) rev FROM order_lines l JOIN orders o ON o.ref = l.ref WHERE o.status IN ('paid','refunded') AND o.paid_at >= ? AND o.paid_at < ? GROUP BY l.size, l.finish`, fromIso, toIso).all()).results;
  let modeledCogs = 0; for (const r of cupsSold) { const key = (r.size === "16" ? "16 oz " : "12 oz ") + (r.finish === "printed" ? "printed" : "engraved"); const ur = unitRows.find((x) => x.product === key); if (ur) modeledCogs += ur.cost_cents * r.qty; }

  // Forecast: 13 weeks of cash
  const wk = 7 * 86400000; const now = Date.now();
  const w8 = new Date(now - 8 * wk).toISOString();
  const inflow8 = (await q(`SELECT COALESCE(SUM(amount_cents - fee_cents - refunded_cents),0) a FROM payments WHERE status='COMPLETED' AND created_at >= ?`, w8).first()).a;
  const bankOut8 = hasBank ? Math.abs((await q(`SELECT COALESCE(SUM(amount_cents),0) a FROM bank_txns WHERE amount_cents < 0 AND posted_at >= ? AND category NOT IN ('transfer','owner_draw','credit_card_payment','loan','equipment','cash_deposit')`, w8.slice(0, 10)).first()).a) : 0;
  const bankWeeks = hasBank ? Math.max(1, Math.min(8, (now - new Date(bankRows.first).getTime()) / wk)) : 8;
  const weeklyIn = inflow8 / 8;
  const payrollWeekly = await payrollWeeklyEstimate(env);
  const weeklyOut = hasBank ? bankOut8 / bankWeeks : (settings.monthly_fixed_costs_cents / 4.33) + payrollWeekly;
  const hireW = (+whatIf.hire_monthly_cents || 0) / 4.33, growthW = (+whatIf.growth_monthly_cents || 0) / 4.33, restock = +whatIf.restock_cents || 0, salesPct = +whatIf.sales_change_pct || 0;
  const start = settings.cash_balance_cents + (inTransit.a || 0);
  const series = []; let cash = start, minCash = start, minWeek = 0;
  for (let i = 1; i <= 13; i++) {
    const inflow = weeklyIn * (1 + salesPct / 100), outflow = weeklyOut + hireW + growthW + (i === 1 ? restock : 0);
    cash += inflow - outflow; series.push({ week: i, cash_cents: Math.round(cash), in_cents: Math.round(inflow), out_cents: Math.round(outflow) });
    if (cash < minCash) { minCash = cash; minWeek = i; }
  }
  const reserve = Math.round(weeklyOut * 4.33 * settings.reserve_months);
  const burn = weeklyOut + hireW + growthW - weeklyIn * (1 + salesPct / 100);
  const forecast = { start_cash_cents: start, cash_balance_cents: settings.cash_balance_cents, cash_as_of: settings.cash_as_of, in_transit_cents: inTransit.a || 0, receivable_cents: unpaid.amt, receivable_n: unpaid.n,
    weekly_in_cents: Math.round(weeklyIn), weekly_out_cents: Math.round(weeklyOut), payroll_weekly_cents: Math.round(payrollWeekly), basis: hasBank ? `bank, ${bankWeeks.toFixed(1)} weeks of data` : "fixed-cost setting", weeks_of_data: +bankWeeks.toFixed(1),
    reserve_cents: reserve, min_cash_cents: Math.round(minCash), min_cash_week: minWeek, safe_to_spend_cents: Math.round(minCash - reserve), runway_weeks: burn > 0 ? Math.max(0, Math.floor(start / burn)) : null, series, what_if: { hire_monthly_cents: +whatIf.hire_monthly_cents || 0, growth_monthly_cents: +whatIf.growth_monthly_cents || 0, restock_cents: restock, sales_change_pct: salesPct } };

  // Health score: EBITDA 30, reserve 25, categorized 20, reconciled 15, receivables 10
  const catShare = hasBank ? 1 - (tot.uncategorized_cents / Math.max(1, Object.values(tot.categories).reduce((a, b) => a + b, 0))) : 0;
  const reconRate = payoutTotals.n ? payoutTotals.matched / payoutTotals.n : (hasBank ? 0 : 0);
  const reserveMonths = weeklyOut > 0 ? start / (weeklyOut * 4.33) : 0;
  const e = tot.ebitda_pct == null ? 0 : tot.ebitda_pct;
  const score = Math.round(Math.max(0, Math.min(30, e * 1.5)) + Math.min(25, reserveMonths / 3 * 25) + catShare * 20 + reconRate * 15 + (unpaid.n === 0 ? 10 : Math.max(0, 10 - unpaid.n)));
  let streak = 0; for (let i = pnl.length - 1; i >= 0; i--) { if (pnl[i].ebitda_cents > 0 && pnl[i].net_sales_cents > 0) streak++; else break; }
  const health = { score, level: score >= 85 ? "Fortress" : score >= 65 ? "Strong" : score >= 40 ? "Steady" : "Bootstrapping", profitable_streak_months: streak, parts: { ebitda_pct: e, reserve_months: +reserveMonths.toFixed(1), categorized_pct: Math.round(catShare * 100), reconciled_pct: Math.round(reconRate * 100), open_receivables: unpaid.n } };

  return { range: { from: fromIso, to: toIso }, months, pnl, totals: tot, categories: catRows, has_bank: hasBank, bank_span: { first: bankRows.first, last: bankRows.last, n: bankRows.n },
    reconciliation: { unmatched_payouts: unmatchedPayouts, unmatched_deposits: unmatchedDeposits, payouts: payoutTotals, cash_collected_cents: tot.cash_cents, cash_deposited_cents: cashDeposits, uncategorized },
    unit: { settings: u, rows: unitRows, cups_sold: cupsSold, modeled_cogs_cents: modeledCogs, actual_cogs_cents: tot.cogs_cents }, forecast, health, settings, chart: CATEGORIES };
}
async function payrollWeeklyEstimate(env) {
  const staff = (await env.DB.prepare(`SELECT id, hourly_rate_cents FROM staff WHERE active = 1 AND hourly_rate_cents > 0`).all()).results;
  if (!staff.length) return 0;
  const since = new Date(Date.now() - 28 * 86400000).toISOString();
  let total = 0;
  for (const s of staff) { const m = (await env.DB.prepare(`SELECT COALESCE(SUM(COALESCE(minutes, 0)),0) m FROM shifts WHERE staff_id = ? AND in_at >= ?`).bind(s.id, since).first()).m; total += (m / 60 / 4) * s.hourly_rate_cents; }
  return total;
}
async function txnsFor(env, month, category, limit = 300) {
  const args = []; let where = "1=1";
  if (month) { where += " AND substr(posted_at,1,7) = ?"; args.push(month); }
  if (category) { where += " AND category = ?"; args.push(category); }
  const rows = (await env.DB.prepare(`SELECT id, posted_at, amount_cents, description, category, vendor, memo, matched_payout_id FROM bank_txns WHERE ${where} ORDER BY posted_at DESC LIMIT ${limit}`).bind(...args).all()).results;
  const total = rows.reduce((a, r) => a + Math.abs(r.amount_cents), 0);
  return { rows: rows.map((r) => ({ ...r, share_pct: total ? +((Math.abs(r.amount_cents) / total) * 100).toFixed(1) : 0 })), total_cents: total };
}

// Employee pay: hours × rate for the current pay period, plus optional commission on jobs marked done.
async function staffPay(env, me) {
  const s = await finSettings(env);
  const rate = me.hourly_rate_cents || 0, comm = me.commission_pct || 0;
  const anchor = new Date(s.pay_period_anchor + "T00:00:00Z"); const len = (s.pay_period_days || 14) * 86400000;
  const now = Date.now(); const k = Math.floor((now - anchor.getTime()) / len);
  const from = new Date(anchor.getTime() + k * len).toISOString(), to = new Date(anchor.getTime() + (k + 1) * len).toISOString();
  const prevFrom = new Date(anchor.getTime() + (k - 1) * len).toISOString();
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const mins = async (a, b) => (await q(`SELECT COALESCE(SUM(CASE WHEN out_at IS NULL THEN (strftime('%s','now') - strftime('%s', in_at)) / 60 ELSE COALESCE(minutes,0) END),0) m FROM shifts WHERE staff_id = ? AND in_at >= ? AND in_at < ?`, me.id, a, b).first()).m;
  const jobs = async (a, b) => (await q(`SELECT COALESCE(SUM(amount_cents),0) a FROM jobs WHERE done_by = ? AND done_at >= ? AND done_at < ?`, me.id, a, b).first()).a;
  const curMin = await mins(from, to), prevMin = await mins(prevFrom, from);
  const curJobs = await jobs(from, to), prevJobs = await jobs(prevFrom, from);
  const yearStart = new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1)).toISOString();
  const ytdMin = await mins(yearStart, to), ytdJobs = await jobs(yearStart, to);
  const avgWeekMin = (await mins(new Date(now - 28 * 86400000).toISOString(), new Date(now).toISOString())) / 4;
  const daysLeft = Math.max(0, (new Date(to).getTime() - now) / 86400000);
  const projectedMin = curMin + avgWeekMin * (daysLeft / 7);
  const pay = (m, j) => Math.round(m / 60 * rate + j * comm / 100);
  return { rate_cents: rate, commission_pct: comm, period_from: from, period_to: to, days_left: Math.ceil(daysLeft),
    hours: +(curMin / 60).toFixed(1), earned_cents: pay(curMin, curJobs), commission_cents: Math.round(curJobs * comm / 100), projected_hours: +(projectedMin / 60).toFixed(1), projected_cents: pay(projectedMin, curJobs),
    last_period_hours: +(prevMin / 60).toFixed(1), last_period_cents: pay(prevMin, prevJobs), ytd_hours: +(ytdMin / 60).toFixed(1), ytd_cents: pay(ytdMin, ytdJobs) };
}

async function bankCsv(env) {
  const rows = (await env.DB.prepare(`SELECT posted_at, source, description, amount_cents, category, vendor, memo, matched_payout_id FROM bank_txns ORDER BY posted_at DESC`).all()).results;
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const csv = ["date,account,description,amount,category,vendor,memo,square_payout"].concat(rows.map((r) => [r.posted_at, r.source, r.description, (r.amount_cents / 100).toFixed(2), r.category, r.vendor, r.memo, r.matched_payout_id].map(esc).join(","))).join("\n");
  return new Response(csv, { headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=hdlaser-ledger.csv" } });
}

function moneyHtml(env) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HD Laser money</title>
<style>
:root{--bg:#F6F4EF;--ink:#15191E;--muted:#545B63;--red:#C8372A;--line:#E4E0D8;--card:#fff;--green:#2F6B4F;--gold:#F2B63D;--amber:#D9822B}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 Figtree,"Helvetica Neue",Arial,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--line);background:#fff}
h1{font-size:20px;margin:0}h2{font-size:17px;margin:24px 0 10px}h3{font-size:15px;margin:0 0 8px}main{max-width:1200px;margin:0 auto;padding:16px 20px 80px}
.act,select,input[type=text],input[type=number],input[type=date]{font:inherit;padding:7px 12px;border:1px solid var(--line);background:#fff;border-radius:999px;cursor:pointer}input,select{border-radius:8px}
.act.red{background:var(--red);color:#fff;border-color:var(--red)}.act.dark{background:var(--ink);color:#fff;border-color:var(--ink)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;overflow:auto}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}.tile{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px}.tile .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}.tile .n{font-size:24px;font-weight:700;margin-top:4px}.tile .d{font-size:12px;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #EDE8DF;vertical-align:top}th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}td.num,th.num{text-align:right;white-space:nowrap}
tr.click{cursor:pointer}tr.click:hover{background:#FBF3D6}tr.tot td{font-weight:700;border-top:2px solid var(--ink)}tr.sub td{color:var(--muted)}
.pill{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:#EDE8DF}.good{background:#E7F2EC;color:var(--green)}.warn{background:#FBF3D6;color:#8a5a00}.over{background:#FBE9E6;color:var(--red)}
.small{font-size:12px;color:var(--muted)}.empty{color:var(--muted);font-style:italic}
.score{display:flex;align-items:center;gap:18px}.ring{width:96px;height:96px;border-radius:50%;display:grid;place-items:center;font-size:30px;font-weight:800;color:#fff;background:conic-gradient(var(--green) calc(var(--p)*1%),#E4E0D8 0)}.ring span{width:76px;height:76px;border-radius:50%;background:var(--ink);display:grid;place-items:center}
.bar{height:8px;background:#EDE8DF;border-radius:999px;overflow:hidden}.bar i{display:block;height:100%;background:var(--green)}.bar i.warn{background:var(--amber)}.bar i.over{background:var(--red)}
#drawer{position:fixed;top:0;right:0;width:min(560px,100%);height:100%;background:#fff;box-shadow:-8px 0 30px rgba(0,0,0,.15);transform:translateX(100%);transition:.2s;overflow:auto;padding:18px;z-index:20}#drawer.open{transform:none}
textarea{width:100%;min-height:90px;font:13px/1.4 ui-monospace,Menlo,monospace;border:1px solid var(--line);border-radius:8px;padding:8px}
.what{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.what label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:4px}
svg text{font-size:11px;fill:var(--muted)}
#err{background:#FBE9E6;color:var(--red);padding:10px 14px;border-radius:10px;margin:12px 0;display:none}
@media (max-width:640px){.score{flex-direction:column;align-items:flex-start}}
.btn{font:inherit;font-size:12px;padding:3px 9px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;white-space:nowrap}.btn.done{background:#FBE9E6;border-color:#EFC3BC;color:var(--red)}
#pricebox{background:var(--red);color:#fff;border-radius:16px;padding:18px 20px;margin:12px 0 20px;box-shadow:0 10px 30px rgba(200,55,42,.35)}
#pricebox h2{margin:0 0 4px;font-size:22px;color:#fff;letter-spacing:.02em}#pricebox .lead{margin:0 0 14px;color:#FBE9E6;font-size:14px}
.sug{background:#fff;color:var(--ink);border-radius:12px;padding:14px 16px;margin-top:10px;display:grid;grid-template-columns:1fr auto;gap:14px;align-items:start}
.sug .what{font-size:17px;font-weight:700}.sug .what span{color:var(--red)}.sug .why{margin:6px 0 0;line-height:1.5}.sug .ev{font-size:12px;color:var(--muted);margin-top:6px}
.sug .acts{display:flex;flex-direction:column;gap:6px;min-width:120px}.sug .acts button{font:inherit;font-weight:700;padding:9px 14px;border-radius:999px;cursor:pointer;border:2px solid var(--ink)}
.sug .acts .ok{background:var(--green);border-color:var(--green);color:#fff}.sug .acts .no{background:#fff;color:var(--ink)}
#pricebox .foot{margin:12px 0 0;font-size:13px;color:#FBE9E6}#pricebox .foot button{font:inherit;font-size:13px;padding:5px 12px;border-radius:999px;border:1px solid #fff;background:transparent;color:#fff;cursor:pointer}
#pricelist input{width:78px;font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;text-align:right}
@media (max-width:640px){.sug{grid-template-columns:1fr}.sug .acts{flex-direction:row}}
</style></head><body>
<header><h1>HD Laser money</h1><div><a class="act" href="/admin" style="text-decoration:none;color:inherit">Sales dashboard</a> <button class="act" id="sync">Sync Square</button> <a class="act" href="/api/bank/export.csv" style="text-decoration:none;color:inherit">Export ledger</a></div></header>
<main>
<div id="err"></div>
<div id="pricebox" hidden><h2>PRICE CHANGES WAITING FOR YOUR DECISION</h2><p class="lead">The pricing review found these. Nothing changes until you press Approve. Each one says why.</p><div id="sugs"></div><p class="foot" id="pricefoot"></p></div>
<div class="grid" style="grid-template-columns:1.2fr 2fr">
  <div class="card"><h3>Financial health</h3><div class="score"><div class="ring" id="ring" style="--p:0"><span id="scoreN">–</span></div><div><div id="level" style="font-size:18px;font-weight:700"></div><div class="small" id="streak"></div><div class="small" id="parts" style="margin-top:6px;line-height:1.6"></div></div></div></div>
  <div class="card"><h3>Last 6 months</h3><div class="tiles" id="tiles"></div></div>
</div>

<h2>This year vs last year</h2>
<div class="card" id="yoy"><p class="empty">Loading…</p></div>
<h2>Two-year trend <span class="small">every month, sales to profit</span> <a class="act" href="/api/money/trends.csv" style="text-decoration:none;color:inherit;font-size:13px;margin-left:8px">Download CSV</a></h2>
<div class="card" id="trend"><p class="empty">Loading…</p></div>
<h2>Where the money goes <span class="small">last 12 months vs the 12 before</span></h2>
<div class="grid" id="spend"></div>
<h2>Profit &amp; loss by month <span class="small">click a row for the itemized list</span></h2>
<div class="card"><table id="pnl"></table><p class="small" id="pnlnote" style="margin:8px 0 0"></p></div>

<h2>Cash forecast, next 13 weeks</h2>
<div class="grid" style="grid-template-columns:2fr 1fr">
  <div class="card"><div id="chart"></div><div class="tiles" id="fctiles" style="margin-top:10px"></div></div>
  <div class="card"><h3>What if…</h3><div class="what">
    <label>Hire, $ per month<input type="number" id="w-hire" value="0" step="100"></label>
    <label>Restock, one-time $<input type="number" id="w-restock" value="0" step="100"></label>
    <label>Growth spend, $ per month<input type="number" id="w-growth" value="0" step="100"></label>
    <label>Sales change, %<input type="number" id="w-sales" value="0" step="5"></label>
    <label>Cash in bank now, $<input type="number" id="w-cash" step="100"></label>
    <label>Reserve, months of costs<input type="number" id="w-reserve" step="0.5" min="0"></label>
    <label>Monthly fixed costs, $ (used until bank data exists)<input type="number" id="w-fixed" step="100"></label>
  </div><p style="margin:10px 0 0"><button class="act dark" id="w-run">Recalculate</button> <button class="act" id="w-save">Save cash &amp; reserve</button></p><p class="small" id="verdict" style="margin-top:10px;line-height:1.5"></p></div>
</div>

<h2>Bank ledger</h2>
<div class="grid">
  <div class="card"><h3>Connected accounts <span class="pill" id="plaidenv"></span></h3><div id="plaid"></div><p style="margin-top:10px"><button class="act dark" id="plaidlink">Connect a bank or card</button> <button class="act" id="plaidsync">Pull now</button> <span class="small" id="plaidmsg"></span></p><p class="small">Live feed through Plaid. New transactions arrive every hour and land in the ledger with the same rules as CSV imports. Balances feed the forecast.</p>
<p class="small" id="retention"></p></div>
<div class="card" style="margin-top:14px"><h3>Ledger sources</h3><div id="sources"></div><p style="margin-top:10px"><button class="act" id="recat">Re-apply rules to the ledger</button> <span class="small" id="recatmsg"></span></p><p class="small">Each line is one bank account's rows in the ledger. A line marked <b>not connected</b> came from a connection that was removed or re-linked (or from the sandbox); delete it so nothing is counted twice. Re-apply rules re-files every auto-categorized row with the current merchant rules; rows you filed by hand are left alone.</p></div>
  <div class="card"><h3>Or import a statement (CSV)</h3>
    <p class="small">Download a CSV from the bank (any date range), pick it here. Columns are detected automatically: date, description, amount (or debit/credit), balance. Re-importing the same rows is safe; duplicates are skipped.</p>
    <p><input type="text" id="src" placeholder="Account name, e.g. Chase checking" style="width:60%"> <input type="file" id="csv" accept=".csv,text/csv"></p>
    <p><button class="act dark" id="imp">Import</button> <span class="small" id="impmsg"></span></p></div>
  <div class="card"><h3>Reconciliation with Square <span class="pill" id="recpill"></span></h3><div id="recon"></div></div>
</div>
<div class="card" style="margin-top:14px"><h3>Uncategorized <span class="pill" id="uncpill">0</span></h3><p class="small">Pick a category. Tick "rule" to apply it to everything with the same name, now and in future imports.</p><div id="unc"></div></div>

<h2>Price list <span class="small">what the order page charges; edit a number and press Enter to change it</span></h2>
<div class="grid" id="pricelist"></div>
<div class="card" style="margin-top:14px"><h3>Pricing review</h3><p class="small" id="reviewmeta"></p><p><button class="act dark" id="runreview">Run the pricing review now</button> <span class="small" id="reviewmsg"></span></p><p class="small">It runs by itself every Monday and looks at four things: the size ladder keeps climbing by a little more each half inch; every item clears the target margin after the blank, labor and consumables; sizes and items that get priced often but rarely bought (or bought far more than average); and materials taking a bigger share of sales than they used to. Suggestions land in the red box at the top. Decided ones are listed below.</p><div id="decided"></div></div>

<h2>Unit economics, logo cups</h2>
<div class="grid">
  <div class="card"><table id="unit"></table><p class="small" id="unitnote" style="margin-top:8px"></p></div>
  <div class="card"><h3>Cost assumptions, cents per cup</h3><div class="what" id="unitform"></div><p style="margin-top:10px"><button class="act dark" id="unitsave">Save assumptions</button> <span class="small" id="unitmsg"></span></p></div>
</div>
</main>
<div id="drawer"><p style="text-align:right;margin:0"><button class="act" id="dclose">Close</button></p><h3 id="dtitle"></h3><p class="small" id="dsub"></p><table id="dtable"></table></div>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const $=s=>document.querySelector(s), esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=c=>(c<0?'-':'')+'$'+Math.abs((c||0)/100).toLocaleString('en-US',{maximumFractionDigits:0});
const mon=m=>new Date(m+'-02').toLocaleDateString('en-US',{month:'short',year:'2-digit'});
let R=null, CATS=[];
function whatIf(){ return {hire_monthly_cents:Math.round((+$('#w-hire').value||0)*100),restock_cents:Math.round((+$('#w-restock').value||0)*100),growth_monthly_cents:Math.round((+$('#w-growth').value||0)*100),sales_change_pct:+$('#w-sales').value||0}; }
async function load(){ $('#err').style.display='none'; const w=whatIf(); const q=new URLSearchParams(Object.entries(w).map(([k,v])=>[k,String(v)]));
  const r=await fetch('/api/money?'+q); if(!r.ok){ $('#err').textContent='Could not load: '+r.status; $('#err').style.display='block'; return; }
  R=await r.json(); if(R.error){ $('#err').textContent=R.error; $('#err').style.display='block'; return; } CATS=R.chart; render(); }
function render(){
  const h=R.health; $('#ring').style.setProperty('--p',h.score); $('#scoreN').textContent=h.score; $('#level').textContent=h.level; $('#streak').textContent=h.profitable_streak_months?h.profitable_streak_months+' profitable month'+(h.profitable_streak_months>1?'s':'')+' in a row':'No profitable-month streak yet';
  $('#parts').innerHTML='EBITDA '+(h.parts.ebitda_pct)+'% · Cash reserve '+h.parts.reserve_months+' months · Ledger categorized '+h.parts.categorized_pct+'% · Payouts reconciled '+h.parts.reconciled_pct+'% · Open receivables '+h.parts.open_receivables;
  const t=R.totals;
  $('#tiles').innerHTML=tile('Net sales',money(t.net_sales_cents),'after refunds & Square fees')+tile('COGS',money(t.cogs_cents),R.has_bank?'from bank ledger':'no bank data yet')+tile('Operating expenses',money(t.opex_cents),'')+tile('EBITDA',money(t.ebitda_cents),(t.ebitda_pct==null?'–':t.ebitda_pct+'%')+' of net sales')+tile('Web cup sales',money(t.web_cents),'')+tile('Cash sales',money(t.cash_cents),'must be deposited')+tile('Bank vs Square',money(t.bank_income_cents-t.net_sales_cents),'deposits minus net sales')+tile('Personal spending',money(t.categories.personal||0),'kept out of the business numbers');
  const ms=R.months; const row=(label,fn,cls,key)=>'<tr class="'+(cls||'')+(key?' click':'')+'"'+(key?' data-cat="'+key+'"':'')+'><td>'+label+'</td>'+ms.map(m=>'<td class="num">'+fn(R.pnl.find(p=>p.month===m))+'</td>').join('')+'<td class="num"><b>'+fn(t)+'</b></td></tr>';
  let html='<tr><th>'+(R.has_bank?'':'<span class="pill warn">import a bank CSV to fill expenses</span>')+'</th>'+ms.map(m=>'<th class="num">'+mon(m)+'</th>').join('')+'<th class="num">Total</th></tr>';
  html+=row('Gross sales (Square)',p=>money(p.gross_cents))+row('Refunds',p=>money(-p.refunds_cents),'sub')+row('Square fees',p=>money(-p.square_fees_cents),'sub')+row('<b>Net sales</b>',p=>money(p.net_sales_cents),'tot');
  const cat=(g)=>CATS.filter(c=>c.group===g).map(c=>row(c.name,p=>p.categories?money(-p.categories[c.key]):money(-(t.categories[c.key]||0)),'',c.key)).join('');
  html+='<tr><td colspan="'+(ms.length+2)+'" class="small" style="padding-top:12px"><b>Cost of goods</b></td></tr>'+cat('cogs')+row('<b>Gross profit</b>',p=>money(p.net_sales_cents-p.cogs_cents)+(p.gross_margin_pct!=null?' <span class="small">'+p.gross_margin_pct+'%</span>':''),'tot');
  html+='<tr><td colspan="'+(ms.length+2)+'" class="small" style="padding-top:12px"><b>Operating expenses</b></td></tr>'+cat('opex')+row('<b>EBITDA</b>',p=>money(p.ebitda_cents)+(p.ebitda_pct!=null?' <span class="small">'+p.ebitda_pct+'%</span>':''),'tot');
  html+='<tr><td colspan="'+(ms.length+2)+'" class="small" style="padding-top:12px"><b>Not in EBITDA</b> (transfers, draws, loans, card payments, equipment)</td></tr>'+CATS.filter(c=>c.group==='excluded').map(c=>row(c.name,p=>money(-(p.categories?p.categories[c.key]:t.categories[c.key])),'sub',c.key)).join('');
  $('#pnl').innerHTML=html;
  $('#pnlnote').innerHTML=R.categories.filter(c=>c.status).map(c=>'<span class="pill '+c.status+'">'+esc(c.name)+' '+c.pct_of_net+'% (target ≤'+Math.round(c.target*100)+'%)</span> ').join('');
  // forecast
  const f=R.forecast; drawChart(f); 
  $('#fctiles').innerHTML=tile('Cash now',money(f.cash_balance_cents),f.cash_as_of?'as of '+f.cash_as_of:'set it in What if')+tile('Square in transit',money(f.in_transit_cents),'not yet paid out')+tile('Receivable',money(f.receivable_cents),f.receivable_n+' unpaid web orders')+tile('Weekly in',money(f.weekly_in_cents),'avg last 8 weeks')+tile('Weekly out',money(f.weekly_out_cents),'basis: '+f.basis)+tile('Lowest cash',money(f.min_cash_cents),'week '+f.min_cash_week)+tile('Safe to spend',money(f.safe_to_spend_cents),'above a '+R.settings.reserve_months+'-month reserve');
  const v=[]; if(f.safe_to_spend_cents>0) v.push('<b>You can commit about '+money(f.safe_to_spend_cents)+'</b> over the next 13 weeks and still keep '+R.settings.reserve_months+' month'+(R.settings.reserve_months==1?'':'s')+' of costs in reserve.'); else v.push('<b>Not safe to add spending yet.</b> Cash would dip '+money(-f.safe_to_spend_cents)+' below your reserve in week '+f.min_cash_week+'.');
  if(f.runway_weeks!=null) v.push('At the current pace, cash runs out in about '+f.runway_weeks+' weeks unless sales rise.'); const w=f.what_if; if(w.hire_monthly_cents||w.growth_monthly_cents||w.restock_cents||w.sales_change_pct) v.push('Includes your what-if: '+[w.hire_monthly_cents?'hire '+money(w.hire_monthly_cents)+'/mo':'',w.restock_cents?'restock '+money(w.restock_cents):'',w.growth_monthly_cents?'growth '+money(w.growth_monthly_cents)+'/mo':'',w.sales_change_pct?'sales '+(w.sales_change_pct>0?'+':'')+w.sales_change_pct+'%':''].filter(Boolean).join(', ')+'.');
  if(!R.has_bank) v.push('No bank data yet, so weekly costs come from the fixed-cost setting. Import a statement for real numbers.');
  $('#verdict').innerHTML=v.join(' ');
  if(!$('#w-cash').value) $('#w-cash').value=Math.round(f.cash_balance_cents/100); if(!$('#w-reserve').value) $('#w-reserve').value=R.settings.reserve_months; if(!$('#w-fixed').value) $('#w-fixed').value=Math.round(R.settings.monthly_fixed_costs_cents/100);
  // reconciliation
  const rc=R.reconciliation; $('#recpill').textContent=(rc.payouts.matched||0)+'/'+(rc.payouts.n||0)+' payouts matched';
  $('#recon').innerHTML=(rc.unmatched_payouts.length?'<p><b>Square says it sent these, not found in the bank:</b></p><table>'+rc.unmatched_payouts.map(p=>'<tr><td class="small">'+(p.arrival_date||p.created_at||'').slice(0,10)+'</td><td>'+esc(p.status)+'</td><td class="num">'+money(p.amount_cents)+'</td></tr>').join('')+'</table>':'<p class="small">Every Square payout in range matches a bank deposit'+(rc.payouts.n?'.':', once payouts are synced.')+'</p>')
    +(rc.unmatched_deposits.length?'<p><b>Bank deposits from Square with no payout record:</b> <span class="small">usually older than the synced window; run Import 2 years on the sales dashboard</span></p><table>'+rc.unmatched_deposits.map(d=>'<tr><td class="small">'+d.posted_at+'</td><td class="small">'+esc(d.description)+'</td><td class="num">'+money(d.amount_cents)+'</td></tr>').join('')+'</table>':'')
    +'<p style="margin-top:8px"><b>Cash:</b> Square recorded '+money(rc.cash_collected_cents)+' in cash sales; the bank shows '+money(rc.cash_deposited_cents)+' in cash deposits'+(rc.cash_collected_cents>rc.cash_deposited_cents+5000?' <span class="pill over">'+money(rc.cash_collected_cents-rc.cash_deposited_cents)+' not deposited</span>':' <span class="pill good">ok</span>')+'.</p>';
  $('#uncpill').textContent=rc.uncategorized.length;
  const opts=CATS.map(c=>'<option value="'+c.key+'">'+esc(c.name)+'</option>').join('');
  $('#unc').innerHTML=rc.uncategorized.length?'<table>'+rc.uncategorized.map(u=>'<tr><td class="small">'+u.posted_at+'</td><td>'+esc(u.description)+'</td><td class="num">'+money(u.amount_cents)+'</td><td><select data-id="'+u.id+'"><option value="">choose…</option>'+opts+'</select> <label class="small"><input type="checkbox" data-rule="'+u.id+'" checked> rule</label></td></tr>').join('')+'</table>':'<p class="empty">Nothing to categorize.</p>';
  // unit economics
  const un=R.unit; $('#unit').innerHTML='<tr><th>Cup</th><th class="num">Sells at (50-tier)</th><th class="num">Our cost</th><th class="num">Margin</th></tr>'+un.rows.map(r=>'<tr><td>'+r.product+'</td><td class="num">'+money(r.price_cents)+'</td><td class="num">'+money(r.cost_cents)+'</td><td class="num">'+money(r.margin_cents)+' <span class="pill '+(r.margin_pct>=50?'good':r.margin_pct>=35?'warn':'over')+'">'+r.margin_pct+'%</span></td></tr>').join('');
  $('#unitnote').textContent='Modeled cost of cups sold in range: '+money(un.modeled_cogs_cents)+' vs '+money(un.actual_cogs_cents)+' actual COGS in the bank ledger. A big gap means blanks or ink were bought in a different month, or the assumptions need tuning.';
  const labels={cup12_blank:'12 oz blank',cup16_blank:'16 oz blank',ink12:'UV ink, 12 oz',ink16:'UV ink, 16 oz',engrave_consumable:'Engraving consumables',packaging:'Packaging',labor_rate_hour:'Labor, cents per hour',minutes_engraved:'Minutes per engraved cup',minutes_printed:'Minutes per printed cup'};
  $('#unitform').innerHTML=Object.keys(labels).map(k=>'<label>'+labels[k]+'<input type="number" step="1" data-unit="'+k+'" value="'+un.settings[k]+'"></label>').join('');
}
function tile(l,n,d){ return '<div class="tile"><div class="l">'+l+'</div><div class="n">'+n+'</div><div class="d">'+(d||'')+'</div></div>'; }
function drawChart(f){ const W=640,H=220,P=36; const vals=[f.start_cash_cents].concat(f.series.map(s=>s.cash_cents)); const lo=Math.min(0,...vals,f.reserve_cents), hi=Math.max(...vals,f.reserve_cents,1); const x=i=>P+i*(W-2*P)/13, y=v=>H-P-(v-lo)/(hi-lo)*(H-2*P);
  let s='<svg viewBox="0 0 '+W+' '+H+'" width="100%" height="'+H+'">'; s+='<line x1="'+P+'" y1="'+y(0)+'" x2="'+(W-P)+'" y2="'+y(0)+'" stroke="#E4E0D8"/>'; s+='<line x1="'+P+'" y1="'+y(f.reserve_cents)+'" x2="'+(W-P)+'" y2="'+y(f.reserve_cents)+'" stroke="#D9822B" stroke-dasharray="4 4"/><text x="'+(W-P)+'" y="'+(y(f.reserve_cents)-4)+'" text-anchor="end">reserve '+money(f.reserve_cents)+'</text>';
  s+='<polyline fill="none" stroke="#15191E" stroke-width="2.5" points="'+vals.map((v,i)=>x(i)+','+y(v)).join(' ')+'"/>'; vals.forEach((v,i)=>{ s+='<circle cx="'+x(i)+'" cy="'+y(v)+'" r="3" fill="'+(v<f.reserve_cents?'#C8372A':'#2F6B4F')+'"/>'; if(i%2===0) s+='<text x="'+x(i)+'" y="'+(H-P+14)+'" text-anchor="middle">'+(i===0?'now':'wk '+i)+'</text>'; });
  s+='<text x="'+P+'" y="'+(y(hi)+4)+'">'+money(hi)+'</text><text x="'+P+'" y="'+(y(lo)-2)+'">'+money(lo)+'</text></svg>'; $('#chart').innerHTML=s; }
async function openCat(key){ const c=CATS.find(x=>x.key===key); const r=await fetch('/api/bank/txns?category='+key+'&from='+R.range.from.slice(0,10)); const d=await r.json();
  $('#dtitle').textContent=c?c.name:key; $('#dsub').textContent=money(d.total_cents)+' across '+d.rows.length+' transactions in range. Share is each item\\'s portion of this category.';
  const opts=CATS.map(x=>'<option value="'+x.key+'">'+esc(x.name)+'</option>').join('');
  $('#dtable').innerHTML='<tr><th>Date</th><th>Description</th><th class="num">Amount</th><th class="num">Share</th><th></th></tr>'+d.rows.map(t=>'<tr><td class="small">'+t.posted_at+'</td><td>'+esc(t.description)+(t.memo?'<div class="small">'+esc(t.memo)+'</div>':'')+'</td><td class="num">'+money(t.amount_cents)+'</td><td class="num">'+t.share_pct+'%</td><td><select data-id="'+t.id+'" data-cur="'+t.category+'"><option value="">move…</option>'+opts+'</select></td></tr>').join('');
  $('#drawer').classList.add('open'); }
document.addEventListener('click',e=>{ const tr=e.target.closest('tr[data-cat]'); if(tr&&!e.target.closest('select')) openCat(tr.dataset.cat); });
$('#dclose').onclick=()=>$('#drawer').classList.remove('open');
document.addEventListener('change',async e=>{ const s=e.target.closest('select[data-id]'); if(!s||!s.value) return; const rule=document.querySelector('input[data-rule="'+s.dataset.id+'"]'); const r=await fetch('/api/bank/txns/'+s.dataset.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({category:s.value,make_rule:!!(rule&&rule.checked)})}); const j=await r.json(); if(!j.ok) alert(j.error||'Failed'); else { const row=s.closest('tr'); row.style.opacity='.4'; if(j.applied) $('#impmsg').textContent='Rule applied to '+j.applied+' more.'; setTimeout(load,300); } });
$('#w-run').onclick=load;
const cents=c=>'$'+((c||0)/100).toFixed(2);
async function loadPricing(){ const r=await fetch('/api/pricing'); if(!r.ok) return; const P=await r.json(); const B=P.book;
  const box=$('#pricebox'); box.hidden=!P.pending.length;
  $('#sugs').innerHTML=P.pending.map(s=>{ const ladder=s.target.type==='ladder'; const dir=s.proposed_cents>s.current_cents?'up':'down'; const pct=s.current_cents?Math.round((s.proposed_cents-s.current_cents)/s.current_cents*100):0;
    return '<div class="sug" data-id="'+s.id+'"><div><div class="what">'+esc(s.label)+': <span>'+cents(s.current_cents)+' \u2192 '+cents(s.proposed_cents)+'</span> ('+(pct>0?'+':'')+pct+'%'+(ladder?', every size':'')+')</div><p class="why"><b>Why:</b> '+esc(s.reason)+'</p><div class="ev">Found '+new Date(s.created_at).toLocaleDateString()+' \u00b7 rule: '+esc(s.rule.replace(/_/g,' '))+'</div></div><div class="acts"><button class="ok" data-dec="approve">Approve</button><button class="no" data-dec="deny">Deny</button></div></div>'; }).join('');
  $('#pricefoot').innerHTML=P.pending.length+' waiting. <button id="rr2">Run the review again</button>';
  $('#reviewmeta').textContent=(P.last_review?'Last review '+new Date(P.last_review).toLocaleString():'The review has not run yet.')+' \u00b7 target margin '+Math.round(P.target_margin*100)+'%';
  const soldOf=(svc,inch)=>{ const r=P.sold.find(x=>x.service===svc&&x.inches===inch); return r?r.n:0; };
  const sizes='<div class="card"><h3>Per piece by artwork size <span class="small">longest side; \u00d7 material factor</span></h3><table><tr><th>Size</th><th class="num">Engraving</th><th class="num">UV print</th><th class="num">Sold</th></tr>'+B.sizes.map(z=>'<tr><td>'+z.inches+' in</td><td class="num"><input data-t=\\''+JSON.stringify({type:'size',service:'engrave',inches:z.inches})+'\\' value="'+(z.engrave_cents/100).toFixed(2)+'"></td><td class="num"><input data-t=\\''+JSON.stringify({type:'size',service:'uv',inches:z.inches})+'\\' value="'+(z.uv_cents/100).toFixed(2)+'"></td><td class="num small">'+(soldOf('engrave',z.inches)+soldOf('uv',z.inches))+'</td></tr>').join('')+'</table></div>';
  const items='<div class="card"><h3>Items we supply</h3><table><tr><th>Item</th><th>Material</th><th class="num">Price</th><th class="num">Our cost</th><th class="num">Max art</th></tr>'+B.products.filter(p=>p.key!=='own').map(p=>'<tr><td>'+esc(p.name)+'</td><td class="small">'+esc(p.material)+'</td><td class="num"><input data-t=\\''+JSON.stringify({type:'product',key:p.key,field:'blank_cents'})+'\\' value="'+(p.blank_cents/100).toFixed(2)+'"></td><td class="num"><input data-t=\\''+JSON.stringify({type:'product',key:p.key,field:'cost_cents'})+'\\' value="'+((p.cost_cents||0)/100).toFixed(2)+'"></td><td class="num small">'+p.max_inches+' in</td></tr>').join('')+'</table><p class="small" style="margin-top:8px">Materials: '+B.materials.map(m=>esc(m.name)+' \u00d7'+m.factor).join(', ')+'. Quantity: '+B.qty_breaks.filter(b=>b.off_pct).map(b=>b.min+'+ '+b.off_pct+'% off the work').join(', ')+'. Setup '+B.services.map(s=>esc(s.name)+' '+cents(s.setup_cents)).join(', ')+'. Rush +'+B.rush_pct+'%. Own item handling '+cents(B.own_item_handling_cents)+' each. Minimum order '+cents(B.min_order_cents)+'.</p></div>';
  $('#pricelist').innerHTML=sizes+items;
  $('#decided').innerHTML=(P.decided.length?'<table>'+P.decided.map(d=>'<tr><td class="small">'+new Date(d.decided_at).toLocaleDateString()+'</td><td>'+esc(d.label)+'</td><td class="num">'+cents(d.current_cents)+' \u2192 '+cents(d.proposed_cents)+'</td><td><span class="pill '+(d.status==='approved'?'good':'over')+'">'+d.status+'</span></td><td class="small">'+esc(d.note||'')+'</td></tr>').join('')+'</table>':'<p class="small">No decisions yet.</p>')
    +(P.history.length?'<p class="small" style="margin-top:10px"><b>Every price change</b></p><table>'+P.history.map(h=>'<tr><td class="small">'+new Date(h.ts).toLocaleDateString()+'</td><td>'+esc(h.label)+'</td><td class="num">'+cents(h.from_cents)+' \u2192 '+cents(h.to_cents)+'</td><td class="small">'+esc(h.source)+(h.note?' \u00b7 '+esc(h.note):'')+'</td></tr>').join('')+'</table>':''); }
document.addEventListener('click',async e=>{ const b=e.target.closest('button[data-dec]'); if(b){ const id=b.closest('.sug').dataset.id; const dec=b.dataset.dec; const note=dec==='deny'?(prompt('Why not? (optional, kept with the record)')||''):''; b.disabled=true; const r=await (await fetch('/api/pricing/suggestions/'+id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision:dec,note})})).json(); if(!r.ok) alert(r.error||'Failed'); loadPricing(); return; }
  if(e.target.id==='runreview'||e.target.id==='rr2'){ e.target.disabled=true; const r=await (await fetch('/api/pricing/analyze',{method:'POST'})).json(); e.target.disabled=false; $('#reviewmsg').textContent=r.ok?('Checked '+r.checked+' thing'+(r.checked===1?'':'s')+', '+r.created+' new suggestion'+(r.created===1?'':'s')+'.'):(r.error||'Failed'); loadPricing(); } });
document.addEventListener('keydown',async e=>{ const i=e.target.closest('#pricelist input[data-t]'); if(!i||e.key!=='Enter') return; const c=Math.round(parseFloat(i.value)*100); if(!(c>=0)) return; i.disabled=true; const r=await (await fetch('/api/pricing/book',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:JSON.parse(i.dataset.t),cents:c,note:'edited on the money page'})})).json(); if(!r.ok) alert(r.error||'Failed'); loadPricing(); });
$('#w-save').onclick=async()=>{ const body={cash_balance_cents:Math.round((+$('#w-cash').value||0)*100),cash_as_of:new Date().toISOString().slice(0,10),reserve_months:+$('#w-reserve').value||1,monthly_fixed_costs_cents:Math.round((+$('#w-fixed').value||0)*100)}; await fetch('/api/money/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); load(); };
$('#unitsave').onclick=async()=>{ const unit={}; document.querySelectorAll('input[data-unit]').forEach(i=>unit[i.dataset.unit]=+i.value); await fetch('/api/money/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({unit})}); $('#unitmsg').textContent='Saved.'; load(); };
$('#sync').onclick=async()=>{ $('#sync').disabled=true; $('#sync').textContent='Working…'; const r=await fetch('/api/sync?days=30',{method:'POST'}); const j=await r.json(); $('#sync').disabled=false; $('#sync').textContent='Sync Square'; if(j.payout_error) alert('Payments synced, but payouts could not be read: '+j.payout_error+'\\n\\nIn Square Developer, give the app the PAYOUTS_READ permission and create a new access token.'); load(); };
function parseCsv(text){ const rows=[]; let row=[],field='',q=false; for(let i=0;i<text.length;i++){ const c=text[i]; if(q){ if(c==='"'){ if(text[i+1]==='"'){field+='"';i++;} else q=false; } else field+=c; } else if(c==='"') q=true; else if(c===','){ row.push(field); field=''; } else if(c==='\\n'||c==='\\r'){ if(c==='\\r'&&text[i+1]==='\\n') i++; row.push(field); rows.push(row); row=[]; field=''; } else field+=c; } if(field||row.length){ row.push(field); rows.push(row);} return rows.filter(r=>r.some(x=>x&&x.trim())); }
$('#imp').onclick=async()=>{ const f=$('#csv').files[0]; if(!f){ alert('Choose a CSV file first.'); return; } const text=await f.text(); const rows=parseCsv(text); if(rows.length<2){ alert('That file has no rows.'); return; }
  const head=rows[0].map(h=>h.toLowerCase().trim()); const find=(...names)=>head.findIndex(h=>names.some(n=>h===n||h.includes(n)));
  const iDate=find('posting date','post date','transaction date','date'), iDesc=find('description','memo','payee','details','name'), iAmt=find('amount'), iDeb=find('debit','withdrawal'), iCred=find('credit','deposit'), iBal=find('balance');
  if(iDate<0||iDesc<0||(iAmt<0&&iDeb<0&&iCred<0)){ alert('Could not find date, description and amount columns. Header row: '+head.join(', ')); return; }
  const out=rows.slice(1).map(r=>({date:r[iDate],description:r[iDesc],amount:iAmt>=0?r[iAmt]:undefined,debit:iDeb>=0?r[iDeb]:undefined,credit:iCred>=0?r[iCred]:undefined,balance:iBal>=0?r[iBal]:undefined}));
  $('#impmsg').textContent='Importing '+out.length+' rows…'; const r=await fetch('/api/bank/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:$('#src').value||f.name.replace(/\\.csv$/i,''),rows:out})}); const j=await r.json();
  $('#impmsg').textContent=j.ok?('Added '+j.added+', skipped '+j.duplicates+' duplicates, '+j.skipped+' unreadable.'+(j.balance_cents!=null?' Balance '+money(j.balance_cents)+' as of '+j.balance_as_of+'.':'')):(j.error||'Import failed'); load(); };
(function(){ const n=new Date(), y=n.getFullYear(), m=n.getMonth(); const due = m<0?null : (m===0||m===6) ? 'this month' : (m<6 ? 'July '+y : 'January '+(y+1)); const soon=(m===0||m===6);
  const el=document.getElementById('retention'); if(el) el.innerHTML=(soon?'<b style="color:var(--red)">Data retention review is due '+due+'.</b> ':'Next data retention review: <b>'+due+'</b>. ')+'Delete records past their period per the <a href="https://hdlaser.net/staff/data-retention-policy/" target="_blank" rel="noopener">Data Retention Policy</a> and note it in your records.'; })();
async function loadSources(){ const r=await fetch('/api/bank/sources'); if(!r.ok) return; const d=await r.json();
  $('#sources').innerHTML=d.sources.length?'<table>'+d.sources.map(s=>'<tr><td>'+esc(s.source||'(no source)')+(s.attached?'':' <span class="pill" style="background:#FBE9E6;color:var(--red)">not connected</span>')+'<div class="small">'+s.rows+' rows · '+(s.first||'').slice(0,10)+' to '+(s.last||'').slice(0,10)+'</div></td><td class="num">'+money(s.total_cents)+'</td><td>'+(s.attached?'':'<button class="btn" data-delsrc="'+esc(s.source)+'">Delete rows</button>')+'</td></tr>').join('')+'</table>':'<p class="empty">No bank rows yet.</p>';
  $('#sources').querySelectorAll('button[data-delsrc]').forEach(b=>b.addEventListener('click',async()=>{ if(!confirm('Delete every ledger row from "'+b.dataset.delsrc+'"? This cannot be undone.')) return; b.disabled=true; const r=await (await fetch('/api/bank/sources?source='+encodeURIComponent(b.dataset.delsrc),{method:'DELETE'})).json(); $('#recatmsg').textContent=r.ok?('Deleted '+r.deleted+' rows.'):(r.error||'Failed'); load(); loadSources(); })); }
$('#recat').onclick=async()=>{ const b=$('#recat'); b.disabled=true; $('#recatmsg').textContent='Working…'; const r=await (await fetch('/api/bank/recategorize',{method:'POST'})).json(); b.disabled=false; $('#recatmsg').textContent=r.ok?('Checked '+r.checked.toLocaleString()+' rows, re-filed '+r.changed.toLocaleString()+'.'):(r.error||'Failed'); load(); };
async function loadYoy(){ const r=await fetch('/api/money/yoy'); if(!r.ok) return; const d=await r.json(); const mn=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const M=d.metrics, g=v=>v==null?'n/a':(v>=0?'+':'')+v+'%'; const usd=c=>'$'+Math.round((c||0)/100).toLocaleString('en-US');
  const tiles=(k,label)=>'<div class="tiles" style="margin-bottom:10px">'+tile(label+', '+d.prev_year+' through '+mn[d.through_month-1],usd(M[k].last_ytd),'')+tile(label+', '+d.year+' through '+mn[d.through_month-1],usd(M[k].this_ytd),'<b class="'+((M[k].growth_pct||0)>=0?'up':'down')+'">'+g(M[k].growth_pct)+'</b> vs last year')+tile(d.prev_year+' full year',usd(M[k].last_full),(M[k].last_q4_share_pct!=null?M[k].last_q4_share_pct+'% of it came in Oct-Dec':''))+tile(d.year+' projected',usd(M[k].projected_full),M[k].method==='seasonal'?'shaped like last year; a straight run-rate would be '+usd(M[k].run_rate_full):'straight run-rate (not enough of last year on file)')+'</div>';
  $('#yoy').innerHTML='<h3 style="margin:0 0 6px">Square net sales <span class="small">what was sold, after refunds and fees</span></h3>'+tiles('square_net_cents','Sales')+'<h3 style="margin:14px 0 6px">Money into the bank <span class="small">Square deposits; Zelle and checks shown separately</span></h3>'+tiles('deposits_cents','Deposits')
    +'<table style="margin-top:8px"><tr><th>Month</th><th class="num">Sales '+d.prev_year+'</th><th class="num">Sales '+d.year+'</th><th class="num">Change</th><th class="num">Deposits '+d.prev_year+'</th><th class="num">Deposits '+d.year+'</th><th class="num">Zelle/checks '+d.year+'</th></tr>'+d.months.map((m,i)=>{ const a=m.last.square_net_cents,b=m.this.square_net_cents; const ch=a&&(+m.month<=d.through_month)?Math.round((b-a)/a*100):null; return '<tr'+(+m.month>d.through_month?' style="color:var(--muted)"':'')+'><td>'+mn[i]+'</td><td class="num">'+usd(a)+'</td><td class="num">'+(+m.month<=d.through_month?usd(b):'')+'</td><td class="num">'+(ch==null?'':'<span class="'+(ch>=0?'up':'down')+'">'+g(ch)+'</span>')+'</td><td class="num">'+usd(m.last.deposits_cents)+'</td><td class="num">'+(+m.month<=d.through_month?usd(m.this.deposits_cents):'')+'</td><td class="num">'+(+m.month<=d.through_month?usd(m.this.other_income_cents):'')+'</td></tr>'; }).join('')+'</table>'
    +'<p class="small" style="margin:8px 0 0">Sales come from Square; deposits are what actually landed in connected bank accounts. If deposits run well below sales, Square is paying out somewhere that is not connected yet. Months after the current one are greyed out.</p>'; }
async function loadTrends(){ const r=await fetch('/api/money/trends'); if(!r.ok) return; const t=await r.json(); const usd=c=>'$'+Math.round((c||0)/100).toLocaleString('en-US'); const neg=c=>usd(-c);
  $('#trend').innerHTML='<table><tr><th>Month</th><th class="num">Sales</th><th class="num">Tickets</th><th class="num">Avg ticket</th><th class="num">To bank</th><th class="num">Zelle/checks</th><th class="num">COGS</th><th class="num">Opex</th><th class="num">Profit</th><th class="num">Margin</th><th class="num">Personal</th><th class="num">Draws</th><th class="num">Unfiled</th></tr>'+t.months.slice().reverse().map(m=>'<tr><td>'+m.month+'</td><td class="num">'+usd(m.square_net_cents)+'</td><td class="num">'+m.payments+'</td><td class="num">'+usd(m.avg_ticket_cents)+'</td><td class="num">'+usd(m.deposits_cents)+'</td><td class="num">'+usd(m.other_income_cents)+'</td><td class="num">'+neg(m.cogs_cents)+'</td><td class="num">'+neg(m.opex_cents)+'</td><td class="num '+(m.ebitda_cents>=0?'up':'down')+'">'+usd(m.ebitda_cents)+'</td><td class="num">'+(m.margin_pct==null?'':m.margin_pct+'%')+'</td><td class="num small">'+neg(m.personal_cents)+'</td><td class="num small">'+neg(m.owner_draw_cents)+'</td><td class="num small">'+neg(m.uncategorized_cents)+'</td></tr>').join('')+'</table><p class="small" style="margin:8px 0 0">Sales are Square net of refunds and fees. Profit = sales + Zelle/checks − COGS − opex, from the bank ledger. Personal, draws and unfiled are shown so you can see what is being kept out; unfiled should be near zero.</p>';
  const cat=(g,title)=>{ const rows=t.categories.filter(c=>c.group===g && (c.recent_cents||c.prior_cents)); return '<div class="card"><h3 style="margin:0 0 6px">'+title+'</h3>'+(rows.length?'<table><tr><th>Category</th><th class="num">Last 12 mo</th><th class="num">12 before</th><th class="num">Change</th><th class="num">% of sales</th><th class="num">Target</th></tr>'+rows.map(c=>'<tr><td>'+esc(c.name)+'</td><td class="num">'+neg(c.recent_cents)+'</td><td class="num">'+neg(c.prior_cents)+'</td><td class="num">'+(c.change_pct==null?'':'<span class="'+(c.change_pct<=0?'up':'down')+'">'+(c.change_pct>0?'+':'')+c.change_pct+'%</span>')+'</td><td class="num">'+(c.share_of_sales_pct==null?'':c.share_of_sales_pct+'%')+'</td><td class="num small">'+(c.target_pct==null?'':'<span class="'+(c.share_of_sales_pct!=null&&c.share_of_sales_pct>c.target_pct?'down':'up')+'">under '+c.target_pct+'%</span>')+'</td></tr>').join('')+'</table>':'<p class="empty">Nothing here</p>')+'</div>'; };
  $('#spend').innerHTML=cat('cogs','Cost of goods')+cat('opex','Operating expenses')+cat('excluded','Kept out of the P&amp;L')
    +'<div class="card"><h3 style="margin:0 0 6px">Biggest vendors, last 12 months</h3><table><tr><th>Vendor</th><th>Filed as</th><th class="num">Paid</th><th class="num">% of sales</th></tr>'+t.vendors.slice(0,25).map(v=>'<tr><td>'+esc(v.vendor)+'<div class="small">'+v.rows+' charges</div></td><td class="small">'+esc(v.category_name)+'</td><td class="num">'+neg(v.total_cents)+'</td><td class="num">'+(v.share_of_sales_pct==null?'':v.share_of_sales_pct+'%')+'</td></tr>').join('')+'</table></div>'
    +'<div class="card"><h3 style="margin:0 0 6px">Best-selling items in Square, last 12 months</h3>'+(t.items.length?'<table><tr><th>Item</th><th class="num">Qty</th><th class="num">Orders</th><th class="num">Revenue</th></tr>'+t.items.map(i=>'<tr><td>'+esc(i.k)+'</td><td class="num">'+(+i.qty).toLocaleString()+'</td><td class="num">'+i.orders+'</td><td class="num">'+usd(i.c)+'</td></tr>').join('')+'</table>':'<p class="empty">Run "Import 2 years of history" on the sales dashboard to fill this.</p>')+'</div>'
    +'<div class="card"><h3 style="margin:0 0 6px">Biggest web customers, last 12 months</h3>'+(t.customers.length?'<table><tr><th>Customer</th><th class="num">Orders</th><th class="num">Paid</th></tr>'+t.customers.map(c=>'<tr><td>'+esc(c.k)+'</td><td class="num">'+c.orders+'</td><td class="num">'+usd(c.paid)+'</td></tr>').join('')+'</table>':'<p class="empty">No paid web orders yet</p>')+'</div>'; }
async function loadPlaid(){ loadSources(); loadYoy(); loadTrends(); const r=await fetch('/api/plaid/items'); const d=await r.json(); $('#plaidenv').textContent=d.configured?d.env:'not set up';
  $('#plaid').innerHTML=d.items.length?'<table>'+d.items.map(it=>'<tr><td><b>'+esc(it.institution)+'</b><div class="small">'+it.accounts.map(a=>'<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin:2px 0"><span>'+esc(a.name)+(a.mask?' …'+a.mask:'')+'</span><button class="btn'+(a.personal?' done':'')+'" data-acct="'+it.item_id+'/accounts/'+a.id+'" data-personal="'+(a.personal?0:1)+'" title="'+(a.personal?'Counted as personal. Click to treat as business.':'Counted as business. Click to keep out of the P&L.')+'">'+(a.personal?'Personal':'Business')+'</button></div>').join('')+'</div>'+(it.status!=='ok'?'<div class="small" style="color:'+(it.status==='pending'?'var(--amber)':'var(--red)')+'">'+esc(it.status==='reconnect'?'Needs reconnecting'+(it.last_error?': '+it.last_error:''):it.last_error||it.status)+'</div>':'')+'</td><td class="num">'+it.balances.map(b=>money(b.available!=null?b.available:b.current)).join('<br>')+'</td><td class="small">'+(it.synced_at?'synced '+new Date(it.synced_at).toLocaleString():'')+'</td><td>'+(it.status==='reconnect'?'<button class="act" data-relink="'+it.item_id+'">Reconnect</button> ':'')+'<button class="act" data-unlink="'+it.item_id+'">Remove</button> <button class="act" data-details="'+it.item_id+'">Details</button></td></tr>').join('')+'</table>':(d.configured?'<p class="empty">No accounts connected yet.</p>':'<p class="small">Add PLAID_CLIENT_ID, PLAID_SECRET and PLAID_ENV to the worker settings to enable the live feed.</p>'); }
async function linkBank(itemId){ $('#plaidmsg').textContent='Opening…'; const r=await fetch('/api/plaid/link-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({item_id:itemId||null})}); const j=await r.json(); if(!j.ok){ $('#plaidmsg').textContent=j.error||'Could not start'; return; }
  const h=Plaid.create({token:j.link_token,onSuccess:async(public_token,metadata)=>{ $('#plaidmsg').textContent='Connecting…'; if(itemId){ await fetch('/api/plaid/sync',{method:'POST'}); } else { const x=await (await fetch('/api/plaid/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({public_token:public_token,metadata:metadata})})).json(); $('#plaidmsg').textContent=x.ok?('Connected '+x.institution+'.'):(x.error||'Failed'); if(x.ok&&x.sync&&x.sync.more){ await pullAll(); return; } } loadPlaid(); load(); },onExit:(err)=>{ $('#plaidmsg').textContent=err?(err.display_message||err.error_message||'Closed'):''; }}); h.open(); }
$('#plaidlink').onclick=()=>linkBank(null);
async function pullAll(){ const b=$('#plaidsync'); b.disabled=true; let tot={added:0,modified:0,removed:0}, errs=[], rounds=0, failures=0;
  while(rounds++<60){ $('#plaidmsg').textContent='Pulling… '+(tot.added?tot.added.toLocaleString()+' transactions so far':'');
    let j; try{ const r=await fetch('/api/plaid/sync',{method:'POST'}); j=await r.json(); }catch(e){ if(++failures>3){ errs.push('The connection dropped; click Pull now again to continue.'); break; } continue; }
    tot.added+=j.added||0; tot.modified+=j.modified||0; tot.removed+=j.removed||0; (j.errors||[]).forEach(x=>{ if(!errs.includes(x)) errs.push(x); }); (j.pending||[]).forEach(x=>{ const m=x+' is still preparing its history; pull again in a few minutes.'; if(!errs.includes(m)) errs.push(m); });
    if(!j.more) break; loadPlaid(); }
  $('#plaidmsg').textContent='Done. Added '+tot.added.toLocaleString()+', changed '+tot.modified+', removed '+tot.removed+(errs.length?'. '+errs.join(' | '):'.'); b.disabled=false; loadPlaid(); load(); }
$('#plaidsync').onclick=pullAll;
document.addEventListener('click',async e=>{ const rl=e.target.closest('button[data-relink]'); if(rl) return linkBank(rl.dataset.relink);
  const dt=e.target.closest('button[data-details]'); if(dt){ dt.disabled=true; const r=await (await fetch('/api/plaid/items/'+dt.dataset.details+'/details')).json(); dt.disabled=false; const w=window.open('','_blank'); if(w){ w.document.write('<pre style="font:13px/1.5 monospace;white-space:pre-wrap;padding:16px">'+JSON.stringify(r,null,2).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</pre>'); w.document.close(); } else alert(JSON.stringify(r,null,2)); return; }
  const ac=e.target.closest('button[data-acct]'); if(ac){ ac.disabled=true; const r=await (await fetch('/api/plaid/items/'+ac.dataset.acct,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({personal:ac.dataset.personal==='1'})})).json(); $('#plaidmsg').textContent=r.ok?((r.personal?'Marked personal. ':'Marked business. ')+r.changed+' transactions re-filed.'):('Could not change it: '+(r.error||'unknown error')); loadPlaid(); load(); return; } const ul=e.target.closest('button[data-unlink]'); if(ul&&confirm('Remove this bank connection? Transactions already in the ledger stay.')){ await fetch('/api/plaid/items/'+ul.dataset.unlink,{method:'DELETE'}); loadPlaid(); } });
loadPlaid();
load(); loadPricing();
</script></body></html>`;
}

// ================================================================ Plaid: live bank feed into the ledger
// Settings: PLAID_CLIENT_ID (Text), PLAID_SECRET (Secret), PLAID_ENV = sandbox | production. One Plaid "item" per bank login.
const PFC_MAP = { INCOME: "other_income", TRANSFER_IN: "transfer", TRANSFER_OUT: "transfer", LOAN_PAYMENTS: "credit_card_payment", BANK_FEES: "bank_fees", ENTERTAINMENT: "personal", FOOD_AND_DRINK: "meals", GENERAL_MERCHANDISE: "uncategorized", HOME_IMPROVEMENT: "supplies", MEDICAL: "personal", PERSONAL_CARE: "personal", GENERAL_SERVICES: "professional", GOVERNMENT_AND_NON_PROFIT: "taxes_licenses", TRANSPORTATION: "vehicle", TRAVEL: "travel", RENT_AND_UTILITIES: "utilities" };
// Re-file every auto-categorized row with the current rules (hand-filed rows and personal-account rows are left alone).
// The Plaid category is recovered from the memo we wrote at import time, so rows can fall back to it when no rule matches.
async function recategorizeAll(env) {
  const rules = await rulesFor(env);
  const rows = (await env.DB.prepare(`SELECT id, description, category, memo FROM bank_txns WHERE (memo IS NULL OR memo LIKE 'Plaid: %') AND matched_payout_id IS NULL`).all()).results;
  const stmts = []; let changed = 0; const moves = {};
  for (const r of rows) {
    const rule = applyRules(rules, r.description);
    let cat, memo = r.memo;
    if (rule) { cat = rule.category; }
    else if (r.memo && r.memo.startsWith("Plaid: ")) { const pfc = r.memo.slice(7).toUpperCase().replace(/ /g, "_"); cat = PFC_MAP[pfc] || "uncategorized"; }
    else cat = r.category === "square_payout" ? "square_payout" : "uncategorized";
    if (cat !== r.category) { changed++; const k = r.category + " -> " + cat; moves[k] = (moves[k] || 0) + 1; stmts.push(env.DB.prepare(`UPDATE bank_txns SET category = ?, vendor = COALESCE(?, vendor) WHERE id = ?`).bind(cat, rule && rule.vendor || null, r.id)); }
  }
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return { ok: true, checked: rows.length, changed, moves };
}
// Ledger sources (one per bank account) with whether a connected bank still feeds them. Rows left behind by a removed or
// re-linked connection are duplicates or sandbox data and can be deleted by source.
async function bankSources(env) {
  const rows = (await env.DB.prepare(`SELECT source, COUNT(*) n, COALESCE(SUM(amount_cents),0) c, MIN(posted_at) first, MAX(posted_at) last FROM bank_txns GROUP BY source ORDER BY source`).all()).results;
  const live = new Set();
  for (const it of (await env.DB.prepare(`SELECT institution, accounts FROM plaid_items`).all()).results)
    for (const a of JSON.parse(it.accounts || "[]")) live.add(`${it.institution} ${a.name}${a.mask ? " …" + a.mask : ""}`);
  return rows.map((r) => ({ source: r.source, rows: r.n, total_cents: r.c, first: r.first, last: r.last, attached: live.has(r.source) || !/\S/.test(r.source || "") || !(r.source || "").match(/…\d{4}$/) }));
}
async function deleteSource(env, source) {
  if (!source) return { ok: false, error: "No source given" };
  const r = await env.DB.prepare(`DELETE FROM bank_txns WHERE source = ?`).bind(source).run();
  return { ok: true, deleted: r.meta ? r.meta.changes : 0 };
}
function plaidHost(env) { return `https://${(env.PLAID_ENV || "sandbox").toLowerCase() === "production" ? "production" : "sandbox"}.plaid.com`; }
async function plaid(env, path, body) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) return { ok: false, error: "PLAID_CLIENT_ID / PLAID_SECRET not set" };
  const res = await fetch(plaidHost(env) + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error_message || data.error_code || ("Plaid " + res.status), code: data.error_code };
  return { ok: true, data };
}
async function plaidLinkToken(env, itemId) {
  const body = { client_name: "HD Laser Studio", user: { client_user_id: "hdlaser-owner" }, country_codes: ["US"], language: "en" };
  if (itemId) { const it = await env.DB.prepare(`SELECT access_token FROM plaid_items WHERE item_id = ?`).bind(itemId).first(); if (!it) return { ok: false, error: "Unknown item" }; body.access_token = it.access_token; }
  else { body.products = ["transactions"]; body.transactions = { days_requested: 730 }; }
  const r = await plaid(env, "/link/token/create", body);
  return r.ok ? { ok: true, link_token: r.data.link_token, env: (env.PLAID_ENV || "sandbox") } : r;
}
async function plaidExchange(env, body) {
  const r = await plaid(env, "/item/public_token/exchange", { public_token: body.public_token });
  if (!r.ok) return r;
  const inst = (body.metadata && body.metadata.institution && body.metadata.institution.name) || "Bank";
  const accounts = (body.metadata && body.metadata.accounts) || [];
  await env.DB.prepare(`INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution, accounts, cursor, status, created_at) VALUES (?,?,?,?,?,?,?)`)
    .bind(r.data.item_id, r.data.access_token, inst, JSON.stringify(accounts.map((a) => ({ id: a.id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype }))), "", "ok", new Date().toISOString()).run();
  const sync = await plaidSync(env, r.data.item_id, 2);
  return { ok: true, item_id: r.data.item_id, institution: inst, accounts: accounts.length, sync };
}
// Pull new/changed/removed transactions since the stored cursor, plus current balances.
// maxPages caps the work per call (a first pull of two years can be thousands of rows); the response says more:true
// when a bank still has pages left, and the cursor is saved after every page so the next call carries on.
async function plaidSync(env, onlyItem, maxPages = 4) {
  const items = (await env.DB.prepare(`SELECT * FROM plaid_items${onlyItem ? " WHERE item_id = ?" : ""}`).bind(...(onlyItem ? [onlyItem] : [])).all()).results;
  const out = { items: items.length, added: 0, modified: 0, removed: 0, errors: [], more: false };
  const rules = await rulesFor(env);
  for (const it of items) {
    try {
      const accts = JSON.parse(it.accounts || "[]"); const acctName = (id) => { const a = accts.find((x) => x.id === id); return a ? `${it.institution} ${a.name}${a.mask ? " …" + a.mask : ""}` : it.institution; };
      const personalIds = new Set(accts.filter((a) => a.personal).map((a) => a.id));
      let cursor = it.cursor || "", more = true, guard = 0;
      while (more && guard++ < maxPages) {
        const r = await plaid(env, "/transactions/sync", { access_token: it.access_token, cursor, count: 250 });
        if (!r.ok) {
          if (r.code === "PRODUCT_NOT_READY") { // the bank is still preparing history for a new connection; not a fault
            await env.DB.prepare(`UPDATE plaid_items SET status = 'pending', last_error = ? WHERE item_id = ?`).bind("Still preparing transaction history. Pull again in a few minutes.", it.item_id).run();
            out.pending = (out.pending || []).concat(it.institution); more = false; break;
          }
          await env.DB.prepare(`UPDATE plaid_items SET status = ?, last_error = ? WHERE item_id = ?`).bind(r.code === "ITEM_LOGIN_REQUIRED" ? "reconnect" : "error", r.error, it.item_id).run(); out.errors.push(`${it.institution}: ${r.error}`); more = false; break; }
        const d = r.data;
        const stmts = [];
        for (const t of [...(d.added || []), ...(d.modified || [])]) {
          if (t.pending) continue;
          const cents = -Math.round((t.amount || 0) * 100); // Plaid: positive = money out
          const desc = String(t.merchant_name || t.name || "").slice(0, 200);
          const rule = applyRules(rules, t.name || desc) || applyRules(rules, desc);
          const pfc = t.personal_finance_category && t.personal_finance_category.primary;
          const personalAcct = personalIds.has(t.account_id);
          const cat = personalAcct ? "personal" : (rule ? rule.category : (pfc === "RENT_AND_UTILITIES" && /RENT/.test(t.personal_finance_category.detailed || "") ? "rent" : (PFC_MAP[pfc] || "uncategorized")));
          const memo = personalAcct ? "Personal account" : (rule ? null : (pfc ? "Plaid: " + pfc.toLowerCase().replace(/_/g, " ") : null));
          stmts.push(env.DB.prepare(`INSERT INTO bank_txns (hash, source, posted_at, amount_cents, description, category, vendor, memo, imported_at) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(hash) DO UPDATE SET posted_at = excluded.posted_at, amount_cents = excluded.amount_cents, description = excluded.description`)
            .bind("plaid:" + t.transaction_id, acctName(t.account_id), t.date, cents, desc, cat, rule && rule.vendor || null, memo, new Date().toISOString()));
        }
        out.added += (d.added || []).length; out.modified += (d.modified || []).length;
        for (const rm of d.removed || []) { stmts.push(env.DB.prepare(`DELETE FROM bank_txns WHERE hash = ?`).bind("plaid:" + rm.transaction_id)); out.removed++; }
        cursor = d.next_cursor || cursor; more = !!d.has_more;
        stmts.push(env.DB.prepare(`UPDATE plaid_items SET cursor = ?, status = 'ok', last_error = NULL, synced_at = ? WHERE item_id = ?`).bind(cursor, new Date().toISOString(), it.item_id));
        for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100)); // one round trip per 100 rows, cursor last
      }
      if (more) out.more = true;
      const b = await plaid(env, "/accounts/balance/get", { access_token: it.access_token });
      if (b.ok) {
        const bal = {}; let checking = 0, any = false;
        for (const a of b.data.accounts || []) { bal[a.account_id] = { name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, current: Math.round((a.balances.current || 0) * 100), available: a.balances.available == null ? null : Math.round(a.balances.available * 100) }; if (a.type === "depository") { checking += Math.round((a.balances.available != null ? a.balances.available : a.balances.current || 0) * 100); any = true; } }
        await env.DB.prepare(`UPDATE plaid_items SET balances = ? WHERE item_id = ?`).bind(JSON.stringify(bal), it.item_id).run();
        if (any) await saveFinSettings(env, { cash_balance_cents: await totalDepository(env), cash_as_of: new Date().toISOString().slice(0, 10) });
      }
    } catch (e) { out.errors.push(`${it.institution}: ${e && e.message || e}`); }
  }
  if (items.length) await reconcile(env);
  return out;
}
// Business cash on hand: checking/savings balances across banks, leaving out accounts flagged personal.
async function totalDepository(env) {
  const items = (await env.DB.prepare(`SELECT accounts, balances FROM plaid_items`).all()).results; let sum = 0;
  for (const it of items) {
    const personal = new Set(JSON.parse(it.accounts || "[]").filter((a) => a.personal).map((a) => a.id));
    for (const [id, a] of Object.entries(JSON.parse(it.balances || "{}"))) if (a.type === "depository" && !personal.has(id)) sum += a.available != null ? a.available : a.current;
  }
  return sum;
}
async function plaidItems(env) {
  const items = (await env.DB.prepare(`SELECT item_id, institution, accounts, balances, status, last_error, synced_at, created_at FROM plaid_items ORDER BY created_at`).all()).results;
  return items.map((it) => ({ ...it, accounts: JSON.parse(it.accounts || "[]"), balances: Object.values(JSON.parse(it.balances || "{}")) }));
}
// Mark one account at a bank as personal (kept out of the business P&L) or business. Re-files the transactions already
// imported from that account, except ones the owner categorized by hand.
async function plaidAccountFlag(env, itemId, accountId, body) {
  const it = await env.DB.prepare(`SELECT institution, accounts FROM plaid_items WHERE item_id = ?`).bind(itemId).first();
  if (!it) return { ok: false, error: "Unknown bank" };
  const accts = JSON.parse(it.accounts || "[]"); const a = accts.find((x) => x.id === accountId);
  if (!a) return { ok: false, error: "Unknown account" };
  const personal = !!body.personal;
  a.personal = personal;
  await env.DB.prepare(`UPDATE plaid_items SET accounts = ? WHERE item_id = ?`).bind(JSON.stringify(accts), itemId).run();
  const source = `${it.institution} ${a.name}${a.mask ? " …" + a.mask : ""}`;
  let changed = 0;
  if (personal) {
    // everything auto-filed from this account moves to personal; hand-filed rows (custom memo) stay put
    const r = await env.DB.prepare(`UPDATE bank_txns SET category = 'personal', memo = 'Personal account' WHERE source = ? AND category != 'personal' AND (memo IS NULL OR memo LIKE 'Plaid: %' OR memo = 'Personal account')`).bind(source).run();
    changed = r.meta ? r.meta.changes : 0;
  } else {
    // back to business: re-run the merchant rules on rows we had filed as personal-account, else leave them to be categorized
    const rows = (await env.DB.prepare(`SELECT id, description FROM bank_txns WHERE source = ? AND memo = 'Personal account'`).bind(source).all()).results;
    const rules = await rulesFor(env); const stmts = [];
    for (const row of rows) { const rule = applyRules(rules, row.description); stmts.push(env.DB.prepare(`UPDATE bank_txns SET category = ?, vendor = ?, memo = NULL WHERE id = ?`).bind(rule ? rule.category : "uncategorized", rule && rule.vendor || null, row.id)); }
    for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
    changed = rows.length;
  }
  if (a.type === "depository") await saveFinSettings(env, { cash_balance_cents: await totalDepository(env) });
  return { ok: true, personal, changed, source };
}
// What Plaid itself says about a connection: institution, products, and the current error object. For troubleshooting.
async function plaidItemDetails(env, itemId) {
  const it = await env.DB.prepare(`SELECT access_token, institution, status, last_error FROM plaid_items WHERE item_id = ?`).bind(itemId).first();
  if (!it) return { ok: false, error: "Unknown bank" };
  const r = await plaid(env, "/item/get", { access_token: it.access_token });
  if (!r.ok) return { ok: false, institution: it.institution, our_status: it.status, our_error: it.last_error, plaid_error: r.error, plaid_code: r.code };
  const item = r.data.item || {};
  const out = { ok: true, institution: it.institution, institution_id: item.institution_id, institution_name: item.institution_name, our_status: it.status, our_error: it.last_error,
    products: item.products, billed: item.billed_products, consented: item.consented_products, available: item.available_products, consent_expires: item.consent_expiration_time, update_type: item.update_type,
    error: item.error ? { code: item.error.error_code, type: item.error.error_type, message: item.error.error_message, display: item.error.display_message } : null, status: r.data.status || null };
  const b = await plaid(env, "/accounts/get", { access_token: it.access_token });
  out.accounts_call = b.ok ? { ok: true, accounts: (b.data.accounts || []).map((a) => ({ name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })) } : { ok: false, error: b.error, code: b.code };
  const t = await plaid(env, "/transactions/sync", { access_token: it.access_token, cursor: "", count: 1 });
  out.transactions_call = t.ok ? { ok: true, has_more: !!t.data.has_more, sample: (t.data.added || []).length } : { ok: false, error: t.error, code: t.code };
  return out;
}
async function plaidRemove(env, itemId) {
  const it = await env.DB.prepare(`SELECT access_token FROM plaid_items WHERE item_id = ?`).bind(itemId).first();
  if (!it) return { ok: false, error: "Unknown item" };
  await plaid(env, "/item/remove", { access_token: it.access_token });
  const full = await env.DB.prepare(`SELECT institution, accounts FROM plaid_items WHERE item_id = ?`).bind(itemId).first();
  let deleted = 0;
  for (const a of JSON.parse(full.accounts || "[]")) { const r = await env.DB.prepare(`DELETE FROM bank_txns WHERE source = ?`).bind(`${full.institution} ${a.name}${a.mask ? " …" + a.mask : ""}`).run(); deleted += r.meta ? r.meta.changes : 0; }
  await env.DB.prepare(`DELETE FROM plaid_items WHERE item_id = ?`).bind(itemId).run();
  return { ok: true, deleted };
}

// ---------------------------------------------------------------- price book, custom orders, pricing review
// One structured price list drives the order builder on the website, the in-store screen, the checkout and the weekly
// pricing review. It lives in D1 (meta.price_book); DEFAULT_BOOK seeds it. Every change, manual or approved, is logged
// to price_history, and the review only ever *suggests*: the owner approves or denies each change on the money page.
const ATTEST_VERSION = "2026-09-26";
const TARGET_MARGIN = 0.55;          // every piece should clear this after blank, labor and consumables
const DEFAULT_BOOK = {
  version: 1,
  services: [
    { key: "engrave", name: "Laser engraving", blurb: "Etched into the surface. Permanent, one tone.", setup_cents: 2500, min_per_piece: 4, per_inch: 2, consumable_cents: 8 },
    { key: "uv", name: "UV printing", blurb: "Full color, printed onto the surface.", setup_cents: 3500, min_per_piece: 3, per_inch: 1.5, consumable_cents: 35 },
  ],
  // Price per piece by the artwork's longest side, in half-inch steps. Each step up costs a little more than the step
  // before it (first_gap, then +gap_growth every step), so the bigger the engraving the more it carries, and the next
  // size up always looks like a small jump. sizes[] is generated from these once, then edited cell by cell.
  ladders: { engrave: { start_cents: 800, first_gap_cents: 150, gap_growth_cents: 50 }, uv: { start_cents: 1000, first_gap_cents: 175, gap_growth_cents: 50 } },
  max_inches: 8,
  sizes: [],
  materials: [
    { key: "wood", name: "Wood", factor: 1, services: ["engrave", "uv"] },
    { key: "metal", name: "Metal", factor: 1.25, services: ["engrave", "uv"] },
    { key: "glass", name: "Glass", factor: 1.35, services: ["engrave", "uv"] },
    { key: "leather", name: "Leather", factor: 1.1, services: ["engrave"] },
    { key: "acrylic", name: "Acrylic or plastic", factor: 1.1, services: ["engrave", "uv"] },
    { key: "stone", name: "Stone or slate", factor: 1.4, services: ["engrave"] },
  ],
  // blank_cents is what the customer pays for the item when we supply it; cost_cents is what it costs us (never shown).
  products: [
    { key: "tumbler", name: "20 oz tumbler", material: "metal", blank_cents: 2200, cost_cents: 900, max_inches: 3.5, w_in: 3.5, h_in: 8.25, shape: "tumbler", photo: "/assets/corp-crest-tumbler.jpg" },
    { key: "bottle", name: "Water bottle", material: "metal", blank_cents: 2400, cost_cents: 1000, max_inches: 3, w_in: 3, h_in: 10, shape: "bottle", photo: "/assets/corp-ucsd-bottle.jpg" },
    { key: "pint", name: "Pint glass", material: "glass", blank_cents: 900, cost_cents: 300, max_inches: 3, w_in: 3.5, h_in: 6, shape: "glass", photo: "/assets/engrave-wine-glasses.jpg" },
    { key: "board", name: "Cutting board", material: "wood", blank_cents: 3200, cost_cents: 1400, max_inches: 8, w_in: 10, h_in: 14, shape: "board", photo: "/assets/wood-wedding-board.jpg" },
    { key: "plaque", name: "Wood plaque", material: "wood", blank_cents: 2800, cost_cents: 1100, max_inches: 7, w_in: 8, h_in: 10, shape: "plaque", photo: "/assets/engrave-tree-plaque.jpg" },
    { key: "tag", name: "Metal tag or plate", material: "metal", blank_cents: 600, cost_cents: 150, max_inches: 2.5, w_in: 3, h_in: 2, shape: "tag", photo: "/assets/engrave-anodized-tags.jpg" },
    { key: "patch", name: "Leather patch or wallet", material: "leather", blank_cents: 1400, cost_cents: 500, max_inches: 2.5, w_in: 3.5, h_in: 2.5, shape: "patch", photo: "/assets/uv-mandala-wallet.jpg" },
    { key: "own", name: "Something I'll bring in", material: null, blank_cents: 0, cost_cents: 0, max_inches: 8, w_in: 8, h_in: 8, shape: "own", photo: null },
  ],
  qty_breaks: [{ min: 1, off_pct: 0 }, { min: 6, off_pct: 5 }, { min: 12, off_pct: 10 }, { min: 25, off_pct: 15 }, { min: 50, off_pct: 20 }, { min: 100, off_pct: 25 }],
  rush_pct: 50,                       // added to the work portion when they need it in under 3 business days
  own_item_handling_cents: 300,       // per piece on customer-supplied items: inspection, test fit, no replacement stock
  min_order_cents: 2500,
};
function ladderPrices(l, steps) { const out = []; let p = l.start_cents; for (let i = 0; i < steps; i++) { out.push(Math.round(p / 25) * 25); p += l.first_gap_cents + i * l.gap_growth_cents; } return out; }
function buildSizes(book) { const n = Math.round(book.max_inches / 0.5); const e = ladderPrices(book.ladders.engrave, n), u = ladderPrices(book.ladders.uv, n); return Array.from({ length: n }, (_, i) => ({ inches: (i + 1) / 2, engrave_cents: e[i], uv_cents: u[i] })); }
DEFAULT_BOOK.sizes = buildSizes(DEFAULT_BOOK);

async function priceBook(env) {
  const row = env.DB ? await env.DB.prepare(`SELECT v FROM meta WHERE k = 'price_book'`).first() : null;
  if (!row) return JSON.parse(JSON.stringify(DEFAULT_BOOK));
  let s = {}; try { s = JSON.parse(row.v); } catch {}
  const book = { ...JSON.parse(JSON.stringify(DEFAULT_BOOK)), ...s };
  if (!Array.isArray(book.sizes) || !book.sizes.length) book.sizes = buildSizes(book);
  return book;
}
async function saveBook(env, book) { book.updated_at = new Date().toISOString(); await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('price_book', ?)`).bind(JSON.stringify(book)).run(); return book; }
function publicBook(book) { return { ...book, products: book.products.map(({ cost_cents, ...p }) => p), ladders: undefined }; }
function r25(c) { return Math.max(0, Math.round(c / 25) * 25); }

// Price one spec against the book. Returns { error } or the full breakdown in cents.
function quoteSpec(book, spec) {
  const product = book.products.find((p) => p.key === String(spec.product || ""));
  if (!product) return { error: "Pick what we're putting it on" };
  const matKey = product.material || String(spec.material || "");
  const material = book.materials.find((m) => m.key === matKey);
  if (!material) return { error: "Pick the material" };
  const service = book.services.find((s) => s.key === String(spec.service || ""));
  if (!service) return { error: "Pick engraving or printing" };
  if (!material.services.includes(service.key)) return { error: `${service.name} isn't available on ${material.name.toLowerCase()}` };
  const inches = Math.round(Number(spec.inches) * 2) / 2;
  const maxIn = Math.min(product.max_inches || book.max_inches, book.max_inches);
  if (!(inches >= 0.5 && inches <= maxIn)) return { error: `Size must be between 0.5 and ${maxIn} inches` };
  const qty = parseInt(spec.qty, 10);
  if (!(qty >= 1 && qty <= 500)) return { error: "Quantity must be 1 to 500" };
  const rush = !!spec.rush;
  const size = book.sizes.find((s) => s.inches === inches);
  if (!size) return { error: "Size not on the price list" };
  const workUnit = r25(size[service.key + "_cents"] * material.factor);
  const brk = [...book.qty_breaks].sort((a, b) => b.min - a.min).find((b) => qty >= b.min) || { off_pct: 0 };
  const workUnitAfter = r25(workUnit * (1 - brk.off_pct / 100));
  const handlingUnit = product.key === "own" ? book.own_item_handling_cents : 0;
  const blankUnit = product.blank_cents || 0;
  const work = workUnitAfter * qty, blank = blankUnit * qty, handling = handlingUnit * qty;
  const rushCents = rush ? r25(work * book.rush_pct / 100) : 0;
  const setup = service.setup_cents;
  let subtotal = work + blank + handling + rushCents + setup;
  const minimumTopUp = Math.max(0, book.min_order_cents - subtotal); subtotal += minimumTopUp;
  const nextBreak = [...book.qty_breaks].sort((a, b) => a.min - b.min).find((b) => b.min > qty);
  return { product, material, service, inches, qty, rush, work_unit_cents: workUnit, work_unit_after_cents: workUnitAfter, discount_pct: brk.off_pct, discount_cents: (workUnit - workUnitAfter) * qty,
    blank_unit_cents: blankUnit, handling_unit_cents: handlingUnit, work_cents: work, blank_cents: blank, handling_cents: handling, rush_cents: rushCents, setup_cents: setup, minimum_top_up_cents: minimumTopUp, subtotal_cents: subtotal,
    next_break: nextBreak ? { min: nextBreak.min, off_pct: nextBreak.off_pct } : null,
    summary: `${qty} × ${service.name.toLowerCase()}, ${inches} in on ${product.key === "own" ? "customer's own " + material.name.toLowerCase() + " item" : product.name.toLowerCase()}${rush ? ", rush" : ""}` };
}
// The exact words the customer initials. Rendered identically on the order page; the copy stored with the order is this one.
function attestText(q, name) {
  return `I, ${name}, have checked this order myself. HD Laser Studio will make exactly what I have specified here: ${q.service.name.toLowerCase()} on ${q.product.key === "own" ? "my own " + q.material.name.toLowerCase() + " item" : "a " + q.product.name.toLowerCase()}, artwork ${q.inches} inches on its longest side, quantity ${q.qty}. I understand that engraving and printing are permanent and cannot be undone. If the size, spelling, artwork or quantity I chose turns out to be wrong, or I change my mind after approving the proof, any redo or replacement is at my expense.`;
}
function initialsFor(name) { const w = String(name || "").trim().split(/\s+/).filter(Boolean); if (!w.length) return ""; return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : "")).toUpperCase(); }

async function orderCheckout(request, env, cors) {
  let b; try { b = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (rateLimited("order:" + ip, 10, 600000)) return json({ error: "Too many attempts. Please wait a few minutes." }, 429, cors);
  const book = await priceBook(env);
  const q = quoteSpec(book, b.spec || {});
  if (q.error) return json({ error: q.error }, 400, cors);
  const c = b.customer || {};
  const email = String(c.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Valid email required" }, 400, cors);
  const name = String(c.name || "").trim().slice(0, 80);
  if (name.length < 2) return json({ error: "Your name is required" }, 400, cors);
  if (!c.agreed) return json({ error: "Terms must be accepted" }, 400, cors);
  const a = b.attest || {};
  const initials = String(a.initials || "").trim().toUpperCase().replace(/[^A-Z]/g, "");
  const expect = initialsFor(name);
  if (initials.length < 2 || initials.length > 4) return json({ error: "Type your initials to confirm the order" }, 400, cors);
  if (!initials.startsWith(expect)) return json({ error: `Your initials should start with ${expect.split("").join(".")}. so they match the name on the order` }, 400, cors);
  const text = attestText(q, name);
  const ref = /^HD-[A-Z0-9]{4,12}$/.test(String(b.ref || "")) ? b.ref : "HD-" + Date.now().toString(36).toUpperCase();
  const now = new Date().toISOString();
  const ua = (request.headers.get("User-Agent") || "").slice(0, 200);
  const hash = await sha256hex([ref, initials, text, now, email].join("|"));
  const notes = String(b.notes || "").trim().slice(0, 2000);
  const neededBy = /^\d{4}-\d{2}-\d{2}$/.test(String(b.needed_by || "")) ? b.needed_by : null;
  const takenBy = String(b.taken_by || "").trim().slice(0, 60) || null;
  const taxRate = parseFloat(env.TAX_RATE || "0.0775") || 0;
  const tax = Math.round(q.subtotal_cents * taxRate);
  const total = q.subtotal_cents + tax;
  // logo, if they added one: a small data URL kept with the order so nobody has to chase the file
  let logo = null; const L = b.logo || {};
  if (L.data && /^data:(image\/(png|jpeg|webp|svg\+xml));base64,[A-Za-z0-9+/=]+$/.test(String(L.data)) && String(L.data).length <= 950000) logo = { name: String(L.name || "logo").slice(0, 120), type: String(L.data).slice(5, String(L.data).indexOf(";")), data: String(L.data) };

  const lineItems = [{ name: `${q.service.name}, ${q.inches} in on ${q.product.key === "own" ? "customer's " + q.material.name.toLowerCase() + " item" : q.product.name.toLowerCase()}${q.discount_pct ? ` (${q.discount_pct}% quantity discount)` : ""}`, quantity: String(q.qty), base_price_money: { amount: q.work_unit_after_cents, currency: "USD" } }];
  if (q.blank_unit_cents) lineItems.push({ name: q.product.name, quantity: String(q.qty), base_price_money: { amount: q.blank_unit_cents, currency: "USD" } });
  if (q.handling_unit_cents) lineItems.push({ name: "Customer-supplied item handling", quantity: String(q.qty), base_price_money: { amount: q.handling_unit_cents, currency: "USD" } });
  lineItems.push({ name: `${q.service.name} setup (artwork prep, one time)`, quantity: "1", base_price_money: { amount: q.setup_cents, currency: "USD" } });
  if (q.rush_cents) lineItems.push({ name: `Rush (+${book.rush_pct}% on the work)`, quantity: "1", base_price_money: { amount: q.rush_cents, currency: "USD" } });
  if (q.minimum_top_up_cents) lineItems.push({ name: "Shop minimum", quantity: "1", base_price_money: { amount: q.minimum_top_up_cents, currency: "USD" } });
  const order = { location_id: env.SQUARE_LOCATION_ID, reference_id: ref, line_items: lineItems };
  if (tax) order.taxes = [{ uid: "ca-sales-tax", name: "CA sales tax", percentage: String(+(taxRate * 100).toFixed(3)), scope: "ORDER" }];
  let linkOk = false, data = {};
  if (env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID) {
    const payload = { idempotency_key: `${ref}-${Date.now()}`, order,
      checkout_options: { redirect_url: `${env.SITE_URL}/thanks/?paid=1&kind=custom&ref=${encodeURIComponent(ref)}${logo ? "&logo=1" : ""}`, ask_for_shipping_address: false, merchant_support_email: env.SUPPORT_EMAIL, allow_tipping: false },
      pre_populated_data: { buyer_email: email, buyer_phone_number: e164(c.phone) },
      payment_note: `hdlaser.net order ${ref}: ${q.summary} for ${c.business || name}`.slice(0, 500) };
    const res = await squareFetch(env, "/v2/online-checkout/payment-links", { method: "POST", body: JSON.stringify(payload) });
    data = await res.json().catch(() => ({}));
    linkOk = res.ok && !!data.payment_link;
    if (!linkOk) console.error("Square error", res.status, JSON.stringify(data).slice(0, 800));
  }
  const spec = { product: q.product.key, material: q.material.key, service: q.service.key, inches: q.inches, qty: q.qty, rush: q.rush, summary: q.summary, work_unit_cents: q.work_unit_cents, work_unit_after_cents: q.work_unit_after_cents, discount_pct: q.discount_pct, blank_unit_cents: q.blank_unit_cents, handling_unit_cents: q.handling_unit_cents, setup_cents: q.setup_cents, rush_cents: q.rush_cents, minimum_top_up_cents: q.minimum_top_up_cents, subtotal_cents: q.subtotal_cents, tax_cents: tax, book_version: book.version, book_updated_at: book.updated_at || null };
  if (env.DB) {
    let assetId = null;
    if (logo) { const ins = await env.DB.prepare(`INSERT INTO order_assets (ref, created_at, name, type, bytes, data) VALUES (?,?,?,?,?,?)`).bind(ref, now, logo.name, logo.type, Math.round(logo.data.length * 0.75), logo.data).run(); assetId = ins.meta && ins.meta.last_row_id; }
    await env.DB.batch([
      env.DB.prepare(`INSERT OR REPLACE INTO orders (ref, created_at, status, business, name, email, phone, notes, text_consent, cups, base_price_cents, cups_subtotal_cents, setup_fee_cents, total_cents, deposit_percent, square_order_id, kind, spec, needed_by, rush, taken_by, tax_cents, tax_invoiced_at, attest_initials, attest_text, attest_at, attest_ip, attest_ua, attest_hash, logo_asset_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(ref, now, linkOk ? "checkout_started" : "pay_later", String(c.business || "").trim().slice(0, 80), name, email, String(c.phone || "").trim().slice(0, 40), notes, c.textConsent ? 1 : 0,
        null, q.work_unit_cents, q.subtotal_cents - q.setup_cents, q.setup_cents, total, 100, linkOk ? (data.payment_link.order_id || null) : null, "custom", JSON.stringify(spec), neededBy, q.rush ? 1 : 0, takenBy, tax, tax ? now : null, initials, text, now, ip, ua, hash, assetId),
      env.DB.prepare(`DELETE FROM order_items WHERE ref = ?`).bind(ref),
      env.DB.prepare(`INSERT INTO order_items (ref, product, material, service, inches, qty, work_unit_cents, blank_unit_cents, discount_pct, line_cents) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(ref, q.product.key, q.material.key, q.service.key, q.inches, q.qty, q.work_unit_after_cents, q.blank_unit_cents, q.discount_pct, q.work_cents + q.blank_cents + q.handling_cents),
      env.DB.prepare(`INSERT INTO events (ts, name, session, ref, path, detail) VALUES (?,?,?,?,?,?)`).bind(now, "order_checkout", null, ref, "/order/", JSON.stringify({ product: q.product.key, service: q.service.key, inches: q.inches, qty: q.qty })),
    ]);
  }
  // tell the shop and the customer straight away; payment confirmation follows from the Square webhook
  const $ = (n) => "$" + (n / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const who = c.business ? `${c.business} (${name})` : name;
  const breakdown = [`${q.qty} × ${q.service.name.toLowerCase()} ${q.inches} in @ ${$(q.work_unit_after_cents)}${q.discount_pct ? ` (${q.discount_pct}% off for quantity)` : ""}`, q.blank_unit_cents ? `${q.qty} × ${q.product.name} @ ${$(q.blank_unit_cents)}` : "", q.handling_unit_cents ? `${q.qty} × customer-supplied item handling @ ${$(q.handling_unit_cents)}` : "", `Setup ${$(q.setup_cents)}`, q.rush_cents ? `Rush ${$(q.rush_cents)}` : "", q.minimum_top_up_cents ? `Shop minimum ${$(q.minimum_top_up_cents)}` : "", tax ? `Sales tax ${$(tax)}` : "", `Total ${$(total)}`].filter(Boolean).join("\n");
  if (env.RESEND_API_KEY) {
    await sendEmail(env, { to: env.SUPPORT_EMAIL, replyTo: email, subject: `${linkOk ? "Order" : "Order (needs payment link)"} ${ref}: ${who}, ${$(total)}`, text:
`New order ${ref} from hdlaser.net${takenBy ? " (taken at the counter by " + takenBy + ")" : ""}

Customer: ${[name, c.business, email, c.phone].filter(Boolean).join(" · ")}
${q.summary}
${neededBy ? "Needed by: " + neededBy + "\n" : ""}${notes ? "Notes: " + notes + "\n" : ""}
${breakdown}

Logo: ${logo ? "attached to the order in the dashboard (" + logo.name + ")" : "not uploaded, ask for it"}
Sizing confirmation: initialed "${initials}" at ${now} from ${ip || "unknown IP"}.
"${text}"

${linkOk ? "They were sent to Square to pay." : "Square did not return a payment link. Send them a Square invoice for " + $(total) + "."}
Dashboard: ${env.WORKER_URL || ""}/admin` });
    const first = name.split(" ")[0] || "there";
    await sendEmail(env, { to: email, subject: `We've got your order ${ref}`, text:
`Hi ${first},

Thanks for your order. Here's what we have on file:

${q.summary}
${breakdown}
${neededBy ? "\nNeeded by " + neededBy + "." : ""}
${logo ? "Your logo file came through with the order." : "Send your logo or artwork to " + env.SUPPORT_EMAIL + " or text it to (858) 373-9866 (vector AI/EPS/SVG/PDF is best; a clean PNG works)."}
${linkOk ? "If you completed payment, you're all set." : "Payment didn't go through online, so we'll email you a secure payment link shortly."}

What happens next:
1. Digital proof by email within 1-2 business days.
2. You approve it. Unlimited revisions until it's right.
3. We make it and text you when it's ready for pickup in Pacific Beach.

Your sizing confirmation (initialed ${initials}):
"${text}"

HD Laser Studio
759 Turquoise St, Pacific Beach
(858) 373-9866 · hdlaser.net` });
  }
  await sendAlert(env, `Order ${ref}: ${who}, ${q.summary}, ${$(total)}. ${linkOk ? "Paying through Square." : "NEEDS A PAYMENT LINK."}`);
  if (!linkOk) return json({ ok: true, url: null, ref, total: total / 100, error: env.SQUARE_ACCESS_TOKEN ? squareErr(data) || "Square did not return a checkout link" : "Online payment is not set up" }, 200, cors);
  return json({ ok: true, url: data.payment_link.url, ref, total: total / 100 }, 200, cors);
}

// ---- pricing review: rules that look at the book, the costs and what customers actually do, and write suggestions
function targetKey(t) { return JSON.stringify(t); }
function describeTarget(book, t) {
  if (t.type === "size") return `${(book.services.find((s) => s.key === t.service) || {}).name}, ${t.inches} in`;
  if (t.type === "product") return `${(book.products.find((p) => p.key === t.key) || {}).name} (item price)`;
  if (t.type === "ladder") return `Every ${(book.services.find((s) => s.key === t.service) || {}).name.toLowerCase()} size`;
  return t.type;
}
function readTarget(book, t) {
  if (t.type === "size") { const s = book.sizes.find((x) => x.inches === t.inches); return s ? s[t.service + "_cents"] : null; }
  if (t.type === "product") { const p = book.products.find((x) => x.key === t.key); return p ? p[t.field || "blank_cents"] : null; }
  if (t.type === "ladder") { const s = book.sizes.find((x) => x.inches === 2) || book.sizes[0]; return s ? s[t.service + "_cents"] : null; }
  return null;
}
function applyTarget(book, t, cents) {
  if (t.type === "size") { const s = book.sizes.find((x) => x.inches === t.inches); if (s) s[t.service + "_cents"] = r25(cents); }
  else if (t.type === "product") { const p = book.products.find((x) => x.key === t.key); if (p) p[t.field || "blank_cents"] = r25(cents); }
  else if (t.type === "ladder") { const f = 1 + (t.pct || 0) / 100; for (const s of book.sizes) s[t.service + "_cents"] = r25(s[t.service + "_cents"] * f); }
  return book;
}
async function analyzePricing(env) {
  if (!env.DB) return { ok: false, error: "No database" };
  const book = await priceBook(env);
  const settings = await finSettings(env);
  const now = new Date(), nowIso = now.toISOString();
  const since90 = new Date(now - 90 * 86400000).toISOString();
  const $ = (c) => "$" + (c / 100).toFixed(2);
  const found = [];
  // 1. The size ladder must keep climbing by a little more each step.
  for (const svc of book.services) {
    const k = svc.key + "_cents"; const p = book.sizes.map((s) => s[k]);
    for (let i = 2; i < p.length; i++) {
      const gap = p[i] - p[i - 1], prev = p[i - 1] - p[i - 2];
      if (gap < prev) { const proposed = p[i - 1] + prev; p[i] = proposed;
        found.push({ rule: "ladder_shape", target: { type: "size", service: svc.key, inches: book.sizes[i].inches }, current: book.sizes[i][k], proposed,
          reason: `Bigger artwork should cost a little more per half inch than the step before it. That keeps every "next size up" feeling like a small jump while the large sizes carry the margin. Right now ${book.sizes[i].inches} in ${svc.name.toLowerCase()} is only ${$(gap)} more than ${book.sizes[i - 1].inches} in, but the step below it is ${$(prev)}. Setting it to ${$(proposed)} restores the progression.`,
          evidence: { gap_cents: gap, previous_gap_cents: prev } }); }
    }
  }
  // 2. Every product should clear the target margin at the size people typically pick.
  const labor = settings.unit.labor_rate_hour || 2200;
  for (const p of book.products) {
    if (!p.cost_cents) continue;
    const m = book.materials.find((x) => x.key === p.material); if (!m) continue;
    const svc = book.services.find((s) => m.services.includes(s.key)); if (!svc) continue;
    const typ = Math.min(p.max_inches, 2.5);
    const size = book.sizes.find((s) => s.inches === typ); if (!size) continue;
    const price = r25(size[svc.key + "_cents"] * m.factor) + p.blank_cents;
    const minutes = svc.min_per_piece + svc.per_inch * typ;
    const cost = p.cost_cents + Math.round(labor * minutes / 60) + svc.consumable_cents;
    const margin = (price - cost) / price;
    if (margin < TARGET_MARGIN - 0.02) {
      const needed = Math.ceil(cost / (1 - TARGET_MARGIN)); const proposed = r25(p.blank_cents + (needed - price));
      found.push({ rule: "margin_floor", target: { type: "product", key: p.key, field: "blank_cents" }, current: p.blank_cents, proposed,
        reason: `A ${p.name.toLowerCase()} with ${typ} in of ${svc.name.toLowerCase()} sells for ${$(price)}. It costs about ${$(cost)} to make: the blank ${$(p.cost_cents)}, ${minutes} minutes of labor at ${$(labor)}/hour, and consumables. That is a ${Math.round(margin * 100)}% margin; the shop needs ${Math.round(TARGET_MARGIN * 100)}% on every piece so rent, payroll and marketing are covered before profit. Raising the item price from ${$(p.blank_cents)} to ${$(proposed)} gets there without touching the engraving price.`,
        evidence: { price_cents: price, cost_cents: cost, margin_pct: Math.round(margin * 100), labor_minutes: minutes } });
    }
  }
  // 3. What customers do on the order page: sizes and items that get looked at a lot but rarely bought, or bought far more than average.
  const views = (await env.DB.prepare(`SELECT session, detail FROM events WHERE name = 'spec_view' AND ts >= ?`).bind(since90).all()).results;
  const bySize = {}, byProduct = {}; const seen = new Set();
  for (const v of views) { let d; try { d = JSON.parse(v.detail || "{}"); } catch { continue; } const sid = v.session || Math.random();
    const ks = `${d.service}|${d.inches}`, kp = String(d.product);
    if (!seen.has(sid + ks)) { seen.add(sid + ks); bySize[ks] = (bySize[ks] || 0) + 1; }
    if (!seen.has(sid + "p" + kp)) { seen.add(sid + "p" + kp); byProduct[kp] = (byProduct[kp] || 0) + 1; } }
  const sold = (await env.DB.prepare(`SELECT i.service, i.inches, i.product, COUNT(*) n FROM order_items i JOIN orders o ON o.ref = i.ref WHERE o.status IN ('paid','refunded') AND o.created_at >= ? GROUP BY i.service, i.inches, i.product`).bind(since90).all()).results;
  const totalViews = Object.values(bySize).reduce((a, b) => a + b, 0), totalSold = sold.reduce((a, r) => a + r.n, 0);
  const overall = totalViews ? totalSold / totalViews : 0;
  if (totalViews >= 100 && totalSold >= 10) {
    for (const [ks, v] of Object.entries(bySize)) { if (v < 25) continue; const [service, inchesS] = ks.split("|"); const inches = +inchesS; const size = book.sizes.find((s) => s.inches === inches); const svc = book.services.find((s) => s.key === service); if (!size || !svc) continue;
      const n = sold.filter((r) => r.service === service && r.inches === inches).reduce((a, r) => a + r.n, 0); const conv = n / v; const cur = size[service + "_cents"];
      if (n >= 5 && conv >= overall * 1.6) found.push({ rule: "demand_high", target: { type: "size", service, inches }, current: cur, proposed: r25(cur * 1.06), reason: `${inches} in ${svc.name.toLowerCase()} converts far better than the rest of the page: ${n} orders from ${v} people who priced it (${Math.round(conv * 100)}%), against ${Math.round(overall * 100)}% overall in the last 90 days. Customers are telling you this size is worth more than you charge. A 6% increase, ${$(cur)} to ${$(r25(cur * 1.06))}, adds margin where demand is strongest.`, evidence: { views: v, orders: n, conversion_pct: Math.round(conv * 100), overall_pct: Math.round(overall * 100) } });
      else if (conv <= overall * 0.4) found.push({ rule: "demand_low", target: { type: "size", service, inches }, current: cur, proposed: r25(cur * 0.93), reason: `${inches} in ${svc.name.toLowerCase()} is looked at often but rarely bought: ${n} orders from ${v} people who priced it (${Math.round(conv * 100)}%), against ${Math.round(overall * 100)}% overall in the last 90 days. The price is where people stall. Trimming it 7%, ${$(cur)} to ${$(r25(cur * 0.93))}, should turn more of that interest into orders; if it doesn't within a month, the size itself is the issue, not the price.`, evidence: { views: v, orders: n, conversion_pct: Math.round(conv * 100), overall_pct: Math.round(overall * 100) } }); }
    for (const [kp, v] of Object.entries(byProduct)) { if (v < 40) continue; const p = book.products.find((x) => x.key === kp); if (!p || !p.blank_cents) continue;
      const n = sold.filter((r) => r.product === kp).reduce((a, r) => a + r.n, 0); const conv = n / v;
      if (conv <= overall * 0.4) found.push({ rule: "demand_low", target: { type: "product", key: kp, field: "blank_cents" }, current: p.blank_cents, proposed: r25(p.blank_cents * 0.9), reason: `${p.name} gets priced by many people (${v} in 90 days) but only ${n} bought it (${Math.round(conv * 100)}% against ${Math.round(overall * 100)}% for the page). The item price is the likeliest reason. A 10% cut on the item, ${$(p.blank_cents)} to ${$(r25(p.blank_cents * 0.9))}, keeps the engraving price intact and tests whether volume follows.`, evidence: { views: v, orders: n, conversion_pct: Math.round(conv * 100), overall_pct: Math.round(overall * 100) } }); }
  }
  // 4. Cost of goods drifting up against sales: pass it through before it eats the margin.
  const cogsKeys = CATEGORIES.filter((c) => c.group === "cogs").map((c) => `'${c.key}'`).join(",");
  const m3 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1)).toISOString().slice(0, 10), m15 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 15, 1)).toISOString().slice(0, 10), m0 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const cogsFor = async (a, b) => { const c = await env.DB.prepare(`SELECT COALESCE(SUM(ABS(amount_cents)),0) c FROM bank_txns WHERE category IN (${cogsKeys}) AND posted_at >= ? AND posted_at < ?`).bind(a, b).first(); const s = await env.DB.prepare(`SELECT COALESCE(SUM(amount_cents - fee_cents - refunded_cents),0) s FROM payments WHERE status = 'COMPLETED' AND created_at >= ? AND created_at < ?`).bind(a, b).first(); return { cogs: c.c, sales: s.s }; };
  const recent = await cogsFor(m3, m0), prior = await cogsFor(m15, m3);
  if (recent.sales > 500000 && prior.sales > 500000 && recent.cogs && prior.cogs) {
    const rp = recent.cogs / recent.sales, pp = prior.cogs / prior.sales; const drift = (rp - pp) * 100;
    if (drift >= 4) { const pct = Math.min(15, Math.round(drift)); for (const svc of book.services) found.push({ rule: "cogs_drift", target: { type: "ladder", service: svc.key, pct }, current: readTarget(book, { type: "ladder", service: svc.key }), proposed: r25(readTarget(book, { type: "ladder", service: svc.key }) * (1 + pct / 100)),
      reason: `Materials and consumables took ${Math.round(rp * 100)}% of sales over the last three months, up from ${Math.round(pp * 100)}% over the twelve months before. That ${Math.round(drift)}-point rise comes straight out of profit unless prices move with it. Raising every ${svc.name.toLowerCase()} size by ${pct}% passes the cost through; the 2 in price would go from ${$(readTarget(book, { type: "ladder", service: svc.key }))} to ${$(r25(readTarget(book, { type: "ladder", service: svc.key }) * (1 + pct / 100)))}.`, evidence: { recent_cogs_pct: Math.round(rp * 100), prior_cogs_pct: Math.round(pp * 100), recent_sales_cents: recent.sales } }); }
  }
  // write the new ones; leave alone anything already pending, denied in the last 60 days or approved in the last 30
  const existing = (await env.DB.prepare(`SELECT target, status, decided_at FROM price_suggestions WHERE status = 'pending' OR decided_at >= ?`).bind(new Date(now - 60 * 86400000).toISOString()).all()).results;
  let created = 0;
  for (const f of found) {
    if (f.proposed === f.current || f.proposed == null) continue;
    const key = targetKey(f.target);
    const dup = existing.find((e) => e.target === key && (e.status === "pending" || e.status === "denied" || (e.status === "approved" && e.decided_at >= new Date(now - 30 * 86400000).toISOString())));
    if (dup) continue;
    await env.DB.prepare(`INSERT INTO price_suggestions (created_at, status, rule, target, current_cents, proposed_cents, reason, evidence) VALUES (?,?,?,?,?,?,?,?)`).bind(nowIso, "pending", f.rule, key, f.current, f.proposed, f.reason, JSON.stringify(f.evidence || {})).run();
    existing.push({ target: key, status: "pending" }); created++;
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('last_price_review', ?)`).bind(nowIso).run();
  return { ok: true, checked: found.length, created, views: totalViews, sold: totalSold };
}
async function pricingAdmin(env) {
  const book = await priceBook(env);
  const pending = (await env.DB.prepare(`SELECT * FROM price_suggestions WHERE status = 'pending' ORDER BY created_at DESC`).all()).results.map((s) => ({ ...s, target: JSON.parse(s.target), evidence: JSON.parse(s.evidence || "{}"), label: describeTarget(book, JSON.parse(s.target)) }));
  const decided = (await env.DB.prepare(`SELECT * FROM price_suggestions WHERE status != 'pending' ORDER BY decided_at DESC LIMIT 20`).all()).results.map((s) => ({ ...s, target: JSON.parse(s.target), label: describeTarget(book, JSON.parse(s.target)) }));
  const history = (await env.DB.prepare(`SELECT * FROM price_history ORDER BY ts DESC LIMIT 30`).all()).results.map((h) => ({ ...h, target: JSON.parse(h.target), label: describeTarget(book, JSON.parse(h.target)) }));
  const last = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'last_price_review'`).first();
  const sold = (await env.DB.prepare(`SELECT i.service, i.inches, COUNT(*) n FROM order_items i JOIN orders o ON o.ref = i.ref WHERE o.status IN ('paid','refunded') GROUP BY i.service, i.inches`).all()).results;
  return { book, pending, decided, history, last_review: last ? last.v : null, sold, target_margin: TARGET_MARGIN };
}
async function decideSuggestion(env, id, body) {
  const s = await env.DB.prepare(`SELECT * FROM price_suggestions WHERE id = ?`).bind(id).first();
  if (!s) return { ok: false, error: "Not found" };
  if (s.status !== "pending") return { ok: false, error: "Already " + s.status };
  const decision = body.decision === "approve" ? "approved" : body.decision === "deny" ? "denied" : null;
  if (!decision) return { ok: false, error: "decision must be approve or deny" };
  const now = new Date().toISOString(); const note = String(body.note || "").slice(0, 500);
  if (decision === "approved") {
    const book = await priceBook(env); const t = JSON.parse(s.target); const from = readTarget(book, t);
    applyTarget(book, t, t.type === "ladder" ? 0 : s.proposed_cents); await saveBook(env, book);
    await env.DB.prepare(`INSERT INTO price_history (ts, target, from_cents, to_cents, source, suggestion_id, note) VALUES (?,?,?,?,?,?,?)`).bind(now, s.target, from, readTarget(book, t), "suggestion", id, note).run();
  }
  await env.DB.prepare(`UPDATE price_suggestions SET status = ?, decided_at = ?, note = ? WHERE id = ?`).bind(decision, now, note, id).run();
  return { ok: true, status: decision };
}
async function editBook(env, body) {
  const book = await priceBook(env); const t = body.target || {}; const cents = Math.round(+body.cents);
  if (!(cents >= 0) || readTarget(book, t) == null) return { ok: false, error: "Bad target or amount" };
  const from = readTarget(book, t); applyTarget(book, t, cents); await saveBook(env, book);
  await env.DB.prepare(`INSERT INTO price_history (ts, target, from_cents, to_cents, source, suggestion_id, note) VALUES (?,?,?,?,?,?,?)`).bind(new Date().toISOString(), JSON.stringify(t), from, readTarget(book, t), "manual", null, String(body.note || "").slice(0, 200)).run();
  return { ok: true, book };
}
async function assetResponse(env, id) {
  const a = await env.DB.prepare(`SELECT * FROM order_assets WHERE id = ?`).bind(id).first();
  if (!a) return json({ error: "Not found" }, 404);
  const comma = a.data.indexOf(","); const bin = Uint8Array.from(atob(a.data.slice(comma + 1)), (c) => c.charCodeAt(0));
  return new Response(bin, { headers: { "Content-Type": a.type, "Content-Disposition": `inline; filename="${a.ref}-${a.name.replace(/[^\w.-]/g, "_")}"`, "Cache-Control": "private, max-age=3600" } });
}
