# Deploy SewaGo With Supabase, Render, And Expo Go

This path gives you an online SewaGo backend plus an Expo Go mobile wrapper.

## 1. Create Supabase

1. Create a Supabase project.
2. Open SQL Editor.
3. Run `docs/supabase-schema.sql`.
4. Copy:
   - Project URL
   - Service role key

Do not put the service role key in browser JavaScript, `public/`, or
`mobile/.env`. It belongs only in server environment variables.

## 2. Test Supabase Locally

Create `.env` from the template:

```bash
cp .env.supabase.example .env
```

Set:

```text
DATA_STORE=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_STATE_ID=development
PUBLIC_APP_URL=http://localhost:4000
```

Push your current local catalog/demo data to Supabase:

```bash
npm run supabase:push
```

Start the server:

```bash
npm start
```

Check:

```text
http://localhost:4000/api/health
```

The response should show:

```json
{ "dataStore": "supabase" }
```

## 3. Deploy On Render

This repo includes `render.yaml`.

1. Push the repo to GitHub.
2. In Render, create a Blueprint from the repo.
3. Set these environment variables:

```text
NODE_ENV=production
TRUST_PROXY=true
DATA_STORE=supabase
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_STATE_ID=production
PUBLIC_APP_URL=https://your-render-domain.onrender.com
ADMIN_EMAIL=admin@your-domain.example
ADMIN_PASSWORD=long-random-secret
DRIVER_LICENSE_DEMO_CODE=private-pilot-code
ALLOW_DEMO_VERIFICATION_IN_PRODUCTION=true
PAYMENT_PROVIDER=sandbox
OTP_PROVIDER=twilio
TWILIO_ACCOUNT_SID=your-twilio-account-sid
TWILIO_AUTH_TOKEN=your-twilio-auth-token
TWILIO_FROM_NUMBER=your-sms-capable-twilio-number
EMAIL_PROVIDER=sandbox
ALLOW_SANDBOX_PROVIDERS_IN_PRODUCTION=true
```

Use `OTP_PROVIDER=webhook` plus `SMS_WEBHOOK_URL`/`SMS_WEBHOOK_TOKEN` instead
if you connect a different SMS gateway. The sandbox provider flags are
acceptable for a private pilot only. Remove them and wire real payment/SMS/email
providers before taking public users or real money.

## 4. Deploy With Docker Anywhere

Build:

```bash
docker build -t sewago .
```

Run:

```bash
docker run --env-file .env -p 4000:4000 sewago
```

## 5. Run In Expo Go

The Expo wrapper is in `mobile/`.

```bash
cd mobile
npm install
cp .env.example .env
```

Set:

```text
EXPO_PUBLIC_SEWAGO_URL=https://your-render-domain.onrender.com
```

Start:

```bash
npm start
```

Scan the QR code with Expo Go. The app can switch between Customer, Driver,
Partner and Admin views.

For local phone testing, use your computer's LAN IP instead of `localhost`.

## Production Caveat

`DATA_STORE=supabase` currently persists the existing app state into Supabase's
`app_state` table. That is enough for an online demo and private pilot.

For a serious public marketplace, migrate the hot paths to relational tables and
transactions:

- Wallet debits/refunds
- Ride accept/start/complete
- Hotel availability and booking
- Food ordering and partner earnings
- Task escrow and payouts
- Withdrawals and admin approvals
