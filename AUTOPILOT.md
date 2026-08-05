# AUTOPILOT.md — session memory for autonomous improvement runs

## Mission
SewaGo is an Uber/Pathao-style super app for the Kathmandu valley: rides, food delivery,
kirana-shop delivery, hotel stays, parcels and mini jobs, four PWAs on one Node server.
Customers pay per ride/order/stay; the platform earns ride commission (20%), food/store/stay
commissions and service fees; drivers/partners keep the rest. Owner is a solo dev heading
for a real production launch — money correctness and trust are the product.

## How to verify
- `npm test` — 10 suites spawn the real server on OS-assigned ports (safe to run in
  parallel checkouts/worktrees since 2026-08-06).
- Manual: `npm start` → customer `/`, driver `/driver`, partner `/partner`, admin `/admin`
  (dev admin login: admin@sewago.app / admin123; Rs 5,000 dev wallet on signup).
- `npm run demo:seed` for demo marketplace data (only touches `demo-` ids).

## Backlog (ranked)
1. Security pass on the recent feature commits (shop maps/store management, pickup-order
   review, regional matching) — attacker mindset: authz on every new endpoint (e.g. store
   PATCH/inventory/helper routes), input validation on money paths, IDOR between partners.
   Started nowhere; nothing known-broken, purely an audit.
2. Customer-experience pass on the paying flows as a first-time phone user (empty states,
   error toasts, loading, mobile layout) — run the app, click through ride/food/shop/stay,
   fix what feels broken or embarrassing.
3. Single-blob JSON/Supabase persistence is the #1 scaling bottleneck for launch (every
   write rewrites the whole state). Needs owner decision — see Decisions.
4. Small residue from the ghost-run fix: a run in the 'offered' state (≤25 s window) is not
   re-pruned if one of its orders is handed over mid-offer; the money is safe (handover
   stamps moneySettledAt) but the rider could still ride to one hollow stop. Low value,
   fix only if touching the sweep anyway.
5. Food-side courier no-show has no bench: a courier who abandons a FOOD delivery is billed
   but not benched (runNoShowUntil only gates shop runs). Consider a shared cooldown.

## Shipped log
- 2026-08-06 — Courier-abandoned shop runs no longer strand money: collected orders
  auto-resolve (customer refunded without restock, shop income honoured, vanished rider
  billed on the COD-debt ledger), still-ready orders release back to pool and counter,
  counter handover stamps `moneySettledAt`, staff incident queue at /admin/attention with
  Reviews-tab UI. Tests: test/delivery-abandoned.test.js. (commit b1ef305)
- 2026-08-06 — Parallel-safe tests: all suites bind OS-assigned ports via test/freePort.js;
  concurrent worktrees/clones can run `npm test` simultaneously. (commit cf43f6a)
- 2026-08-06 — Food courier abandonment resolves the money (refund / restaurant income /
  courier billed + forced offline past float) on the 5 s sweep instead of the hourly one;
  /admin/attention unified across shop + food with one resolve endpoint; the overview
  books-reconciliation recompute learned store orders, run payouts and courier-abandoned
  revenue, so the "books do not reconcile" banner no longer cries wolf once shops trade.
  Tests: test/food-abandoned.test.js + reconciliation asserts. (commit 4faf57f)
- 2026-08-06 — Forming runs prune orders that were handed over / cancelled while queued:
  route + payout re-planned around live orders, empty runs cancelled — closes the "rider
  paid full payout for ticking hollow stops" hole. Tests in delivery-runs suite.
  (commit 2203749)

## Decisions needed (owner)
- Persistence migration off the single-blob store (per-table Supabase writes vs. SQLite):
  prerequisite for real launch traffic. Recommendation: move hot collections (orders,
  rides, runs, transactions) to per-row Supabase tables first; keep cold config in the blob.
- This branch (claude/zealous-ishizaka-c363de) has 4 commits ready to merge to main —
  review and merge, or say the word and a session can open a PR.
