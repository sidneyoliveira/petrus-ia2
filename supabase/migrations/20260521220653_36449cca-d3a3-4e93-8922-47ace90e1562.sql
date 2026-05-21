ALTER TABLE public.quote_items
  ADD COLUMN IF NOT EXISTS valor_inferido numeric,
  ADD COLUMN IF NOT EXISTS valor_inferido_confianca numeric,
  ADD COLUMN IF NOT EXISTS valor_inferido_status text,
  ADD COLUMN IF NOT EXISTS valor_inferido_at timestamptz,
  ADD COLUMN IF NOT EXISTS valor_inferido_reason text;

CREATE INDEX IF NOT EXISTS quote_items_heal_pending_idx
  ON public.quote_items (search_id)
  WHERE valor IS NULL
    AND valor_total IS NOT NULL
    AND valor_inferido_status IS NULL;