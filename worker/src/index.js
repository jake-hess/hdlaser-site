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
//   POST /webhooks/twilio     inbound texts (owner replies 1/2 to the no-show alert)
//   STAFF_ALERTS (optional)   which staff events text the owner: clockin,clockout,noshow (default all)
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
CREATE TABLE IF NOT EXISTS inquiries (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, name TEXT, business TEXT, email TEXT, phone TEXT, fields TEXT, emailed INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS inquiries_created ON inquiries(created_at);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'staff', phone TEXT DEFAULT '', email TEXT DEFAULT '', pin_hash TEXT, pin_salt TEXT, on_call INTEGER DEFAULT 0, active INTEGER DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS staff_sessions (token TEXT PRIMARY KEY, staff_id INTEGER NOT NULL, created_at TEXT, expires_at TEXT, ip TEXT);
CREATE TABLE IF NOT EXISTS shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER NOT NULL, in_at TEXT NOT NULL, out_at TEXT, minutes INTEGER, note TEXT);
CREATE INDEX IF NOT EXISTS shifts_in ON shifts(in_at);
CREATE TABLE IF NOT EXISTS checklist (id INTEGER PRIMARY KEY AUTOINCREMENT, shift_id INTEGER NOT NULL, kind TEXT NOT NULL, step INTEGER NOT NULL, done_at TEXT, UNIQUE(shift_id, kind, step));
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, staff_id INTEGER, customer TEXT, phone TEXT, product TEXT NOT NULL, qty INTEGER DEFAULT 1, minutes INTEGER, amount_cents INTEGER DEFAULT 0, due_at TEXT, status TEXT DEFAULT 'queued', started_at TEXT, done_at TEXT, done_by INTEGER, note TEXT, ref TEXT);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
CREATE TABLE IF NOT EXISTS staff_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, staff_id INTEGER, action TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS staff_log_ts ON staff_log(ts);`;
// Columns added after the first release. Each ALTER is tried once and ignored if the column already exists.
const ALTERS = ["ALTER TABLE orders ADD COLUMN notified_paid_at TEXT", "ALTER TABLE payments ADD COLUMN team_member_id TEXT"];

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
      if (path === "/webhooks/square" && request.method === "POST") return squareWebhook(request, env);
      if (path === "/webhooks/twilio" && request.method === "POST") return twilioInbound(request, env);
      // ---- staff portal (per-employee sign-in, Bearer token) ----
      if (path.startsWith("/staff/")) return requireOrigin(cors) || staffRoutes(request, env, cors, path, url);

      // ---- admin ----
      if (path === "/admin" || path.startsWith("/api/")) {
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
        if (path === "/api/team") return json(await teamKpis(env, url.searchParams.get("from"), url.searchParams.get("to")), 200, { "Cache-Control": "no-store" });
        if (path === "/api/staff" && request.method === "POST") { const r = await upsertStaff(env, await request.json()); await staffLog(env, null, "team_update_admin", JSON.stringify({ id: r.id })); return json(r, r.ok ? 200 : 400); }
        if (path === "/api/noshow-check" && request.method === "POST") return json(await noShowCheck(env), 200);
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
      if (d.getUTCMinutes() >= 10) { await noShowCheck(env); return; }   // the :15 crons only run the no-show check
      await syncSquare(env, 3);
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
  const from = env.FROM_EMAIL || `HD Laser Studio <orders@hdlaser.net>`;
  const body = { from, to: Array.isArray(to) ? to : [to], subject, text };
  if (html) body.html = html;
  if (replyTo) body.reply_to = replyTo;
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
async function sendAlert(env, text) {
  const msg = String(text).slice(0, 300);
  const jobs = [];
  const to = String(env.ALERT_TO || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length && env.RESEND_API_KEY) jobs.push(sendEmail(env, { to, subject: "HD Laser", text: msg }));
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
  let payments = 0, refunds = 0, orders = 0, items = 0, locations = [];
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
  return { ok: errors.length === 0, payments, refunds, orders, items, locations: locations.length, since: begin, until: end, errors };
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
  const ref = orderRow ? orderRow.ref : null;
  await env.DB.prepare(`INSERT INTO payments (payment_id, created_at, updated_at, status, amount_cents, fee_cents, refunded_cents, square_order_id, ref, source, card_brand) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(payment_id) DO UPDATE SET updated_at=excluded.updated_at, status=excluded.status, amount_cents=excluded.amount_cents, fee_cents=excluded.fee_cents, refunded_cents=excluded.refunded_cents, ref=COALESCE(excluded.ref, payments.ref), card_brand=COALESCE(excluded.card_brand, payments.card_brand)`)
    .bind(p.id, p.created_at || null, p.updated_at || null, p.status || null, amount, fee, refunded, p.order_id || null, ref, p.source_type || null, brand).run();
  if (p.team_member_id) await env.DB.prepare(`UPDATE payments SET team_member_id = ? WHERE payment_id = ?`).bind(p.team_member_id, p.id).run().catch(() => {});
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
<div><button class="act" id="sync">Sync Square now</button> <button class="act" id="backfill">Import 2 years of history</button> <a class="act" href="/api/orders.csv" style="text-decoration:none;color:inherit">Download CSV</a> <button class="act" id="digest">Email digest</button></div></header>
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
  $('#orders').innerHTML='<tr><th>Ref</th><th>Customer</th><th>Items</th><th class="num">Total</th><th>Status</th><th>Progress</th></tr>'+k.recent.map(r=>'<tr><td><b>'+r.ref+'</b><div class="small">'+fmtDate(r.created_at)+'</div></td><td>'+who(r)+'</td><td class="small">'+esc(r.items||'')+'</td><td class="num">'+money(r.total_cents)+(r.refunded_cents?'<div class="small">refunded '+money(r.refunded_cents)+'</div>':'')+(r.fee_cents?'<div class="small">fee '+money(r.fee_cents)+'</div>':'')+'</td><td><span class="pill '+r.status+'">'+r.status.replace('_',' ')+'</span></td><td>'+flag(r.ref,'logo_received_at',r.logo_received_at,'Logo')+flag(r.ref,'proof_approved_at',r.proof_approved_at,'Proof OK')+flag(r.ref,'completed_at',r.completed_at,'Done')+flag(r.ref,'resale_received_at',r.resale_received_at,'Resale cert')+flag(r.ref,'tax_invoiced_at',r.tax_invoiced_at,'Tax invoiced')+'</td></tr>').join('');
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
      if (staffAlertsOn(env, "clockin")) await sendAlert(env, `${me.name} clocked in at ${fmtLocal(now)}${first.n === 0 ? " (first in today)" : ""}.`);
      await env.DB.prepare(`DELETE FROM meta WHERE k = 'noshow_pending'`).run();
      return json({ ok: true, shift: { id: r.meta && r.meta.last_row_id, in_at: now } }, 200, cors);
    }
    if (b.action === "out") {
      if (!open) return json({ error: "You're not clocked in" }, 400, cors);
      const mins = Math.max(1, Math.round((Date.now() - new Date(open.in_at)) / 60000));
      await env.DB.prepare(`UPDATE shifts SET out_at = ?, minutes = ?, note = ? WHERE id = ?`).bind(now, mins, String(b.note || "").slice(0, 500) || null, open.id).run();
      await staffLog(env, me.id, "clock_out", mins + " min");
      if (staffAlertsOn(env, "clockout")) await sendAlert(env, `${me.name} clocked out at ${fmtLocal(now)} (${(mins / 60).toFixed(1)} h).`);
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
function pub(p) { return { id: p.id, name: p.name, role: p.role, phone: p.phone || "", email: p.email || "", on_call: !!p.on_call, active: p.active !== 0 }; }

async function upsertStaff(env, b) {
  const name = String(b.name || "").trim().slice(0, 60);
  const role = ["staff", "manager", "owner"].includes(b.role) ? b.role : "staff";
  if (b.id) {
    const sets = [], args = [];
    if (name) { sets.push("name = ?"); args.push(name); }
    if (b.role) { sets.push("role = ?"); args.push(role); }
    for (const k of ["phone", "email"]) if (k in b) { sets.push(`${k} = ?`); args.push(String(b[k] || "").slice(0, 120)); }
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
  const r = await env.DB.prepare(`INSERT INTO staff (name, role, phone, email, pin_hash, pin_salt, on_call, active, created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
    .bind(name, role, String(b.phone || "").slice(0, 40), String(b.email || "").slice(0, 120), await pbkdf(String(b.pin), salt), salt, b.on_call ? 1 : 0, new Date().toISOString()).run();
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
    queue, capacity: cap, products: products(env), week: mine,
    is_manager: ROLE_RANK[me.role] >= 2,
  };
}

