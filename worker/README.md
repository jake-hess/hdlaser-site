# hdlaser-checkout worker

One Cloudflare Worker that does four jobs for hdlaser.net:

1. **Checkout**: turns a calculator order into a Square hosted checkout page (card details never touch the site).
2. **Order ledger**: records every checkout, payment, refund, resale permit and funnel event in a D1 database.
3. **Dashboard**: `/admin` shows sales, product and financial KPIs, needs-attention lists, status buttons, CSV export.
4. **Automation**: hourly Square sync, Monday 8am PT email digest to contact@.

Files: `src/index.js` (paste into Cloudflare), `schema.sql` (reference only; the worker creates tables itself).

## Setup in the Cloudflare dashboard

### A. The worker (done)
Workers & Pages → Create → Create Worker → `hdlaser-checkout` → Deploy → Edit code → paste `src/index.js` → Deploy.

### B. Database
1. Left menu **Storage & Databases → D1 SQL Database → Create** → name `hdlaser` → Create.
2. Back on the worker: **Settings → Bindings → Add → D1 database**. Variable name `DB`, database `hdlaser`. Save/Deploy.
   Tables are created automatically on the first request.

### C. Variables and Secrets (worker → Settings)

| Name | Value | Type |
|---|---|---|
| `SQUARE_ENV` | `production` (or `sandbox` for testing) | Text |
| `SQUARE_LOCATION_ID` | Location ID from Square developer dashboard → Locations | Text |
| `SQUARE_ACCESS_TOKEN` | Access token from Square developer dashboard → Credentials | **Secret** |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Signature key from the Square webhook subscription (step D) | **Secret** |
| `ADMIN_KEY` | Password for `/admin`. Long and random. | **Secret** |
| `SITE_URL` | `https://hdlaser.net` | Text |
| `WORKER_URL` | `https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev` | Text |
| `ALLOWED_ORIGINS` | `https://hdlaser.net,https://www.hdlaser.net` | Text |
| `DEPOSIT_PERCENT` | `100` (or `50` for half now, balance invoiced) | Text |
| `SUPPORT_EMAIL` | `contact@hdlaser.net` | Text |
| `ALERT_TO` | e.g. `8585551234@vtext.com, hugh@example.com` | Text, optional. Extra addresses that get a one-line alert on new orders, payments and resale permits. Use your carrier's email-to-text address to get it as a text message: Verizon `number@vtext.com`, T-Mobile `number@tmomail.net`, AT&T `number@txt.att.net` (AT&T has been retiring this). |
| `NTFY_TOPIC` | e.g. `hdlaser-orders-7f3k9q` | Text, optional. Sends the same one-line alert as a push notification to the free ntfy app (iOS/Android). Install ntfy, subscribe to the exact topic name, and set it here. Pick a long random name: anyone who guesses it can read the alerts. |
| `TWILIO_ACCOUNT_SID` | `AC…` | Text, optional. From the Twilio console home page. |
| `TWILIO_AUTH_TOKEN` | | **Secret**, optional. From the Twilio console home page. |
| `TWILIO_FROM` | `+18885551234` | Text, optional. The Twilio number you bought (toll-free is simplest to verify). |
| `ALERT_SMS_TO` | `8585551234, 6195551234` | Text, optional. Phones that get a real SMS on new orders, payments and permits. All four Twilio settings must be set for texts to go out. |
| `RESEND_API_KEY` | API key from resend.com (step F). Turns on worker-sent email for forms, payments, resale and the digest | **Secret** |
| `FROM_EMAIL` | `HD Laser Studio <contact@hdlaser.net>` (must be on the domain verified in Resend; use a mailbox that exists, since customers reply to it) | Text |
| `FORMSPREE_ENDPOINT` | `https://formspree.io/f/xaenoorj` (fallback only, used until RESEND_API_KEY is set) | Text |
| `TAX_RATE` | `0.0775` (San Diego sales tax, used for the tax-exposure estimate) | Text |

