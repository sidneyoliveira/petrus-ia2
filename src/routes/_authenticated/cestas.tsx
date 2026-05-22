import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Trash2, ShoppingBasket, Download, Loader2, Upload } from "lucide-react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import {
  listBaskets,
  loadBasket,
  deleteBasket,
  saveBasket,
} from "@/lib/baskets.functions";
import { useBasket, replaceBasketItems, setActiveBasketId } from "@/lib/basket";

export const Route = createFileRoute("/_authenticated/cestas")({
  component: CestasPage,
  head: () => ({
    meta: [
      { title: "Minhas cestas · CotaçãoIA" },
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

  const { data, isLoading } = useQuery({
    queryKey: ["baskets"],
    queryFn: () => list(),
  });

  const loadMut = useMutation({
    mutationFn: (id: string) => load({ data: { id } }),
    onSuccess: (row) => {
      if (row && Array.isArray(row.items)) {
        replaceBasketItems(row.items as never);
        setActiveBasketId(row.id);
      }
    },
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["baskets"] }),
  });

  const saveMut = useMutation({
    mutationFn: (name: string) =>
      save({ data: { name, items: basket.items as never } }),
    onSuccess: () => {
      setNewName("");
      qc.invalidateQueries({ queryKey: ["baskets"] });
    },
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
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
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
          ) : !data || data.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Nenhuma cesta salva ainda.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.map((b) => (
                <li
                  key={b.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium truncate">{b.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {b.itemCount} itens · atualizada em{" "}
                      {new Date(b.updated_at).toLocaleString("pt-BR")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Link
                      to="/cotacao"
                      onClick={() => loadMut.mutate(b.id)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-foreground hover:opacity-90"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Carregar
                    </Link>
                    <button
                      onClick={() => {
                        if (confirm(`Excluir cesta "${b.name}"?`))
                          delMut.mutate(b.id);
                      }}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-destructive/10 hover:text-destructive"
                      title="Excluir"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}