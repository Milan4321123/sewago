# Production Readiness

This repository is currently a strong local MVP, not a one-click production launch.
It can be downloaded and run immediately with JSON storage and sandbox payments,
but real users require external infrastructure and provider credentials.

## Current Status

| Area | Status | Production action |
|---|---|---|
| App server | Runs with Express | Put behind HTTPS and a reverse proxy or deploy platform |
| Database | Local JSON, single-blob Supabase, or per-row Supabase (`supabase_rows`) | Apply `docs/supabase-schema.sql`, then `DATA_STORE=supabase_rows` for real traffic; move hot paths to fully relational tables + transactions before high-scale launch |
| Auth | Password hashing, expiring bearer tokens (60 d), phone-OTP login, emailed password-reset links | Set real SMS + email provider keys |
| Password reset email | Resend / SendGrid / webhook adapters built in | Set `EMAIL_PROVIDER` + `EMAIL_PROVIDER_API_KEY` + `EMAIL_FROM` |
| Payments | Khalti (KPG-2) + eSewa (ePay v2) with server-side verification; PIN sandbox fallback in dev | Set live gateway keys (`KHALTI_SECRET_KEY`, `ESEWA_PRODUCT_CODE`+`ESEWA_SECRET`, `*_MODE=live`) |
| Payouts | Admin approves; rejection auto-refunds amount + fee | Add real disbursement workflow or finance ops process |
| Account deletion | Self-service in all three apps (blocked while money is in flight, anonymizing, audited) | — (app-store requirement met) |
| Legal | `/privacy` + `/terms` served and linked | Review the text with a Nepali lawyer before scale |
| Food fulfillment | Real for partner restaurants: restaurant accept/reject, bike-driver couriers, delivery addresses, auto-refund timeout | Recruit restaurants + couriers; demo restaurants stay simulated |
| Maps | Real Nominatim geocoding (valley-bounded) + Leaflet/CARTO CDN | Point `NOMINATIM_BASE` at a paid host for volume |
| Real-time | SSE push + adaptive polling | — |
| Dispatch | Sequential nearest-driver offers with decline/timeout cascade (`RIDE_OFFER_SECONDS`) | — |
| Rate limiting | In-memory per process | Move to Redis/Upstash if more than one server runs |
| Admin | Env password + partner KYC review + append-only audit log | Add individual staff accounts and roles |
| KYC | Sandbox OTP + document reference workflow | Integrate real phone/license/business verification and file storage |
| Tests | `npm test` — money paths (wallet debit/refund, escrow, withdrawal rejection, deletion guards) | Extend as features grow |

## Supabase

Supabase is wired into the runtime through a server-side app-state table. This
keeps the current Express routes working online while you prepare a deeper
relational rewrite. The schema is in:

```text
docs/supabase-schema.sql
```

To make Supabase active:

1. Create a Supabase project.
2. Run `docs/supabase-schema.sql` in the Supabase SQL editor.
3. Set `DATA_STORE=supabase`.
4. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server.
5. Optionally run `npm run supabase:push` to upload your local demo state.
6. Keep service-role keys on the server only. Do not expose them in `public/*.js` or `mobile/.env`.

For local-only development, set:

```bash
DATA_STORE=json
```

For a private pilot only, you can still run JSON storage with a mounted persistent volume:

```bash
DATA_DIR=/var/lib/sewago
ALLOW_JSON_DB_IN_PRODUCTION=true
```

Do not use JSON storage for a public multi-user production deployment.

### Storage modes and the per-row store

There are two Supabase modes:

- `DATA_STORE=supabase` — the whole app state is one JSONB blob in the `app_state`
  row. Simple and persistent, but **every save re-uploads the entire state** and
  the blob grows without bound, so it cannot scale past a pilot.
- `DATA_STORE=supabase_rows` — **recommended for real traffic.** Each record (a
  user, ride, order, session token, …) is its own row in `app_records`, and each
  save writes **only the rows that changed** (a new ride writes ~2 rows, not the
  whole state). This removes the single-blob ceiling and gives real Postgres rows
  you can index and query.

Cutover from blob to per-row is a config flip with a built-in rollback:

1. Run `docs/supabase-schema.sql` again (it adds the `app_records` table; safe to
   re-run — everything is `create table if not exists`).
2. Set `DATA_STORE=supabase_rows` and redeploy.
3. On first boot the app **auto-imports the existing `app_state` blob** into
   `app_records`, then serves from rows. The old blob is left untouched, so you
   can roll back to `DATA_STORE=supabase` at any time.