### D. Square webhook (real-time payment updates; the hourly sync covers everything anyway)
1. developer.squareup.com → your app → **Webhooks → Subscriptions → Add subscription**.
2. Name `hdlaser ledger`, URL `https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev/webhooks/square`, API version latest.
3. Events: `payment.created`, `payment.updated`, `payment.completed`, `refund.created`, `refund.updated`. Save.
4. Open the subscription, copy **Signature key**, save it in Cloudflare as `SQUARE_WEBHOOK_SIGNATURE_KEY` (Secret).

### F. Email through Resend (replaces Formspree)
1. resend.com → sign up with the business email → **Domains → Add domain** → `hdlaser.net`.
2. Resend shows three DNS records (DKIM TXT, SPF TXT and MX on a `send` subdomain). Add them at GoDaddy → DNS. Do not remove the existing Google MX/SPF records.
3. Wait for Resend to show **Verified**, then **API Keys → Create** (sending access) and save it in Cloudflare as `RESEND_API_KEY` (Secret). Set `FROM_EMAIL`.
4. In the site repo, set `SUBMIT_ENDPOINT` in `assets/site-config.js` to `https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev/submit`.
   From then on: quote/order forms → worker (stored in `inquiries`, emails shop + customer), paid orders → confirmation email to customer + "PAID" email to shop, resale permits → email to shop, Monday digest → Resend. Formspree can be cancelled.

### E. Hourly schedule
Worker → **Settings → Triggers → Cron Triggers → Add**: `0 * * * *` (every hour). The Monday 15:00 UTC run also sends the digest.

## Using it
- Dashboard: `https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev/admin`. Any username, password = `ADMIN_KEY`.
- Buttons per order: Logo received, Proof OK, Done, Resale cert, Tax invoiced. Each stamps a date.
- "Sales tax to invoice" lists paid orders with no resale certificate and the tax amount on the order. Send the invoice from Square, then click Invoiced.
- "Sync Square now" pulls the last 30 days of payments and refunds. "Email digest" sends the weekly summary immediately.
- Health: `/health` returns `{"ok":true,"env":"production","db":true}` once the database is bound.

## Sandbox test
Sandbox test card: 4111 1111 1111 1111, any future date, any CVV, any ZIP. In sandbox, Square shows a testing panel instead of a card form.

## Later
- Auto-create the sales-tax invoice in Square from the "Tax to invoice" list (needs Customers + Invoices API; do after a few real orders).
- Logo intake is by email/text today. Candidate upgrade: accept uploads in this worker and store in R2.

## Text alerts through Twilio (optional)

Carrier email-to-text (ALERT_TO with an address like `number@vtext.com`) is free but T-Mobile drops it. For guaranteed texts:

