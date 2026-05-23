import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Trash2, ShoppingBasket, ExternalLink, FileSpreadsheet, FileText, Cloud, Loader2 } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { useBasket, getActiveBasketId, setActiveBasketId } from "@/lib/basket";
import { buildBasketReport, type ReportPlan } from "@/lib/export-report-pdf";
import { ReportPreviewDialog } from "@/components/ReportPreviewDialog";
import { buildProcessDossier } from "@/lib/report.functions";
import { saveBasket } from "@/lib/baskets.functions";
import { useAuth } from "@/lib/auth";
import {
  ThemeSelector,
  getActiveThemeId,
  setActiveThemeId,
} from "@/components/ThemeSelector";
import { calculateBasketStats } from "@/lib/basket-stats";
import { CheckCircle2, AlertTriangle } from "lucide-react";

export const Route = createFileRoute("/cotacao")({
  component: CotacaoPage,
  head: () => ({
    meta: [
      { title: "Minha cotação · Petrus IA" },
      { name: "description", content: "Monte sua Nota Técnica de preços a partir de itens selecionados de múltiplas fontes." },
      { property: "og:title", content: "Minha cotação · Petrus IA" },
      { property: "og:description", content: "Monte sua Nota Técnica de preços a partir de itens selecionados de múltiplas fontes." },
    ],
  }),
});

