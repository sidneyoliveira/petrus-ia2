import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { PriceResult } from "./types";

/** Busca itens já gravados no banco que casem com a query usando full-text
 *  search em português (tsvector via search_quote_items_fts). Fallback ILIKE
 *  só se o FTS não retornar nada (queries muito curtas ou termos raros).
 *  Não chama fontes externas — serve o cache cruzado de forma instantânea. */
export const searchDbItems = createServerFn({ method: "POST" })
  .inputValidator((d: { query: string; limit?: number }) =>
    z.object({ query: z.string().trim().min(1).max(200), limit: z.number().int().min(1).max(200).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const limit = data.limit ?? 30;
    const q = data.query.trim();
    if (!q) return { results: [] as PriceResult[] };

    // FTS via RPC — usa tsvector (português, unaccent, pesos A/B/C/D)
    const { data: fts, error } = await supabaseAdmin.rpc("search_quote_items_fts", {
      _query: q,
      _limit: limit,
    });

    const rows = error ? [] : (fts ?? []);

    // Fallback ILIKE somente se FTS vazio (tokens muito raros ou < 3 chars)
    let fallback: Array<{ payload: unknown }> = [];
    if (rows.length === 0) {
      const token = q.toLowerCase().replace(/[^a-z0-9]/g, " ").trim().split(/\s+/)[0];
      if (token && token.length >= 2) {
        const { data: ilike } = await supabaseAdmin
          .from("quote_items")
          .select("payload, updated_at")
          .ilike("titulo", `%${token}%`)
          .order("updated_at", { ascending: false })
          .limit(limit);
        fallback = ilike ?? [];
      }
    }

    const seen = new Set<string>();
    const out: PriceResult[] = [];
    for (const row of [...rows, ...fallback]) {
      const r = (row as { payload: unknown }).payload as PriceResult;
      if (!r || typeof r !== "object" || !r.id) continue;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ ...r, origem: r.origem || "Banco local", fromLocalDb: true });
      if (out.length >= limit) break;
    }
    return { results: out };
  });