1. Sign up at twilio.com, upgrade out of trial (add a payment method; trial accounts can only text verified numbers).
2. Phone Numbers → Buy a number → pick a **toll-free** US number with SMS. About $2/month.
3. Messaging → Regulatory compliance → **Toll-Free Verification**. Business name HD Laser Studio INC, address, website hdlaser.net, use case "order notifications to the business owner", sample message `HD Laser: PAID $850 by Boards n' Beans (HD-7K2Q). 50 cups. Logo + proof next.`, volume under 100/month, opt-in "internal staff only". Approval usually takes 1–3 business days. Texts to unverified toll-free numbers are blocked, so wait for approval.
4. In Cloudflare set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` (Secret), `TWILIO_FROM`, `ALERT_SMS_TO`, then Deploy.

## Staff portal (hdlaser.net/staff)

Every employee signs in with their own name and PIN (no shared account). The portal gives them clock in/out, the opening and closing checklists, the prioritized work queue with a same-day capacity counter, a form to log walk-in jobs, and their own weekly numbers. Managers and the owner also get a Team tab with everyone's KPIs, and can add people, reset PINs, set who is on call, and deactivate accounts. The written SOP lives at hdlaser.net/staff/sop/.

Setup, once:

1. **Add the first team members** on the owner dashboard (`/admin`, section *Team*). Hugh should be role `owner`. Employees who may open the shop alone get a cell number and, for one of them, *On call*.
2. **No-show watchdog.** In Cloudflare → hdlaser-checkout → Settings → Trigger events, add two cron triggers next to the hourly one: `15 17 * * *` and `15 18 * * *`. The watchdog runs on every cron tick during open hours (10 AM to closing, Pacific); the two :15 entries make the first check land at 10:15 in daylight and standard time. If nobody is clocked in, it texts the on-call employee ("Reply 1 if on your way, 2 if not") and the owner ("Reply 1 to text the rest of the team, 2 to stop today's reminders"), then reminds the owner once an hour until someone clocks in.
3. **Inbound texts.** In Twilio → Phone Numbers → your toll-free number → Messaging configuration → *A message comes in*: Webhook, `https://hdlaser-checkout.yellow-smoke-9c0e.workers.dev/webhooks/twilio`, HTTP POST. Save. This is what lets Hugh and the on-call employee reply 1 or 2. Twilio still handles STOP/HELP itself.
4. **Square passcodes.** In Square Dashboard → Staff → Team, add each employee with their own passcode and the permissions you want (sales yes; refunds up to a limit or manager only). Every sale and refund is then attributed to a person in Square; the worker stores the Square team member id on each payment for per-person sales later.
5. Optional settings: `STAFF_ALERTS` (default `clockin,clockout,noshow`) picks which staff events text the owner. `PRODUCT_MINUTES` (JSON array of `{key,name,setup,each}`) overrides the planning minutes per product used by the queue and the capacity counter.

Endpoints (all under `/staff/`, Bearer token from `/staff/login`): `me`, `clock`, `checklist`, `jobs`, `jobs/:id`, `orders/:ref`, `team` (managers). Admin: `/api/team`, `/api/staff`, `/api/noshow-check`.

## Money page (`/admin/money`)

Live P&L, bank ledger, Square reconciliation, unit economics and a 13-week cash forecast. Same login as the dashboard.

- **Bank data comes in as CSV.** Download a statement CSV from the bank or card (any range), pick it on the page, Import. Columns are detected (date, description, amount or debit/credit, balance). Re-imports skip duplicates. Rows are auto-categorized by built-in rules (Square, SDG&E, Gusto, Adobe, JDS, Uline, transfers, card payments…); anything left lands in *Uncategorized*, where picking a category with the *rule* box ticked teaches the ledger for next time.
- **P&L.** Revenue side comes from Square (gross, refunds, fees → net sales); cost side from the categorized ledger. Transfers, owner draws, loan principal, card payments and equipment are shown but kept out of EBITDA. Click any row for the itemized list with each item's share.
- **Reconciliation.** Square payouts (synced with the hourly job; needs the PAYOUTS_READ permission on the Square app) are matched to bank deposits of the same amount within a few days. Unmatched payouts and deposits are listed. Cash sales in Square are compared with cash deposits in the bank.
- **Forecast.** Cash now (from the latest imported balance, or typed in) + Square money in transit, then 13 weeks of average inflow (last 8 weeks of Square) minus average outflow (bank ledger, or the fixed-cost setting until bank data exists). *Safe to spend* is the lowest projected cash minus the reserve. What-if fields add a hire, a restock, growth spend or a sales change.
- **Health score** (0–100): EBITDA %, months of reserve, share of ledger categorized, share of payouts reconciled, open receivables.
- **Employee pay.** Set an hourly rate and optional commission % per person (Team tab or dashboard). The portal's *My pay* tab shows hours, earned, commission, projected pay for the period, last period and year to date. Pay periods are 14 days from `pay_period_anchor` in the money settings.
- **Live bank feed (Plaid).** Set `PLAID_CLIENT_ID` (Text), `PLAID_SECRET` (Secret) and `PLAID_ENV` (`sandbox` while testing, `production` for real banks) on the worker. On the Money page click *Connect a bank or card*, sign in to the bank in the Plaid window, done. Transactions from the last 24 months load, then new ones arrive every hour with the Square job. Balances of checking/savings accounts feed *Cash now*. If the bank asks to re-authenticate, the account shows *Needs reconnecting* with a button. Plaid's own merchant categories fill in when no ledger rule matches (memo says "Plaid: …"). CSV import still works alongside.

