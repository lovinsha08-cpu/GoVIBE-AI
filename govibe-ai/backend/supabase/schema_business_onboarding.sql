-- ============================================================
-- GoVIBE AI — Business AI Onboarding & Digital Presence Agent
-- Phase 1: database/data-model foundation only.
--
-- No AI content generation, webpage rendering, payment-gateway calls, or
-- analytics UI are implemented by this file — it only adds the tables and
-- columns those later phases will read/write.
--
-- Purely additive — every statement is idempotent (`if not exists`) and
-- extends the existing `businesses` table rather than duplicating it.
-- Existing tables (travelers, businesses, spots, trips, itineraries,
-- offers, emergency_facilities) and their current RLS policies are left
-- untouched except for the new `alter table businesses add column`
-- statements below, which cannot change any existing row's behavior
-- (new columns are nullable / defaulted).
--
-- Run AFTER schema.sql (and, if present, schema_ai_orchestration.sql /
-- schema_rag_v2.sql — this file has no dependency on either, ordering
-- relative to them doesn't matter).
-- ============================================================


-- ============================================================
-- 1. Businesses — onboarding, geo verification, owner verification,
--    external place identification, public-page slug
-- ============================================================
-- Reuses the existing `businesses` table (created in schema.sql) instead
-- of introducing a parallel "business_profile" table. The pre-existing
-- `verified` boolean is left exactly as-is — it already means "publicly
-- listed / passed genuineness check" and existing RLS policies and the
-- offers feature depend on that meaning. Nothing here changes when or how
-- `verified` gets set; that remains a later-phase decision.

-- -- Location / geo verification (kept separate from owner verification) --
-- Owner-captured coordinates (from the onboarding wizard's geo-tag step).
alter table businesses add column if not exists latitude double precision;
alter table businesses add column if not exists longitude double precision;
-- Google Place the location was matched against during verification.
-- Only the identifier is stored — no cached name/address/rating/photo
-- fields, to avoid duplicating data that's already fetched live from the
-- Google Places API when needed (per product decision: don't scrape or
-- cache more Google data than necessary).
alter table businesses add column if not exists google_place_id text;
-- 'manual_geotag' | 'google_places' — how latitude/longitude were obtained.
alter table businesses add column if not exists location_source text;
-- Set once a human/verification step has accepted the captured location
-- against the matched place. Null = not yet verified.
alter table businesses add column if not exists location_verified_at timestamptz;

-- -- Owner verification (kept separate from location verification) --
-- Each channel has its own timestamp so partial progress is visible
-- (e.g. email done, phone still pending) without needing a status enum.
alter table businesses add column if not exists owner_email_verified_at timestamptz;
alter table businesses add column if not exists owner_phone_verified_at timestamptz;
-- Explicit flag rather than a computed/generated column, mirroring the
-- style of the existing `verified` column. A later phase's controller is
-- responsible for setting this true once both timestamps above are set.
alter table businesses add column if not exists owner_verified boolean default false;

-- -- Overall onboarding progress (informational — no automatic transitions
-- -- are implemented in this phase) --
-- 'pending' | 'location_verified' | 'owner_verified' | 'details_reviewed' | 'live'
alter table businesses add column if not exists onboarding_status text default 'pending';

-- -- Public digital-presence identifier --
-- URL slug for the generated business webpage (e.g. /b/:slug). Unique so
-- it can be safely used as a public route param.
alter table businesses add column if not exists slug text unique;

create index if not exists businesses_slug_idx on businesses(slug);
create index if not exists businesses_onboarding_status_idx on businesses(onboarding_status);
create index if not exists businesses_google_place_id_idx on businesses(google_place_id);


-- ============================================================
-- 2. Owner verification OTPs (email + mobile)
-- ============================================================
-- Deliberately has NO client-facing RLS policies below (RLS is enabled
-- with zero grants), because only the backend — using the service-role
-- client, which bypasses RLS — should ever read or write OTP rows. A
-- business's own anon/authenticated session has no reason to query this
-- table directly. Only a salted hash of the code is stored, never the
-- raw OTP.
create table if not exists business_otp_requests (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  channel text not null,                 -- 'email' | 'sms'
  destination text not null,             -- email address or phone number the code was sent to
  code_hash text not null,               -- hash of the OTP; raw code is never persisted
  purpose text default 'owner_verification',
  attempts int default 0,
  max_attempts int default 5,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists business_otp_business_idx on business_otp_requests(business_id);

alter table business_otp_requests enable row level security;
-- No policies created — default-deny for anon/authenticated roles.
-- The backend's service-role client bypasses RLS entirely, so OTP
-- issuance/verification continues to work from server code.


-- ============================================================
-- 3. Business services (what a business actually offers/sells)
-- ============================================================
-- Distinct from `offers` (existing table = time-bound discounts/promos).
-- A service is the underlying bookable item; an offer can later reference
-- one, but that link is left out of Phase 1 to avoid speculative schema —
-- `offers` already works standalone today and isn't being touched.
create table if not exists business_services (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  name text not null,
  description text,
  price_inr numeric(10,2),
  duration_minutes int,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists business_services_business_idx on business_services(business_id);

alter table business_services enable row level security;

drop policy if exists "Businesses manage own services" on business_services;
create policy "Businesses manage own services" on business_services
  for all using (auth.uid() = business_id);

-- Mirrors the existing "Anyone can view active offers" policy on `offers`.
drop policy if exists "Anyone can view active services" on business_services;
create policy "Anyone can view active services" on business_services
  for select using (is_active = true);


-- ============================================================
-- 4. Bookings
-- ============================================================
-- Guest (non-account) bookings are expected, so `traveler_id` is nullable
-- and customer contact fields are captured directly on the row. All writes
-- are expected to go through the backend's service-role client (same
-- pattern already used by every existing controller in this codebase), so
-- guest inserts work uniformly regardless of RLS.
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  service_id uuid references business_services(id) on delete set null,
  offer_id uuid references offers(id) on delete set null,
  traveler_id uuid references travelers(id) on delete set null,
  customer_name text,
  customer_email text,
  customer_phone text,
  booking_date date,
  booking_time time,
  party_size int default 1,
  status text default 'pending',        -- 'pending' | 'confirmed' | 'cancelled' | 'completed'
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists bookings_business_idx on bookings(business_id);
create index if not exists bookings_traveler_idx on bookings(traveler_id);

alter table bookings enable row level security;

drop policy if exists "Businesses manage own bookings" on bookings;
create policy "Businesses manage own bookings" on bookings
  for all using (auth.uid() = business_id);

drop policy if exists "Travelers view own bookings" on bookings;
create policy "Travelers view own bookings" on bookings
  for select using (auth.uid() = traveler_id);

-- No public/anon insert policy: guest bookings are created by the backend
-- via the service-role client, which bypasses RLS. This avoids opening an
-- unauthenticated write policy on a table containing customer contact info.


-- ============================================================
-- 5. Payments (safe references/status only — no sensitive payment data)
-- ============================================================
-- Only gateway-issued identifiers and a status string are stored. Card
-- numbers, UPI VPAs, bank details, or any other cardholder/instrument
-- data must never be written to this table — the gateway (e.g. Razorpay)
-- is the system of record for that; this table just tracks what GoVIBE
-- needs to reconcile a booking against a gateway transaction.
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid references bookings(id) on delete cascade,
  business_id uuid references businesses(id) on delete cascade,
  gateway text default 'razorpay',
  gateway_order_id text,
  gateway_payment_id text,
  amount_inr numeric(10,2),
  currency text default 'INR',
  status text default 'created',        -- 'created' | 'authorized' | 'captured' | 'failed' | 'refunded'
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists payments_business_idx on payments(business_id);
create index if not exists payments_booking_idx on payments(booking_id);

alter table payments enable row level security;

drop policy if exists "Businesses view own payments" on payments;
create policy "Businesses view own payments" on payments
  for select using (auth.uid() = business_id);

-- No insert/update policy for any client role: payment status must only
-- ever be written by the backend after verifying a gateway webhook
-- signature, never by a business's or traveler's own session.


-- ============================================================
-- 6. Business webpage configuration
-- ============================================================
-- Holds the *output* of the (not-yet-built) AI content agent and template
-- system as structured JSON — never raw HTML/CSS — so the generated page
-- stays inside the controlled React template set described in the Phase 0
-- plan. One config per business.
create table if not exists business_webpage_config (
  id uuid primary key default gen_random_uuid(),
  business_id uuid unique references businesses(id) on delete cascade,
  template_key text,                    -- selects the category-specific React template, e.g. 'restaurant_v1'
  theme_config jsonb default '{}',      -- colors/fonts/layout knobs consumed by the template
  content_config jsonb default '{}',    -- section copy/media consumed by the template
  status text default 'draft',          -- 'draft' | 'published'
  published_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table business_webpage_config enable row level security;

drop policy if exists "Businesses manage own webpage config" on business_webpage_config;
create policy "Businesses manage own webpage config" on business_webpage_config
  for all using (auth.uid() = business_id);

-- Public webpage rendering needs to read published configs without a
-- business session — mirrors "Anyone can view active offers/services".
drop policy if exists "Anyone can view published webpage config" on business_webpage_config;
create policy "Anyone can view published webpage config" on business_webpage_config
  for select using (status = 'published');


-- ============================================================
-- 7. Business analytics events
-- ============================================================
-- Raw event log the (not-yet-built) Business AI Agent will summarize into
-- insights. Kept intentionally generic (event_type + metadata) so new
-- event kinds don't require schema changes later.
create table if not exists business_analytics_events (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  event_type text not null,             -- 'page_view' | 'offer_click' | 'booking_started' | 'booking_completed' | 'contact_click'
  metadata jsonb default '{}',
  occurred_at timestamptz default now()
);
create index if not exists business_analytics_business_idx on business_analytics_events(business_id);
create index if not exists business_analytics_type_idx on business_analytics_events(event_type);

alter table business_analytics_events enable row level security;

drop policy if exists "Businesses view own analytics events" on business_analytics_events;
create policy "Businesses view own analytics events" on business_analytics_events
  for select using (auth.uid() = business_id);

-- No insert policy for any client role. Public-webpage events (e.g. an
-- anonymous visitor's page_view) are recorded by the backend via the
-- service-role client, not written directly by an anon session — avoids
-- an open write policy on the anon key.


-- ============================================================
-- 8. AI-generated business insights (periodic snapshots)
-- ============================================================
-- Persists the Business AI Agent's output so the dashboard can display it
-- without re-running the LLM on every page load. Raw events above remain
-- the source of truth; this is a cache/history of generated summaries.
create table if not exists business_insights (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  period_start date,
  period_end date,
  summary text,
  insights jsonb default '[]',          -- structured, e.g. [{ title, detail, recommended_action }]
  generated_by text default 'llm',
  created_at timestamptz default now()
);
create index if not exists business_insights_business_idx on business_insights(business_id);

alter table business_insights enable row level security;

drop policy if exists "Businesses view own insights" on business_insights;
create policy "Businesses view own insights" on business_insights
  for select using (auth.uid() = business_id);

-- No insert/update policy for any client role: insights are only ever
-- written by the backend after the (not-yet-built) AI agent generates
-- them.