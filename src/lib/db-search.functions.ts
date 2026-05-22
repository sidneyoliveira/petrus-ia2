import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PriceResult } from "./types";

function normalizeQueryNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Busca itens já gravados no banco que casem (fuzzy) com a query.
 *  Não chama fontes externas. Útil pra exibir resultados instantâneos do cache cruzado. */
export const searchDbItems = createServerFn({ method: "POST" })
  .inputValidator((d: { query: string; limit?: number }) =>
    z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const qn = normalizeQueryNorm(data.query);
    const limit = data.limit ?? 30;
    const tokens = qn.split(/\s+/).filter(Boolean).slice(0, 6);
    if (tokens.length === 0) return { results: [] as PriceResult[] };

    // Match exato no query_norm (prioridade máxima)
    const { data: exact } = await supabaseAdmin
      .from("quote_items")
      .select("payload, updated_at, query_norm")
      .eq("query_norm", qn)
      .order("updated_at", { ascending: false })
      .limit(limit);

    // Match parcial: ILIKE no título/query_norm com cada token
    const orClauses = tokens
      .map((t) => `titulo.ilike.%${t}%,query_norm.ilike.%${t}%`)
      .join(",");
    const { data: fuzzy } = await supabaseAdmin
      .from("quote_items")
      .select("payload, updated_at, query_norm")
      .or(orClauses)
      .order("updated_at", { ascending: false })
      .limit(limit);

    const seen = new Set<string>();
    const out: PriceResult[] = [];
    for (const row of [...(exact ?? []), ...(fuzzy ?? [])]) {
      const r = row.payload as unknown as PriceResult;
      if (!r || typeof r !== "object" || !r.id) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      // Marca origem
      const enriched: PriceResult = {
        ...r,
        origem: r.origem || "Banco local",
      };
      out.push(enriched);
      if (out.length >= limit) break;
    }
    return { results: out };
  });