# AUTOPILOT.md — session memory for unattended improvement runs

## Mission
SewaGo is a Nepal-focused super-app: rides, food delivery, hotel stays, task
hiring and kirana-shop commerce in one PWA. Customers pay per order/ride/stay;
the platform earns commissions and service fees; partners (shopkeepers,
restaurants, hotels) and drivers are paid out of each transaction. The paying
loop that must never break: order placed → stock reserved → delivered/handed
over → partner credited, courier paid, platform cut recorded.

## Current state (2026-08-06)
- Branch `claude/confident-neumann-d0f9ec` (worktree). All 83 tests green;
  `npm run verify` = syntax check + i18n dictionary guard.
- Partner portal is hub-and-spoke (Home + pages), Nepali-first with English
  toggle, stock-level meters, day/week/month per-item sales reports, printable
  invoices. Delivery runs prune counter-handed orders (payout-abuse fix).

## Backlog (ranked)
1. **storeOrders unbounded growth** — `db.storeOrders` has no cap or pruning;
   insights (polled) and other endpoints scan the full array. Mirror the
   stockMoves cap or resolve refIds from the tail. (Blocked on the retention
   decision below.)
2. **Single-blob persistence bottleneck** — the known #1 scaling risk: whole
   DB serialized as one JSON blob (also on Supabase store). Split hot
   collections or move to per-collection persistence.
3. **Server error strings are English** — a Nepali-UI partner sees English
   errors from the API (`data.error` passthrough). Either error codes with
   client-side translation, or an Accept-Language switch.
4. **UTC day buckets vs shop-local midnight** — `salesDaily` keys are UTC, so
   the reports' "today" bar can lag the move-based totals until 05:45 NPT.
   Accepted approximation, documented in `salesInsights`; revisit if partners
   report confusion.
5. **Re-run the interrupted review** — the adversarial review workflow lost
   its `js-correctness` and `ui-visual` finders to a session usage limit; only
   i18n and server-insights dimensions completed (all their findings fixed).
6. **Customer app localization** — the partner portal is Nepali-first; the
   customer app (app.js, ~2900 lines) is still English-only. Reuse the t() +
   dictionary + guard pattern; sizable but mechanical.

## Shipped log
- 2026-08-06: Delivery runs prune dead (counter-handed/cancelled) orders before
  offer and accept — closes a full-payout-for-no-work abuse. (72bc5b1)
- 2026-08-06: Partner portal: stock gauges, sales insights endpoint + tab,
  Nepali-first i18n with English toggle, printable invoices. (a0d70b4)
- 2026-08-06: Merged main's hub-and-spoke portal redesign and re-ported all
  four features onto it. (fc3476e)
- 2026-08-06: Per-item day/week/month reports with period switcher; app always
  boots on Home. (6d191d2)
- 2026-08-06: Insights rounding/perf fixes; suite made deterministic — the
  parallel run was tripping the per-IP API rate limit, cascading 429s.
  (871eec6)
- 2026-08-06: Three silent-English i18n fixes, 38 dead keys pruned, and a
  dictionary drift guard wired into `npm run verify`. (0f47428)
- 2026-08-06: Customer order API stops leaking commission/partnerCut/internal
  flags; contract locked by test. (aa83c1b)
- 2026-08-06: Customer receipt screen + past-orders history in the shops tab,
  printable via the shared invoice styles. (6f116cd)
- 2026-08-06: Sales terminology unified in partner-lang (आम्दानी → बिक्री).
  (448b0f6)

## Decisions needed (owner)
- **Nepali as the default language** for every partner device (English is one
  tap away, choice persists). Recommendation: keep — the target shopkeeper
  reads Nepali — but confirm before production, since existing partners will
  see the flip.
- **storeOrders retention** — cap in-memory like stockMoves (20k) and accept
  history loss, or add an archival export first? Recommendation: cap + weekly
  JSON archive alongside the existing backup job.
