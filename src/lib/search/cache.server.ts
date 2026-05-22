/**
 * Cache do searchPrices em quote_searches + quote_items.
 * Extraído de search.functions.ts para isolar do entrypoint do serverFn.
 */
import type { PriceResult, SearchSourceStatus } from "../types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { classifyTriad } from "../extract/triad";

export const asJson = <T,>(v: T): Json => v as unknown as Json;


// ============================================================
// CACHE — quote_searches + quote_items
// ============================================================
// Janela de frescor padrão: 24h. Resultados mais novos são servidos do cache
// imediatamente; resultados velhos ainda são servidos do cache mas a UI
// dispara um refresh em background.
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function normalizeQueryNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function filtersHash(d: {
  uf?: string; modalidade?: string; unidade?: string;
  apenasHomologados?: boolean; valorMin?: number; valorMax?: number;
  mode?: string; keywords?: string[]; pagina?: number; tema?: string;
}): string {
  return JSON.stringify({
    uf: d.uf ?? null,
    modalidade: d.modalidade ?? null,
    unidade: d.unidade ?? null,
    apenasHomologados: !!d.apenasHomologados,
    valorMin: d.valorMin ?? null,
    valorMax: d.valorMax ?? null,
    mode: d.mode ?? "semantic",
    keywords: (d.keywords ?? []).slice().sort(),
    pagina: d.pagina ?? 1,
    tema: d.tema ?? null,
  });
}

export async function readCachedSearch(
  query_norm: string,
  filters_hash: string,
): Promise<{ search: {
  id: string; computed_at: string; fresh_until: string;
  sources: SearchSourceStatus[] | null; took_ms: number;
}; results: PriceResult[] } | null> {
  try {
    const { data: search, error } = await supabaseAdmin
      .from("quote_searches")
      .select("id, computed_at, fresh_until, sources, took_ms")
      .eq("query_norm", query_norm)
      .eq("filters_hash", filters_hash)
      .maybeSingle();
    if (error || !search) return null;
    const { data: items } = await supabaseAdmin
      .from("quote_items")
      .select("payload")
      .eq("search_id", search.id)
      .order("score_final", { ascending: false })
      .limit(500);
    const results = (items ?? [])
      .map((r) => r.payload as unknown as PriceResult)
      .filter((r) => r && typeof r === "object" && r.id);
    return {
      search: search as {
        id: string; computed_at: string; fresh_until: string;
        sources: SearchSourceStatus[] | null; took_ms: number;
      },
      results,
    };
  } catch (e) {
    console.warn("readCachedSearch failed", (e as Error).message);
    return null;
  }
}

export async function writeCachedSearch(opts: {
  query_norm: string;
  query_raw: string;
  filters_hash: string;
  filters: Record<string, unknown>;
  sources: SearchSourceStatus[];
  tookMs: number;
  results: PriceResult[];
}): Promise<void> {
  try {
    const { data: search, error } = await supabaseAdmin
      .from("quote_searches")
      .upsert(
        {
          query_norm: opts.query_norm,
          query_raw: opts.query_raw.slice(0, 500),
          filters_hash: opts.filters_hash,
          filters: asJson(opts.filters),
          total: opts.results.length,
          took_ms: opts.tookMs,
          sources: asJson(opts.sources),
          computed_at: new Date().toISOString(),
          fresh_until: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        },
        { onConflict: "query_norm,filters_hash" },
      )
      .select("id")
      .single();
    if (error || !search) {
      console.warn("write quote_searches err", error?.message);
      return;
    }
    await supabaseAdmin.from("quote_items").delete().eq("search_id", search.id);
    const rows = opts.results.slice(0, 500).map((r) => {
      const triad = classifyTriad({
        quantidade: r.quantidade ?? null,
        valor: r.valor ?? null,
        valor_total: r.valorTotal ?? null,
      });
      // Espelha de volta no payload pra UI ler sem nova query
      r.mathStatus = triad.math_status;
      r.extractionQuality = triad.extraction_quality;
      r.valorTotalCalculado = triad.valor_total_calculado;
      r.mathDeltaPct = triad.math_delta_pct;
      return {
      fingerprint: `${opts.query_norm}|${r.id}`.slice(0, 240),
      search_id: search.id,
      query_norm: opts.query_norm,
      titulo: (r.titulo || "").slice(0, 500),
      objeto_estruturado: (r.objetoEstruturado || r.titulo || "").slice(0, 240),
      descricao: (r.descricao || "").slice(0, 3000),
      unidade: r.unidade ?? null,
      quantidade: r.quantidade ?? null,
      valor: r.valor ?? null,
      valor_total: r.valorTotal ?? null,
      valor_total_calculado: triad.valor_total_calculado,
      math_status: triad.math_status,
      math_delta_pct: triad.math_delta_pct,
      extraction_quality: triad.extraction_quality,
      valor_tipo: r.valorTipo ?? null,
      fornecedor: r.fornecedor ?? null,
      cnpj: r.cnpj ?? null,
      orgao: r.orgao ?? null,
      municipio: r.municipio ?? null,
      uf: r.uf ?? null,
      data:
        r.data && /^\d{4}-\d{2}-\d{2}/.test(r.data) ? r.data.slice(0, 10) : null,
      modalidade: r.modalidade ?? null,
      homologado: !!r.homologado,
      origem: r.origem ?? null,
      url: r.url ?? null,
      documento: r.documento ?? null,
      score_final: r.scoreFinal ?? null,
      payload: asJson(r),
      source_payload_raw: asJson({
        url: r.url ?? null,
        origem: r.origem ?? null,
        numero: r.numero ?? null,
        ano: r.ano ?? null,
      }),
      source_excerpt: (r.descricao ?? "").slice(0, 1000),
      };
    });
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error: e2 } = await supabaseAdmin
        .from("quote_items")
        .upsert(chunk, { onConflict: "fingerprint" });
      if (e2) console.warn("write quote_items err", e2.message);
    }
    console.info(
      `[cache] wrote search id=${search.id} items=${rows.length} q="${opts.query_raw.slice(0, 60)}"`,
    );
  } catch (e) {
    console.warn("writeCachedSearch failed", (e as Error).message);
  }
}
