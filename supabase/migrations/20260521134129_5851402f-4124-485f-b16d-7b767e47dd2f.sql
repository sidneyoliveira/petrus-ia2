
create table public.search_feedback (
  id uuid primary key default gen_random_uuid(),
  query text not null,
  query_norm text not null,
  item_id text not null,
  source text not null,
  action text not null check (action in ('accept','reject')),
  reason text,
  snapshot jsonb,
  created_at timestamptz not null default now()
);

create index search_feedback_query_norm_idx on public.search_feedback (query_norm);
create index search_feedback_item_idx on public.search_feedback (item_id);

alter table public.search_feedback enable row level security;

create policy "feedback_public_select" on public.search_feedback
  for select using (true);

create policy "feedback_public_insert" on public.search_feedback
  for insert with check (
    action in ('accept','reject')
    and length(query) between 1 and 500
    and length(item_id) between 1 and 200
    and length(source) between 1 and 50
  );
