
-- 1. Colunas novas em quote_items
ALTER TABLE public.quote_items
  ADD COLUMN IF NOT EXISTS source_payload_raw jsonb,
  ADD COLUMN IF NOT EXISTS source_excerpt text;

-- 2. Telemetria por fonte
CREATE TABLE IF NOT EXISTS public.source_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id uuid,
  source_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ok','error','timeout','empty')),
  count integer NOT NULL DEFAULT 0,
  took_ms integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_source_runs_search ON public.source_runs(search_id);
CREATE INDEX IF NOT EXISTS idx_source_runs_source_created ON public.source_runs(source_id, created_at DESC);

ALTER TABLE public.source_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY source_runs_public_read ON public.source_runs FOR SELECT USING (true);

-- 3. Cache de CNPJ
CREATE TABLE IF NOT EXISTS public.cnpj_cache (
  cnpj text PRIMARY KEY,
  razao_social text,
  nome_fantasia text,
  cnae_principal text,
  cnae_descricao text,
  situacao text,
  uf text,
  municipio text,
  ativo boolean,
  payload jsonb,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cnpj_cache_fetched ON public.cnpj_cache(fetched_at DESC);

ALTER TABLE public.cnpj_cache ENABLE ROW LEVEL SECURITY;
CREATE POLICY cnpj_cache_public_read ON public.cnpj_cache FOR SELECT USING (true);
