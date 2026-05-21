
INSERT INTO public.price_sources (domain, name, category, priority, enabled, discovered_auto)
VALUES
  ('portaldecompraspublicas.com.br', 'Portal de Compras Públicas', 'portal', 78, true, false),
  ('bllcompras.com',                 'BLL Compras',                'portal', 76, true, false),
  ('licitacoes-e.com.br',            'Licitações-e (BB)',          'portal', 74, true, false),
  ('bnccompras.com',                 'BNC Compras',                'portal', 72, true, false),
  ('compras.bb.com.br',              'Compras BB',                 'portal', 70, true, false),
  ('sebrae.comprasnet.gov.br',       'ComprasNet Sebrae',          'portal', 68, true, false)
ON CONFLICT DO NOTHING;
