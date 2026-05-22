-- ===== Roles =====
CREATE TYPE public.app_role AS ENUM ('admin', 'user');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "user_roles_select_own" ON public.user_roles
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'admin'));

CREATE POLICY "user_roles_admin_all" ON public.user_roles
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- ===== Harvest =====
CREATE TABLE public.harvest_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  term text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  priority int NOT NULL DEFAULT 50,
  last_run_at timestamptz,
  total_found int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (term)
);

ALTER TABLE public.harvest_queries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "harvest_queries_admin_all" ON public.harvest_queries
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE TABLE public.harvest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_id uuid REFERENCES public.harvest_queries(id) ON DELETE CASCADE,
  term text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  items_persisted int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running',
  error text
);

ALTER TABLE public.harvest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "harvest_runs_admin_read" ON public.harvest_runs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE INDEX harvest_queries_enabled_lastrun ON public.harvest_queries (enabled, last_run_at NULLS FIRST, priority DESC);
CREATE INDEX harvest_runs_started ON public.harvest_runs (started_at DESC);

-- ===== quote_items: discovered_via + índice textual =====
ALTER TABLE public.quote_items ADD COLUMN IF NOT EXISTS discovered_via text DEFAULT 'search';

CREATE INDEX IF NOT EXISTS quote_items_query_norm_trgm ON public.quote_items USING gin (query_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS quote_items_titulo_trgm ON public.quote_items USING gin (titulo gin_trgm_ops);

-- Garantir extensão trigram
CREATE EXTENSION IF NOT EXISTS pg_trgm;