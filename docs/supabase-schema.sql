-- SewaGo production database starter for Supabase/Postgres.
-- This mirrors the current JSON collections and keeps flexible JSONB fields
-- where the demo app still stores nested data.

create extension if not exists pgcrypto;

-- Runtime store used by the current Express app.
-- It keeps the existing JSON app state in Supabase so the app can deploy
-- online before every route is rewritten to relational Postgres queries.
create table if not exists app_state (
  id text primary key,
  data jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- Per-row store used by DATA_STORE=supabase_rows. Each app record (a user, ride,
-- order, session token, …) is its own row, so a save writes only what changed
-- instead of re-uploading the whole app_state blob. This is the incremental step
-- between the single-blob store and the fully relational tables below: real
-- Postgres rows you can index and query, with no route rewrites required.
-- On first boot in this mode the app auto-imports an existing app_state blob.
create table if not exists app_records (
  collection text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);
create index if not exists idx_app_records_collection on app_records(collection);

create table if not exists users (
  id text primary key,
  name text not null,
  email text not null unique,
  password text not null,
  phone text not null default '',
  phone_verified boolean not null default false,
  phone_verified_at bigint,
  wallet integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists drivers (
  id text primary key,
  name text not null,
  email text not null unique,
  password text not null,
  tier text not null check (tier in ('bike', 'car', 'xl')),
  vehicle text not null,
  plate text not null unique,
  phone text not null default '',
  phone_verified boolean not null default false,
  phone_verified_at bigint,
  rating numeric not null default 5,
  online boolean not null default false,
  earnings integer not null default 0,
  trips_completed integer not null default 0,
  license_hash text,
  license_last4 text,
  license_verified boolean not null default false,
  verification_status text not null default 'pending',
  kyc_status text not null default 'pending',
  kyc jsonb not null default '{}'::jsonb,
  current_lat numeric,
  current_lng numeric,
  location_accuracy integer,
  location_updated_at bigint,
  base_name text,
  base_lat numeric,
  base_lng numeric,
  created_at timestamptz not null default now()
);

create table if not exists partners (
  id text primary key,
  name text not null,
  email text not null unique,
  password text not null,
  phone text not null,
  phone_verified boolean not null default false,
  phone_verified_at bigint,
  reg_no text not null,
  business_kyc_status text not null default 'pending',
  business_kyc jsonb not null default '{}'::jsonb,
  earnings integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists restaurants (
  id text primary key,
  owner_id text references partners(id) on delete set null,
  name text not null,
  cuisine text not null,
  rating numeric,
  eta_minutes integer not null,
  delivery_fee integer not null default 0,
  icon text not null default '',
  menu jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  review_note text not null default '',
  submitted_at bigint,
  reviewed_at bigint
);

create table if not exists hotels (
  id text primary key,
  owner_id text references partners(id) on delete set null,
  name text not null,
  city text not null,
  area text not null default '',
  description text not null default '',
  rating numeric,
  icon text not null default '',
  rooms jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  review_note text not null default '',
  submitted_at bigint,
  reviewed_at bigint
);

create table if not exists rides (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  driver_id text references drivers(id) on delete set null,
  customer_name text not null,
  pickup text not null,
  dropoff text not null,
  pickup_loc jsonb not null,
  dropoff_loc jsonb not null,
  tier text not null,
  tier_label text not null,
  icon text not null,
  distance_km numeric not null,
  fare integer not null,
  payout integer,
  payment text not null default 'wallet',
  mode text not null default 'live',
  driver jsonb,
  driver_start jsonb,
  driver_live_loc jsonb,
  driver_eta_to_pickup_min integer,
  status text not null,
  cancel_reason text,
  trip_seconds integer not null,
  rating integer,
  created_at bigint not null,
  accepted_at bigint,
  started_at bigint,
  completed_at bigint,
  cancelled_at bigint
);

create table if not exists orders (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  restaurant_id text not null references restaurants(id) on delete restrict,
  restaurant_name text not null,
  restaurant_icon text not null,
  items jsonb not null,
  subtotal integer not null,
  delivery_fee integer not null,
  total integer not null,
  partner_id text references partners(id) on delete set null,
  partner_cut integer,
  status text not null,
  created_at bigint not null,
  delivered_at bigint,
  cancelled_at bigint
);

create table if not exists bookings (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  hotel_id text not null references hotels(id) on delete restrict,
  hotel_name text not null,
  hotel_icon text not null,
  city text not null,
  room_id text not null,
  room_type text not null,
  check_in date not null,
  check_out date not null,
  nights integer not null,
  price_per_night integer not null,
  total integer not null,
  partner_id text references partners(id) on delete set null,
  partner_cut integer,
  status text not null,
  created_at bigint not null,
  cancelled_at bigint
);

create table if not exists tasks (
  id text primary key,
  poster_id text not null references users(id) on delete cascade,
  worker_id text references users(id) on delete set null,
  title text not null,
  category text not null,
  location text not null,
  budget integer not null,
  worker_payout integer,
  fee integer,
  status text not null,
  created_at bigint not null,
  accepted_at bigint,
  done_at bigint,
  completed_at bigint,
  cancelled_at bigint
);

create table if not exists payments (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  amount integer not null,
  method text not null,
  provider text not null default 'sandbox',
  provider_ref text,
  status text not null,
  created_at bigint not null,
  paid_at bigint
);

create table if not exists withdrawals (
  id text primary key,
  owner_kind text not null check (owner_kind in ('user', 'driver', 'partner')),
  owner_id text not null,
  owner_name text not null,
  amount integer not null,
  fee integer not null,
  channel text not null,
  account text not null,
  status text not null,
  created_at bigint not null,
  paid_at bigint,
  rejected_at bigint,
  note text
);

create table if not exists transactions (
  id text primary key,
  owner_kind text not null check (owner_kind in ('user', 'driver', 'partner')),
  owner_id text not null,
  type text not null,
  label text not null,
  amount integer not null,
  sign integer not null check (sign in (-1, 1)),
  method text,
  ref_id text,
  status text not null default 'completed',
  balance_after integer not null,
  created_at bigint not null
);

create table if not exists otp_codes (
  id text primary key,
  owner_kind text not null check (owner_kind in ('user', 'driver', 'partner')),
  owner_id text not null,
  phone text not null,
  code_hash text not null,
  expires_at bigint not null,
  attempts integer not null default 0,
  created_at bigint not null
);

create table if not exists password_reset_tokens (
  id text primary key,
  owner_kind text not null check (owner_kind in ('user', 'driver', 'partner')),
  owner_id text not null,
  token_hash text not null,
  expires_at bigint not null,
  used_at bigint,
  created_at bigint not null
);

create table if not exists auth_tokens (
  token text primary key,
  owner_kind text not null check (owner_kind in ('user', 'driver', 'partner', 'admin')),
  owner_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_rides_user_id on rides(user_id);
create index if not exists idx_rides_driver_id on rides(driver_id);
create index if not exists idx_rides_status on rides(status);
create index if not exists idx_orders_user_id on orders(user_id);
create index if not exists idx_bookings_user_id on bookings(user_id);
create index if not exists idx_transactions_owner on transactions(owner_kind, owner_id, created_at desc);
create index if not exists idx_withdrawals_status on withdrawals(status);
create index if not exists idx_otp_owner on otp_codes(owner_kind, owner_id);
create index if not exists idx_password_reset_token on password_reset_tokens(token_hash);
