-- Lock down price_sources writes to admins
DROP POLICY IF EXISTS sources_public_insert ON public.price_sources;
DROP POLICY IF EXISTS sources_public_update ON public.price_sources;

CREATE POLICY "sources_admin_insert"
  ON public.price_sources
  FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "sources_admin_update"
  ON public.price_sources
  FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "sources_admin_delete"
  ON public.price_sources
  FOR DELETE
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- handle_new_user runs only from the auth trigger; no client should call it
REVOKE EXECUTE ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
