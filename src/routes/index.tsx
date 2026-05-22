import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Search, Sparkles, ShieldCheck, Database, Scale, Zap, FileText, MapPin } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";

export const Route = createFileRoute("/")({
  component: Home,
  head: () => ({
    meta: [
      { title: "Petrus IA · Pesquisa de preços para licitações" },
      { name: "description", content: "Busca semântica em PNCP, Compras.gov.br, atas e contratos, conforme Art. 23 da Lei 14.133/2021." },
      { property: "og:title", content: "Petrus IA · Pesquisa de preços para licitações" },
      { property: "og:description", content: "Busca semântica em PNCP, Compras.gov.br, atas e contratos, conforme Art. 23 da Lei 14.133/2021." },
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
          name: "Petrus IA",
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
        <section className="relative overflow-hidden border-b border-border/60">
          <div className="absolute inset-0 bg-hero" />
          <div className="relative mx-auto max-w-5xl px-4 sm:px-6 pt-20 pb-20 text-center">
            <h1 className="text-4xl sm:text-5xl font-bold text-foreground leading-[1.1] text-balance">
              Pesquisa inteligente de preços para licitações públicas
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-base sm:text-lg text-muted-foreground">
              Encontre, valide e organize cotações em minutos — sem planilhas, sem
              fontes informais, sem retrabalho.
            </p>

            <form onSubmit={submit} className="mx-auto mt-8 max-w-2xl">
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-card p-2 shadow-card">
                <Search className="ml-3 h-5 w-5 text-muted-foreground shrink-0" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Descreva o item a cotar"
                  className="flex-1 bg-transparent text-foreground placeholder:text-muted-foreground outline-none px-2 py-2 text-base"
                />
                <button
                  type="submit"
                  className="inline-flex items-center gap-2 rounded-xl bg-accent-gradient px-5 py-2.5 text-sm font-semibold text-accent-foreground shadow-elegant transition-smooth hover:opacity-95"
                >
                  Pesquisar
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 sm:px-6 py-16">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              { i: Sparkles, t: "Busca semântica", d: "Entende sinônimos e equivalências técnicas." },
              { i: ShieldCheck, t: "Filtro jurídico", d: "Descarta pesquisas vencidas e sem comprovação." },
              { i: Database, t: "Cache inteligente", d: "Reaproveita itens já encontrados — resposta instantânea." },
              { i: Scale, t: "Fontes oficiais", d: "PNCP, Compras.gov.br e Portais da Transparência." },
            ].map((f) => (
              <div key={f.t} className="rounded-xl border border-border bg-card p-5 shadow-card transition-smooth hover:-translate-y-0.5 hover:shadow-elegant">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-accent/15 text-accent mb-3">
                  <f.i className="h-5 w-5" />
                </div>
                <div className="font-semibold mb-1">{f.t}</div>
                <p className="text-sm text-muted-foreground">{f.d}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-7xl px-4 sm:px-6 pb-16">
          <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-card">
            <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border/60">
              {[
                { i: Zap, n: "01", t: "Descreva o item", d: "A IA expande palavras-chave e especificações." },
                { i: FileText, n: "02", t: "Consulta paralela", d: "Fontes oficiais varridas e filtradas por validade." },
                { i: MapPin, n: "03", t: "Ranqueamento", d: "Compatibilidade semântica, jurídica e geográfica." },
              ].map((s) => (
                <div key={s.n} className="p-6 sm:p-8">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="text-3xl font-bold text-muted-foreground/40 font-mono">{s.n}</span>
                    <s.i className="h-5 w-5 text-accent" />
                  </div>
                  <div className="font-semibold mb-1.5">{s.t}</div>
                  <p className="text-sm text-muted-foreground">{s.d}</p>
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