The in-memory working set is unchanged, so no route code changes are needed. The
next step (still ahead) is moving hot paths — wallet debits/refunds, bookings,
rides, payouts — to the fully relational tables in the schema with Postgres
transactions for true multi-instance concurrency.

## Payments

`PAYMENT_PROVIDER=sandbox` is the only implemented provider right now.
Setting another provider returns `501 Not Implemented` so the app does not
pretend to take real money.

Before taking real payments:

1. Create real merchant accounts for eSewa/Khalti/Stripe.
2. Implement provider intent creation in `POST /api/payments/topup/initiate`.
3. Implement provider verification/webhook handling before crediting wallets.
4. Store provider reference IDs on each payment.
5. Verify webhook signatures or lookup responses server-side.
6. Reconcile successful gateway payments against ledger transactions.
7. Decide whether withdrawals are automated disbursements or admin-reviewed manual payouts.

The wallet ledger, order/booking earnings, driver cash-commission debt, and
withdrawal queue are already separated enough to keep when provider verification
is added.

## Phone OTP, Password Reset, KYC

The app now has sandbox-ready flows for:

- Customer, driver and partner password reset tokens.
- Customer, driver and partner phone OTP verification.
- Driver go-online gate requiring verified phone plus verified license.
- Partner business KYC submission and admin approve/reject.
- Partner listing gate requiring verified phone and approved business KYC.

The sandbox provider returns OTPs/reset tokens in the API response for local
testing. Production must replace this with real delivery:

```bash
OTP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=<twilio-account-sid>
TWILIO_AUTH_TOKEN=<twilio-auth-token>
TWILIO_FROM_NUMBER=<sms-capable-from-number>
# Or use OTP_PROVIDER=webhook with SMS_WEBHOOK_URL and optional SMS_WEBHOOK_TOKEN.

# Password-reset links are emailed via server/email.js:
EMAIL_PROVIDER=resend            # or sendgrid, or webhook
EMAIL_PROVIDER_API_KEY=<secret>  # for resend/sendgrid
EMAIL_FROM=no-reply@your-domain.example
# EMAIL_PROVIDER=webhook instead POSTs {to, from, subject, text, html} to
# EMAIL_WEBHOOK_URL (optional bearer EMAIL_WEBHOOK_TOKEN).
```

The reset email carries a link back to the right app (`/?reset=<token>`,
`/driver?reset=…`, `/partner?reset=…`); the app opens the reset form with the
token pre-filled.

The code intentionally refuses `NODE_ENV=production` with sandbox OTP/email
providers.

## Required Production Environment

Use `.env.example` as the template.

For `NODE_ENV=production`, the app now refuses to start unless these demo values
are replaced:

```bash
ADMIN_EMAIL=ops@example.com
ADMIN_PASSWORD=<strong-secret>
DRIVER_LICENSE_DEMO_CODE=<replace-with-real-flow-or-secret>
PUBLIC_APP_URL=https://your-domain.example
DATA_STORE=supabase
SUPABASE_URL=<your-supabase-url>
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
PAYMENT_PROVIDER=<real-provider-after-adapter>
OTP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=<twilio-account-sid>
TWILIO_AUTH_TOKEN=<twilio-auth-token>
TWILIO_FROM_NUMBER=<sms-capable-from-number>
EMAIL_PROVIDER=<real-email-provider-after-adapter>
```

If you intentionally run a private pilot with JSON and sandbox payments, keep
`NODE_ENV=development` or explicitly set the temporary overrides. Do not do that
for public launch.

## Minimum Work Before Public Launch

Already done in this codebase: server-verified Khalti/eSewa payments, Twilio/webhook
SMS adapters, Resend/SendGrid/webhook email adapters with reset links, expiring
session tokens, in-app account deletion, `/privacy` + `/terms`, an append-only
admin audit log, and `npm test` money-path coverage.

Still yours to do:

1. Apply `docs/supabase-schema.sql` and flip `DATA_STORE=supabase_rows`
   (`supabase db push` — the migration is staged in `supabase/migrations/`).
2. Real provider credentials: Khalti/eSewa live keys, Twilio, Resend/SendGrid.
3. Real driver-license and partner business verification, including secure
   document storage (the demo license code is a stand-in).
4. Later, for scale: hot money paths on fully relational tables + Postgres
   transactions, Redis-backed rate limiting, and multi-instance dispatch.
5. Error monitoring (e.g. a log drain + alerts on `/api/health`).
6. Backups and restore drills for the production database.

After launch, the next builds worth doing are:

1. Sequential driver dispatch hardening, finishing the remaining scale item.
2. Promoted listings for partner restaurants and hotels.
3. A SewaGo Plus subscription tier.
