-- GoVIBE Explore: wishlist + traveler-created itineraries
-- Safe to run independently after schema.sql.
create table if not exists traveler_wishlist (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid not null references travelers(id) on delete cascade,
  place_key text not null,
  source text,
  place_id text,
  name text not null,
  category text,
  subcategory text,
  description text,
  address text,
  latitude double precision,
  longitude double precision,
  rating numeric(2,1),
  review_count int,
  image_url text,
  maps_url text,
  website_url text,
  created_at timestamptz default now(),
  unique (traveler_id, place_key)
);
create index if not exists traveler_wishlist_traveler_idx on traveler_wishlist(traveler_id);
create table if not exists explore_itineraries (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid not null references travelers(id) on delete cascade,
  title text not null,
  destination text,
  start_date date,
  end_date date,
  transport_mode text,
  stops jsonb not null default '[]',
  total_distance_km numeric(8,2) default 0,
  total_travel_minutes int default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists explore_itineraries_traveler_idx on explore_itineraries(traveler_id);
alter table traveler_wishlist enable row level security;
alter table explore_itineraries enable row level security;
drop policy if exists "Travelers manage own wishlist" on traveler_wishlist;
create policy "Travelers manage own wishlist" on traveler_wishlist for all using (auth.uid() = traveler_id) with check (auth.uid() = traveler_id);
drop policy if exists "Travelers manage own explore itineraries" on explore_itineraries;
create policy "Travelers manage own explore itineraries" on explore_itineraries for all using (auth.uid() = traveler_id) with check (auth.uid() = traveler_id);
