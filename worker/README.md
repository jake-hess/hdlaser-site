# hdlaser-checkout worker

Turns an order from hdlaser.net/grounds-for-profit into a Square hosted checkout page.

## One-time setup (Cloudflare dashboard, no command line needed)

1. dash.cloudflare.com → Workers & Pages → Create → Create Worker → name it `hdlaser-checkout` → Deploy.
2. Click **Edit code**, delete the sample, paste the contents of `src/index.js`, click **Deploy**.
3. Settings → Variables and Secrets → add:
   - `SQUARE_ENV` = `sandbox` (change to `production` when going live)
   - `SQUARE_LOCATION_ID` = the Location ID from the Square developer dashboard
   - `SITE_URL` = `https://hdlaser.net`
   - `ALLOWED_ORIGINS` = `https://hdlaser.net,https://www.hdlaser.net`
   - `DEPOSIT_PERCENT` = `100` (or `50` for a half deposit)
   - `SUPPORT_EMAIL` = `contact@hdlaser.net`
   - `SQUARE_ACCESS_TOKEN` = the access token, saved as type **Secret**
4. Copy the worker URL (looks like `https://hdlaser-checkout.<something>.workers.dev`).
5. In the site repo, set `CHECKOUT_ENDPOINT` in `assets/site-config.js` to that URL plus `/checkout`.

## Going live

Switch `SQUARE_ENV` to `production`, replace `SQUARE_LOCATION_ID` and `SQUARE_ACCESS_TOKEN` with the production values from Square, then Deploy.

## Test

`GET https://<worker>/health` should return `{"ok":true,"env":"sandbox"}`.
Sandbox test card: 4111 1111 1111 1111, any future date, any CVV, any ZIP.

## Later: automation to-do (per Jake, Sept 2026)

- Checkout prices every order as tax-exempt (resale). If a customer never sends a signed resale certificate,
  send a Square invoice for the California sales tax on the non-exempt price. Track: ref, paid date,
  permit number received (Formspree "Resale certificate info" email), signed certificate received.
- Logo intake is by email/text today. Candidate upgrade: accept uploads in this worker and store in R2.
