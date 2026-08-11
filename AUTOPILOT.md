# AUTOPILOT — session memory

Read by the `/autopilot` command. Each session: execute the backlog top-down, then update this file before ending.

## Mission
SewaGo — rides, food delivery, kirana shops and hotel stays in one app for the Kathmandu valley. Customers pay per ride/order/booking; the platform earns commissions, service/delivery/cancel fees, surge, and promoted listings. Goal: production launch, real users, real revenue.

## How to verify
- `npm test` — integration tests that boot the real server (money paths especially). Must stay green.
- `npm run verify` — syntax-checks all server/ and public/ JS, then the partner-lang dictionary drift guard.
- `npm run dev` / `npm run dev:seed` — local dev server on a JSON store in `data/local` with sandbox providers. **Never run the app against `.env` to click through it** — that config points at the live Supabase project.

## Conventions (do not violate)
- Customer + partner apps use the hub-and-spoke Home launcher (`.home-grid` tiles → full-screen pages with `.back-chip`, popstate back). Driver and admin keep bottom tabbars. Keep new UI consistent with this — explicit owner preference.
- Money or auth logic never ships without an integration test (see `test/money.test.js` pattern).
- Bump the `sw.js` cache version whenever precached frontend files change (now v8).
- Large uncommitted owner work may be present — the owner commits their own checkpoints; never commit files you didn't change.
- With `DATA_STORE=supabase`, never run `npm run demo:seed` while a server is running (blob save clobbers the seed) — use dev route `POST /api/demo/seed` instead.
- Partner UI strings go through `t()` and the `public/partner-lang.js` dictionary; `npm run verify` fails on drift.
- **Parallel sessions happen.** On 2026-08-06 four worktrees (main + three branches) shipped overlapping fixes independently; the divergence cost a large merge. If `git log` shows commits you did not make, re-read this file and `git log` before picking work, keep commits scoped to files you actually changed — and prefer working ON MAIN unless the owner says otherwise.

## Current state (2026-08-06, post-merge)
All three worktree branches (`claude/zealous-ishizaka-c363de`, `claude/upbeat-engelbart-6bf40a`, `claude/confident-neumann-d0f9ec`) are merged into main and the suite is green (114 tests). Where branches had re-implemented the same feature, one implementation was kept: main's helper-invite hardening (+ env-tunable TTL), main's `test/net.js` OS-port helper, zealous's courier-abandonment cluster (shop + food + unified `/admin/attention` + reconciliation terms), confident's run pruning, upbeat's stdin watchdog and store-commission dashboard row. The branches can be deleted.

## The shopkeeper (kirana) product line
A full map + design workflow ran 2026-08-11 (13 agents: 5 readers, 4 design lenses,
3 judges, 1 synthesis). Headline: **the shopkeeper app was not missing verticals, it
was missing a shelf that answers instantly.** Six changes shipped that day (see log).
The owner's other asks were deliberately sequenced or declined — reasons below, because
they will come up again:

- **Buying from wholesalers (owner ask D)** — NOT built. Three blockers that code cannot
  fix: zero wholesalers on the platform (empty page on day one); a flat 8% commission is
  several times a wholesaler's entire gross margin on a Rs 50,000 invoice, so none would
  list; and a partner has no spendable balance at all (no wallet, no top-up — `earnings`
  is simultaneously the payout balance and the COD-debt ledger and can go negative).
  Three refund paths also resolve the buyer with `db.users.find` and would silently
  swallow a partner's refund with a green reconciliation. **Build instead:** turn the
  existing 'To buy' list into a purchase order shared to the supplier's WhatsApp, plus a
  'Received' step that restocks twenty lines in one tap. Needs no counterparty, saves
  real time on delivery day, and captures cost price as a side effect.
- **Booking a rider to move goods (owner ask E)** — NOT built, same wallet blocker: a new
  shop with Rs 0 earnings could not pay for a job. Also needs escrow, a declared-cargo
  cap, abandonment recovery and registration in three busy-predicates or riders
  double-book. **Note:** if wholesale buying is ever built, transport comes almost free —
  a wholesale order is a store order with fulfilment 'delivery', which already enters the
  courier dispatcher; only the bike-only filter needs relaxing for heavy loads.
- **A storefront per shop (owner ask F)** — already exists and is good (live shelf,
  basket, subscriber pricing, pickup code, economics hidden). What is missing is
  DISTRIBUTION, not a storefront: a shareable `?shop=<id>` link for the shopkeeper's own
  WhatsApp group, and 'Order again' on a past order. Small, high value, not yet done.
