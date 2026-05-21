import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Search, Sparkles, ShieldCheck, Database, Scale, Zap, FileText, MapPin } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "CotaçãoIA · Pesquisa de preços para licitações" },
      { name: "description", content: "Busca semântica com IA em PNCP, Compras.gov.br, atas e contratos, conforme Art. 23 da Lei 14.133/2021." },
      { property: "og:title", content: "CotaçãoIA · Pesquisa de preços para licitações" },
      { property: "og:description", content: "Busca semântica com IA em PNCP, Compras.gov.br, atas e contratos, conforme Art. 23 da Lei 14.133/2021." },
      { property: "og:url", content: "https://petrus-ia.lovable.app/" },
    ],
    links: [
      { rel: "canonical", href: "https://petrus-ia.lovable.app/" },
    ],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "WebSite",
          name: "CotaçãoIA",
          url: "https://petrus-ia.lovable.app/",
          potentialAction: {
            "@type": "SearchAction",
            target: "https://petrus-ia.lovable.app/buscar?q={search_term_string}",
            "query-input": "required name=search_term_string",
          },
        }),
      },
    ],
  }),
});

const EXAMPLES = [
  "Caneta esferográfica azul",
  "Notebook 16GB RAM SSD 512GB",
  "Cadeira ergonômica giratória",
  "Resma papel A4 75g",
  "Impressora multifuncional laser",
];

function Home() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const query = q.trim();
    if (query.length < 2) return;
    navigate({ to: "/buscar", search: { q: query } });
  };

  return (
    <div className="min-h-screen flex flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="absolute inset-0 bg-hero" />
          <div className="absolute inset-0 grid-bg opacity-30" />
          <div className="absolute inset-x-0 -bottom-px h-32 bg-gradient-to-b from-transparent to-background" />
          <div className="relative mx-auto max-w-5xl px-4 sm:px-6 pt-20 pb-24 text-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-white/80 backdrop-blur">
              <Sparkles className="h-3 w-3" /> Powered by IA · Lei 14.133/2021
            </div>
            <h1 className="mt-6 text-4xl sm:text-6xl font-bold text-white leading-[1.05] text-balance">
              Pesquisa de preços públicos,
              <br />
              <span className="bg-clip-text text-transparent bg-accent-gradient">com inteligência jurídica.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-base sm:text-lg text-white/75 leading-relaxed">
              Motor semântico que vasculha PNCP, Compras.gov.br, Portais da Transparência,
              atas, contratos e empenhos homologados — entendendo contexto técnico
              e conformidade do Art. 23.
            </p>

            <form onSubmit={submit} className="mx-auto mt-8 max-w-2xl">
              <div className="flex items-center gap-2 rounded-2xl border border-white/15 bg-white/10 p-2 backdrop-blur-md shadow-elegant">
                <Search className="ml-3 h-5 w-5 text-white/70 shrink-0" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Descreva o item: ex. caneta esferográfica azul ponta 1.0mm"
                  className="flex-1 bg-transparent text-white placeholder:text-white/50 outline-none px-2 py-2 text-base"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-xl bg-accent-gradient px-5 py-2.5 text-sm font-semibold text-accent-foreground shadow-elegant transition-smooth hover:opacity-95"
                >
                  Pesquisar
                </button>
              </div>
            </form>

            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <span className="text-xs text-white/60 mr-1">Tente:</span>
              {EXAMPLES.map((e) => (
                <button
                  key={e}
                  onClick={() => navigate({ to: "/buscar", search: { q: e } })}
                  className="text-xs rounded-full border border-white/15 bg-white/5 px-3 py-1 text-white/80 hover:bg-white/10 transition-smooth"
                >
                  {e}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 sm:px-6 py-20">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { i: Sparkles, t: "Busca semântica", d: "Embeddings da Lovable AI entendem equivalências técnicas, sinônimos e contexto." },
              { i: ShieldCheck, t: "Filtro jurídico", d: "Remove pesquisas vencidas, fornecedores sem CNPJ e itens sem comprovação." },
              { i: Database, t: "Fontes oficiais", d: "PNCP, Compras.gov.br e Portais da Transparência. Nada de marketplaces informais." },
              { i: Scale, t: "Conforme 14.133", d: "Estrutura alinhada ao Art. 23 e suas exigências de pesquisa de preços." },
            ].map((f) => (
              <div key={f.t} className="rounded-xl border border-border bg-card p-5 shadow-card transition-smooth hover:-translate-y-0.5 hover:shadow-elegant">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent mb-3">
                  <f.i className="h-5 w-5" />
                </div>
                <div className="font-semibold mb-1">{f.t}</div>
                <p className="text-sm text-muted-foreground leading-relaxed">{f.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 sm:px-6 pb-20">
          <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
            <div className="p-8 sm:p-10 border-b border-border/60">
              <div className="text-[11px] uppercase tracking-[0.2em] text-accent font-semibold mb-2">Como funciona</div>
              <h2 className="text-2xl sm:text-3xl font-bold text-balance max-w-2xl">
                Um analista de pesquisa de preços em tempo real
              </h2>
            </div>
            <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border/60">
              {[
                { i: Zap, n: "01", t: "Você descreve o item", d: "Texto livre. A IA expande palavras-chave e detecta especificações técnicas relevantes." },
                { i: FileText, n: "02", t: "Buscamos nas fontes", d: "PNCP, Compras.gov.br e Transparência são consultados em paralelo e filtrados por validade." },
                { i: MapPin, n: "03", t: "Ranqueamos por compatibilidade", d: "Cinco scores combinados — semântico, textual, jurídico, técnico e geográfico." },
              ].map((s) => (
                <div key={s.n} className="p-8 sm:p-10">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl font-bold text-muted-foreground/40 font-mono">{s.n}</span>
                    <s.i className="h-5 w-5 text-accent" />
                  </div>
                  <div className="font-semibold mb-1.5">{s.t}</div>
                  <p className="text-sm text-muted-foreground leading-relaxed">{s.d}</p>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}