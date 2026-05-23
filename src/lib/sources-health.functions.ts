import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Resumo de saúde das fontes nos últimos N dias. Cruza `price_sources`
 * (catálogo registrado) com `source_runs` (telemetria real). Permite
 * identificar quais fontes estão produzindo resultados e quais estão
 * silenciosas/quebradas.
 */
export const getSourcesHealth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [catalogRes, runsRes] = await Promise.all([
      supabaseAdmin
        .from("price_sources")
        .select("id, name, domain, category, enabled")
        .order("category", { ascending: true })
        .order("name", { ascending: true }),
      supabaseAdmin
        .from("source_runs")
        .select("source_id, status, count, took_ms, created_at, error")
        .gte("created_at", since)
        .limit(5000),
    ]);

    if (catalogRes.error) throw new Error(catalogRes.error.message);
    if (runsRes.error) throw new Error(runsRes.error.message);

    const runs = runsRes.data ?? [];
    type Agg = {
      runs: number;
      ok: number;
      empty: number;
      error: number;
      items: number;
      avgMs: number;
      lastRun: string | null;
      lastError: string | null;
    };
    const byId = new Map<string, Agg>();
    const totalMsById = new Map<string, number>();

    for (const r of runs) {
      const key = (r.source_id || "desconhecido").toLowerCase();
      const a = byId.get(key) ?? {
        runs: 0,
        ok: 0,
        empty: 0,
        error: 0,
        items: 0,
        avgMs: 0,
        lastRun: null,
        lastError: null,
      };
      a.runs++;
      if (r.status === "ok") a.ok++;
      else if (r.status === "empty") a.empty++;
      else a.error++;
      a.items += r.count ?? 0;
      totalMsById.set(key, (totalMsById.get(key) ?? 0) + (r.took_ms ?? 0));
      if (!a.lastRun || (r.created_at && r.created_at > a.lastRun)) {
        a.lastRun = r.created_at;
      }
      if (r.error && !a.lastError) a.lastError = r.error.slice(0, 200);
      byId.set(key, a);
    }
    for (const [k, a] of byId.entries()) {
      const total = totalMsById.get(k) ?? 0;
      a.avgMs = a.runs > 0 ? Math.round(total / a.runs) : 0;
    }

    // Combina catálogo + métricas em ID normalizado (domínio simplificado).
    type SourceRow = {
      id: string;
      name: string;
      domain: string;
      category: string;
      enabled: boolean;
      registered: boolean;
      runs: number;
      ok: number;
      empty: number;
      error: number;
      items: number;
      avgMs: number;
      successRate: number;
      lastRun: string | null;
      lastError: string | null;
      health: "healthy" | "warning" | "broken" | "idle";
    };

    const rows: SourceRow[] = [];
    const seenIds = new Set<string>();
    for (const src of catalogRes.data ?? []) {
      const candidates = [
        src.name.toLowerCase(),
        src.domain.toLowerCase(),
        src.domain.split(".")[0].toLowerCase(),
      ];
      const matchKey = candidates.find((c) => byId.has(c)) ?? src.domain.toLowerCase();
      const agg = byId.get(matchKey) ?? {
        runs: 0,
        ok: 0,
        empty: 0,
        error: 0,
        items: 0,
        avgMs: 0,
        lastRun: null,
        lastError: null,
      };
      seenIds.add(matchKey);
      const successRate = agg.runs > 0 ? agg.ok / agg.runs : 0;
      let health: SourceRow["health"];
      if (agg.runs === 0) health = "idle";
      else if (successRate >= 0.8 && agg.items > 0) health = "healthy";
      else if (agg.items === 0 || successRate < 0.3) health = "broken";
      else health = "warning";

      rows.push({
        id: src.id,
        name: src.name,
        domain: src.domain,
        category: src.category,
        enabled: src.enabled,
        registered: true,
        runs: agg.runs,
        ok: agg.ok,
        empty: agg.empty,
        error: agg.error,
        items: agg.items,
        avgMs: agg.avgMs,
        successRate,
        lastRun: agg.lastRun,
        lastError: agg.lastError,
        health,
      });
    }

    // Fontes que aparecem em source_runs mas NÃO estão no catálogo
    for (const [key, agg] of byId.entries()) {
      if (seenIds.has(key)) continue;
      const successRate = agg.runs > 0 ? agg.ok / agg.runs : 0;
      rows.push({
        id: key,
        name: key,
        domain: key,
        category: "auto",
        enabled: true,
        registered: false,
        runs: agg.runs,
        ok: agg.ok,
        empty: agg.empty,
        error: agg.error,
        items: agg.items,
        avgMs: agg.avgMs,
        successRate,
        lastRun: agg.lastRun,
        lastError: agg.lastError,
        health:
          successRate >= 0.8 && agg.items > 0
            ? "healthy"
            : agg.items > 0
              ? "warning"
              : "broken",
      });
    }

    // Ordena: quebradas no topo (precisam de atenção), depois warning, depois ok, depois idle.
    const order: Record<SourceRow["health"], number> = {
      broken: 0,
      warning: 1,
      healthy: 2,
      idle: 3,
    };
    rows.sort((a, b) => {
      if (order[a.health] !== order[b.health]) return order[a.health] - order[b.health];
      return b.items - a.items;
    });

    return { sources: rows, sinceIso: since };
  });