import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Search, Loader2, Sparkles, Download, FileText, FileJson, FileSpreadsheet, SlidersHorizontal, AlertCircle } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ResultCard } from "@/components/ResultCard";
import { ResultModal } from "@/components/ResultModal";
import { searchPrices } from "@/lib/search.functions";
import { exportCSV, exportJSON, exportTXT } from "@/lib/export";
import type { PriceResult } from "@/lib/types";

const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

const SearchSchema = z.object({
  q: z.string().optional().default(""),
});

export const Route = createFileRoute("/buscar")({
  component: Buscar,
  validateSearch: (s) => SearchSchema.parse(s),
  head: () => ({
    meta: [
      { title: "Pesquisar preços · CotaçãoIA" },
      { name: "description", content: "Pesquisa semântica de preços em fontes oficiais com ranqueamento por compatibilidade técnica e jurídica." },
    ],
  }),
});

function Buscar() {
  const navigate = useNavigate();
  const { q } = Route.useSearch();
  const [input, setInput] = useState(q);
  const [filters, setFilters] = useState({
    uf: "" as string,
    modalidade: "",
    apenasHomologados: false,
    ultimosMeses: 12,
    onlyValor: false,
    minScore: 0,
  });
  const [opened, setOpened] = useState<PriceResult | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState(12);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const callSearch = useServerFn(searchPrices);

  // Debounce input -> URL q
  useEffect(() => {
    const t = setTimeout(() => {
      if (input.trim() !== q) {
        navigate({ to: "/buscar", search: { q: input.trim() } });
      }
    }, 450);
    return () => clearTimeout(t);
  }, [input, q, navigate]);

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["search", q],
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    queryFn: () =>
      callSearch({
        data: { query: q.trim(), pagina: 1 },
      }),
  });

  const filtered = useMemo(() => {
    if (!data?.results) return [];
    return data.results.filter((r) => {
      if (filters.uf && (r.uf ?? "").toUpperCase() !== filters.uf) return false;
      if (filters.modalidade && !(r.modalidade ?? "").toLowerCase().includes(filters.modalidade.toLowerCase())) return false;
      if (filters.apenasHomologados && !r.homologado) return false;
      if (filters.onlyValor && typeof r.valor !== "number") return false;
      if (r.scoreFinal * 100 < filters.minScore) return false;
      return true;
    });
  }, [data, filters]);

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) setVisible((v) => Math.min(v + 12, filtered.length));
    });
    io.observe(sentinelRef.current);
    return () => io.disconnect();
  }, [filtered.length]);

  useEffect(() => setVisible(12), [q, filters]);

  const toggleSave = (it: PriceResult) => {
    setSaved((s) => {
      const n = new Set(s);
      if (n.has(it.id)) n.delete(it.id); else n.add(it.id);
      return n;
    });
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        {/* Search bar */}
        <section className="border-b border-border/60 bg-card/40">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-5">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                navigate({ to: "/buscar", search: { q: input.trim() } });
                refetch();
              }}
              className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 shadow-card"
            >
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Descreva o item a cotar — ex. impressora multifuncional laser monocromática"
                className="flex-1 bg-transparent outline-none text-sm py-1.5"
                autoFocus
              />
              {isFetching && <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />}
              <button type="submit" className="hidden sm:inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-smooth">
                <Sparkles className="h-3.5 w-3.5" />
                Buscar com IA
              </button>
            </form>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="text-xs text-muted-foreground">
                {data ? (
                  <>
                    <span className="font-medium text-foreground tabular-nums">{filtered.length}</span> resultados
                    {data.tookMs ? <> · processado em <span className="tabular-nums">{data.tookMs}ms</span></> : null}
                    {q ? <> · para <span className="text-foreground">"{q}"</span></> : null}
                  </>
                ) : q ? "Buscando..." : "Digite um termo para pesquisar."}
              </div>
              {data && filtered.length > 0 && (
                <div className="flex items-center gap-1">
                  <button onClick={() => exportCSV(filtered, q)} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-secondary transition-smooth">
                    <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
                  </button>
                  <button onClick={() => exportTXT(filtered, q)} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-secondary transition-smooth">
                    <FileText className="h-3.5 w-3.5" /> TXT
                  </button>
                  <button onClick={() => exportJSON(filtered, q)} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-xs hover:bg-secondary transition-smooth">
                    <FileJson className="h-3.5 w-3.5" /> JSON
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8 grid lg:grid-cols-[260px_1fr] gap-8">
          {/* Filters */}
          <aside className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5 shadow-card sticky top-20">
              <div className="flex items-center gap-2 mb-4">
                <SlidersHorizontal className="h-4 w-4 text-accent" />
                <div className="font-semibold text-sm">Filtros</div>
              </div>

              <div className="space-y-4 text-sm">
                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">UF</label>
                  <select
                    value={filters.uf}
                    onChange={(e) => setFilters({ ...filters, uf: e.target.value })}
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="">Todas</option>
                    {UFS.map((u) => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">Modalidade</label>
                  <input
                    value={filters.modalidade}
                    onChange={(e) => setFilters({ ...filters, modalidade: e.target.value })}
                    placeholder="Ex. pregão, dispensa"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">Últimos meses</label>
                  <input
                    type="range" min={1} max={24} step={1}
                    value={filters.ultimosMeses}
                    onChange={(e) => setFilters({ ...filters, ultimosMeses: Number(e.target.value) })}
                    className="w-full accent-accent"
                  />
                  <div className="text-[11px] text-muted-foreground tabular-nums">{filters.ultimosMeses} mês(es)</div>
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">Score mínimo</label>
                  <input
                    type="range" min={0} max={90} step={5}
                    value={filters.minScore}
                    onChange={(e) => setFilters({ ...filters, minScore: Number(e.target.value) })}
                    className="w-full accent-accent"
                  />
                  <div className="text-[11px] text-muted-foreground tabular-nums">≥ {filters.minScore}%</div>
                </div>

                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={filters.apenasHomologados}
                    onChange={(e) => setFilters({ ...filters, apenasHomologados: e.target.checked })}
                    className="h-4 w-4 rounded border-input accent-accent"
                  />
                  <span className="text-sm">Apenas homologados</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={filters.onlyValor}
                    onChange={(e) => setFilters({ ...filters, onlyValor: e.target.checked })}
                    className="h-4 w-4 rounded border-input accent-accent"
                  />
                  <span className="text-sm">Apenas com valor</span>
                </label>

                <button
                  onClick={() => setFilters({ uf: "", modalidade: "", apenasHomologados: false, ultimosMeses: 12, onlyValor: false, minScore: 0 })}
                  className="w-full mt-2 rounded-md border border-border bg-background px-3 py-1.5 text-xs hover:bg-secondary transition-smooth"
                >
                  Limpar filtros
                </button>
              </div>
            </div>

            {saved.size > 0 && (
              <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 text-xs text-accent-foreground">
                <div className="flex items-center gap-2 font-semibold mb-1 text-accent">
                  <Download className="h-3.5 w-3.5" /> {saved.size} item(ns) salvo(s)
                </div>
                <p className="text-muted-foreground">Use os botões de exportação para gerar o documento da pesquisa.</p>
              </div>
            )}
          </aside>

          {/* Results */}
          <section>
            {!q && (
              <EmptyState
                title="Digite o que você quer cotar"
                desc="Descreva o item com o máximo de detalhes técnicos. Nossa IA expandirá palavras-chave e buscará em fontes oficiais."
              />
            )}

            {error && (
              <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-5 text-sm text-destructive flex items-start gap-3">
                <AlertCircle className="h-5 w-5 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold mb-1">Não foi possível concluir a busca</div>
                  <div className="text-destructive/80">{(error as Error).message}</div>
                </div>
              </div>
            )}

            {isFetching && !data && <ResultsSkeleton />}

            {data && filtered.length === 0 && !isFetching && (
              <EmptyState
                title="Nenhum resultado compatível"
                desc="Tente refinar a descrição técnica ou afrouxar os filtros (UF, modalidade, score mínimo)."
              />
            )}

            {filtered.length > 0 && (
              <>
                <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
                  {filtered.slice(0, visible).map((it) => (
                    <ResultCard
                      key={it.id}
                      item={it}
                      onOpen={setOpened}
                      onSave={toggleSave}
                      saved={saved.has(it.id)}
                      query={q}
                    />
                  ))}
                </div>
                {visible < filtered.length && (
                  <div ref={sentinelRef} className="flex items-center justify-center py-10 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Carregando mais resultados…
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </main>
      <ResultModal item={opened} onClose={() => setOpened(null)} />
      <SiteFooter />
    </div>
  );
}

function EmptyState({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 p-12 text-center">
      <div className="mx-auto h-12 w-12 rounded-full bg-accent/15 text-accent inline-flex items-center justify-center mb-4">
        <Search className="h-5 w-5" />
      </div>
      <div className="font-semibold mb-1">{title}</div>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">{desc}</p>
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-5 animate-pulse">
          <div className="flex gap-2 mb-3">
            <div className="h-4 w-16 rounded bg-muted" />
            <div className="h-4 w-20 rounded bg-muted" />
          </div>
          <div className="h-5 w-3/4 rounded bg-muted mb-2" />
          <div className="h-3 w-full rounded bg-muted mb-1" />
          <div className="h-3 w-5/6 rounded bg-muted mb-4" />
          <div className="h-8 w-32 rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}