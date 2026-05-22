import { createFileRoute, redirect } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { backfillTriad, backfillHeal } from "@/lib/backfill.functions";
import { triggerBackfill } from "@/lib/inngest/trigger.functions";
import {
  listHarvestQueries,
  addHarvestQuery,
  toggleHarvestQuery,
  deleteHarvestQuery,
  listHarvestRuns,
  runHarvestNow,
} from "@/lib/harvest.functions";
import { useAuth } from "@/lib/auth";
import { Trash2, Play, Plus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin")({
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (!data.user) {
      throw redirect({ to: "/login" });
    }
  },
  component: AdminPage,
  head: () => ({
    meta: [
      { title: "Admin · Petrus IA" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
});

function AdminPage() {
  const runTriad = useServerFn(backfillTriad);
  const runHeal = useServerFn(backfillHeal);
  const runBackfill = useServerFn(triggerBackfill);
  const [triadLog, setTriadLog] = useState<string>("");
  const [healLog, setHealLog] = useState<string>("");
  const [pncpLog, setPncpLog] = useState<string>("");
  const [busy, setBusy] = useState<"triad" | "heal" | "pncp" | null>(null);

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

  async function doPncpBackfill() {
    setBusy("pncp");
    setPncpLog("Disparando evento crawler/backfill.start no Inngest...");
    try {
      const r = await runBackfill({ data: { days: 180 } });
      setPncpLog(JSON.stringify(r, null, 2) + "\n\nAcompanhe execução no dashboard do Inngest.");
    } catch (e) {
      setPncpLog(`Erro: ${(e as Error).message}`);
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

        <HarvestSection />

        <section className="rounded-xl border border-border bg-card p-4 shadow-card">
          <h2 className="font-semibold text-sm">4. Backfill PNCP 180 dias (Inngest)</h2>
          <p className="text-xs text-muted-foreground mt-1">
            Dispara o crawler em background para varrer 180 dias × 5 modalidades do PNCP.
            Limitado a 2000 janelas (~5% do free tier do Inngest). Cron automático roda a cada 6h
            no dia anterior. Idempotente — pode rodar várias vezes.
          </p>
          <button
            onClick={doPncpBackfill}
            disabled={busy !== null}
            className="mt-3 inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy === "pncp" ? "Disparando..." : "Rodar backfill 180 dias"}
          </button>
          {pncpLog && (
            <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-muted p-2 text-[11px]">{pncpLog}</pre>
          )}
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}

function HarvestSection() {
  const auth = useAuth();
  const qc = useQueryClient();
  const list = useServerFn(listHarvestQueries);
  const add = useServerFn(addHarvestQuery);
  const toggle = useServerFn(toggleHarvestQuery);
  const remove = useServerFn(deleteHarvestQuery);
  const runs = useServerFn(listHarvestRuns);
  const runNow = useServerFn(runHarvestNow);
  const [term, setTerm] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const queriesQ = useQuery({
    queryKey: ["harvest-queries"],
    queryFn: () => list(),
    enabled: auth.isAuthenticated,
  });
  const runsQ = useQuery({
    queryKey: ["harvest-runs"],
    queryFn: () => runs(),
    enabled: auth.isAuthenticated,
    refetchInterval: 5000,
  });

  const addM = useMutation({
    mutationFn: (t: string) => add({ data: { term: t } }),
    onSuccess: () => { setTerm(""); setErr(null); qc.invalidateQueries({ queryKey: ["harvest-queries"] }); },
    onError: (e) => setErr((e as Error).message),
  });
  const toggleM = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => toggle({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["harvest-queries"] }),
  });
  const delM = useMutation({
    mutationFn: (id: string) => remove({ data: { id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["harvest-queries"] }),
  });
  const runM = useMutation({
    mutationFn: (id: string) => runNow({ data: { id } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["harvest-queries"] }); qc.invalidateQueries({ queryKey: ["harvest-runs"] }); },
    onError: (e) => setErr((e as Error).message),
  });

  if (!auth.isAuthenticated) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 shadow-card">
        <h2 className="font-semibold text-sm">3. Harvester (robô de coleta contínua)</h2>
        <p className="mt-2 text-xs text-muted-foreground">
          Faça login com uma conta admin pra gerenciar termos de coleta automática.
        </p>
      </section>
    );
  }

  const queries = queriesQ.data?.queries ?? [];
  const runRows = runsQ.data?.runs ?? [];

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-card">
      <h2 className="font-semibold text-sm">3. Harvester (robô de coleta contínua)</h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Termos que o sistema vai pesquisar em segundo plano (cron a cada 30min, máx 2 termos por tick, mín 12h entre execuções do mesmo termo).
        Cada execução enriquece o banco — itens já coletados aparecem instantaneamente em buscas relacionadas.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); if (term.trim()) addM.mutate(term.trim()); }}
        className="mt-4 flex gap-2"
      >
        <input
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Ex: caneta esferográfica azul, papel A4 75g, notebook i5..."
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs"
          maxLength={120}
        />
        <button
          type="submit"
          disabled={!term.trim() || addM.isPending}
          className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" /> Adicionar
        </button>
      </form>
      {err && <p className="mt-2 text-xs text-destructive">{err}</p>}

      <div className="mt-4 overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left px-2 py-1.5">Termo</th>
              <th className="text-left px-2 py-1.5">Última execução</th>
              <th className="text-left px-2 py-1.5">Itens</th>
              <th className="text-left px-2 py-1.5">Ativo</th>
              <th className="text-right px-2 py-1.5">Ações</th>
            </tr>
          </thead>
          <tbody>
            {queries.length === 0 && (
              <tr><td colSpan={5} className="px-2 py-3 text-center text-muted-foreground">Nenhum termo. Adicione um acima.</td></tr>
            )}
            {queries.map((q) => (
              <tr key={q.id} className="border-t border-border">
                <td className="px-2 py-1.5 font-medium">{q.term}</td>
                <td className="px-2 py-1.5 text-muted-foreground">
                  {q.last_run_at ? new Date(q.last_run_at).toLocaleString("pt-BR") : "—"}
                </td>
                <td className="px-2 py-1.5 tabular-nums">{q.total_found}</td>
                <td className="px-2 py-1.5">
                  <button
                    type="button"
                    onClick={() => toggleM.mutate({ id: q.id, enabled: !q.enabled })}
                    className={`text-[10px] px-2 py-0.5 rounded-full ${q.enabled ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}
                  >
                    {q.enabled ? "ativo" : "pausado"}
                  </button>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <button
                    type="button"
                    onClick={() => runM.mutate(q.id)}
                    disabled={runM.isPending}
                    title="Rodar agora"
                    className="inline-flex items-center justify-center rounded p-1 hover:bg-accent disabled:opacity-50"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { if (confirm(`Remover "${q.term}"?`)) delM.mutate(q.id); }}
                    title="Remover"
                    className="inline-flex items-center justify-center rounded p-1 hover:bg-destructive/10 text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4">
        <h3 className="text-xs font-semibold">Execuções recentes</h3>
        <div className="mt-2 max-h-60 overflow-auto rounded-md border border-border">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/50 text-[10px] uppercase tracking-wider text-muted-foreground sticky top-0">
              <tr>
                <th className="text-left px-2 py-1">Termo</th>
                <th className="text-left px-2 py-1">Quando</th>
                <th className="text-left px-2 py-1">Status</th>
                <th className="text-right px-2 py-1">Itens</th>
              </tr>
            </thead>
            <tbody>
              {runRows.length === 0 && (
                <tr><td colSpan={4} className="px-2 py-2 text-center text-muted-foreground">Sem execuções ainda.</td></tr>
              )}
              {runRows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-2 py-1">{r.term}</td>
                  <td className="px-2 py-1 text-muted-foreground">{new Date(r.started_at).toLocaleString("pt-BR")}</td>
                  <td className="px-2 py-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${r.status === "ok" ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-400" : r.status === "error" ? "bg-destructive/20 text-destructive" : "bg-muted"}`}>
                      {r.status}
                    </span>
                    {r.error && <span className="ml-2 text-destructive">{r.error.slice(0, 60)}</span>}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.items_persisted}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
