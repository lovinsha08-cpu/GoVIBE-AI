-- GoVIBE AI — initial schema
-- Run this in the Supabase SQL editor after creating your project.
-- auth.users is managed by Supabase Auth; these tables extend it per role.
-- This script is idempotent — safe to run multiple times against the same project.

create table if not exists travelers (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  created_at timestamptz default now()
);

create table if not exists businesses (
  id uuid primary key references auth.users(id) on delete cascade,
  business_name text not null,
  business_model text not null,       -- e.g. "restaurant", "homestay", "tour operator"
  location text not null,
  category text not null,             -- e.g. "food", "stay", "activity", "shopping"
  description text,
  phone text,
  verified boolean default false,     -- flips true after genuineness check passes
  created_at timestamptz default now()
);

-- Row Level Security: users can only read/write their own row
alter table travelers enable row level security;
alter table businesses enable row level security;

drop policy if exists "Travelers can view own profile" on travelers;
create policy "Travelers can view own profile" on travelers
  for select using (auth.uid() = id);

drop policy if exists "Travelers can update own profile" on travelers;
create policy "Travelers can update own profile" on travelers
  for update using (auth.uid() = id);

drop policy if exists "Businesses can view own profile" on businesses;
create policy "Businesses can view own profile" on businesses
  for select using (auth.uid() = id);

drop policy if exists "Businesses can update own profile" on businesses;
create policy "Businesses can update own profile" on businesses
  for update using (auth.uid() = id);

-- Public read of verified businesses (for traveler-facing offers/listings)
drop policy if exists "Anyone can view verified businesses" on businesses;
create policy "Anyone can view verified businesses" on businesses
  for select using (verified = true);


-- ============================================================
-- Trip planning + itinerary engine tables
-- ============================================================

-- Tourist spots / points of interest. Seed this from OSM/Overpass + manual curation.
create table if not exists spots (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null,              -- matches interest_categories.slug (e.g. "nature_scenic", "heritage_historical")
  subcategory text,
  latitude double precision not null,
  longitude double precision not null,
  city text,
  rating numeric(2,1),                 -- 0.0–5.0
  popularity_score numeric(3,2),       -- 0.00–1.00, used for hidden-gem detection (low popularity + high rating)
  avg_visit_minutes int default 60,
  entry_fee_inr numeric(10,2) default 0,
  description text,
  image_url text,
  source text default 'manual',        -- 'osm' | 'manual' | 'business'
  created_at timestamptz default now()
);
create index if not exists spots_category_idx on spots(category);
create index if not exists spots_location_idx on spots(latitude, longitude);

-- Interest taxonomy shown in wizard step 3 (category -> subcategories, multi-select)
create table if not exists interest_categories (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,           -- e.g. "nature"
  label text not null,                 -- e.g. "Nature & Outdoors"
  subcategories text[] not null default '{}'  -- e.g. ["Trekking","Waterfalls","Wildlife"]
);

-- A traveler's trip request — captures every wizard step's input
create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid references travelers(id) on delete cascade,

  -- Step 1: destination
  start_location text,
  start_lat double precision,
  start_lng double precision,
  destination text not null,
  destination_lat double precision,
  destination_lng double precision,
  end_location text,
  end_lat double precision,
  end_lng double precision,

  -- Step 2: duration
  start_date date not null,
  end_date date not null,
  start_time time,
  end_time time,
  needs_accommodation boolean default true,

  -- Step 3: interests
  interests jsonb default '[]',        -- [{category:"nature", subcategories:["Trekking","Waterfalls"]}]

  -- Trip style (chosen right after interests) — one of:
  -- 'fast_paced' | 'relaxed' | 'scenic' | 'food_explorer' | 'family_friendly' |
  -- 'budget_friendly' | 'luxury' | 'hidden_gems_only'
  trip_style text,

  -- Step 4: budget (INR)
  total_budget_inr numeric(10,2) not null,

  -- Step 5: group composition
  adults int default 1,
  kids int default 0,
  elderly int default 0,
  specially_abled int default 0,

  -- Step 6: transport
  transport_priority text,             -- 'fastest' | 'cheapest' | 'comfortable'
  transport_modes text[] default '{}', -- e.g. ["cab","train"]

  -- Step 7: food preferences
  food_preferences text[] default '{}', -- e.g. ["veg","vegan"]

  status text default 'draft',         -- 'draft' | 'generated' | 'booked' | 'completed'
  created_at timestamptz default now()
);
create index if not exists trips_traveler_idx on trips(traveler_id);

-- Generated itinerary output — one row per generation (regenerate creates a new row, keeps history)
create table if not exists itineraries (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id) on delete cascade,
  version int default 1,
  stops jsonb not null default '[]',
  -- stops: [{ spot_id, order, arrival_time, departure_time, transport_mode,
  --           travel_minutes_from_prev, distance_km_from_prev, reasoning,
  --           crowd_level, weather_note }]
  budget_summary jsonb default '{}',
  -- { per_spot: [...], by_category: {food,transport,experience,accommodation}, total }
  total_distance_km numeric(8,2),
  total_duration_minutes int,
  generated_by text default 'heuristic', -- 'heuristic' | 'gemini'
  created_at timestamptz default now()
);
create index if not exists itineraries_trip_idx on itineraries(trip_id);

-- Emergency facilities near a spot (hospitals/clinics), sourced from Overpass
create table if not exists emergency_facilities (
  id uuid primary key default gen_random_uuid(),
  spot_id uuid references spots(id) on delete cascade,
  name text not null,
  type text,                    -- 'hospital' | 'clinic' | 'pharmacy'
  latitude double precision,
  longitude double precision,
  phone text,
  distance_km numeric(6,2)
);
create index if not exists emergency_spot_idx on emergency_facilities(spot_id);

