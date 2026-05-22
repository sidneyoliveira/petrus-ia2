import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { searchPrices } from "./search.functions";

/** Executa harvest para um termo específico. Usado por runHarvestNow e pelo cron tick. */
export async function runHarvestForTerm(queryId: string, term: string) {
  const { data: run } = await supabaseAdmin
    .from("harvest_runs")
    .insert({ query_id: queryId, term, status: "running" })
    .select("id")
    .single();
  const runId = run?.id;
  try {
    const res = await searchPrices({ data: { query: term, forceRefresh: true } });
    const persisted = res.results?.length ?? 0;
    await supabaseAdmin
      .from("harvest_queries")
      .update({
        last_run_at: new Date().toISOString(),
        total_found: persisted,
        updated_at: new Date().toISOString(),
      })
      .eq("id", queryId);
    if (runId) {
      await supabaseAdmin
        .from("harvest_runs")
        .update({
          finished_at: new Date().toISOString(),
          items_persisted: persisted,
          status: "ok",
        })
        .eq("id", runId);
    }
    return { ok: true, persisted };
  } catch (e) {
    const msg = (e as Error).message;
    if (runId) {
      await supabaseAdmin
        .from("harvest_runs")
        .update({
          finished_at: new Date().toISOString(),
          status: "error",
          error: msg.slice(0, 500),
        })
        .eq("id", runId);
    }
    throw e;
  }
}

/** Tick do cron: pega top N queries elegíveis e roda. */
export async function harvestTick(maxQueries = 2, minHoursBetween = 12) {
  const cutoff = new Date(Date.now() - minHoursBetween * 60 * 60 * 1000).toISOString();
  const { data: queries, error } = await supabaseAdmin
    .from("harvest_queries")
    .select("id, term, last_run_at")
    .eq("enabled", true)
    .or(`last_run_at.is.null,last_run_at.lt.${cutoff}`)
    .order("last_run_at", { ascending: true, nullsFirst: true })
    .order("priority", { ascending: false })
    .limit(maxQueries);
  if (error) throw new Error(error.message);
  const results: Array<{ term: string; persisted?: number; error?: string }> = [];
  for (const q of queries ?? []) {
    try {
      const r = await runHarvestForTerm(q.id, q.term);
      results.push({ term: q.term, persisted: r.persisted });
    } catch (e) {
      results.push({ term: q.term, error: (e as Error).message });
    }
  }
  return { processed: results.length, results };
}