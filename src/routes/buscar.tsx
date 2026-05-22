import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { Search, Loader2, Sparkles, Download, FileText, FileJson, FileSpreadsheet, SlidersHorizontal, AlertCircle, Database, RefreshCw, LayoutGrid, Rows3, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { ResultCard } from "@/components/ResultCard";
import { ResultsTable } from "@/components/ResultsTable";
import { ResultModal } from "@/components/ResultModal";
import { searchPrices } from "@/lib/search.functions";
import { searchDbItems } from "@/lib/db-search.functions";
import { exportCSV, exportJSON, exportTXT } from "@/lib/export";
import { useBasket } from "@/lib/basket";
import type { PriceResult } from "@/lib/types";

const UFS = ["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"];

const SearchSchema = z.object({
  q: z.coerce.string().optional().default(""),
  tema: z.coerce.string().optional().default(""),
});

export const Route = createFileRoute("/buscar")({
  component: Buscar,
  validateSearch: (s) => SearchSchema.parse(s),
  head: () => ({
    meta: [
      { title: "Pesquisar preços · Petrus IA" },
      { name: "description", content: "Pesquisa semântica de preços em fontes oficiais com ranqueamento por compatibilidade técnica e jurídica." },
      { property: "og:title", content: "Pesquisar preços · Petrus IA" },
      { property: "og:description", content: "Pesquisa semântica de preços em fontes oficiais com ranqueamento por compatibilidade técnica e jurídica." },
      { property: "og:url", content: "https://petrus-ia.lovable.app/buscar" },
    ],
    links: [
      { rel: "canonical", href: "https://petrus-ia.lovable.app/buscar" },
    ],
  }),
});

function Buscar() {
  const navigate = useNavigate();
  const { q, tema } = Route.useSearch();
  const [input, setInput] = useState(q);
  const [temaInput, setTemaInput] = useState(tema);
  const [keywordsInput, setKeywordsInput] = useState("");
  const [mode, setMode] = useState<"semantic" | "exact" | "all_keywords">("semantic");
  const [filters, setFilters] = useState({
    uf: "" as string,
    unidade: "",
    minScore: 0,
    valorMin: "" as string,
    valorMax: "" as string,
  });
  const [sortBy, setSortBy] = useState<
    "compat" | "semantico" | "juridico" | "valorAsc" | "valorDesc" | "valorMedio" | "dataRecente"
  >("compat");
  const [opened, setOpened] = useState<PriceResult | null>(null);
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const basket = useBasket();
  // View padrão = cards (original). Persiste a escolha do usuário no navegador.
  const [view, setView] = useState<"table" | "cards">(() => {
    if (typeof window === "undefined") return "cards";
    const v = window.localStorage.getItem("buscar:view");
    return v === "table" || v === "cards" ? v : "cards";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("buscar:view", view);
  }, [view]);
  // Paginação persistente
  const [pageSize, setPageSize] = useState<number>(() => {
    if (typeof window === "undefined") return 20;
    const n = Number(window.localStorage.getItem("buscar:pageSize"));
    return [10, 20, 50, 100].includes(n) ? n : 20;
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("buscar:pageSize", String(pageSize));
  }, [pageSize]);
  const [page, setPage] = useState(1);

  const callSearch = useServerFn(searchPrices);
  const callDbSearch = useServerFn(searchDbItems);
  const queryClient = useQueryClient();

  // A busca só dispara via submit (botão "Buscar" ou Enter).
  // Não há mais debounce que altera a URL enquanto o usuário digita.

  // Restaura o último termo pesquisado ao voltar para /buscar sem ?q.
  // Assim o usuário reencontra os resultados sem precisar repesquisar.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (q.trim().length === 0) {
      const last = window.localStorage.getItem("buscar:lastQ");
      if (last && last.trim().length >= 2) {
        setInput(last);
        navigate({ to: "/buscar", search: { q: last }, replace: true });
      }
    } else {
      window.localStorage.setItem("buscar:lastQ", q);
      if (input !== q) setInput(q);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

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
    queryKey: ["search", q, tema, mode, parsedKeywords.join("|")],
    enabled: q.trim().length >= 2,
    staleTime: 30 * 60_000,
    gcTime: 24 * 60 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () =>
      callSearch({
        data: {
          query: q.trim(),
          tema: tema.trim() || undefined,
          pagina: 1,
          mode,
          keywords: parsedKeywords.length ? parsedKeywords : undefined,
        },
      }),
  });

  // DB-first: busca instantânea no banco local (zero créditos) em paralelo
  // com a busca remota. Resultados aparecem no topo enquanto a remota carrega.
  const { data: dbData } = useQuery({
    queryKey: ["search-db", q],
    enabled: q.trim().length >= 2,
    staleTime: 30 * 60_000,
    gcTime: 24 * 60 * 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    queryFn: () => callDbSearch({ data: { query: q.trim(), limit: 30 } }),
  });

  // Refresh em background quando o resultado vem do cache.
  // Roda a varredura completa, atualiza o banco e invalida a query
  // para a UI re-renderizar com os dados frescos.
  const isCached = !!data?.fromCache;
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!isCached || q.trim().length < 2) return;
    let cancelled = false;
    setRefreshing(true);
    callSearch({
      data: {
        query: q.trim(),
        tema: tema.trim() || undefined,
        pagina: 1,
        mode,
        keywords: parsedKeywords.length ? parsedKeywords : undefined,
        forceRefresh: true,
      },
    })
      .then((fresh) => {
        if (cancelled) return;
        queryClient.setQueryData(
          ["search", q, tema, mode, parsedKeywords.join("|")],
          fresh,
        );
      })
      .catch((e) => console.warn("background refresh failed", e))
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCached, q, tema, mode, parsedKeywords.join("|")]);

  const filtered = useMemo(() => {
    // Merge: resultados do banco local + remotos, dedupe por id, banco vai
    // primeiro (já casa por query_norm/ILIKE) e remoto preenche o resto.
    const remote = data?.results ?? [];
    const local = dbData?.results ?? [];
    const seen = new Set<string>();
    const merged: PriceResult[] = [];
    for (const r of [...local, ...remote]) {
      if (!r?.id || seen.has(r.id)) continue;
      seen.add(r.id);
      merged.push(r);
    }
    if (merged.length === 0) return [];
    const vMin = filters.valorMin ? Number(filters.valorMin.replace(",", ".")) : null;
    const vMax = filters.valorMax ? Number(filters.valorMax.replace(",", ".")) : null;
    let arr = merged.filter((r) => {
      if (filters.uf && (r.uf ?? "").toUpperCase() !== filters.uf) return false;
      if (filters.unidade && !(r.unidade ?? "").toLowerCase().includes(filters.unidade.toLowerCase())) return false;
      if (vMin !== null && !Number.isNaN(vMin) && (r.valor ?? -Infinity) < vMin) return false;
      if (vMax !== null && !Number.isNaN(vMax) && (r.valor ?? Infinity) > vMax) return false;
      if (r.scoreFinal * 100 < filters.minScore) return false;
      return true;
    });

    // Fallback: se os filtros zeraram a lista mas há resultados brutos,
    // mostra todos eles (ordenados por score). O usuário nunca deve ficar
    // com a tela vazia quando o servidor retornou algo.
    if (arr.length === 0 && merged.length > 0) {
      arr = [...merged];
    }

    // Ordenação configurável
    const withValor = arr.filter((r) => typeof r.valor === "number") as (PriceResult & { valor: number })[];
    const media = withValor.length
      ? withValor.reduce((s, r) => s + r.valor, 0) / withValor.length
      : 0;
    const propMid = vMin !== null && vMax !== null && !Number.isNaN(vMin) && !Number.isNaN(vMax) ? (vMin + vMax) / 2 : media;

    // Tier de aderência ao termo pesquisado:
    // Normaliza (lowercase, sem acento, sem pontuação) e calcula o maior
    // prefixo contíguo do título-de-busca presente no item. Tier 0 = match
    // do termo inteiro; cada palavra perdida do final = +1 no tier. Itens
    // com tier menor sempre vêm antes — só depois aplica a ordenação escolhida.
    const norm = (s: string) =>
      (s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const qWords = norm(q).split(" ").filter(Boolean);
    const tierOf = (r: PriceResult): number => {
      if (qWords.length === 0) return 0;
      const hay = norm(
        [r.objetoEstruturado, r.titulo, r.descricao].filter(Boolean).join(" "),
      );
      for (let n = qWords.length; n >= 1; n--) {
        const phrase = qWords.slice(0, n).join(" ");
        if (hay.includes(phrase)) return qWords.length - n;
      }
      return qWords.length; // nenhuma palavra do prefixo bateu
    };

    arr = [...arr].sort((a, b) => {
      const ta = tierOf(a);
      const tb = tierOf(b);
      if (ta !== tb) return ta - tb;
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
  }, [data, dbData, filters, sortBy, q]);

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

  // Reset de página quando muda termo/filtros/ordenação/pageSize
  useEffect(() => setPage(1), [q, filters, sortBy, pageSize]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const pageItems = filtered.slice(pageStart, pageStart + pageSize);

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
          <div className="mx-auto w-full max-w-screen-2xl px-4 sm:px-6 py-5">
            <h1 className="sr-only">Pesquisar Preços Públicos</h1>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = input.trim();
                navigate({ to: "/buscar", search: { q: v } });
                if (v.length >= 2) refetch();
              }}
              className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2 shadow-card"
              aria-label="Pesquisar item"
            >
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Descreva o item a cotar — ex. impressora multifuncional laser monocromática"
                className="flex-1 bg-transparent outline-none text-sm py-1.5"
                autoFocus
                aria-label="Termo de pesquisa"
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
              {data?.fromCache && (
                <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
                  {refreshing ? (
                    <>
                      <RefreshCw className="h-3 w-3 animate-spin" />
                      Cache de {data.cachedAt ? new Date(data.cachedAt).toLocaleString("pt-BR") : "—"} · atualizando ao vivo…
                    </>
                  ) : (
                    <>
                      <Database className="h-3 w-3" />
                      Cache · {data.cachedAt ? new Date(data.cachedAt).toLocaleString("pt-BR") : ""}
                    </>
                  )}
                </div>
              )}
              {data && filtered.length > 0 && (
                <div className="flex items-center gap-1">
                  <div className="mr-2 inline-flex items-center rounded-md border border-border bg-card overflow-hidden">
                    <button
                      onClick={() => setView("table")}
                      title="Tabela facetada"
                      className={`inline-flex items-center gap-1 px-2 py-1.5 text-xs transition-smooth ${view === "table" ? "bg-accent/15 text-accent" : "hover:bg-secondary text-muted-foreground"}`}
                    >
                      <Rows3 className="h-3.5 w-3.5" /> Tabela
                    </button>
                    <button
                      onClick={() => setView("cards")}
                      title="Cards"
                      className={`inline-flex items-center gap-1 px-2 py-1.5 text-xs transition-smooth ${view === "cards" ? "bg-accent/15 text-accent" : "hover:bg-secondary text-muted-foreground"}`}
                    >
                      <LayoutGrid className="h-3.5 w-3.5" /> Cards
                    </button>
                  </div>
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
            {isFetching && !data && <LiveSearchLog />}
            {!isFetching && data?.sources?.length ? (
              <SourceStrip sources={data.sources} />
            ) : null}
          </div>
        </section>

        <div className="mx-auto w-full max-w-screen-2xl px-4 sm:px-6 py-8 grid lg:grid-cols-[240px_minmax(0,1fr)] gap-6">
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
                  <option value="semantic">Semelhante (IA)</option>
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

                <button
                  onClick={() => setFilters({ uf: "", unidade: "", minScore: 0, valorMin: "", valorMax: "" })}
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
          <section className="min-w-0">
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
                {view === "table" ? (
                  <ResultsTable
                    items={pageItems}
                    onOpen={setOpened}
                    onSave={toggleSave}
                    savedIds={saved}
                    onAddToBasket={(it) => basket.toggle(it, q)}
                    basketIds={basket.ids}
                    query={q}
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    {pageItems.map((it) => (
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
                )}
                <Pager
                  page={safePage}
                  totalPages={totalPages}
                  pageSize={pageSize}
                  total={filtered.length}
                  start={pageStart}
                  end={pageStart + pageItems.length}
                  onPage={setPage}
                  onPageSize={setPageSize}
                />
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
  sources,
}: {
  sources?: { name: string; domain?: string; total: number }[];
}) {
  const fallback = ["PNCP", "Compras.gov.br", "TCE-CE", "TCEs/portais oficiais", "Fornecedores"];
  const list: { name: string; domain?: string; total: number }[] = sources?.length
    ? sources
    : fallback.map((name) => ({ name, total: 0 }));
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex items-center gap-1 pr-1">Fontes consultadas</span>
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

/**
 * Log rotativo durante a varredura — passa por cada fonte oficial a cada ~700ms
 * pra mostrar ao usuário que o sistema está vivo e onde está buscando.
 */
function LiveSearchLog() {
  const stages = useMemo(
    () => [
      "PNCP (Portal Nacional de Contratações Públicas)",
      "Compras.gov.br",
      "Portal da Transparência",
      "TCE-CE",
      "Transparência de Itarema",
      "Diários Oficiais municipais",
      "Atas de Registro de Preços",
      "Bases de fornecedores",
    ],
    [],
  );
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % stages.length), 700);
    return () => clearInterval(t);
  }, [stages.length]);
  return (
    <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] font-mono text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin text-accent" />
      <span>
        Buscando em <span className="text-foreground">{stages[idx]}</span>
        <span className="text-muted-foreground">…</span>
      </span>
    </div>
  );
}

function Pager({
  page,
  totalPages,
  pageSize,
  total,
  start,
  end,
  onPage,
  onPageSize,
}: {
  page: number;
  totalPages: number;
  pageSize: number;
  total: number;
  start: number;
  end: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  // Janela compacta de páginas: 1 … p-1 p p+1 … N
  const pages: (number | "ellipsis")[] = useMemo(() => {
    const set = new Set<number>([1, totalPages, page, page - 1, page + 1]);
    const arr = [...set].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
    const out: (number | "ellipsis")[] = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(arr[i]);
      if (i < arr.length - 1 && arr[i + 1] - arr[i] > 1) out.push("ellipsis");
    }
    return out;
  }, [page, totalPages]);

  const go = (p: number) => onPage(Math.min(totalPages, Math.max(1, p)));
  const btn = "inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-border bg-card px-2 text-xs tabular-nums hover:bg-secondary transition-smooth disabled:opacity-40 disabled:pointer-events-none";

  return (
    <nav
      aria-label="Paginação"
      className="mt-6 flex flex-col sm:flex-row items-center justify-between gap-3 rounded-xl border border-border bg-card/60 px-3 py-2"
    >
      <div className="text-xs text-muted-foreground">
        Exibindo <span className="font-medium text-foreground tabular-nums">{total === 0 ? 0 : start + 1}–{end}</span>{" "}
        de <span className="font-medium text-foreground tabular-nums">{total}</span>
      </div>
      <div className="flex items-center gap-1">
        <button className={btn} onClick={() => go(1)} disabled={page === 1} aria-label="Primeira página">
          <ChevronsLeft className="h-3.5 w-3.5" />
        </button>
        <button className={btn} onClick={() => go(page - 1)} disabled={page === 1} aria-label="Página anterior">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pages.map((p, i) =>
          p === "ellipsis" ? (
            <span key={`e-${i}`} className="px-1 text-muted-foreground text-xs">…</span>
          ) : (
            <button
              key={p}
              onClick={() => go(p)}
              aria-current={p === page ? "page" : undefined}
              className={`${btn} ${p === page ? "bg-accent/15 text-accent border-accent/40" : ""}`}
            >
              {p}
            </button>
          ),
        )}
        <button className={btn} onClick={() => go(page + 1)} disabled={page === totalPages} aria-label="Próxima página">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button className={btn} onClick={() => go(totalPages)} disabled={page === totalPages} aria-label="Última página">
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <label htmlFor="page-size">Por página</label>
        <select
          id="page-size"
          value={pageSize}
          onChange={(e) => onPageSize(Number(e.target.value))}
          className="rounded-md border border-input bg-background px-2 py-1 text-xs tabular-nums outline-none focus:ring-2 focus:ring-ring"
        >
          {[10, 20, 50, 100].map((n) => (
            <option key={n} value={n}>{n}</option>
          ))}
        </select>
      </div>
    </nav>
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