import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { backfillTriad, backfillHeal } from "@/lib/backfill.functions";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
  head: () => ({
    meta: [
      { title: "Admin · CotaçãoIA" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
});

function AdminPage() {
  const runTriad = useServerFn(backfillTriad);
  const runHeal = useServerFn(backfillHeal);
  const [triadLog, setTriadLog] = useState<string>("");
  const [healLog, setHealLog] = useState<string>("");
  const [busy, setBusy] = useState<"triad" | "heal" | null>(null);

  async function doTriad() {
    setBusy("triad");
    setTriadLog("Rodando...");
    try {
      const r = await runTriad({ data: { batchSize: 500, maxBatches: 20 } });
      setTriadLog(JSON.stringify(r, null, 2));
    } catch (e) {
      setTriadLog(`Erro: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  async function doHeal() {
    setBusy("heal");
    setHealLog("Rodando (pode demorar — chama Lovable AI)...");
    try {
      const r = await runHeal({ data: { limit: 30 } });
      setHealLog(JSON.stringify(r, null, 2));
    } catch (e) {
      setHealLog(`Erro: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex-1 mx-auto max-w-4xl px-4 sm:px-6 py-8 space-y-8">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">Admin — Backfill</h1>
          <p className="text-xs text-muted-foreground mt-1">
            Ferramentas internas. Estes botões processam itens já gravados, em lote, e são seguros de rodar várias vezes (idempotentes).
          </p>
        </header>

        <section className="rounded-xl border border-border bg-card p-4 shadow-card">
          <h2 className="font-semibold text-sm">1. Reclassificar tríade matemática</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Aplica <code>classifyTriad</code> em todos os <code>quote_items</code> sem
            <code> math_status</code>. Roda até 20 lotes × 500 itens.
          </p>
          <button
            onClick={doTriad}
            disabled={busy !== null}
            className="mt-3 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "triad" ? "Rodando..." : "Rodar backfill da tríade"}
          </button>
          {triadLog && (
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px]">{triadLog}</pre>
          )}
        </section>

        <section className="rounded-xl border border-border bg-card p-4 shadow-card">
          <h2 className="font-semibold text-sm">2. Healer retroativo (valor unitário)</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Para itens antigos sem valor unitário (ou com matemática divergente) que ainda
            não passaram pelo healer. Usa few-shot das correções humanas. Processa 30 por clique.
          </p>
          <button
            onClick={doHeal}
            disabled={busy !== null}
            className="mt-3 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "heal" ? "Rodando..." : "Rodar healer (30 itens)"}
          </button>
          {healLog && (
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px]">{healLog}</pre>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
