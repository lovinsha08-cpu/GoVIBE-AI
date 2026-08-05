-- ============================================================
-- GoVIBE AI — AI Orchestration / Assistant v2 schema
-- Adds: pgvector RAG (FAQs + knowledge base), conversation memory,
-- wishlist, bookings, reviews, and lat/lng on businesses for nearby search.
-- Idempotent — safe to run multiple times against the same project.
-- Run AFTER schema.sql.
-- ============================================================

create extension if not exists vector;

-- ------------------------------------------------------------
-- 1. Nearby-search support on businesses
-- ------------------------------------------------------------
alter table businesses add column if not exists latitude double precision;
alter table businesses add column if not exists longitude double precision;
alter table businesses add column if not exists avg_rating numeric(2,1) default 0;
alter table businesses add column if not exists phone_public text;
create index if not exists businesses_location_idx on businesses(latitude, longitude);

-- ------------------------------------------------------------
-- 2. Conversation memory (chat history, survives page reloads / new devices)
-- ------------------------------------------------------------
create table if not exists chat_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,                  -- references auth.users(id), traveler OR business
  role text not null check (role in ('traveler','business')),
  trip_id uuid references trips(id) on delete set null,  -- set when scoped to a trip
  title text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists chat_conversations_user_idx on chat_conversations(user_id, updated_at desc);

create table if not exists chat_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references chat_conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  -- Orchestration metadata: which path answered this turn (faq | db | api | rag | llm | multi_tool),
  -- which functions were called, and any retrieved sources — kept for
  -- debugging/analytics and so the UI can show "answered from FAQ" etc.
  route text,
  tools_used jsonb default '[]',
  sources jsonb default '[]',
  created_at timestamptz default now()
);
create index if not exists chat_messages_conversation_idx on chat_messages(conversation_id, created_at);

alter table chat_conversations enable row level security;
alter table chat_messages enable row level security;

drop policy if exists "Users manage own conversations" on chat_conversations;
create policy "Users manage own conversations" on chat_conversations
  for all using (auth.uid() = user_id);

drop policy if exists "Users manage own messages" on chat_messages;
create policy "Users manage own messages" on chat_messages
  for all using (
    exists (select 1 from chat_conversations c where c.id = chat_messages.conversation_id and c.user_id = auth.uid())
  );

-- ------------------------------------------------------------
-- 3. User memory — durable preferences learned across conversations
-- ------------------------------------------------------------
create table if not exists user_memory (
  user_id uuid primary key,
  role text not null check (role in ('traveler','business')),
  -- { interests:[...], preferred_transport:"cab", budget_range:{min,max},
  --   food_preference:"veg", home_city:"Chennai", notes:[...] }
  preferences jsonb not null default '{}',
  updated_at timestamptz default now()
);

alter table user_memory enable row level security;
drop policy if exists "Users manage own memory" on user_memory;
create policy "Users manage own memory" on user_memory
  for all using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- 4. RAG — FAQs (semantic FAQ retrieval, high-confidence = skip LLM)
-- ------------------------------------------------------------
-- Gemini text-embedding-004 produces 768-dim vectors.
create table if not exists faqs (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  category text,                       -- e.g. "booking", "itinerary", "billing"
  audience text not null default 'both' check (audience in ('traveler','business','both')),
  embedding vector(768),
  created_at timestamptz default now()
);
create index if not exists faqs_audience_idx on faqs(audience);

-- ------------------------------------------------------------
-- 5. RAG — knowledge base (travel guides, docs, policies, hidden gems, business docs)
-- ------------------------------------------------------------
create table if not exists kb_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,               -- a single chunk (~200-500 words)
  source text,                         -- e.g. "platform_docs", "travel_guide", "policy", "hidden_gems"
  category text,
  audience text not null default 'both' check (audience in ('traveler','business','both')),
  city text,
  embedding vector(768),
  created_at timestamptz default now()
);
create index if not exists kb_documents_audience_idx on kb_documents(audience);
create index if not exists kb_documents_city_idx on kb_documents(city);