- **Cost price — the keystone.** Nothing records what stock COST, so profit is
  uncomputable and 'insights' can only ever report turnover. Add optional `costPrice` to
  the item and `unitCost` to `moveStock`'s options (a destructured default, so all ten
  call sites keep working), captured on the Received step above.
- **Three different 'Sold today' figures** coexist on three bases (storeStats vs
  insights vs the daily buckets) and can disagree on the same screen; daily buckets are
  keyed in UTC while Kathmandu is UTC+5:45, so every sale before 05:45 is filed on
  yesterday. Fix the timezone and pick one canonical basis BEFORE adding more numbers.
- **Cross-script search**: item 'चिनी', query 'chini' returns zero rows. The
  transliteration + synonym lexicon already exists in server/voiceCommand.js and could be
  shared with the client shelf search.
- `db.stockMoves` is capped at 20,000 rows GLOBALLY across every shop, so a busy
  neighbour can truncate a quiet shop's own numbers. Probably needs to be per-store.

## Backlog (ranked)
1. **Customer-experience pass** — click through sign-up → ride → food order → shop basket → subscription request as a first-time customer at mobile viewport. Log every friction point, fix the worst ones. *(Shops vertical covered 2026-08-06 — transparent checkout bar fixed. Rides/Food/Stays/Tasks still un-walked.)*
2. **Throttle `/group-orders/join` + subscribe-request abuse** — (a) `/group-orders/join`: 6-digit code matched against every open group, no attempt limit; give it the same per-account failure budget + per-IP limiter as `/stores/helper/join`. (b) `POST /stores/:id/items/:itemId/subscribe-request`: no strict limiter, no per-user/per-store cap, `db.subscriptionRequests` never pruned — cap pending requests, add a strict limiter, prune in the hourly sweep (mirror the group-lobby pruning, 4642cba).
3. **Revenue candidates the owner already wants** — SewaGo Plus subscription; corporate accounts. Design the smallest shippable slice, backlog the design, then build.
4. **Food-delivery dispatch parity** — delivery jobs are broadcast first-come while rides use sequential nearest-driver offers with decline/timeout. Port sequential offers to delivery runs.
5. **Money-path scaling** — move wallet/earnings/payouts/rides onto fully-relational tables with Postgres transactions (currently per-row `app_records` store) for true multi-instance concurrency.
6. **Audit the pre-2026-08-05 surface** — older rides/stays/food routes have never had an adversarial read for authorization gaps and guessable codes.
7. **Parallel-suite timing flakiness** — timing-sensitive suites occasionally cascade-fail mid-file under the full parallel run and pass in isolation (seen with money.test and delivery-runs on 2026-08-06). Suspects: offer windows == sweep cadence. Consider more headroom in test envs or capping --test-concurrency.

## Shipped log
### 2026-08-11, shopkeeper smoothness pass (six commits, 8686125..0f3f179)
- **The shelf comes first** (8686125): three assistant cards (command mic, AI drafting,
  a second older mic) sat above the goods — measured 375x812, the search box was 1,238px
  down and the first item 1,383px. Shelf now renders first; assistants collapse into one
  strip with two jobs ('Say it' / 'Add many'). Both older paths kept.
- **Counter sales are instant and multi-unit** (2b1b23a): in-row [− n +] stepper,
  optimistic update, ONE debounced request, no auto-retry (/sold is not idempotent),
  rollback + refetch when the server refuses. Shelf order frozen while worked so a row
  never teleports mid-sale. Closes a real data bug: the only multi-unit route the UI
  offered was a negative '+ Stock', filed as reason 'correction', which moveStock
  EXCLUDES from sales — silently starving velocity and every insight.
- **Items became editable** (b4b7179): PATCH/DELETE existed server-side since the vertical
  shipped and the client called neither, so a mis-heard voice item was permanent. '⋯'
  sheet for name / shelf / low-stock threshold / retire. Categories are now a FIXED
  nine-item vocabulary (free text would break the rail within a month).
- **Category rail** (85b0200): the owner's literal ask. Vertical rail replaces the
  horizontally-scrolling chip strip where ~2.5 of 11 shelves were reachable. Secondary
  row actions moved behind '⋯' to pay for the width. A max-width:380px block written for
  the old full-width row was undoing the compaction and now only carries the sticky offset.
  Net across the six: first item 1,383px -> 420px, page 10,011px -> 5,174px.
- **Orders inside the shop** (80d0a99): fifth tab, this shop's orders only, live first,
  past behind a link. Accept -> ready -> handover without leaving the shelf.
