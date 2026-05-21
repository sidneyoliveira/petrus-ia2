ALTER TABLE public.quote_items
  ADD COLUMN IF NOT EXISTS objeto_estruturado text,
  ADD COLUMN IF NOT EXISTS valor_total_calculado numeric,
  ADD COLUMN IF NOT EXISTS math_status text,
  ADD COLUMN IF NOT EXISTS math_delta_pct numeric,
  ADD COLUMN IF NOT EXISTS extraction_quality text;

CREATE INDEX IF NOT EXISTS quote_items_quality_idx
  ON public.quote_items (extraction_quality, math_status);