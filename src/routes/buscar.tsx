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
  q: z.coerce.string().optional().default(""),
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
  const [keywordsInput, setKeywordsInput] = useState("");
  const [mode, setMode] = useState<"semantic" | "exact" | "all_keywords">("semantic");
  const [filters, setFilters] = useState({
    uf: "" as string,
    modalidade: "",
    unidade: "",
    apenasHomologados: false,
    onlyValor: false,
    minScore: 0,
    valorMin: "" as string,
    valorMax: "" as string,
  });
  const [sortBy, setSortBy] = useState<
    "compat" | "semantico" | "juridico" | "valorAsc" | "valorDesc" | "valorMedio" | "dataRecente"
  >("compat");
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

  const parsedKeywords = useMemo(
    () =>
      keywordsInput
        .split(",")
        .map((k) => k.trim())
        .filter((k) => k.length > 0)
        .slice(0, 20),
    [keywordsInput],
  );

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["search", q, mode, parsedKeywords.join("|")],
    enabled: q.trim().length >= 2,
    staleTime: 60_000,
    queryFn: () =>
      callSearch({
        data: {
          query: q.trim(),
          pagina: 1,
          mode,
          keywords: parsedKeywords.length ? parsedKeywords : undefined,
        },
      }),
  });

  const filtered = useMemo(() => {
    if (!data?.results) return [];
    const vMin = filters.valorMin ? Number(filters.valorMin.replace(",", ".")) : null;
    const vMax = filters.valorMax ? Number(filters.valorMax.replace(",", ".")) : null;
    let arr = data.results.filter((r) => {
      if (filters.uf && (r.uf ?? "").toUpperCase() !== filters.uf) return false;
      if (filters.modalidade && !(r.modalidade ?? "").toLowerCase().includes(filters.modalidade.toLowerCase())) return false;
      if (filters.unidade && !(r.unidade ?? "").toLowerCase().includes(filters.unidade.toLowerCase())) return false;
      if (filters.apenasHomologados && !r.homologado) return false;
      if (filters.onlyValor && typeof r.valor !== "number") return false;
      if (vMin !== null && !Number.isNaN(vMin) && (r.valor ?? -Infinity) < vMin) return false;
      if (vMax !== null && !Number.isNaN(vMax) && (r.valor ?? Infinity) > vMax) return false;
      if (r.scoreFinal * 100 < filters.minScore) return false;
      return true;
    });

    // Ordenação configurável
    const withValor = arr.filter((r) => typeof r.valor === "number") as (PriceResult & { valor: number })[];
    const media = withValor.length
      ? withValor.reduce((s, r) => s + r.valor, 0) / withValor.length
      : 0;
    const propMid = vMin !== null && vMax !== null && !Number.isNaN(vMin) && !Number.isNaN(vMax) ? (vMin + vMax) / 2 : media;

    arr = [...arr].sort((a, b) => {
      switch (sortBy) {
        case "semantico": return b.scoreSemantico - a.scoreSemantico;
        case "juridico": return b.scoreJuridico - a.scoreJuridico;
        case "valorAsc": return (a.valor ?? Infinity) - (b.valor ?? Infinity);
        case "valorDesc": return (b.valor ?? -Infinity) - (a.valor ?? -Infinity);
        case "valorMedio": {
          const da = typeof a.valor === "number" ? Math.abs(a.valor - propMid) : Infinity;
          const db = typeof b.valor === "number" ? Math.abs(b.valor - propMid) : Infinity;
          return da - db;
        }
        case "dataRecente": {
          const ta = a.data ? new Date(a.data).getTime() : 0;
          const tb = b.data ? new Date(b.data).getTime() : 0;
          return tb - ta;
        }
        case "compat":
        default:
          return b.scoreFinal - a.scoreFinal;
      }
    });
    return arr;
  }, [data, filters, sortBy]);

  // Estatísticas — apenas valores UNITÁRIOS confiáveis, com remoção de outliers (IQR)
  const stats = useMemo(() => {
    const vals = filtered
      .filter((r) => r.valorTipo === "unitario_homologado" || r.valorTipo === "unitario_estimado")
      .map((r) => r.valor!)
      .filter((v): v is number => typeof v === "number" && v > 0)
      .sort((a, b) => a - b);
    if (vals.length === 0) return null;
    const q = (p: number) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
    const q1 = q(0.25); const q3 = q(0.75); const iqr = q3 - q1;
    const lo = q1 - 1.5 * iqr; const hi = q3 + 1.5 * iqr;
    const clean = vals.filter((v) => v >= lo && v <= hi);
    const base = clean.length >= 3 ? clean : vals;
    const mean = base.reduce((s, v) => s + v, 0) / base.length;
    const median = base[Math.floor(base.length / 2)];
    return { n: base.length, removidos: vals.length - base.length, mean, median, min: base[0], max: base[base.length - 1] };
  }, [filtered]);

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
          <div className="mx-auto max-w-none px-4 sm:px-6 py-5">
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
            {(isFetching || data?.sources?.length) && (
              <SourceStrip loading={isFetching} sources={data?.sources} />
            )}
          </div>
        </section>

        <div className="mx-auto max-w-none px-4 sm:px-6 py-8 grid lg:grid-cols-[260px_1fr] gap-8">
          {/* Filters */}
          <aside className="space-y-6">
            <div className="rounded-xl border border-border bg-card p-5 shadow-card sticky top-20">
              {/* Ordenação */}
              <div className="mb-5">
                <label className="text-xs text-muted-foreground mb-1.5 block">Ordenar por</label>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="compat">Maior compatibilidade</option>
                  <option value="semantico">Mais similares (semântico)</option>
                  <option value="juridico">Maior conformidade jurídica</option>
                  <option value="valorMedio">Mais próximos do valor médio</option>
                  <option value="valorAsc">Menor valor</option>
                  <option value="valorDesc">Maior valor</option>
                  <option value="dataRecente">Mais recentes</option>
                </select>
              </div>

              <div className="mb-5">
                <label className="text-xs text-muted-foreground mb-1.5 block">Tipo de pesquisa</label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as typeof mode)}
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="semantic">Semelhante (IA + sinônimos)</option>
                  <option value="all_keywords">Todas as palavras do título</option>
                  <option value="exact">Exata (sem expansão)</option>
                </select>
              </div>

              <div className="mb-5">
                <label className="text-xs text-muted-foreground mb-1.5 block">Palavras-chave obrigatórias</label>
                <input
                  value={keywordsInput}
                  onChange={(e) => setKeywordsInput(e.target.value)}
                  placeholder="ex.: juvenil, unissex, elástico"
                  className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <div className="text-[10px] text-muted-foreground mt-1">Separe por vírgula. Todas devem aparecer no item.</div>
              </div>

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
                  <label className="text-xs text-muted-foreground mb-1.5 block">Unidade</label>
                  <input
                    value={filters.unidade}
                    onChange={(e) => setFilters({ ...filters, unidade: e.target.value })}
                    placeholder="Ex. UN, CX, KG, PC"
                    className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring uppercase"
                  />
                </div>

                <div>
                  <label className="text-xs text-muted-foreground mb-1.5 block">Faixa de valor (R$)</label>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      inputMode="decimal"
                      value={filters.valorMin}
                      onChange={(e) => setFilters({ ...filters, valorMin: e.target.value })}
                      placeholder="Mín."
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring tabular-nums"
                    />
                    <input
                      inputMode="decimal"
                      value={filters.valorMax}
                      onChange={(e) => setFilters({ ...filters, valorMax: e.target.value })}
                      placeholder="Máx."
                      className="w-full rounded-md border border-input bg-background px-2.5 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring tabular-nums"
                    />
                  </div>
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
                  onClick={() => setFilters({ uf: "", modalidade: "", unidade: "", apenasHomologados: false, onlyValor: false, minScore: 0, valorMin: "", valorMax: "" })}
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
                {stats && (
                  <div className="mb-4 grid grid-cols-2 md:grid-cols-5 gap-2 rounded-xl border border-border bg-card p-3">
                    <Stat label="Cotações válidas" value={String(stats.n)} hint={stats.removidos ? `${stats.removidos} outliers removidos` : "IN 65/2021"} />
                    <Stat label="Média" value={brl(stats.mean)} accent />
                    <Stat label="Mediana" value={brl(stats.median)} />
                    <Stat label="Mínimo" value={brl(stats.min)} />
                    <Stat label="Máximo" value={brl(stats.max)} />
                  </div>
                )}
                <div className="flex flex-col gap-3">
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
    <div className="flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-5 animate-pulse flex gap-4">
          <div className="flex-1 space-y-2">
            <div className="h-4 w-24 rounded bg-muted" />
            <div className="h-5 w-3/4 rounded bg-muted" />
            <div className="h-3 w-1/2 rounded bg-muted" />
          </div>
          <div className="w-48 space-y-2">
            <div className="h-5 w-24 rounded bg-muted" />
            <div className="h-3 w-full rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SourceStrip({
  loading,
  sources,
}: {
  loading: boolean;
  sources?: { name: string; domain?: string; total: number }[];
}) {
  const fallback = ["PNCP", "Compras.gov.br", "TCE-CE", "TCEs/portais oficiais", "Fornecedores"];
  const list = sources?.length ? sources : fallback.map((name) => ({ name, total: 0 }));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1 pr-1">
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
        {loading ? "Pesquisando em" : "Fontes consultadas"}
      </span>
      {list.map((source) => (
        <span
          key={`${source.name}-${source.domain ?? ""}`}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5"
          title={source.domain}
        >
          {source.name}
          {source.total > 0 && <span className="tabular-nums text-foreground">{source.total}</span>}
        </span>
      ))}
    </div>
  );
}

function brl(v: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums truncate ${accent ? "text-accent" : ""}`} title={value}>{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground truncate" title={hint}>{hint}</div>}
    </div>
  );
}