function brl(v?: number | null) {
  if (typeof v !== "number") return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function CotacaoPage() {
  const { items, remove, setQuantidade, clear } = useBasket();
  const auth = useAuth();
  const callSave = useServerFn(saveBasket);
  const callDossier = useServerFn(buildProcessDossier);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [reportPlan, setReportPlan] = useState<ReportPlan | null>(null);
  const [activeTheme, setActiveTheme] = useState<string | null>(() =>
    typeof window !== "undefined" ? getActiveThemeId() : null,
  );

  useEffect(() => {
    const sync = () => setActiveTheme(getActiveThemeId());
    window.addEventListener("petrus:theme:changed", sync);
    return () => window.removeEventListener("petrus:theme:changed", sync);
  }, []);

  async function saveToCloud() {
    if (!auth.isAuthenticated || items.length === 0) return;
    setSaving(true);
    try {
      const id = getActiveBasketId() ?? undefined;
      const name = `Cesta de ${new Date().toLocaleString("pt-BR")}`;
      const row = await callSave({
        data: { id, name, items: items as never, themeId: activeTheme },
      });
      if (row?.id) setActiveBasketId(row.id);
      setSavedAt(new Date().toLocaleTimeString("pt-BR"));
    } catch (e) {
      alert("Não foi possível salvar: " + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const totals = useMemo(() => {
    let totalGeral = 0;
    let comUnitario = 0;
    const rows = items.map((b) => {
      const unit = typeof b.item.valor === "number" ? b.item.valor : null;
      const subtotal = unit !== null ? unit * b.quantidade : null;
      if (subtotal !== null) {
        totalGeral += subtotal;
        comUnitario += 1;
      }
      return { ...b, unit, subtotal };
    });
    const unitVals = rows
      .map((r) => r.unit)
      .filter((v): v is number => typeof v === "number" && v > 0);
    const media = unitVals.length
      ? unitVals.reduce((s, v) => s + v, 0) / unitVals.length
      : 0;
    const sorted = [...unitVals].sort((a, b) => a - b);
    const mediana = sorted.length
      ? sorted[Math.floor(sorted.length / 2)]
      : 0;
    return { rows, totalGeral, comUnitario, media, mediana };
  }, [items]);

  /** Estatísticas IN 65/2021 (CV, outliers, recomendação). */
  const stats = useMemo(
    () =>
      calculateBasketStats(
        items
          .map((b) => ({ id: b.item.id, valor: b.item.valor }))
          .filter((x): x is { id: string; valor: number } => typeof x.valor === "number"),
      ),
    [items],
  );

  const exportCotacaoCSV = () => {
    const headers = [
      "Item",
      "Unidade",
      "Qtd cotada",
      "Valor unitário (R$)",
      "Subtotal (R$)",
      "Fornecedor",
      "Órgão",
      "UF",
      "Data",
      "Origem",
      "URL",
    ];
    const esc = (s: unknown) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = totals.rows.map((r) =>
      [
        r.item.objetoEstruturado || r.item.titulo,
        r.item.unidade ?? "",
        r.quantidade,
        typeof r.unit === "number" ? r.unit.toFixed(2).replace(".", ",") : "",
        typeof r.subtotal === "number" ? r.subtotal.toFixed(2).replace(".", ",") : "",
        r.item.fornecedor ?? "",
        r.item.orgao ?? "",
        r.item.uf ?? "",
        r.item.data ?? "",
        r.item.origem,
        r.item.url ?? "",
      ].map(esc).join(";"),
    );
    const csv = "\ufeff" + [headers.join(";"), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `minha-cotacao-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const exportPDF = async () => {
    if (pdfLoading) return;
    setPdfLoading(true);
    try {
      // Busca dossier de cada processo distinto em paralelo (até 6 por vez)
      const seen = new Map<string, ReturnType<typeof callDossier>>();
      for (const r of totals.rows) {
        const key = r.item.url || `${r.item.origem}|${r.item.titulo}`;
        if (seen.has(key)) continue;
        seen.set(
          key,
          callDossier({
            data: {
              origem: r.item.origem,
              url: r.item.url,
              fallback: {
                orgao: r.item.orgao,
                modalidade: r.item.modalidade,
                municipio: r.item.municipio,
                uf: r.item.uf,
                dataPublicacao: r.item.data,
                objetoCompra: r.item.descricao,
              },
            },
          }),
        );
      }
      const resolved = new Map<string, Awaited<ReturnType<typeof callDossier>>>();
      await Promise.all(
        Array.from(seen.entries()).map(async ([k, p]) => {
          try { resolved.set(k, await p); } catch { /* tolera */ }
        }),
      );
      const plan = buildBasketReport(
        totals.rows.map((r) => ({
          item: r.item,
          quantidadeCotada: r.quantidade,
          dossier: resolved.get(r.item.url || `${r.item.origem}|${r.item.titulo}`) ?? null,
        })),
        { totalGeral: totals.totalGeral, media: totals.media, mediana: totals.mediana },
      );
      setReportPlan(plan);
    } catch (e) {
      alert("Falha ao gerar PDF: " + (e as Error).message);
    } finally {
      setPdfLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border/60 bg-card/40">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 py-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                  <ShoppingBasket className="h-5 w-5 text-accent" />
                  Minha cotação
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Itens selecionados de múltiplas fontes para compor sua Nota Técnica de preços (Lei 14.133, IN 65/2021).
                </p>
              </div>
              {items.length > 0 && (
                <div className="flex items-center gap-2">
                  {auth.isAuthenticated ? (
                    <>
                      <button
                        onClick={saveToCloud}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs text-accent hover:bg-accent/20 disabled:opacity-50"
                        title="Salvar cesta na nuvem"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Cloud className="h-3.5 w-3.5" />}
                        {savedAt ? `Salvo ${savedAt}` : "Salvar na nuvem"}
                      </button>
                      <Link
                        to="/cestas"
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-secondary"
                      >
                        Minhas cestas
                      </Link>
                    </>
                  ) : (
                    <Link
                      to="/login"
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-secondary"
                      title="Entre pra salvar suas cestas"
                    >
                      <Cloud className="h-3.5 w-3.5" /> Entrar pra salvar
                    </Link>
                  )}
                  <button
                    onClick={exportPDF}
                    disabled={pdfLoading}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90 transition-smooth"
                  >
                    {pdfLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />}
                    {pdfLoading ? "Gerando relatório…" : "Relatório completo (PDF)"}
                  </button>
                  <button
                    onClick={exportCotacaoCSV}
                    className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-smooth"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Exportar CSV
                  </button>
                  <button
                    onClick={() => {
                      if (confirm("Limpar todos os itens da cotação?")) clear();
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs hover:bg-secondary transition-smooth"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Limpar
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <div className="mx-auto max-w-7xl px-4 sm:px-6 py-8">
          {auth.isAuthenticated && (
            <div className="mb-4">
              <ThemeSelector
                value={activeTheme}
                onChange={(id) => {
                  setActiveTheme(id);
                  setActiveThemeId(id);
                }}
              />
            </div>
          )}
          {items.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 p-12 text-center">
              <div className="mx-auto h-12 w-12 rounded-full bg-accent/15 text-accent inline-flex items-center justify-center mb-4">
                <ShoppingBasket className="h-5 w-5" />
              </div>
              <div className="font-semibold mb-1">Sua cotação está vazia</div>
              <p className="text-sm text-muted-foreground max-w-md mx-auto mb-5">
                Na pesquisa, expanda qualquer linha da tabela e clique em <span className="text-foreground font-medium">"Adicionar à cotação"</span> para começar.
              </p>
              <Link
                to="/buscar"
                search={{ q: "" }}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                Ir para pesquisa
              </Link>
            </div>
          ) : (
            <>
              <div
                className={`mb-4 rounded-xl border p-4 transition-colors ${
                  stats.n === 0
                    ? "border-border bg-card"
                    : stats.homogeneo
                      ? "border-success/30 bg-success/5"
                      : "border-destructive/30 bg-destructive/5"
                }`}
              >
                <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
                  <Stat label="Itens" value={String(items.length)} />
                  <Stat label="Total geral" value={brl(totals.totalGeral)} accent />
                  <Stat label="Média" value={brl(stats.media || totals.media)} />
                  <Stat label="Mediana" value={brl(stats.mediana || totals.mediana)} />
                  <Stat label="Desvio" value={brl(stats.desvio)} />
                  <Stat
                    label="CV (IN 65/2021)"
                    value={`${stats.coeficienteVariacao.toFixed(1)} %`}
                    tone={stats.n === 0 ? "neutral" : stats.homogeneo ? "success" : "danger"}
                  />
                </div>
                {stats.n > 0 && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3 text-xs">
                    {stats.homogeneo ? (
                      <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                    ) : (
                      <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span
                      className={`font-medium ${
                        stats.homogeneo ? "text-success" : "text-destructive"
                      }`}
                    >
                      {stats.recomendacao}
                    </span>
                    {stats.outliers.length > 0 && (
                      <span className="text-muted-foreground">
                        · {stats.outliers.length} outlier(s) excluído(s) do cálculo
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-border bg-card overflow-hidden shadow-card">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-secondary/30">
                      <tr className="text-left text-xs text-muted-foreground">
                        <th className="px-3 py-2.5 font-medium">Item</th>
                        <th className="px-3 py-2.5 font-medium w-20">Un.</th>
                        <th className="px-3 py-2.5 font-medium w-28 text-right">Qtd</th>
                        <th className="px-3 py-2.5 font-medium w-32 text-right">Unitário</th>
                        <th className="px-3 py-2.5 font-medium w-32 text-right">Subtotal</th>
                        <th className="px-3 py-2.5 font-medium w-12"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {totals.rows.map((r) => (
                        <tr key={r.item.id} className="border-t border-border/60 align-top">
                          <td className="px-3 py-3">
                            <div className="font-medium leading-snug line-clamp-2">
                              {r.item.objetoEstruturado || r.item.titulo}
                            </div>
                            <div className="mt-1 text-[11px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
                              <span className="uppercase tracking-wider">{r.item.origem}</span>
                              {r.item.orgao && <span className="truncate max-w-[20rem]" title={r.item.orgao}>{r.item.orgao}</span>}
                              {r.item.uf && <span>{r.item.uf}</span>}
                              {r.item.fornecedor && <span className="truncate max-w-[16rem]" title={r.item.fornecedor}>{r.item.fornecedor}</span>}
                              {r.item.url && (
                                <a
                                  href={r.item.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="inline-flex items-center gap-1 hover:text-foreground"
                                >
                                  fonte <ExternalLink className="h-3 w-3" />
                                </a>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-3 uppercase text-xs">{r.item.unidade || "—"}</td>
                          <td className="px-3 py-3 text-right">
                            <input
                              type="number"
                              min={0}
                              step="any"
                              value={r.quantidade}
                              onChange={(e) => setQuantidade(r.item.id, Number(e.target.value))}
                              className="w-24 rounded-md border border-input bg-background px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring"
                            />
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{brl(r.unit)}</td>
                          <td className="px-3 py-3 text-right tabular-nums font-medium">
                            {brl(r.subtotal)}
                          </td>
                          <td className="px-3 py-3">
                            <button
                              onClick={() => remove(r.item.id)}
                              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-destructive/10 hover:text-destructive transition-smooth"
                              title="Remover"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-secondary/20">
                      <tr className="border-t border-border/60">
                        <td colSpan={4} className="px-3 py-3 text-right text-xs uppercase tracking-wider text-muted-foreground">
                          Total geral
                        </td>
                        <td className="px-3 py-3 text-right text-base font-semibold text-accent tabular-nums">
                          {brl(totals.totalGeral)}
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Itens sem valor unitário (apenas total global do processo) não entram no cálculo.
              </p>
            </>
          )}
        </div>
      </main>
      <SiteFooter />
      <ReportPreviewDialog plan={reportPlan} onClose={() => setReportPlan(null)} />
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  tone,
}: {
  label: string;
  value: string;
  accent?: boolean;
  tone?: "neutral" | "success" | "danger";
}) {
  const toneCls =
    tone === "success"
      ? "text-success"
      : tone === "danger"
        ? "text-destructive"
        : accent
          ? "text-accent"
          : "";
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-semibold tabular-nums truncate ${toneCls}`} title={value}>{value}</div>
    </div>
  );
}