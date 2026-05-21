
CREATE TABLE public.price_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  domain text NOT NULL UNIQUE,
  category text NOT NULL,
  inciso text,
  priority int NOT NULL DEFAULT 50,
  enabled boolean NOT NULL DEFAULT true,
  hits int NOT NULL DEFAULT 0,
  successes int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  discovered_auto boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.price_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sources_public_read" ON public.price_sources FOR SELECT USING (true);
CREATE POLICY "sources_public_insert" ON public.price_sources FOR INSERT WITH CHECK (
  length(name) BETWEEN 1 AND 200 AND length(domain) BETWEEN 3 AND 200 AND length(category) BETWEEN 1 AND 50
);
CREATE POLICY "sources_public_update" ON public.price_sources FOR UPDATE USING (true);

CREATE INDEX idx_price_sources_priority ON public.price_sources(enabled, priority DESC);

-- Seed ~50 official sources for procurement price research
INSERT INTO public.price_sources (name, domain, category, inciso, priority) VALUES
('PNCP', 'pncp.gov.br', 'federal', 'I', 100),
('Painel de Preços', 'paineldeprecos.planejamento.gov.br', 'federal', 'I', 100),
('Compras.gov.br', 'compras.gov.br', 'federal', 'I', 95),
('Comprasnet', 'comprasnet.gov.br', 'federal', 'I', 90),
('BPS Saúde', 'bps.saude.gov.br', 'federal', 'I', 90),
('CMED Anvisa', 'gov.br/anvisa', 'federal', 'I', 85),
('SINAPI Caixa', 'caixa.gov.br/poder-publico/modernizacao-gestao/sinapi', 'federal', 'I', 80),
('SICRO DNIT', 'gov.br/dnit', 'federal', 'I', 80),
('TCU', 'portal.tcu.gov.br', 'tribunal', 'II', 95),
('TCE-SP', 'tce.sp.gov.br', 'tribunal', 'II', 85),
('TCE-MG', 'tce.mg.gov.br', 'tribunal', 'II', 85),
('TCE-RS', 'tce.rs.gov.br', 'tribunal', 'II', 80),
('TCE-CE', 'tce.ce.gov.br', 'tribunal', 'II', 90),
('TCE-BA', 'tce.ba.gov.br', 'tribunal', 'II', 80),
('TCE-PE', 'tce.pe.gov.br', 'tribunal', 'II', 80),
('TCE-PR', 'tce.pr.gov.br', 'tribunal', 'II', 80),
('TCE-SC', 'tce.sc.gov.br', 'tribunal', 'II', 80),
('TCE-GO', 'tce.go.gov.br', 'tribunal', 'II', 80),
('TCE-DF', 'tc.df.gov.br', 'tribunal', 'II', 80),
('TCE-RN', 'tce.rn.gov.br', 'tribunal', 'II', 80),
('TCE-PB', 'tce.pb.gov.br', 'tribunal', 'II', 80),
('TCE-PI', 'tce.pi.gov.br', 'tribunal', 'II', 80),
('TCE-MA', 'tce.ma.gov.br', 'tribunal', 'II', 80),
('TCE-PA', 'tce.pa.gov.br', 'tribunal', 'II', 80),
('TCE-AM', 'tce.am.gov.br', 'tribunal', 'II', 75),
('TCE-MT', 'tce.mt.gov.br', 'tribunal', 'II', 75),
('TCE-MS', 'tce.ms.gov.br', 'tribunal', 'II', 75),
('TCE-RO', 'tce.ro.gov.br', 'tribunal', 'II', 75),
('TCE-RJ', 'tce.rj.gov.br', 'tribunal', 'II', 80),
('TCE-ES', 'tcees.tc.br', 'tribunal', 'II', 75),
('TCE-AL', 'tce.al.gov.br', 'tribunal', 'II', 75),
('TCE-SE', 'tce.se.gov.br', 'tribunal', 'II', 75),
('TCE-AP', 'tce.ap.gov.br', 'tribunal', 'II', 75),
('TCE-AC', 'tceac.tc.br', 'tribunal', 'II', 75),
('TCE-RR', 'tce.rr.gov.br', 'tribunal', 'II', 75),
('TCE-TO', 'tce.to.gov.br', 'tribunal', 'II', 75),
('BEC SP', 'bec.sp.gov.br', 'estadual', 'I', 75),
('Compras MG', 'compras.mg.gov.br', 'estadual', 'I', 75),
('Compras RS', 'compras.rs.gov.br', 'estadual', 'I', 70),
('Compras PR', 'comprasparana.pr.gov.br', 'estadual', 'I', 70),
('Compras BA', 'comprasnet.ba.gov.br', 'estadual', 'I', 70),
('Compras DF', 'compras.df.gov.br', 'estadual', 'I', 70),
('Compras Municipais RN', 'comprasmunicipais.rn.gov.br', 'estadual', 'II', 75),
('Licitações-e BB', 'licitacoes-e.com.br', 'privado', 'III', 60),
('BLL Compras', 'bllcompras.com', 'privado', 'III', 60),
('Portal BNC', 'portaldecompraspublicas.com.br', 'privado', 'III', 60),
('Banco de Preços', 'bancodeprecos.com.br', 'privado', 'III', 55),
('Kalunga', 'kalunga.com.br', 'varejo', 'III', 50),
('DixiPonto', 'dixiponto.com.br', 'varejo', 'III', 45),
('Amazon Business', 'amazon.com.br', 'varejo', 'III', 45),
('Magazine Luiza', 'magazineluiza.com.br', 'varejo', 'III', 40),
('Casas Bahia', 'casasbahia.com.br', 'varejo', 'III', 40),
('Leroy Merlin', 'leroymerlin.com.br', 'varejo', 'III', 40),
('Cirúrgica Fernandes', 'cirurgicafernandes.com.br', 'varejo', 'III', 50),
('Hospfar', 'hospfar.com.br', 'varejo', 'III', 50);