Plaid setup, once: dashboard.plaid.com → sign up as HD Laser Studio INC → Team Settings → Keys gives the client_id and the sandbox and production secrets. Sandbox works immediately (test bank "First Platypus Bank", user `user_good` / `pass_good`). Production needs Plaid's short application (business details, use case "own business accounting") and, for Chase, Plaid's OAuth institution registration, which Plaid runs on your behalf; both are usually approved within a few business days. Pricing is pay-as-you-go, roughly $0.30 per connected account per month.



## Boards n' Beans coffee counter

`hdlaser.net/coffee/` sells Boards n' Beans drinks for pickup. The menu and prices live in the `COFFEE` constant at the top of the coffee section in `src/index.js` (the page fetches `/coffee/menu`, so editing the worker updates the site).

Flow: the page posts the cart to `POST /coffee/checkout`, the worker prices it, creates a Square payment link (tipping on) and stores a `coffee_orders` row with status `checkout_started`. When Square's payment webhook (or the hourly sync) reports the payment `COMPLETED`, the row becomes `paid` and `notifyCoffee` runs once:

- a text to the bar (`COFFEE_SMS_TO`, default 858-349-3522; comma-separate to text several phones),
- an email to `SUPPORT_EMAIL`,
- a text to the customer if they ticked "Text me when it's ready",
- an email receipt if they gave an email.

The customer's return page polls `GET /coffee/status?ref=` until the order is paid. The admin dashboard has a coffee card with today's totals and Ready / Picked up / Re-text bar buttons (`GET /api/coffee`, `POST /api/coffee/:ref`). Texts need the Twilio toll-free number verified; until then the bar gets the email only.

### Business vs personal accounts

Each connected account has a Business / Personal switch on the money page (`POST /api/plaid/items/:item/accounts/:account` with `{personal: true|false}`). A personal account's transactions are filed under `personal` (excluded from the P&L) as they arrive, existing auto-filed rows are re-filed when the switch changes, hand-categorized rows are left alone, and personal checking balances are left out of cash on hand. Move the odd business purchase on a personal card by categorizing that one row.

First pulls are chunked: `plaidSync` handles a few pages per request, saves the cursor after every page, and returns `more: true`; the money page keeps calling until it is caught up.

### Cleaning the ledger

The money page's **Ledger sources** card lists every bank account that has rows in the ledger. A source marked *not connected* belongs to a removed or re-linked connection (or the Plaid sandbox); delete its rows so nothing is counted twice. Removing a bank now deletes its rows automatically. **Re-apply rules to the ledger** re-files every auto-categorized row with the current `DEFAULT_RULES` plus the owner's own rules; rows filed by hand (custom memo) and rows from personal accounts are left alone. Card-side payment credits, airlines and rental cars (`travel`), groceries and clothing (`personal`), and common shop suppliers are covered by the default rules.

### Assessment views on the money page

- **This year vs last year** (`GET /api/money/yoy`): month-by-month Square net sales and bank deposits for the current and previous year, year-to-date growth, and a full-year projection that scales this year's year-to-date by the share of last year that had arrived by the same point (falls back to a straight run-rate when less than a fifth of last year is on file).
- **Two-year trend** (`GET /api/money/trends`, CSV at `/api/money/trends.csv`): for each of the last 24 months, sales, ticket count, average ticket, bank deposits, Zelle/check income, COGS, opex, profit, margin, and what was kept out (personal, owner draws, unfiled).
- **Where the money goes**: spend by category for the last 12 months against the 12 before, with share of sales against the category target; biggest vendors; best-selling Square items; biggest web customers.
