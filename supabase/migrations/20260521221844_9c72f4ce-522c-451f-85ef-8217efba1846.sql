
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE public.quote_items
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS embedding_status text DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS embedding_at timestamptz;

CREATE INDEX IF NOT EXISTS quote_items_embedding_idx
  ON public.quote_items
  USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS quote_items_embed_pending_idx
  ON public.quote_items (created_at DESC)
  WHERE embedding IS NULL AND (embedding_status IS NULL OR embedding_status = 'pending');

CREATE OR REPLACE FUNCTION public.match_quote_items(
  query_embedding vector(768),
  match_count int DEFAULT 20,
  min_similarity float DEFAULT 0.55
)
RETURNS TABLE (
  id uuid,
  search_id uuid,
  query_norm text,
  titulo text,
  descricao text,
  valor numeric,
  valor_total numeric,
  unidade text,
  fornecedor text,
  cnpj text,
  orgao text,
  uf text,
  data date,
  origem text,
  url text,
  payload jsonb,
  similarity float
)
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT
    qi.id,
    qi.search_id,
    qi.query_norm,
    qi.titulo,
    qi.descricao,
    qi.valor,
    qi.valor_total,
    qi.unidade,
    qi.fornecedor,
    qi.cnpj,
    qi.orgao,
    qi.uf,
    qi.data,
    qi.origem,
    qi.url,
    qi.payload,
    1 - (qi.embedding <=> query_embedding) AS similarity
  FROM public.quote_items qi
  WHERE qi.embedding IS NOT NULL
    AND 1 - (qi.embedding <=> query_embedding) >= min_similarity
  ORDER BY qi.embedding <=> query_embedding
  LIMIT match_count;
$$;
