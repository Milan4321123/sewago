# AUTOPILOT.md — session memory for autonomous improvement runs

## Mission
SewaGo is an Uber/Pathao-style super app for Kathmandu: customers pay for rides,
food delivery, kirana (shop) delivery, hotel stays and mini jobs; drivers,
restaurants, shops and hotels earn through it, with SewaGo keeping a commission
on every vertical. The product's core promise is that every rupee is traceable:
the platform ledger, partner earnings and driver debts must always reconcile.

## Backlog (ranked)
1. **Merge divergent worktrees.** `claude/zealous-ishizaka-c363de` holds an
   unmerged, uncommitted shop-side courier-abandonment fix (settleAbandonedOrder,
   store /admin/attention, test/delivery-abandoned.test.js on port 4995). This
   branch (`claude/upbeat-engelbart-6bf40a`) has the committed food-side twin.
   Both define `GET /admin/attention`; merged version should concat lists (food
   rows carry `kind: 'food'`). Note for the merge: the reconciliation derived
   terms added here (server/routes/admin.js) assume store orders cancelled as
   'courier_abandoned' don't exist on this branch — the zealous fix books
   commission on such orders, so the merged derived terms need a
   courier_abandoned store term mirroring the food one.
2. **Single-blob persistence bottleneck** — the whole DB saves as one JSON blob
   (JSON file locally / one Supabase row in prod). #1 scaling risk per owner
   memory. Needs incremental persistence design; too big for one session —
   design doc + slice plan first.
3. **Parallel-suite timing flakiness** — under `npm test` (10 servers at once),
   timing-sensitive suites occasionally cascade-fail mid-file (seen twice on
   2026-08-06: money.test 6 fails, delivery-runs 5 fails; both green on
   re-run/isolation). Mechanism: one timing flake leaves state (e.g. an
   unclaimed run) that steals later tests' offers. Suspects: 5s offer window ==
   5s sweep in delivery-runs env. Consider longer offer windows in test envs or
   capping --test-concurrency.
4. **Per-source revenue trend** — revenueTrend(14) charts totals only; a
   per-vertical split would show which business line moves. Low priority.
5. **Partner UI for helper invites doesn't show expiry** — invites now expire
   (48h default); the helpers list endpoint doesn't expose expiresAt, so a
   shopkeeper can't tell a code went stale until the join fails. One-line API
   field + a line in the partner UI.

## Shipped log
- 2026-08-06 — **Food courier abandonment resolves money + admin queue**
  (801ec47): prepaid customers auto-refunded, restaurant income honoured,
  courier billed order.total ('abandoned_goods'), incident queue in admin
  Approvals inbox with resolve + audit note. Env knobs FOOD_PICKUP_DEADLINE_MIN
  / FOOD_DROPOFF_DEADLINE_MIN; recovery moved to the 5s sweep. Tests:
  test/food-abandoned.test.js.
- 2026-08-06 — **Store vertical added to revenue reconciliation** (ab915d9):
  derivedTotal in /admin/overview had no store/run terms, so the drift alarm
  fired permanently (ledger 215 vs derived 0 in the stores suite) once shops
  sold. Wallet orders count commission+fee unless cancelled; cash orders count
  commission when delivered; completed runs subtract courier payout. Drift-0
  tests added to stores and delivery-runs suites.
- 2026-08-06 — **Test servers die with their runner** (c541c9a): opt-in
  EXIT_WHEN_STDIN_CLOSES=1 stdin watchdog in server/index.js; all 10 test files
  spawn with piped stdin. Verified: SIGKILL of parent kills server ~1s; SIGKILL
  of the whole runner mid-suite drains to zero listeners. Fixes the orphaned-
  server port-poisoning that broke this session's baseline (two orphans from an
  interrupted run were squatting on 4979/4993).
- 2026-08-06 — **Store commission row on admin revenue breakdown** (7cf61fd):
  the kirana vertical's revenue was in the Total but had no row, so rows didn't
  sum. Verified in the running app (Rs 80 + Rs 5 = Rs 85, green banner).
- 2026-08-06 — **Helper invite hardening** (50dab00): /stores/helper/join was
  the one unguarded code-guessing surface (Math.random 6-digit code, no expiry,
  no attempt cap; a joined "helper" can rewrite someone's stock counts). Now:
  crypto.randomInt codes, 48h expiry (HELPER_INVITE_TTL_MIN), 10-wrong-codes/hr
  per-account lock (audited), and the strict per-IP limiter. Strict limiter
  budget now env-tunable (RATE_LIMIT_STRICT_PER_10MIN, default 60 unchanged).
- 2026-08-06 — **Shop checkout bar readability on mobile** (583e9e1): .cartbar
  was a transparent positioning div — the shop checkout's toggle/address/pay
  controls had the item list bleeding through on a phone. Now the same glass
  chrome as the tabbar; clearance sized per mode. Verified at 375px in pickup,
  delivery and food variants.

## Decisions needed
- **Worktree merge order** for the shop-side vs food-side abandonment fixes
  (backlog #1). Recommendation: land zealous-ishizaka's shop fix first (older),
  then rebase this branch's four commits on top; reconcile GET /admin/attention
  by concatenating both lists and extend the derived-revenue terms per the note
  in backlog #1.
- **This branch is 4 commits ahead of main and unpushed** (I never push).
  Merge/push when you're ready.

## Session notes
- Test suite: `npm test` (10 files, each spawns a real server on its own 49xx
  port; ports 4979–4997 odd set, 4995 reserved by the zealous worktree's test).
- Audited and found healthy across two sessions: auth rate limiting + OTP caps,
  admin login, run-stop settlement (ownership/ordering/idempotence), AI
  inventory endpoint (auth, length cap, per-partner limiter), pickup-code
  handover (5-try lock + audit), session tokens & OTPs (crypto randomness).
- Mobile walkthrough done (2026-08-06, 375px): login, food browse → cart →
  wallet checkout → live tracking (wallet math exact), shops browse → cart →
  pickup/delivery/pay toggles. One bug found (cartbar transparency — fixed).
  Sim (demo) food orders skip the address prompt by design; real partner
  restaurants require it.
- Baseline at session close: 84/84 green, no lingering listeners.
