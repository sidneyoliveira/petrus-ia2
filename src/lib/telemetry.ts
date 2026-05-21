import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Registra telemetria por fonte por busca em public.source_runs.
 * Fire-and-forget — nunca bloqueia ou derruba a busca.
 */
export interface SourceRunInput {
  searchId?: string | null;
  sourceId: string;
  status: "ok" | "error" | "timeout" | "empty";
  count?: number;
  tookMs?: number;
  error?: string | null;
}

export async function logSourceRun(input: SourceRunInput): Promise<void> {
  try {
    await supabaseAdmin.from("source_runs").insert({
      search_id: input.searchId ?? null,
      source_id: input.sourceId.slice(0, 60),
      status: input.status,
      count: input.count ?? 0,
      took_ms: input.tookMs ?? 0,
      error: input.error ? input.error.slice(0, 500) : null,
    });
  } catch (e) {
    console.warn("logSourceRun failed", (e as Error).message);
  }
}

export async function logSourceRunsBatch(rows: SourceRunInput[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await supabaseAdmin.from("source_runs").insert(
      rows.map((r) => ({
        search_id: r.searchId ?? null,
        source_id: r.sourceId.slice(0, 60),
        status: r.status,
        count: r.count ?? 0,
        took_ms: r.tookMs ?? 0,
        error: r.error ? r.error.slice(0, 500) : null,
      })),
    );
  } catch (e) {
    console.warn("logSourceRunsBatch failed", (e as Error).message);
  }
}

/**
 * Wrapper para promessas de fonte: mede tempo, captura erro, devolve o resultado original.
 * O log final é acumulado pelo chamador (que conhece o search_id depois do upsert).
 */
export async function trackSource<T>(
  sourceId: string,
  task: Promise<T>,
): Promise<{ sourceId: string; status: SourceRunInput["status"]; tookMs: number; error?: string; value?: T }> {
  const t0 = Date.now();
  try {
    const value = await task;
    const tookMs = Date.now() - t0;
    const count = Array.isArray(value) ? value.length : value ? 1 : 0;
    return {
      sourceId,
      status: count === 0 ? "empty" : "ok",
      tookMs,
      value,
    };
  } catch (e) {
    return {
      sourceId,
      status: "error",
      tookMs: Date.now() - t0,
      error: (e as Error).message,
    };
  }
}