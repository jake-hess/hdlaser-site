-- HD Laser order ledger (Cloudflare D1 / SQLite). Applied automatically by the worker.
CREATE TABLE IF NOT EXISTS orders (
  ref TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,              -- checkout_started | paid | refunded | pay_later
  business TEXT, name TEXT, email TEXT, phone TEXT, notes TEXT, text_consent INTEGER DEFAULT 0,
  cups INTEGER, base_price_cents INTEGER, cups_subtotal_cents INTEGER, setup_fee_cents INTEGER, total_cents INTEGER, deposit_percent INTEGER,
  square_order_id TEXT, square_payment_id TEXT, paid_at TEXT, paid_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, refunded_cents INTEGER DEFAULT 0,
  resale_permit TEXT, resale_business TEXT, resale_received_at TEXT,
  logo_received_at TEXT, proof_approved_at TEXT, completed_at TEXT, tax_invoiced_at TEXT, admin_notes TEXT
);
CREATE TABLE IF NOT EXISTS order_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT NOT NULL, size TEXT, finish TEXT, lid TEXT, color TEXT, qty INTEGER, unit_cents INTEGER
);
CREATE INDEX IF NOT EXISTS order_lines_ref ON order_lines(ref);
CREATE TABLE IF NOT EXISTS payments (
  payment_id TEXT PRIMARY KEY,
  created_at TEXT, updated_at TEXT, status TEXT,
  amount_cents INTEGER DEFAULT 0, fee_cents INTEGER DEFAULT 0, refunded_cents INTEGER DEFAULT 0,
  square_order_id TEXT, ref TEXT, source TEXT, card_brand TEXT
);
CREATE INDEX IF NOT EXISTS payments_created ON payments(created_at);
CREATE TABLE IF NOT EXISTS refunds (
  refund_id TEXT PRIMARY KEY,
  payment_id TEXT, created_at TEXT, status TEXT, amount_cents INTEGER DEFAULT 0, reason TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL, name TEXT NOT NULL, session TEXT, ref TEXT, path TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
