
CREATE TABLE public.extraction_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid REFERENCES public.quote_items(id) ON DELETE SET NULL,
  query_norm text NOT NULL,
  source_domain text,
  source_url text,
  field text NOT NULL,
  value_before text,
  value_after text NOT NULL,
  source_excerpt text,
  user_note text,
  embedding vector(768),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX extraction_corrections_domain_idx
  ON public.extraction_corrections (source_domain);
CREATE INDEX extraction_corrections_query_idx
  ON public.extraction_corrections (query_norm);
CREATE INDEX extraction_corrections_embedding_idx
  ON public.extraction_corrections USING hnsw (embedding vector_cosine_ops);

ALTER TABLE public.extraction_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "corrections_public_read"
  ON public.extraction_corrections FOR SELECT
  USING (true);

CREATE POLICY "corrections_public_insert"
  ON public.extraction_corrections FOR INSERT
  WITH CHECK (
    field = ANY (ARRAY['valor','valor_total','quantidade','unidade','titulo','descricao','fornecedor','orgao','uf','data','outro'])
    AND length(query_norm) BETWEEN 1 AND 500
    AND length(value_after) BETWEEN 1 AND 2000
    AND (user_note IS NULL OR length(user_note) <= 2000)
    AND (source_excerpt IS NULL OR length(source_excerpt) <= 4000)
    AND (source_domain IS NULL OR length(source_domain) <= 200)
    AND (source_url IS NULL OR length(source_url) <= 2000)
  );

CREATE OR REPLACE FUNCTION public.match_corrections(
  query_embedding vector,
  match_count integer DEFAULT 5,
  min_similarity double precision DEFAULT 0.55,
  filter_domain text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  item_id uuid,
  query_norm text,
  source_domain text,
  source_url text,
  field text,
  value_before text,
  value_after text,
  source_excerpt text,
  user_note text,
  similarity double precision
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT
    c.id, c.item_id, c.query_norm, c.source_domain, c.source_url,
    c.field, c.value_before, c.value_after, c.source_excerpt, c.user_note,
    1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.extraction_corrections c
  WHERE c.embedding IS NOT NULL
    AND (filter_domain IS NULL OR c.source_domain = filter_domain)
    AND 1 - (c.embedding <=> query_embedding) >= min_similarity
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
