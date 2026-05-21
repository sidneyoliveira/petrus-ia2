export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-border/60">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 py-10 grid gap-8 md:grid-cols-3 text-sm">
        <div>
          <div className="font-semibold mb-2">CotaçãoIA</div>
          <p className="text-muted-foreground leading-relaxed">
            Pesquisa de preços inteligente para licitações públicas, em
            conformidade com a Lei nº 14.133/2021.
          </p>
        </div>
        <div>
          <div className="font-semibold mb-2">Fontes oficiais</div>
          <ul className="space-y-1 text-muted-foreground">
            <li>Portal Nacional de Contratações Públicas (PNCP)</li>
            <li>Compras.gov.br</li>
            <li>Portais da Transparência</li>
            <li>Atas, contratos e empenhos homologados</li>
          </ul>
        </div>
        <div>
          <div className="font-semibold mb-2">Aviso</div>
          <p className="text-muted-foreground leading-relaxed">
            Os resultados auxiliam o processo decisório do agente público, sem
            substituir a análise técnica e jurídica exigida pela legislação.
          </p>
        </div>
      </div>
      <div className="border-t border-border/60 py-4 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} CotaçãoIA. Não afiliado a órgãos governamentais.
      </div>
    </footer>
  );
}