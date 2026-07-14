# Testing live rides with your real GPS

How to see a real driver's live location move on the customer's map, from
anywhere in the world (the dev server defaults to `SERVICE_AREA=global`; on a
production deployment set `SERVICE_AREA=global` temporarily).

## The one rule that trips everyone up

A booking only goes **live** if a real driver of that tier is *available at the
moment you book*: online + license verified + phone verified + a GPS ping fresh
enough (default 10 min, `DRIVER_LOCATION_FRESH_MIN`). Otherwise the app falls
back to a **🤖 simulated demo driver** — that ride will never appear in the
driver portal.

The fare list tells you before you book: each tier shows either
**"🟢 N live drivers online"** or **"🤖 demo driver"**. If it says demo, fix the
driver side first.

## Best setup: two devices

- **Phone = driver** (it has the real, moving GPS)
- **Laptop / second phone = customer**

1. Phone → `/driver` → register or log in → verify license + phone → **Update
   live GPS** → **Go online**. The status line shows the exact coordinates the
   server received and how many seconds ago — watch it tick as you move.
   Keep this screen on (the app requests a screen wake lock while online;
   a locked phone stops sending GPS).
2. Laptop → customer app → pick pickup/dropoff (📍 GPS button or address
   search) → the tier should show **🟢 1 live driver online** → book.
3. Phone chimes with the exclusive offer (pickup, distance, your payout,
   15s countdown) → **Accept**. Missed the countdown? No problem — lapsed
   offers cycle back to online drivers for the whole search window (90s by
   default, `RIDE_SEARCH_TIMEOUT_SECONDS`); only tapping **Pass** is final.
4. Laptop → the customer card shows the driver's name/vehicle/plate with a
   **🟢 LIVE** badge, and the map marker is the driver's *real* GPS position,
   updated every few seconds. Walk/cycle with the phone and watch the marker
   move toward the pickup.

## One phone only

Works, but switch tabs quickly: a backgrounded driver tab stops sending GPS.
The freshness window is 10 minutes, so go online as the driver first, then
switch to the customer tab and book within a few minutes.

## If no driver accepts

While a live ride is still searching, the customer can raise the fare
(+Rs 20/50/100, up to +Rs 500). Each boost charges the wallet immediately
(cash rides just raise what the driver collects), restarts the search
window, and re-offers the ride — including to drivers who declined the old
price. The driver's offer card shows an **⚡ BOOSTED** badge.

## Quick diagnosis

| Symptom | Cause |
| --- | --- |
| Tier shows 🤖 demo driver | Driver offline, wrong tier, unverified, or GPS stale — reopen the driver tab, tap **Update live GPS** |
| "outside the Kathmandu valley" | Server is in `kathmandu` mode — set `SERVICE_AREA=global` (check `/api/health`) |
| Driver saw nothing, ride completed anyway | It was a simulated ride — it was booked while no real driver was available |