-- Vector similarity indexes (cosine). Built lazily — fine to omit until the
-- table has meaningful rows; safe to re-run.
create index if not exists faqs_embedding_idx on faqs using ivfflat (embedding vector_cosine_ops) with (lists = 50);
create index if not exists kb_documents_embedding_idx on kb_documents using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Match functions used by rag.service.js via supabase.rpc(...)
create or replace function match_faqs(
  query_embedding vector(768),
  match_audience text,
  match_threshold float default 0.75,
  match_count int default 3
) returns table (id uuid, question text, answer text, category text, similarity float)
language sql stable as $$
  select f.id, f.question, f.answer, f.category,
         1 - (f.embedding <=> query_embedding) as similarity
  from faqs f
  where f.embedding is not null
    and (match_audience = 'both' or f.audience = 'both' or f.audience = match_audience)
    and 1 - (f.embedding <=> query_embedding) > match_threshold
  order by f.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function match_kb_documents(
  query_embedding vector(768),
  match_audience text,
  match_threshold float default 0.65,
  match_count int default 5
) returns table (id uuid, title text, content text, source text, category text, city text, similarity float)
language sql stable as $$
  select k.id, k.title, k.content, k.source, k.category, k.city,
         1 - (k.embedding <=> query_embedding) as similarity
  from kb_documents k
  where k.embedding is not null
    and (match_audience = 'both' or k.audience = 'both' or k.audience = match_audience)
    and 1 - (k.embedding <=> query_embedding) > match_threshold
  order by k.embedding <=> query_embedding
  limit match_count;
$$;

alter table faqs enable row level security;
alter table kb_documents enable row level security;
drop policy if exists "Anyone can read faqs" on faqs;
create policy "Anyone can read faqs" on faqs for select using (true);
drop policy if exists "Anyone can read kb_documents" on kb_documents;
create policy "Anyone can read kb_documents" on kb_documents for select using (true);

-- ------------------------------------------------------------
-- 6. Wishlist (traveler)
-- ------------------------------------------------------------
create table if not exists wishlist_items (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid references travelers(id) on delete cascade,
  item_name text not null,
  category text,
  city text,
  latitude double precision,
  longitude double precision,
  spot_id uuid references spots(id) on delete set null,
  notes text,
  created_at timestamptz default now()
);
create index if not exists wishlist_traveler_idx on wishlist_items(traveler_id);

alter table wishlist_items enable row level security;
drop policy if exists "Travelers manage own wishlist" on wishlist_items;
create policy "Travelers manage own wishlist" on wishlist_items
  for all using (auth.uid() = traveler_id);

-- ------------------------------------------------------------
-- 7. Bookings (traveler <-> business, backs "Bookings"/"Revenue" functions)
-- ------------------------------------------------------------
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid references travelers(id) on delete cascade,
  business_id uuid references businesses(id) on delete cascade,
  offer_id uuid references offers(id) on delete set null,
  trip_id uuid references trips(id) on delete set null,
  item_name text not null,
  amount_inr numeric(10,2) not null default 0,
  status text not null default 'confirmed' check (status in ('pending','confirmed','completed','cancelled')),
  booked_for_date date,
  created_at timestamptz default now()
);
create index if not exists bookings_traveler_idx on bookings(traveler_id);
create index if not exists bookings_business_idx on bookings(business_id);

alter table bookings enable row level security;
drop policy if exists "Travelers manage own bookings" on bookings;
create policy "Travelers manage own bookings" on bookings
  for all using (auth.uid() = traveler_id);
drop policy if exists "Businesses view own bookings" on bookings;
create policy "Businesses view own bookings" on bookings
  for select using (auth.uid() = business_id);

-- ------------------------------------------------------------
-- 8. Reviews (backs business "Reviews"/"Customer insights" functions)
-- ------------------------------------------------------------
create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  traveler_id uuid references travelers(id) on delete cascade,
  rating int not null check (rating between 1 and 5),
  comment text,
  created_at timestamptz default now()
);
create index if not exists reviews_business_idx on reviews(business_id);

alter table reviews enable row level security;
drop policy if exists "Anyone can read reviews" on reviews;
create policy "Anyone can read reviews" on reviews for select using (true);
drop policy if exists "Travelers manage own reviews" on reviews;
create policy "Travelers manage own reviews" on reviews
  for all using (auth.uid() = traveler_id);