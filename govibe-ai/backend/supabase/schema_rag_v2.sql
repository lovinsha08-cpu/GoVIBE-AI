-- ============================================================
-- GoVIBE AI — RAG v2: canonical knowledge document model
-- Adds locality/subcategory/tags/geo/rating/dataset/derived-flag columns to
-- kb_documents, plus a metadata-filtered match function (match_kb_documents_v2).
-- Purely additive — existing columns, the existing match_kb_documents()
-- function, and every existing row are left untouched, so nothing that
-- currently calls the v1 function breaks.
-- Idempotent — safe to run multiple times. Run AFTER schema_ai_orchestration.sql.
-- ============================================================

alter table kb_documents add column if not exists locality text;
alter table kb_documents add column if not exists subcategory text;
alter table kb_documents add column if not exists tags text[] default '{}';
alter table kb_documents add column if not exists latitude double precision;
alter table kb_documents add column if not exists longitude double precision;
alter table kb_documents add column if not exists rating numeric(2,1);
-- Which raw source produced this doc, e.g. "Religion dataset", "Shopping
-- dataset", "businesses table", "platform_docs" — kept distinct from the
-- existing `source` column (which is a coarser bucket: platform_docs,
-- travel_guide, policy, business_docs, tourism, food, shopping, business).
alter table kb_documents add column if not exists dataset text;
alter table kb_documents add column if not exists family_friendly boolean default false;
alter table kb_documents add column if not exists peaceful boolean default false;
alter table kb_documents add column if not exists hidden_gem boolean default false;
-- 'free' | 'budget' | 'mid' | 'premium' | null (unknown)
alter table kb_documents add column if not exists budget_level text;

create index if not exists kb_documents_locality_idx on kb_documents(locality);
create index if not exists kb_documents_category_idx on kb_documents(category);
create index if not exists kb_documents_subcategory_idx on kb_documents(subcategory);
create index if not exists kb_documents_dataset_idx on kb_documents(dataset);
create index if not exists kb_documents_tags_idx on kb_documents using gin(tags);
create index if not exists kb_documents_flags_idx on kb_documents(family_friendly, peaceful, hidden_gem);

-- ------------------------------------------------------------
-- Metadata-filtered match function. Every p_* filter defaults to null,
-- meaning "don't filter on this field" — so a call passing none of them
-- behaves exactly like the v1 match_kb_documents(), just with the extra
-- metadata columns present on each returned row for source tracking (step 6).
-- ------------------------------------------------------------
create or replace function match_kb_documents_v2(
  query_embedding vector(768),
  match_audience text,
  match_threshold float default 0.65,
  match_count int default 5,
  p_city text default null,
  p_locality text default null,
  p_category text default null,
  p_subcategory text default null,
  p_family_friendly boolean default null,
  p_peaceful boolean default null,
  p_hidden_gem boolean default null,
  p_budget_level text default null,
  p_tags text[] default null
) returns table (
  id uuid, title text, content text, source text, dataset text,
  category text, subcategory text, city text, locality text,
  tags text[], latitude double precision, longitude double precision,
  rating numeric, family_friendly boolean, peaceful boolean,
  hidden_gem boolean, budget_level text, similarity float
)
language sql stable as $$
  select k.id, k.title, k.content, k.source, k.dataset,
         k.category, k.subcategory, k.city, k.locality,
         k.tags, k.latitude, k.longitude,
         k.rating, k.family_friendly, k.peaceful,
         k.hidden_gem, k.budget_level,
         1 - (k.embedding <=> query_embedding) as similarity
  from kb_documents k
  where k.embedding is not null
    and (match_audience = 'both' or k.audience = 'both' or k.audience = match_audience)
    and 1 - (k.embedding <=> query_embedding) > match_threshold
    and (p_city is null or k.city ilike p_city)
    and (p_locality is null or k.locality ilike p_locality)
    and (p_category is null or k.category = p_category)
    and (p_subcategory is null or k.subcategory ilike p_subcategory)
    and (p_family_friendly is null or k.family_friendly = p_family_friendly)
    and (p_peaceful is null or k.peaceful = p_peaceful)
    and (p_hidden_gem is null or k.hidden_gem = p_hidden_gem)
    and (p_budget_level is null or k.budget_level = p_budget_level)
    and (p_tags is null or k.tags && p_tags)
  order by k.embedding <=> query_embedding
  limit match_count;
$$;