-- Business offers/deals shown in traveler's "Offers" tab
create table if not exists offers (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  title text not null,
  description text,
  discount_percent int,
  valid_until date,
  views int default 0,
  bookings_attributed int default 0,
  created_at timestamptz default now()
);

-- RLS for new tables
alter table trips enable row level security;
alter table itineraries enable row level security;
alter table offers enable row level security;

drop policy if exists "Travelers manage own trips" on trips;
create policy "Travelers manage own trips" on trips
  for all using (auth.uid() = traveler_id);

drop policy if exists "Travelers view own itineraries" on itineraries;
create policy "Travelers view own itineraries" on itineraries
  for select using (
    exists (select 1 from trips where trips.id = itineraries.trip_id and trips.traveler_id = auth.uid())
  );

drop policy if exists "Businesses manage own offers" on offers;
create policy "Businesses manage own offers" on offers
  for all using (auth.uid() = business_id);

drop policy if exists "Anyone can view offers from verified businesses" on offers;
create policy "Anyone can view offers from verified businesses" on offers
  for select using (
    exists (select 1 from businesses where businesses.id = offers.business_id and businesses.verified = true)
  );

-- ============================================================
-- Map + real-data-seeding additions
-- ============================================================
-- Timings, direct booking link, and an explicit hidden-gem flag
-- (in addition to the popularity_score heuristic already used to detect them).
alter table spots add column if not exists opening_hours text;
alter table spots add column if not exists booking_url text;
alter table spots add column if not exists is_hidden_gem boolean default false;

-- Trip Style feature — safe to re-run against an existing database that
-- predates this column.
alter table trips add column if not exists trip_style text;

-- Saved-itinerary history (Feature: "View Booked Itineraries") — an optional
-- human-friendly label a traveler can give their trip; falls back to the
-- destination name in the UI when not set.
alter table trips add column if not exists trip_name text;

-- Seed interest taxonomy (mirrors frontend/src/lib/interestCategories.js)
insert into interest_categories (slug, label, subcategories) values
  ('religious_spiritual', 'Religious & Spiritual', array['Temples','Churches','Mosques','Jain Temples','Gurudwaras','Ashrams']),
  ('heritage_historical', 'Heritage & Historical', array['Forts','Memorials','Museums','Heritage Buildings','Monuments','Archaeological Sites']),
  ('nature_scenic', 'Nature & Scenic', array['Beaches','Parks','Gardens','Lakes','Rivers & Backwaters','Eco Parks','Bird Sanctuaries','Mangroves']),
  ('wildlife', 'Wildlife', array['Zoos','Aquariums','Snake Parks','Wildlife Parks']),
  ('entertainment_recreation', 'Entertainment & Recreation', array['Amusement Parks','Water Parks','Theme Parks','Gaming Zones','Escape Rooms','Bowling Centres','Trampoline Parks']),
  ('arts_culture', 'Arts & Culture', array['Art Galleries','Cultural Centres','Music & Dance Venues','Theatres','Exhibition Centres']),
  ('science_learning', 'Science & Learning', array['Science Centres','Planetariums','Libraries','Educational Museums']),
  ('shopping', 'Shopping', array['Shopping Malls','Street Markets','Flea Markets','Handicraft Stores','Textile & Silk Stores','Bookstores']),
  ('food_dining', 'Food & Dining', array['Restaurants','Cafés','Street Food','Bakeries','Fine Dining','Rooftop Dining','Food Courts']),
  ('photography_landmarks', 'Photography & Landmarks', array['Lighthouses','Viewpoints','Sunrise Spots','Sunset Spots','Iconic Landmarks','Instagram Spots']),
  ('sports_adventure', 'Sports & Adventure', array['Stadiums','Sports Complexes','Go-Karting','Adventure Parks','Indoor Sports']),
  ('wellness_leisure', 'Wellness & Leisure', array['Spas','Yoga Centres','Meditation Centres','Wellness Retreats']),
  ('nightlife', 'Nightlife', array['Pubs','Lounges','Bars','Night Cafés','Live Music Venues'])
on conflict (slug) do update set label = excluded.label, subcategories = excluded.subcategories;

-- Categories retired from the master taxonomy above (2026 Chennai refresh).
-- Deleted rather than updated in place since none of the old slugs map 1:1
-- onto a single new category.
delete from interest_categories where slug in ('nature','heritage','adventure','food','family','relaxation','photography','hidden_gems','transport_city');

-- ============================================================
-- Offers & Deals — Business Dashboard <-> Traveler Dashboard sync
-- ============================================================
-- Extends the `offers` table created above with the fields the
-- Business "Add New Offer" form and the Traveler "Offers & Deals"
-- cards need. Safe to re-run.
alter table offers add column if not exists category text;
alter table offers add column if not exists discount_type text default 'percent'; -- 'percent' | 'flat'
alter table offers add column if not exists discount_value numeric(10,2);
alter table offers add column if not exists valid_from date;
alter table offers add column if not exists image_url text;
alter table offers add column if not exists is_active boolean default true;
alter table offers add column if not exists updated_at timestamptz default now();

-- Offers are shown to travelers as soon as a business creates them,
-- without waiting on the (separate, not-yet-built) business
-- verification workflow — gating on `is_active` only.
drop policy if exists "Anyone can view offers from verified businesses" on offers;
drop policy if exists "Anyone can view active offers" on offers;
create policy "Anyone can view active offers" on offers
  for select using (is_active = true);