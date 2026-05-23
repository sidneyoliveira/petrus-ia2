import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2, ShoppingBasket, Download, Loader2, Upload, Package } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import {
  listBaskets,
  loadBasket,
  deleteBasket,
  saveBasket,
} from "@/lib/baskets.functions";
import { useBasket, replaceBasketItems, setActiveBasketId } from "@/lib/basket";
import {
  ThemeSelector,
  getActiveThemeId,
  setActiveThemeId,
} from "@/components/ThemeSelector";
import { listThemes } from "@/lib/themes.functions";
import { calculateBasketStats } from "@/lib/basket-stats";
import { useEffect } from "react";
import { btn } from "@/lib/button-variants";

function brl(v?: number | null) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(v);
}

export const Route = createFileRoute("/_authenticated/cestas")({
  component: CestasPage,
  head: () => ({
    meta: [
      { title: "Minhas cestas · Petrus IA" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
});

function CestasPage() {
  const qc = useQueryClient();
  const list = useServerFn(listBaskets);
  const load = useServerFn(loadBasket);
  const del = useServerFn(deleteBasket);
  const save = useServerFn(saveBasket);
  const basket = useBasket();
  const [newName, setNewName] = useState("");
  const [activeTheme, setActiveTheme] = useState<string | null>(() =>
    typeof window !== "undefined" ? getActiveThemeId() : null,
  );

  useEffect(() => {
    const sync = () => setActiveTheme(getActiveThemeId());
    window.addEventListener("petrus:theme:changed", sync);
    return () => window.removeEventListener("petrus:theme:changed", sync);
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["baskets"],
    queryFn: () => list(),
  });

  const themesFn = useServerFn(listThemes);
  const { data: themesData } = useQuery({
    queryKey: ["themes"],
    queryFn: () => themesFn(),
  });
  const themesById = new Map(
    (themesData?.themes ?? []).map((t) => [t.id, t]),
  );

  const loadMut = useMutation({
    mutationFn: (id: string) => load({ data: { id } }),
    onSuccess: (row) => {
      if (row && Array.isArray(row.items)) {
        replaceBasketItems(row.items as never);
        setActiveBasketId(row.id);
        // herda o tema da cesta carregada
        const themeId = (row as { theme_id?: string | null }).theme_id ?? null;
        setActiveThemeId(themeId);
      }
    },
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["baskets"] }),
  });

  const saveMut = useMutation({
    mutationFn: (name: string) =>
      save({
        data: {
          name,
          items: basket.items as never,
          themeId: activeTheme,
        },
      }),
    onSuccess: () => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["baskets"] });
    },
  });

  const filtered = (data ?? []).filter((b) => {
    if (!activeTheme) return true;
    return (b as { theme_id?: string | null }).theme_id === activeTheme;
  });

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-5xl px-4 sm:px-6 py-8">
        <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2 mb-1">
          <ShoppingBasket className="h-5 w-5 text-accent" />
          Minhas cestas
        </h1>
        <p className="text-xs text-muted-foreground mb-6">
          Cestas salvas na nuvem ficam disponíveis em qualquer dispositivo onde
          você entrar.
        </p>

        <div className="mb-4">
          <ThemeSelector
            value={activeTheme}
            onChange={(id) => {
              setActiveTheme(id);
              setActiveThemeId(id);
            }}
          />
        </div>

        <div className="rounded-xl border border-border bg-card p-4 mb-6">
          <div className="text-sm font-medium mb-2">
            Salvar cesta atual ({basket.items.length} itens)
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const n = newName.trim();
              if (n.length === 0 || basket.items.length === 0) return;
              saveMut.mutate(n);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Nome da cesta (ex: Cotação Mat. escritório 2026)"
              className="flex-1 min-w-[200px] rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
              maxLength={120}
            />
            <button
              type="submit"
              disabled={
                saveMut.isPending ||
                newName.trim().length === 0 ||
                basket.items.length === 0
              }
              className={btn("primary", "sm")}
            >
              {saveMut.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              Salvar na nuvem
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-border bg-card overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Carregando…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {activeTheme
                ? "Nenhuma cesta neste tema. Salve uma cesta com o tema selecionado para que ela apareça aqui."
                : "Nenhuma cesta salva ainda."}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 p-3">
              {filtered.map((b) => {
                const themeId = (b as { theme_id?: string | null }).theme_id ?? null;
                const theme = themeId ? themesById.get(themeId) : null;
                const rawItems = Array.isArray((b as { items?: unknown }).items)
                  ? ((b as { items: Array<{ item?: { valor?: number; id?: string }; quantidade?: number }> }).items)
                  : [];
                const totalEstimado = rawItems.reduce((sum, it) => {
                  const v = typeof it?.item?.valor === "number" ? it.item.valor : 0;
                  const q = typeof it?.quantidade === "number" ? it.quantidade : 0;
                  return sum + v * q;
                }, 0);
                const stats = calculateBasketStats(
                  rawItems
                    .map((it) => ({
                      id: it?.item?.id ?? "",
                      valor: typeof it?.item?.valor === "number" ? it.item.valor : NaN,
                    }))
                    .filter((x) => Number.isFinite(x.valor) && x.id),
                );
                return (
                  <div
                    key={b.id}
                    className="group relative rounded-xl border border-border bg-card p-4 hover:shadow-card transition-smooth flex flex-col"
                  >
                    {/* Faixa de tema */}
                    <div
                      className="absolute inset-x-0 top-0 h-1 rounded-t-xl"
                      style={{ backgroundColor: theme?.color ?? "transparent" }}
                    />
                    <div className="flex items-start justify-between gap-2 mb-3">
                      <div className="flex items-start gap-2 min-w-0">
                        {theme?.icon ? (
                          <span className="text-lg leading-none mt-0.5">{theme.icon}</span>
                        ) : (
                          <Package className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="font-semibold text-sm truncate" title={b.name}>
                            {b.name}
                          </div>
                          {theme && (
                            <div
                              className="text-[10px] font-medium uppercase tracking-wider"
                              style={{ color: theme.color }}
                            >
                              {theme.name}
                            </div>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          if (confirm(`Excluir cesta "${b.name}"?`))
                            delMut.mutate(b.id);
                        }}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 transition-smooth"
                        title="Excluir"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {/* Métricas rápidas */}
                    <div className="grid grid-cols-3 gap-2 text-center mb-3">
                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Itens</div>
                        <div className="text-sm font-semibold tabular-nums">{b.itemCount}</div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">Estimado</div>
                        <div className="text-sm font-semibold tabular-nums text-accent truncate">
                          {brl(totalEstimado)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[9px] uppercase tracking-wider text-muted-foreground">CV</div>
                        <div
                          className={`text-sm font-semibold tabular-nums ${
                            stats.n === 0
                              ? "text-muted-foreground"
                              : stats.homogeneo
                                ? "text-success"
                                : "text-destructive"
                          }`}
                        >
                          {stats.n === 0 ? "—" : `${stats.coeficienteVariacao.toFixed(0)}%`}
                        </div>
                      </div>
                    </div>

                    <div className="text-[10px] text-muted-foreground mb-3 flex-1">
                      Atualizada em {new Date(b.updated_at).toLocaleString("pt-BR")}
                    </div>

                    <Link
                      to="/cotacao"
                      onClick={() => loadMut.mutate(b.id)}
                      className={`${btn("accent", "sm")} w-full`}
                    >
                      <Download className="h-3.5 w-3.5" />
                      Carregar na cotação
                    </Link>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}