import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, ShoppingBasket, Trash2, FolderOpen, Save } from "lucide-react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { listBaskets, loadBasket, deleteBasket } from "@/lib/baskets.functions";
import { replaceBasketItems, setActiveBasketId } from "@/lib/basket";

export const Route = createFileRoute("/_authenticated/cestas")({
  component: CestasPage,
  head: () => ({ meta: [{ title: "Minhas cestas · CotaçãoIA" }] }),
});

function CestasPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fetchList = useServerFn(listBaskets);
  const fetchOne = useServerFn(loadBasket);
  const del = useServerFn(deleteBasket);
  const [busy, setBusy] = useState<string | null>(null);

  const { data: list, isLoading } = useQuery({
    queryKey: ["baskets"],
    queryFn: () => fetchList(),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["baskets"] });
      toast.success("Cesta apagada");
    },
  });

  const openBasket = async (id: string, name: string) => {
    setBusy(id);
    try {
      const row = await fetchOne({ data: { id } });
      if (!row) {
        toast.error("Cesta não encontrada");
        return;
      }
      replaceBasketItems((row.items as unknown as never) ?? []);
      setActiveBasketId(id);
      toast.success(`Cesta "${name}" carregada`);
      navigate({ to: "/cotacao" });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border/60 bg-card/40">
          <div className="mx-auto max-w-screen-2xl px-4 sm:px-6 py-6">
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <ShoppingBasket className="h-5 w-5 text-accent" /> Minhas cestas
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Cestas de preços salvas na sua conta.
            </p>
          </div>
        </section>
        <div className="mx-auto max-w-screen-2xl px-4 sm:px-6 py-8">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : !list || list.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 p-12 text-center">
              <div className="font-semibold mb-1">Nenhuma cesta salva ainda</div>
              <p className="text-sm text-muted-foreground">
                Em <span className="font-medium text-foreground">/cotacao</span>, clique em{" "}
                <span className="font-medium text-foreground">"Salvar na nuvem"</span>.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {list.map((b) => (
                <div key={b.id} className="rounded-xl border border-border bg-card p-4 shadow-card">
                  <div className="font-semibold leading-snug line-clamp-2">{b.name}</div>
                  <div className="text-xs text-muted-foreground mt-1 tabular-nums">
                    {b.itemCount} itens · {new Date(b.updated_at).toLocaleString("pt-BR")}
                  </div>
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => openBasket(b.id, b.name)}
                      disabled={busy === b.id}
                      className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 transition-smooth disabled:opacity-60"
                    >
                      {busy === b.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
                      Abrir
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Apagar "${b.name}"?`)) delMut.mutate(b.id);
                      }}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border hover:bg-destructive/10 hover:text-destructive transition-smooth"
                      title="Apagar"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}