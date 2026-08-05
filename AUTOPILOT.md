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

> ⚠️ **[SECURITY — HIGH, verified 2026-08-06, still OPEN] Shopkeeper handover settles prepaid DELIVERY orders with no proof → keeps the customer's money.** `POST /partner/store-orders/:orderId/handover` (stores.js ~L1091) applies the pickup-code check only when `fulfilment==='pickup'`; a prepaid **delivery** order accepts an empty body, is set `delivered`, and its `partnerCut` (incl. the delivery fee) moves `pendingEarnings → earnings` (withdrawable). No courier ran, and no refund path survives (customer cancel needs `placed`, reject needs placed/accepted). The run guard only blocks `collecting`/`delivering`, so a KYC-approved shop can do this the instant the order is `ready`. The **courier-double-debit** side-effect of this same bug is already fixed (c84a479, idempotent settlement); the **theft** remains. *Fix:* restrict the settle-on-handover branch to `fulfilment==='pickup'`; for delivery orders reject handover or leave it `ready`/`collected` for the courier dropoff to settle, and set `order.moneySettledAt` wherever handover settles. *(Logged by the concurrent autopilot session — recommend ranking #1. Fix lives in stores.js, which the other session was actively editing; coordinate.)*

1. **Customer-experience pass** — click through sign-up → ride → food order → shop basket → subscription request as a first-time customer at mobile viewport. Log every friction point, fix the worst ones. *(2026-08-06 covered the Shops vertical — fixed the transparent checkout bar, b0efa05. Rides/Food/Stays/Tasks still un-walked.)*
2. **Throttle `/group-orders/join`** — same shape as the helper-invite hole fixed on 2026-08-06, but much lower impact: a 6-digit code matched against every open group, no attempt limit. The code IS crypto-generated and joining moves no money, so the prize is a privacy leak (who is in the lobby and what they picked) plus lobby spam. Give it the same per-account failure budget + dedicated per-IP limiter as `/stores/helper/join`. **Same family (verified 2026-08-06, MEDIUM):** `POST /stores/:id/items/:itemId/subscribe-request` has no strict limiter and no per-user/per-store cap, and `db.subscriptionRequests` is never pruned — one account can open ~500 pending requests per shop (an SSE nudge each) and grow the Supabase blob unbounded. Cap concurrent pending requests per user/store, add a strict limiter, and prune decided/old entries in the hourly housekeeping sweep.
3. **Revenue candidates the owner already wants** — SewaGo Plus subscription; corporate accounts. Design the smallest shippable slice (e.g. Plus = monthly fee from wallet → waived service fees + free delivery under X km), backlog the design, then build.
4. **Food-delivery dispatch parity** — delivery jobs are broadcast first-come while rides use sequential nearest-driver offers with decline/timeout. Port sequential offers to delivery runs.
5. **Money-path scaling** — longer term: move wallet/earnings/payouts/rides onto fully-relational tables with Postgres transactions (currently per-row `app_records` store) for true multi-instance concurrency.
6. **Audit the pre-2026-08-05 surface the same way** — this session's three findings were all in recently-added code because that is where it looked. The older rides/stays/food routes have never had an adversarial read for authorization gaps and guessable codes.

## Shipped log
### 2026-08-06 (autopilot)
- **Baseline** — the 10 failing delivery-run tests were not a product bug: test files hardcoded ports and collided with stray servers. The owner's `test/net.js` (`freePort()`) migration landed in parallel and fixed it (82c199b). Suite green, no change needed from me.
- **Helper invite codes were guessable into a stranger's shop** (11acddb) — `/stores/helper/join` matches a code against EVERY shop, so any hit anywhere grants write access to that shop's stock. Code came from `Math.random()` (the only security code in the app not using crypto), invites never expired, and only the general 600/min/IP budget capped guessing against a 900k space. Now crypto codes, 24h expiry, collision-rejected at creation, 10 wrong tries per account per hour, and its own per-IP limiter (deliberately NOT the money limiter — a fat-fingered invite code must not spend the budget guarding withdrawals).
- **The withdrawal hold could be laundered off** (c610156) — spending released the hold correctly, but refunds credited the wallet and restored nothing. Top up by card → post a task → cancel it → the money came back withdrawable with no counterparty, then charge back the card. Every refund path had it (rides, stays, tasks, food incl. per-member group refunds, shop orders, admin-rejected withdrawals). All now go through `creditWallet()`, which restores the hold capped at the window's high-water mark so refunds of genuinely old money stay withdrawable.
- **Voice parser accepted any Authorization header** (95c8274) — the "partner or helper" check tested only that the header existed, so `Bearer x` worked. Both token maps are now really checked and spoken input is bounded per line.
- (for history before 2026-08-05 see git log and docs/)

## Decisions needed from the owner
- **Rotate a leaked Supabase service-role key.** `VLM-FO1/sewago/mobile/.env` (the app's old location, now stale) holds a live service-role key for project `uxolhsevwzdmojpeubvz` — a different project from the active `kneycqxbfjurtpaopyvl`. It is gitignored and was never committed, but Expo bundles `.env` into APKs, so any build made from that folder shipped it. Recommendation: rotate the key in Supabase, then delete the stale folder. Not touched by autopilot — it is a live credential.
- `ANTHROPIC_API_KEY` is not set in `.env`, so the partner AI-inventory feature returns 503. Add a key to enable it.
- Confirm the Supabase `app_records` migration ran in production and `DATA_STORE=supabase_rows` is live (render.yaml was flipped; the migration itself was owner-only).
- Live provider credentials still pending: Khalti/eSewa, Twilio, Resend; Render deploy + APK build are owner-only steps.
