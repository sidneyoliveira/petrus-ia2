
-- ============================================================
-- Temas de busca (categorização paralela de cestas e pesquisas)
-- ============================================================
CREATE TABLE public.search_themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#10b981',
  icon text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT search_themes_name_chk CHECK (char_length(name) BETWEEN 1 AND 60),
  CONSTRAINT search_themes_color_chk CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  CONSTRAINT search_themes_user_name_unique UNIQUE (user_id, name)
);

CREATE INDEX search_themes_user_id_idx ON public.search_themes(user_id);

ALTER TABLE public.search_themes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "themes_select_own" ON public.search_themes
  FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "themes_insert_own" ON public.search_themes
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "themes_update_own" ON public.search_themes
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "themes_delete_own" ON public.search_themes
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

CREATE TRIGGER touch_search_themes_updated
  BEFORE UPDATE ON public.search_themes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- ============================================================
-- Cestas ganham theme_id opcional
-- ============================================================
ALTER TABLE public.baskets
  ADD COLUMN theme_id uuid REFERENCES public.search_themes(id) ON DELETE SET NULL;

CREATE INDEX baskets_theme_id_idx ON public.baskets(theme_id);
