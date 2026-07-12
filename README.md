# SewaGo 🛺

One platform for **rides**, **food delivery**, **hotel booking** and **mini jobs** — an Uber/Pathao-style super app you can run locally and extend into a real product. Ships with **four apps** on one server:

| App | URL | Who uses it |
|---|---|---|
| Customer | `/` | Book rides, order food, book rooms, post & take mini jobs |
| Driver | `/driver` | Go online, accept rides, earn 80% of fares |
| Partner | `/partner` | Restaurants & hotels submit listings + documents |
| **Admin** | `/admin` | **Your team** — approve/reject every listing before it goes live |
| Install | `/download` | Mobile users install the PWA or open the right workspace |

## Run it

```bash
cd sewago
npm install
npm start
```

To populate the app with simulated marketplace activity:

```bash
npm run demo:seed
```

This creates demo customers, online drivers, partner-owned restaurant/hotel listings, ride history, active food orders, stay bookings, open tasks and in-progress task work. It only replaces records whose IDs start with `demo-`, so your own local test data stays intact.

- **Customer app:** http://localhost:4000 — create an account (Rs 5,000 demo wallet credit included)
  - demo login after `npm run demo:seed`: `aarav.demo@sewago.app` / `customer123`
- **Driver app:** http://localhost:4000/driver — log in with a demo driver (password `driver123`):
  - 🏍️ `ramesh@sewago.app` (Bike) · 🚗 `sita@sewago.app` (Car) · 🚐 `dipesh@sewago.app` (XL)
  - seeded demo drivers: 🏍️ `bijay.demo@sewago.app` · 🚗 `tara.demo@sewago.app` · 🚐 `om.demo@sewago.app`
  - or register a brand-new driver with your own vehicle
- **Partner portal:** http://localhost:4000/partner — after `npm run demo:seed`: `partner.demo@sewago.app` / `partner123`

### Try the live two-sided flow

Open the customer app and the driver app in **two browser windows**. Go **online** as the driver, then request a ride as the customer:

1. Customer books → request appears instantly on the driver's screen with the fare and their 80% payout
2. Driver taps **Accept** → customer sees the driver's name, vehicle and plate
3. Driver taps **Picked up — start trip** → customer sees "On trip" with a progress bar
4. Driver taps **Complete trip** → earnings are credited; customer rates the trip ⭐

If **no driver of that tier is online**, the app falls back to a simulated driver so the demo always works. If a live request isn't accepted **within 45 s**, it auto-cancels and refunds the customer.

## What's inside

| Area | What works |
|---|---|
| **Auth** | Separate customer and driver accounts, salted scrypt password hashing, bearer tokens |
| **Rides** | Fare estimates for Bike / Car / XL, real driver matching (accept / start / complete), live trip status, cancel with refund, star ratings |
| **Real locations & map** | 24 real Kathmandu-valley places with actual GPS coordinates (autocomplete + tap-chips), live OpenStreetMap view with pickup 🟢, dropoff 🏁 and the driver moving along the route |
| **Arrival ETAs** | Every driver has a real base location (Ramesh waits in Thamel, Sita in Jawalakhel…) — "arrives in ~7 min" is computed from base → pickup distance at that vehicle's city speed, and counts down live |
| **Driver app** | Online/offline toggle, **sequential dispatch** — each ride is offered exclusively to the nearest driver for ~15 s with Accept/Pass, then cascades to the next-nearest (no more racing every driver to tap first; decliners are never re-offered the same ride) — trip map, trip controls, 80% fare payouts, food-courier delivery jobs, earnings + trip history, driver signup |
| **Food** | 6 restaurants with menus, cart, live order tracking (placed → preparing → on the way → delivered), cancel while "placed". **Partner-run restaurants are fulfilled for real**: the customer sets a delivery address (GPS or area), the restaurant accepts or rejects from the partner portal, and an online bike driver couriers it (accept → picked up → delivered) earning 80% of the delivery fee. Unconfirmed orders auto-refund after 10 min. Seeded demo restaurants stay timer-simulated |
| **Parcels** | Send a package on the bike network: name the receiver (name + phone + contents), a bike courier picks it up and hands it over — same fares, dispatch, live tracking and 80% payout as rides |
| **Ratings** | Restaurant ratings come from real delivered orders (one tap after delivery) and live-trip stars update the driver's rating — seeded reputations are vote-weighted so one bad review can't tank a listing |
| **Stays** | Hotels in Kathmandu / Pokhara / Chitwan, real date-overlap availability, booking, cancel with refund before check-in |
| **Partner portal** | Businesses register with phone + registration/PAN number, submit restaurants (menus) and hotels (rooms), track review status, resubmit after rejection, manage the live order queue, and **promote listings** — Rs 500/week from their earnings pins a listing to the top of the customer list with a ⭐ Featured badge (stacks on repeat purchase) |
| **Admin portal** | Platform overview (revenue, users, drivers online, pending reviews), review queue with partner contact details for call-verification, approve → instantly live / reject with a note |
| **Mini jobs** | Post any small contract (shopping, cleaning, delivery, repair…), budget held in escrow, anyone accepts → marks done → poster confirms → tasker paid 90%, SewaGo keeps 10% |
| **Payments** | Gateway-style checkout for top-ups (eSewa / Khalti / card, sandbox PIN `1234`), full transaction ledger with balance-after on every entry, withdrawals to eSewa/Khalti/bank with a Rs 10 fee — payouts require admin approval, rejection auto-refunds |
| **Wallet** | Every service pays from an in-app wallet; rides, food, stays, and task escrow all write ledger entries |
| **Activity** | Full history of rides, orders and bookings |

