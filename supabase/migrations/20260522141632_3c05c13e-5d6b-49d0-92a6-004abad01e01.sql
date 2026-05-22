
-- 1. Extensão para busca sem acento
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 2. Coluna tsvector
ALTER TABLE public.quote_items
  ADD COLUMN IF NOT EXISTS tsv tsvector;

-- 3. Função imutável que monta o tsvector (precisa ser IMMUTABLE para uso em trigger/index)
CREATE OR REPLACE FUNCTION public.quote_items_tsv(
  _titulo text,
  _descricao text,
  _objeto text,
  _fornecedor text,
  _orgao text
) RETURNS tsvector
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_catalog
AS $$
  SELECT
    setweight(to_tsvector('portuguese', unaccent(coalesce(_titulo, ''))), 'A') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(_objeto, ''))), 'B') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(_descricao, ''))), 'C') ||
    setweight(to_tsvector('portuguese', unaccent(coalesce(_fornecedor, '') || ' ' || coalesce(_orgao, ''))), 'D');
$$;

-- 4. Trigger para manter tsv atualizado
CREATE OR REPLACE FUNCTION public.quote_items_tsv_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  NEW.tsv := public.quote_items_tsv(
    NEW.titulo,
    NEW.descricao,
    NEW.objeto_estruturado,
    NEW.fornecedor,
    NEW.orgao
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS quote_items_tsv_update ON public.quote_items;
CREATE TRIGGER quote_items_tsv_update
  BEFORE INSERT OR UPDATE OF titulo, descricao, objeto_estruturado, fornecedor, orgao
  ON public.quote_items
  FOR EACH ROW EXECUTE FUNCTION public.quote_items_tsv_trigger();

-- 5. Backfill das linhas existentes
UPDATE public.quote_items
SET tsv = public.quote_items_tsv(titulo, descricao, objeto_estruturado, fornecedor, orgao)
WHERE tsv IS NULL;

-- 6. Índice GIN
CREATE INDEX IF NOT EXISTS quote_items_tsv_gin ON public.quote_items USING GIN (tsv);

-- 7. Índice em discovered_via para filtrar crawler vs search
CREATE INDEX IF NOT EXISTS quote_items_discovered_via_idx ON public.quote_items (discovered_via);

-- 8. RPC pública de busca FTS
CREATE OR REPLACE FUNCTION public.search_quote_items_fts(
  _query text,
  _limit int DEFAULT 30
)
RETURNS TABLE (
  id uuid,
  titulo text,
  descricao text,
  valor numeric,
  valor_total numeric,
  unidade text,
  quantidade numeric,
  fornecedor text,
  cnpj text,
  orgao text,
  uf text,
  data date,
  origem text,
  url text,
  homologado boolean,
  payload jsonb,
  updated_at timestamptz,
  rank real
)
LANGUAGE sql STABLE
SET search_path = public, pg_catalog
AS $$
  WITH q AS (
    SELECT plainto_tsquery('portuguese', unaccent(coalesce(_query, ''))) AS tsq
  )
  SELECT
    qi.id,
    qi.titulo,
    qi.descricao,
    qi.valor,
    qi.valor_total,
    qi.unidade,
    qi.quantidade,
    qi.fornecedor,
    qi.cnpj,
    qi.orgao,
    qi.uf,
    qi.data,
    qi.origem,
    qi.url,
    qi.homologado,
    qi.payload,
    qi.updated_at,
    ts_rank_cd(qi.tsv, q.tsq) AS rank
  FROM public.quote_items qi, q
  WHERE qi.tsv @@ q.tsq
  ORDER BY rank DESC, qi.updated_at DESC
  LIMIT greatest(1, least(coalesce(_limit, 30), 200));
$$;

-- 9. Permite execução pública (RLS de quote_items já é pública para leitura)
GRANT EXECUTE ON FUNCTION public.search_quote_items_fts(text, int) TO anon, authenticated;