- **Insights say what the shop KEEPS** (0f3f179): take-home vs SewaGo's cut, which shelf
  earns, this week vs last — all from data already recorded. Profit deliberately NOT
  shown: it needs cost price (see the product-line notes above).

### 2026-08-06, merge session (all branches → main)
- Merged the three parallel worktree branches into main, resolving overlapping re-implementations (see Current state). Semantic fixes made during the merge, each with tests: a released delivery order still cannot settle at the counter (asserts the 409 + reject-and-refund exit); confident's counter-race run tests converted to the reject exit; duplicate `pruneDeadOrders` and duplicate derived-revenue terms collapsed to one canonical version each; tests recompute the shop split the customer API now hides (aa83c1b); a shadowing duplicate of `resolveAttention` posted to a dead route (caught by browser smoke test, removed); five partner-order `t()` wraps restored + `No rider — refund` added to the dictionary.
- The unified admin attention queue (shop + food abandonment incidents) now renders in the Approvals inbox with per-kind rows and a single resolve endpoint — browser-verified end to end.

### 2026-08-06 (branch work now merged; highlights)
- **Courier abandonment resolves the money** (zealous cluster, b1ef305 + 4faf57f): shop runs and food deliveries whose courier vanishes auto-refund prepaid customers, honour partner income, bill the courier the order total on the COD-debt ledger, and queue the incident for staff with an audit-note resolve. Reconciliation counts abandoned orders correctly.
- **Test servers die with their runner** (upbeat, c541c9a): `EXIT_WHEN_STDIN_CLOSES=1` stdin watchdog + piped stdin in every suite; an interrupted run can no longer orphan servers onto test ports.
- **Store commission surfaced on the admin revenue breakdown** (upbeat, 7cf61fd).
- **Delivery runs prune dead orders before offer and accept** (confident, 72bc5b1): no payout for hollow stops; re-planned runs carry only live orders.
- **Partner portal cluster** (confident): stock gauges, sales insights + per-item day/week/month reports, Nepali-first i18n with dictionary CI guard, printable invoices, customer receipts + order history, customer order API stops leaking shop economics (aa83c1b).

### 2026-08-06 (main sessions before the merge)
- Helper invite codes hardened (11acddb): crypto codes, expiry, per-account tries, own limiter. TTL now env-tunable (`HELPER_INVITE_TTL_MIN`).
- Withdrawal-hold laundering closed (c610156); voice parser requires a real session (95c8274); session tokens out of the realtime URL via one-minute tickets (8347912); shop cannot pocket a prepaid delivery order (97d5a4f); food counter code attempt-capped (49a60c7); store-order settlement idempotent (c84a479); Home hydrates in-flight orders on boot (e7a8cb0); `npm run dev` local-only scripts (1422800); group orders charge only confirmed shares, codes scoped to payers, lobbies bounded and pruned (a232ceb, 4642cba); shop checkout bar opaque on mobile (b0efa05); tests on OS-assigned ports (82c199b).
- (for history before 2026-08-05 see git log and docs/)

## Decisions needed (owner)
- **Rotate a leaked Supabase service-role key.** `VLM-FO1/sewago/mobile/.env` (stale folder) holds a live service-role key for old project `uxolhsevwzdmojpeubvz`. Rotate in Supabase, then delete the folder. Not touched by autopilot — live credential.
- **Delete the merged branches?** `claude/zealous-ishizaka-c363de`, `claude/upbeat-engelbart-6bf40a`, `claude/confident-neumann-d0f9ec` and their worktrees are fully merged into main.
- **Nepali as the default partner language** (English one tap away, persisted). Recommendation: keep — confirm before production since existing partners see the flip.
- **storeOrders retention** — cap in-memory like stockMoves and accept history loss, or archival export first? Recommendation: cap + weekly JSON archive alongside the backup job.
- **Add a free Gemini key to switch the AI assistant on.** Get one at https://aistudio.google.com/apikey and set `GEMINI_API_KEY` in `.env` — its free tier covers a shop's normal day, which `ANTHROPIC_API_KEY` (also supported, still unset) does not. Two features are dormant until then: partner AI-inventory (503) and the model fallback that reads rambling spoken messages the local Nepali grammar cannot place. Speaking to the shop works fully without any key. If Google renames the free model, change `GEMINI_MODEL` rather than the code — a wrong name surfaces Google's own error message.
- Confirm the Supabase `app_records` migration ran in production and `DATA_STORE=supabase_rows` is live.
- Live provider credentials pending: Khalti/eSewa, Twilio, Resend; Render deploy + APK build are owner-only.