## Trust & safety model

Nothing partner-submitted reaches customers without staff approval: new listings are `pending`, the customer API only serves `approved` ones, and rejection sends the partner your note. Drivers need a license ID (verified with a one-time code, demo `123456`) and a **fresh live GPS fix** before they can go online. Ride money flows through the wallet with automatic refunds on cancels and timeouts; task budgets sit in escrow until the poster confirms.

**Admin login:** `admin@sewago.app` / `admin123` in dev — override with `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables in production.

## Production and mobile deployment

Already in place: per-IP rate limiting (tighter on auth endpoints), security headers, 200 kB body limit, central error handler, atomic JSON writes, graceful shutdown, env-configurable admin credentials and port, `.gitignore` for data + secrets, Supabase-backed app-state persistence, Dockerfile, Render blueprint, an Expo Go mobile wrapper, emailed password-reset links (Resend/SendGrid/webhook via [server/email.js](server/email.js)), in-app account deletion in all three apps (app-store requirement), `/privacy` + `/terms` pages, and a money-path test suite (`npm test`).

Current production truth: this repo runs on local JSON by default, or Supabase when `DATA_STORE=supabase`. Supabase mode stores the existing app state in an `app_state` row so the app can deploy online without rewriting every route first. That is good for an online demo/private pilot; serious public scale still needs relational Postgres transactions for wallets, bookings, rides and payouts.

Use:

- [.env.example](.env.example) for local config.
- [.env.supabase.example](.env.supabase.example) for Supabase deployments.
- [docs/supabase-schema.sql](docs/supabase-schema.sql) in the Supabase SQL editor.
- [docs/deployment/supabase-render-expo.md](docs/deployment/supabase-render-expo.md) for the full Render + Expo Go path.

Before real users: put it behind HTTPS, set strong `ADMIN_PASSWORD` + `DRIVER_LICENSE_DEMO_CODE`, use `DATA_STORE=supabase`, move rate limiting to Redis if you run more than one instance, and add real OTP/KYC providers for phone and license verification.

When `NODE_ENV=production`, the server refuses unsafe defaults unless you explicitly enable private-pilot overrides such as `ALLOW_SANDBOX_PROVIDERS_IN_PRODUCTION=true`.

### Supabase quick start

```bash
cp .env.supabase.example .env
# edit SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
npm run supabase:push
npm start
```

### Expo Go quick start

```bash
cd mobile
npm install
cp .env.example .env
# set EXPO_PUBLIC_SEWAGO_URL to your deployed backend
npm start
```

For local phone testing on the same Wi-Fi, set `EXPO_PUBLIC_SEWAGO_URL` to your
computer's LAN URL, for example `http://192.168.179.36:4000`.

For a directly downloadable Android APK:

```bash
cd mobile
npm run build:android:apk
```

For browser install on phones, deploy the server over HTTPS and open:

```text
https://your-domain.example/download
```

**Going live with payments:** the gateway is deliberately isolated in [server/payments.js](server/payments.js) and [server/routes/payments.js](server/routes/payments.js) with the same shape real providers use (create intent → confirm/verify). To go live, replace the sandbox PIN check in `topup/confirm` with the provider's server-side verification call (eSewa ePay verification / Khalti lookup API / Stripe PaymentIntent), and trigger real disbursements where admin approves a withdrawal. The ledger, escrow, fee, and refund logic all stay exactly as they are.

## Architecture

```
sewago/
├── server/
│   ├── index.js          # Express app, static hosting, route mounting
│   ├── db.js             # JSON-file datastore + seed data (drivers, restaurants, hotels)
│   ├── passwords.js      # scrypt hashing shared by customer & driver auth
│   ├── rideLogic.js      # ride status machine (live + simulated), payouts, refunds
│   └── routes/
│       ├── auth.js       # customer register / login / me / wallet
│       ├── driver.js     # driver auth, online toggle, requests, accept/start/complete
│       ├── rides.js      # estimates, booking, live status, cancel, rate
│       ├── food.js       # restaurants, orders, live status, cancel
│       └── stays.js      # hotels, availability, bookings, cancel
├── public/
│   ├── index.html + app.js      # customer app (vanilla JS, no build step)
│   ├── driver.html + driver.js  # driver app
│   └── styles.css               # shared dark mobile-first UI
└── data/db.json          # created on first run (delete it to reset everything)
```

