
-- ===== FASE 1: profiles =====
create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles for select
  to authenticated
  using (auth.uid() = user_id);

create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = user_id);

create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (auth.uid() = user_id);

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ===== FASE 2: baskets =====
create table public.baskets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Cesta sem nome',
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index baskets_user_id_idx on public.baskets(user_id, updated_at desc);

alter table public.baskets enable row level security;

create policy "baskets_select_own"  on public.baskets for select to authenticated using (auth.uid() = user_id);
create policy "baskets_insert_own"  on public.baskets for insert to authenticated with check (auth.uid() = user_id);
create policy "baskets_update_own"  on public.baskets for update to authenticated using (auth.uid() = user_id);
create policy "baskets_delete_own"  on public.baskets for delete to authenticated using (auth.uid() = user_id);

create trigger baskets_touch_updated_at
  before update on public.baskets
  for each row execute function public.touch_updated_at();

-- ===== FASE 5: valor contratado em quote_items =====
alter table public.quote_items
  add column if not exists valor_contratado numeric,
  add column if not exists valor_contratado_fonte text,
  add column if not exists contract_fetch_status text default 'pending',
  add column if not exists contract_fetched_at timestamptz;