// Everything waiting to be made, scored so the most urgent and valuable work sits on top.
async function workQueue(env) {
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const items = [];
  const jobs = (await q(`SELECT j.*, p.name staff_name FROM jobs j LEFT JOIN staff p ON p.id = j.staff_id WHERE j.status IN ('queued','started') ORDER BY j.created_at`).all()).results;
  for (const j of jobs) items.push({ kind: "job", id: j.id, title: `${j.customer || "Walk-in"}: ${prodName(env, j.product)} x${j.qty}`, note: j.note, phone: j.phone, minutes: j.minutes, amount_cents: j.amount_cents, due_at: j.due_at, created_at: j.created_at, status: j.status, by: j.staff_name });
  const orders = (await q(`SELECT o.ref, o.business, o.name, o.phone, o.cups, o.paid_at, o.paid_cents, o.logo_received_at, o.proof_approved_at,
      (SELECT SUM(CASE WHEN finish='printed' THEN qty*3+30 ELSE qty*2.5+20 END) FROM order_lines l WHERE l.ref=o.ref) minutes,
      (SELECT GROUP_CONCAT(qty || ' x ' || size || 'oz ' || finish || ' ' || color || ' (' || lid || ')', '; ') FROM order_lines l WHERE l.ref = o.ref) items
      FROM orders o WHERE o.status = 'paid' AND o.completed_at IS NULL ORDER BY o.paid_at`).all()).results;
  for (const o of orders) {
    const stage = !o.logo_received_at ? "waiting for logo" : !o.proof_approved_at ? "send proof" : "in production";
    const due = o.proof_approved_at ? new Date(new Date(o.proof_approved_at).getTime() + 21 * 86400000).toISOString() : (o.logo_received_at ? new Date(new Date(o.logo_received_at).getTime() + 2 * 86400000).toISOString() : null);
    items.push({ kind: "order", id: o.ref, title: `${o.business || o.name}: ${o.cups} logo cups`, note: o.items, phone: o.phone, minutes: stage === "in production" ? Math.round(o.minutes || 0) : stage === "send proof" ? 20 : 0, amount_cents: o.paid_cents, due_at: due, created_at: o.paid_at, status: stage, stage, logo: !!o.logo_received_at, proof: !!o.proof_approved_at });
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

// 10:15 AM shop time: nobody clocked in yet? Text the owner and the on-call employee.
async function noShowCheck(env) {
  const l = local();
  if (l.hour !== OPEN_HOUR || l.minute < 10 || l.minute > 25) return { skipped: "not 10:15 local" };
  const day = localDayRange(l.date);
  const n = (await env.DB.prepare(`SELECT COUNT(*) n FROM shifts WHERE in_at >= ? AND in_at < ?`).bind(day.from, day.to).first()).n;
  if (n > 0) return { ok: true, clocked_in: n };
  const already = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'noshow_pending'`).first();
  if (already && JSON.parse(already.v).date === l.date) return { ok: true, already_alerted: true };
  const onCall = await env.DB.prepare(`SELECT * FROM staff WHERE active = 1 AND on_call = 1 AND phone != '' ORDER BY role, name LIMIT 1`).first();
  let sentToOnCall = false;
  if (onCall && onCall.phone) sentToOnCall = (await sendSms(env, onCall.phone, `HD Laser: nobody has clocked in yet and the shop opens at 10. Are you on your way? Reply 1 for yes, 2 if you can't make it.`)).ok;
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('noshow_pending', ?)`).bind(JSON.stringify({ date: l.date, on_call_id: onCall ? onCall.id : null, on_call_name: onCall ? onCall.name : null })).run();
  if (staffAlertsOn(env, "noshow")) await sendAlert(env, `No employee has clocked in by 10:15.${onCall ? ` I texted ${onCall.name} (on call)${sentToOnCall ? "" : ", but the text failed"} asking for confirmation.` : " No on-call employee is set."} Reply 1 to text everyone else on the team, 2 to ignore.`);
  return { ok: true, alerted: true, on_call: onCall ? onCall.name : null };
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
      const others = staffRow.results.filter((s) => s.id !== p.on_call_id && !owners.includes(e164(s.phone)));
      let n = 0; for (const s of others) if ((await sendSms(env, s.phone, `HD Laser: nobody has opened the shop yet. Can you come in? Reply 1 for yes.`)).ok) n++;
      return twiml(`Texted ${n} team member${n === 1 ? "" : "s"}. I'll tell you who replies.`);
    }
    if (body === "2") { await env.DB.prepare(`DELETE FROM meta WHERE k = 'noshow_pending'`).run(); return twiml("OK, ignoring today's no-show."); }
    return twiml("Reply 1 to text the rest of the team, or 2 to ignore.");
  }
  if (sender) {
    if (body === "1") { await sendAlert(env, `${sender.name} replied: on the way.`); return twiml(`Thanks ${sender.name.split(" ")[0]}, see you soon. Remember to clock in at hdlaser.net/staff.`); }
    if (body === "2") { await sendAlert(env, `${sender.name} replied: can't make it. Reply 1 to text the rest of the team.`); return twiml("Got it, I've let the owner know."); }
    await sendAlert(env, `Text from ${sender.name}: ${body.slice(0, 200)}`);
    return twiml();
  }
  // Anyone else: forward to the owner, no auto-reply beyond Twilio's STOP/HELP handling.
  await sendAlert(env, `Text from ${from}: ${body.slice(0, 200)}`);
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
