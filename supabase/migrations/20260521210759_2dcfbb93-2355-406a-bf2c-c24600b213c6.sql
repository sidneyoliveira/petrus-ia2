
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================================================
-- quote_searches: uma linha por busca executada
-- ============================================================
CREATE TABLE IF NOT EXISTS public.quote_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  query_norm text NOT NULL,
  query_raw text NOT NULL,
  filters_hash text NOT NULL DEFAULT '',
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  total integer NOT NULL DEFAULT 0,
  took_ms integer NOT NULL DEFAULT 0,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  fresh_until timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_norm, filters_hash)
);

CREATE INDEX IF NOT EXISTS quote_searches_query_norm_trgm
  ON public.quote_searches USING gin (query_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS quote_searches_fresh_until_idx
  ON public.quote_searches (fresh_until DESC);

ALTER TABLE public.quote_searches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quote_searches_public_read"
  ON public.quote_searches FOR SELECT
  USING (true);

-- ============================================================
-- quote_items: uma linha por item granular
-- ============================================================
CREATE TABLE IF NOT EXISTS public.quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  search_id uuid REFERENCES public.quote_searches(id) ON DELETE SET NULL,
  query_norm text NOT NULL,
  titulo text NOT NULL,
  descricao text,
  unidade text,
  quantidade numeric,
  valor numeric,
  valor_total numeric,
  valor_tipo text,
  fornecedor text,
  cnpj text,
  orgao text,
  municipio text,
  uf text,
  data date,
  modalidade text,
  homologado boolean DEFAULT false,
  origem text,
  url text,
  documento text,
  score_final numeric,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS quote_items_query_norm_idx
  ON public.quote_items (query_norm);
CREATE INDEX IF NOT EXISTS quote_items_query_norm_trgm
  ON public.quote_items USING gin (query_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS quote_items_fts_idx
  ON public.quote_items USING gin (
    to_tsvector('portuguese', coalesce(titulo,'') || ' ' || coalesce(descricao,''))
  );
CREATE INDEX IF NOT EXISTS quote_items_search_id_idx
  ON public.quote_items (search_id);
CREATE INDEX IF NOT EXISTS quote_items_cnpj_idx
  ON public.quote_items (cnpj);
CREATE INDEX IF NOT EXISTS quote_items_created_at_idx
  ON public.quote_items (created_at DESC);

ALTER TABLE public.quote_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "quote_items_public_read"
  ON public.quote_items FOR SELECT
  USING (true);

-- trigger para manter updated_at
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quote_items_touch_updated_at ON public.quote_items;
CREATE TRIGGER quote_items_touch_updated_at
  BEFORE UPDATE ON public.quote_items
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();
