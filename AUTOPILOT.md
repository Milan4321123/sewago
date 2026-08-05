# AUTOPILOT — session memory

Read by the `/autopilot` command. Each session: execute the backlog top-down, then update this file before ending.

## Mission
SewaGo — rides, food delivery, kirana shops and hotel stays in one app for the Kathmandu valley. Customers pay per ride/order/booking; the platform earns commissions, service/delivery/cancel fees, surge, and promoted listings. Goal: production launch, real users, real revenue.

## How to verify
- `npm test` — integration tests that boot the real server (money paths especially). Must stay green.
- `npm run verify` — syntax-checks all server/ and public/ JS.
- `npm start` — dev server; Express + vanilla-JS frontends in `public/` (app.js customer, driver.js, partner.js, admin.js).

## Conventions (do not violate)
- Customer + partner apps use the hub-and-spoke Home launcher (`.home-grid` tiles → full-screen pages with `.back-chip`, popstate back). Driver and admin keep bottom tabbars. Keep new UI consistent with this — explicit owner preference.
- Money or auth logic never ships without an integration test (see `test/money.test.js` pattern).
- Bump the `sw.js` cache version whenever precached frontend files change.
- Large uncommitted owner work may be present — the owner commits their own checkpoints; never commit files you didn't change.
- With `DATA_STORE=supabase`, never run `npm run demo:seed` while a server is running (blob save clobbers the seed) — use dev route `POST /api/demo/seed` instead.

## Backlog (ranked)
1. **Stabilize the new tests** — `test/food-modes.test.js` and `test/group-orders.test.js` are new/untracked. Run the full suite; make everything green and reliable.
2. **Security audit of the 2026-08-05 surface** — the multi-app overhaul added endpoints with few eyes on them: subscription requests (subscribe-request/accept/decline), delivery runs/batching, partner AI inventory, group orders. Check authorization (does the caller own the store/order/request?), input validation, and abuse paths (e.g. spamming subscriber-price requests). Fix findings with tests.
3. **Customer-experience pass** — click through sign-up → ride → food order → shop basket → subscription request as a first-time customer at mobile viewport. Log every friction point, fix the worst ones.
4. **Revenue candidates the owner already wants** — SewaGo Plus subscription; corporate accounts. Design the smallest shippable slice (e.g. Plus = monthly fee from wallet → waived service fees + free delivery under X km), backlog the design, then build.
5. **Food-delivery dispatch parity** — delivery jobs are broadcast first-come while rides use sequential nearest-driver offers with decline/timeout. Port sequential offers to delivery runs.
6. **Money-path scaling** — longer term: move wallet/earnings/payouts/rides onto fully-relational tables with Postgres transactions (currently per-row `app_records` store) for true multi-instance concurrency.

## Shipped log
- (sessions append here — for history before 2026-08-05 see git log and docs/)

## Decisions needed from the owner
- `ANTHROPIC_API_KEY` is not set in `.env`, so the partner AI-inventory feature returns 503. Add a key to enable it.
- Confirm the Supabase `app_records` migration ran in production and `DATA_STORE=supabase_rows` is live (render.yaml was flipped; the migration itself was owner-only).
- Live provider credentials still pending: Khalti/eSewa, Twilio, Resend; Render deploy + APK build are owner-only steps.
