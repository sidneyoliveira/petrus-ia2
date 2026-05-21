import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { classifyTriad } from "@/lib/extract/triad";

/**
 * Backfill — aplica `classifyTriad` em todos os `quote_items` antigos
 * que ainda não têm `math_status`/`extraction_quality` preenchidos.
 * Processamento em lote, idempotente.
 */

const BackfillSchema = z.object({
  batchSize: z.number().int().min(10).max(2000).default(500),
  maxBatches: z.number().int().min(1).max(50).default(20),
});

export const backfillTriad = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => BackfillSchema.parse(input ?? {}))
  .handler(async ({ data }) => {
    let totalScanned = 0;
    let totalUpdated = 0;
    const tally: Record<string, number> = {};

    for (let i = 0; i < data.maxBatches; i++) {
      const { data: rows, error } = await supabaseAdmin
        .from("quote_items")
        .select("id, quantidade, valor, valor_total, valor_inferido, valor_inferido_status")
        .is("math_status", null)
        .limit(data.batchSize);
      if (error) {
        return { ok: false as const, error: error.message, totalScanned, totalUpdated };
      }
      if (!rows || rows.length === 0) break;
      totalScanned += rows.length;

      // Update um-a-um (Supabase JS não tem bulk-update por id em uma chamada
      // sem upsert; mantemos simples e em paralelo com pequena concorrência).
      const CONCURRENCY = 8;
      for (let j = 0; j < rows.length; j += CONCURRENCY) {
        const chunk = rows.slice(j, j + CONCURRENCY);
        await Promise.all(
          chunk.map(async (r) => {
            // Se valor unitário veio só do healer, usa o inferido para a
            // classificação retroativa (mas não sobrescreve valor).
            const valorEfetivo =
              r.valor != null
                ? Number(r.valor)
                : r.valor_inferido_status === "ok" && r.valor_inferido != null
                ? Number(r.valor_inferido)
                : null;
            const res = classifyTriad({
              quantidade: r.quantidade != null ? Number(r.quantidade) : null,
              valor: valorEfetivo,
              valor_total: r.valor_total != null ? Number(r.valor_total) : null,
            });
            tally[res.extraction_quality] = (tally[res.extraction_quality] ?? 0) + 1;
            const { error: upErr } = await supabaseAdmin
              .from("quote_items")
              .update({
                math_status: res.math_status,
                extraction_quality: res.extraction_quality,
                valor_total_calculado: res.valor_total_calculado,
                math_delta_pct: res.math_delta_pct,
              })
              .eq("id", r.id);
            if (!upErr) totalUpdated += 1;
          }),
        );
      }

      if (rows.length < data.batchSize) break;
    }

    return { ok: true as const, totalScanned, totalUpdated, tally };
  });

/**
 * Backfill healer — pega itens antigos sem valor unitário (ou com matemática
 * divergente) que ainda não passaram pelo healer, e dispara a inferência.
 * Reusa exatamente a mesma lógica do background-heal, mas sem filtro de
 * `search_id`.
 */
const HealSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
});

export const backfillHeal = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => HealSchema.parse(input ?? {}))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { ok: false as const, error: "LOVABLE_API_KEY missing", processed: 0 };

    const { data: candidates, error } = await supabaseAdmin
      .from("quote_items")
      .select("id, titulo, descricao, unidade, quantidade, valor_total, source_excerpt, url, query_norm")
      .is("valor_inferido_status", null)
      .not("source_excerpt", "is", null)
      .or("valor.is.null,math_status.eq.divergente")
      .not("valor_total", "is", null)
      .limit(data.limit);

    if (error) return { ok: false as const, error: error.message, processed: 0 };
    const list = candidates ?? [];
    if (list.length === 0) return { ok: true as const, processed: 0, scanned: 0 };

    // Lazy-import para não trazer o healer (e seu peso) ao bundle do cliente.
    const { healItemsBatch } = await import("@/lib/heal/value-healer.server");
    const processed = await healItemsBatch(list, apiKey);
    return { ok: true as const, scanned: list.length, processed };
  });