- **No build step, one dependency** (Express). `npm start` is all it takes.
- Rides have two modes: **live** (a real online driver accepts and drives the state machine) and **sim** (timer-based fallback when nobody's online). Food orders are timer-simulated.
- Both apps poll every ~2 s, so updates appear on the other side almost instantly.
- Geocoding is **real**: the address box searches live OpenStreetMap data ([server/geo.js](server/geo.js), proxied + cached + rate-limited server-side, biased to the Kathmandu valley), and the 📍 button reverse-geocodes the browser's GPS fix into a labelled pickup. Points outside the valley are rejected. A built-in gazetteer ([server/places.js](server/places.js)) still backs the "popular places" chips and any free-text fallback. Distances use haversine × 1.3 road factor, so Thamel → Patan ≈ 6.4 km, matching reality. Swap the geocoder host with `NOMINATIM_BASE` for production volume.
- The map is Leaflet + CARTO dark tiles from a CDN; without internet the app still works, only map tiles are blank.

## Payments — how the money flows

Every rupee moves through the SewaGo wallet, so the platform sees (and earns on) every booking:

- **Top-ups** go through real gateways — **Khalti** (hosted checkout) and **eSewa** (signed ePay v2 form). Both are verified server-to-server (lookup / status-check API) before a single rupee is credited; redirects alone are never trusted, credits are idempotent, and mismatched amounts are rejected.
- **Service fees**: wallet ride bookings add Rs 5, food orders add Rs 15 (env-tunable via `RIDE_SERVICE_FEE` / `FOOD_SERVICE_FEE`) — shown in the fare card and cart, refunded on cancellation, and tracked as their own `service_fee` revenue line.
- **Surge pricing**: when riders searching outnumber online drivers of a tier, fares step up (1.2× / 1.4× / capped at `RIDE_SURGE_CAP`, default 1.5×) with a ⚡ busy badge shown before booking. Drivers earn 80% of the surged fare, so supply is pulled toward demand. The simulated-driver fallback never surges.
- **Late cancellation fee**: cancelling a wallet ride after a real driver accepted costs Rs 40 (`RIDE_CANCEL_FEE`) — half compensates the driver, half is platform revenue. Cancelling while still searching stays free, as do sim and cash rides. The cancel button warns before charging.
- **Rides**: fare from wallet (or cash) → driver gets 80%, SewaGo keeps 20% (deducted from balance on cash trips).
- **Food**: paid from wallet → partner restaurant gets 85% of the subtotal; the courier who delivers earns 80% of the delivery fee; SewaGo keeps 15% of the subtotal + 20% of the delivery fee + the service fee. Delivery is priced by road distance: the restaurant's base fee covers the first 3 km, then Rs 15/km (env-tunable).
- **Parcels**: standard bike fare + service fee; the courier keeps 80% like any trip.
- **Stays**: paid from wallet → partner hotel gets 90%, SewaGo keeps 10%.
- **Tasks**: budget held in escrow until the poster confirms → worker gets 90%, SewaGo keeps 10%.
- **Withdrawals**: Rs 10 flat fee, paid out after admin approval (eSewa / Khalti / bank).
- **Featured listings**: partners pay Rs 500/week (`PROMOTE_WEEK_PRICE`) from earnings for top placement — pure-margin platform revenue on its own ledger line.
- Every fee and commission (and any reversal on refunds) lands in a **platform ledger** — the admin Payments view shows a full audit trail, not a recomputed number.

**Go-live checklist**: set `KHALTI_SECRET_KEY` + `KHALTI_MODE=live` and/or `ESEWA_PRODUCT_CODE` + `ESEWA_SECRET` + `ESEWA_MODE=live`, plus `PUBLIC_APP_URL=https://your-domain` (gateway return URLs are built from it). A method goes live automatically once its keys are present; without keys it falls back to the PIN-1234 sandbox in development and is hidden in production. Test with `ESEWA_PRODUCT_CODE=EPAYTEST` / the documented test secret, and Khalti test keys from dev.khalti.com.

## Taking it to production (roadmap)

1. Swap the JSON store for Postgres (the route files are already organized per domain).
2. Real auth: JWT with refresh tokens, phone OTP.
3. Real maps: Google Maps / OpenStreetMap for geocoding, routing and driver tracking via WebSockets.
4. Restaurant & hotel partner apps (like the driver app), then an admin dashboard.
5. Wrap the web app with Capacitor for Android/iOS, or rebuild the UI in React Native.
