-- GoVIBE AI — Phase 2: Business onboarding & geo-location verification
-- Run this in the Supabase SQL editor (after schema.sql). Idempotent — safe
-- to run multiple times against the same project.
--
-- Adds the columns needed to capture a business's GPS location at signup,
-- match it against an official place-data provider (Google Places), and
-- record the result — WITHOUT conflating "is this the right place on the
-- map" (location_verified) with "is the person signing up actually the
-- owner" (owner_verified, a separate manual/human process not implemented
-- in this phase).
--
-- `latitude`/`longitude` also match the column names already expected by
-- backend/src/services/nearbySearch.service.js's GoVIBE-partner "near me"
-- query, so this migration also unblocks that existing read path.

alter table businesses add column if not exists latitude double precision;
alter table businesses add column if not exists longitude double precision;

-- Free-text formatted address, preferably the one returned by the place
-- match (falls back to the business's own typed `location` if unmatched).
alter table businesses add column if not exists address text;

-- Google Place ID of the matched place, if any — lets later phases re-fetch
-- fresh details without re-running the matching step.
alter table businesses add column if not exists google_place_id text;

-- true only when the submitted GPS coordinates deterministically matched a
-- real place (by name + Haversine distance) via the Places API. Never set
-- by an LLM and never inferred from anything other than that check.
alter table businesses add column if not exists location_verified boolean default false;

-- true only after a separate, human/manual ownership-verification process
-- (out of scope for this phase). Always false here — included now so the
-- two concepts are never conflated in the schema or the API.
alter table businesses add column if not exists owner_verified boolean default false;

-- Diagnostic fields describing *why* location_verified has its value —
-- shown to the business owner and useful for support/debugging.
alter table businesses add column if not exists location_match_status text; -- 'matched' | 'too_far' | 'not_found' | 'unavailable' | 'skipped'
alter table businesses add column if not exists location_distance_meters numeric(10, 2);
alter table businesses add column if not exists location_verified_at timestamptz;

-- Snapshot of whatever the Places API returned for the matched place at
-- verification time (name, formatted address, category/types, opening
-- hours, rating, review count, phone, website) — kept for display/audit;
-- never treated as a legitimacy decision by itself.
alter table businesses add column if not exists place_details jsonb;

create index if not exists businesses_location_verified_idx on businesses(location_verified);