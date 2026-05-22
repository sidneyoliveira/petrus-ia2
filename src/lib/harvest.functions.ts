import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { searchPrices } from "./search.functions";

async function requireAdmin(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Acesso negado: requer papel admin");
}

export const listHarvestQueries = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("harvest_queries")
      .select("*")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { queries: data ?? [] };
  });

export const addHarvestQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { term: string; priority?: number }) =>
    z.object({ term: z.string().trim().min(1).max(120), priority: z.number().int().min(0).max(100).optional() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("harvest_queries")
      .insert({ term: data.term, priority: data.priority ?? 50, created_by: context.userId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleHarvestQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string; enabled: boolean }) =>
    z.object({ id: z.string().uuid(), enabled: z.boolean() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { error } = await supabaseAdmin
      .from("harvest_queries")
      .update({ enabled: data.enabled, updated_at: new Date().toISOString() })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteHarvestQuery = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { error } = await supabaseAdmin.from("harvest_queries").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listHarvestRuns = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const { data, error } = await supabaseAdmin
      .from("harvest_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { runs: data ?? [] };
  });

export const runHarvestNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { data: q, error } = await supabaseAdmin
      .from("harvest_queries")
      .select("id, term")
      .eq("id", data.id)
      .maybeSingle();
    if (error || !q) throw new Error("Query not found");
    return runHarvestForTerm(q.id, q.term);
  });

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
      .update({ last_run_at: new Date().toISOString(), total_found: persisted, updated_at: new Date().toISOString() })
      .eq("id", queryId);
    if (runId) {
      await supabaseAdmin
        .from("harvest_runs")
        .update({ finished_at: new Date().toISOString(), items_persisted: persisted, status: "ok" })
        .eq("id", runId);
    }
    return { ok: true, persisted };
  } catch (e) {
    const msg = (e as Error).message;
    if (runId) {
      await supabaseAdmin
        .from("harvest_runs")
        .update({ finished_at: new Date().toISOString(), status: "error", error: msg.slice(0, 500) })
        .eq("id", runId);
    }
    throw e;
  }
}