import { createFileRoute } from "@tanstack/react-router";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export const Route = createFileRoute("/sobre")({
  component: Sobre,
  head: () => ({
    meta: [
      { title: "Sobre · Petrus IA" },
      { name: "description", content: "Petrus IA é um motor de pesquisa semântica para preços públicos alinhado à Lei nº 14.133/2021 — Art. 23." },
      { property: "og:title", content: "Sobre · Petrus IA" },
      { property: "og:description", content: "Petrus IA é um motor de pesquisa semântica para preços públicos alinhado à Lei nº 14.133/2021 — Art. 23." },
      { property: "og:url", content: "https://petrus-ia.lovable.app/sobre" },
    ],
    links: [
      { rel: "canonical", href: "https://petrus-ia.lovable.app/sobre" },
    ],
  }),
});

function Sobre() {
  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1 mx-auto max-w-3xl px-4 sm:px-6 py-16">
        <div className="text-[11px] uppercase tracking-[0.2em] text-accent font-semibold mb-2">Sobre a plataforma</div>
        <h1 className="text-3xl sm:text-4xl font-bold mb-6 text-balance">
          Inteligência aplicada à pesquisa de preços públicos
        </h1>
        <div className="prose prose-sm max-w-none text-foreground/90 space-y-5 leading-relaxed">
          <p>
            A Petrus IA combina busca semântica com filtros jurídicos para
            entregar resultados verdadeiramente comparáveis ao item pesquisado —
            evitando equivalências indevidas (ex.: priorizar "lápis preto" quando
            o pedido é "caneta azul").
          </p>
          <h2 className="text-xl font-semibold mt-8 mb-2">Conformidade legal</h2>
          <p>
            A estrutura observa o Art. 23 da Lei nº 14.133/2021 e suas
            recomendações sobre pesquisa de preços: prioridade a fontes
            oficiais, exigência de comprovação documental, exclusão de
            referências antigas (mais de 1 ano) e validação de fornecedor com
            CNPJ.
          </p>
          <h2 className="text-xl font-semibold mt-8 mb-2">Fontes utilizadas</h2>
          <ul className="list-disc pl-6 space-y-1">
            <li>Portal Nacional de Contratações Públicas (PNCP)</li>
            <li>Compras.gov.br</li>
            <li>Portais da Transparência da União, estados e municípios</li>
            <li>Atas de registro de preços, contratos e empenhos homologados</li>
          </ul>
          <p className="text-sm text-muted-foreground">
            Marketplaces informais (Mercado Livre, Shopee, AliExpress, OLX,
            Facebook Marketplace) são <strong>explicitamente excluídos</strong>{" "}
            da base de resultados.
          </p>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}