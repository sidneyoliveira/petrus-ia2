import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ============================================================
// Self-Healing — valor global → valor unitário (Rodada 2)
// ============================================================
// Quando um item é persistido sem `valor` (unitário) mas com `valor_total`,
// passamos o `source_excerpt` para o Lovable AI Gateway e tentamos inferir
// quantidade + unidade + valor unitário. Roda em background, sem bloquear o
// retorno da busca, e marca o status para não reprocessar o mesmo item.
//
// Rodada D-final: injeta como few-shot as correções humanas mais similares
// (mesmo domínio + mesma query) gravadas em `extraction_corrections`.

const MODEL = "google/gemini-3-flash-preview";
const MAX_ITEMS_PER_RUN = 15;
const MIN_EXCERPT_LEN = 40;
const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 768;
const FEWSHOT_LIMIT = 3;

interface HealCandidate {
  id: string;
  titulo: string | null;
  descricao: string | null;
  unidade: string | null;
  quantidade: number | null;
  valor_total: number | null;
  source_excerpt: string | null;
  url?: string | null;
  query_norm?: string | null;
}

interface InferredValue {
  quantidade: number | null;
  unidade: string | null;
  valor_unitario: number | null;
  confianca: number; // 0..1
  motivo: string;
}

const TOOL = {
  type: "function" as const,
  function: {
    name: "registrar_valor_unitario",
    description:
      "Registra a inferência de valor unitário a partir do trecho original. " +
      "Use confianca >= 0.7 apenas quando quantidade e unidade estão claras no texto.",
    parameters: {
      type: "object",
      properties: {
        quantidade: {
          type: ["number", "null"],
          description: "Quantidade comprada do item (apenas o número).",
        },
        unidade: {
          type: ["string", "null"],
          description: "Unidade de medida (UN, KG, L, M, CX, etc).",
        },
        valor_unitario: {
          type: ["number", "null"],
          description:
            "Valor unitário em reais. Se o texto traz apenas valor_total e " +
            "quantidade, calcule valor_total / quantidade.",
        },
        confianca: {
          type: "number",
          description: "0 a 1. 1 = trecho mostra explicitamente o unitário.",
        },
        motivo: {
          type: "string",
          description: "Justificativa curta (até 140 chars) do que foi inferido.",
        },
      },
      required: ["quantidade", "unidade", "valor_unitario", "confianca", "motivo"],
      additionalProperties: false,
    },
  },
};

async function inferOne(
  item: HealCandidate,
  apiKey: string,
  fewshot: string,
): Promise<InferredValue | null> {
  const excerpt = (item.source_excerpt ?? "").slice(0, 2000);
  if (excerpt.length < MIN_EXCERPT_LEN) return null;

  const system =
    "Você é um auditor de compras públicas brasileiras. Sua tarefa é, a partir " +
    "de um trecho de edital/ata/contrato, extrair o VALOR UNITÁRIO de um item " +
    "quando só temos o valor global. Seja conservador: se não tiver certeza, " +
    "use confianca baixa (< 0.5) e valor_unitario null.";

  const user = [
    fewshot,
    `Item: ${item.titulo ?? "(sem título)"}`,
    item.descricao ? `Descrição: ${item.descricao.slice(0, 300)}` : "",
    item.unidade ? `Unidade conhecida: ${item.unidade}` : "",
    item.quantidade != null ? `Quantidade conhecida: ${item.quantidade}` : "",
    item.valor_total != null ? `Valor TOTAL conhecido: R$ ${item.valor_total}` : "",
    "",
    "Trecho original:",
    excerpt,
  ]
    .filter(Boolean)
    .join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        tools: [TOOL],
        tool_choice: {
          type: "function",
          function: { name: "registrar_valor_unitario" },
        },
      }),
    });
    if (!res.ok) {
      console.warn(
        "[heal] gateway error",
        res.status,
        await res.text().catch(() => ""),
      );
      return null;
    }
    const data = (await res.json()) as {
      choices?: Array<{
        message?: {
          tool_calls?: Array<{ function?: { arguments?: string } }>;
        };
      }>;
    };
    const args =
      data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return null;
    const parsed = JSON.parse(args) as Partial<InferredValue>;
    return {
      quantidade:
        typeof parsed.quantidade === "number" ? parsed.quantidade : null,
      unidade: typeof parsed.unidade === "string" ? parsed.unidade : null,
      valor_unitario:
        typeof parsed.valor_unitario === "number" ? parsed.valor_unitario : null,
      confianca:
        typeof parsed.confianca === "number"
          ? Math.max(0, Math.min(1, parsed.confianca))
          : 0,
      motivo: String(parsed.motivo ?? "").slice(0, 200),
    };
  } catch (e) {
    console.warn("[heal] infer error", (e as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function embedQuery(text: string, apiKey: string): Promise<number[] | null> {
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EMBED_MODEL,
        input: [text.slice(0, 2000)],
        dimensions: EMBED_DIMS,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

async function buildFewshot(item: HealCandidate, apiKey: string): Promise<string> {
  const domain = domainOf(item.url);
  const probe = [item.titulo, item.descricao, item.query_norm].filter(Boolean).join(" ").trim();
  if (!probe) return "";
  const emb = await embedQuery(probe, apiKey);
  if (!emb) return "";

  // 1ª tentativa: mesmo domínio
  let rows: Array<{
    field: string; value_before: string | null; value_after: string;
    source_excerpt: string | null; user_note: string | null; similarity: number;
  }> = [];
  if (domain) {
    const { data } = await supabaseAdmin.rpc("match_corrections", {
      query_embedding: emb as unknown as never,
      match_count: FEWSHOT_LIMIT,
      min_similarity: 0.6,
      filter_domain: domain,
    });
    rows = (data ?? []) as typeof rows;
  }
  // 2ª tentativa: qualquer domínio
  if (rows.length === 0) {
    const { data } = await supabaseAdmin.rpc("match_corrections", {
      query_embedding: emb as unknown as never,
      match_count: FEWSHOT_LIMIT,
      min_similarity: 0.7,
      filter_domain: null,
    });
    rows = (data ?? []) as typeof rows;
  }
  if (rows.length === 0) return "";

  const lines = rows.map((r, i) => {
    const excerpt = (r.source_excerpt ?? "").slice(0, 400);
    return [
      `Correção humana #${i + 1} (similaridade ${(r.similarity * 100).toFixed(0)}%)`,
      `- Campo: ${r.field}`,
      r.value_before ? `- Valor errado (a evitar): ${r.value_before}` : "",
      `- Valor correto: ${r.value_after}`,
      r.user_note ? `- Observação: ${r.user_note}` : "",
      excerpt ? `- Trecho-fonte: ${excerpt}` : "",
    ].filter(Boolean).join("\n");
  });

  return [
    "EXEMPLOS DE CORREÇÕES HUMANAS ANTERIORES (use como referência para não repetir os mesmos erros):",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Processa um lote arbitrário de itens (usado pelo backfill).
 * Idempotente: pula itens que já têm `valor_inferido_status`.
 */
export async function healItemsBatch(
  list: HealCandidate[],
  apiKey: string,
): Promise<number> {
  if (list.length === 0) return 0;
  let processed = 0;
  const CONCURRENCY = 3;
  for (let i = 0; i < list.length; i += CONCURRENCY) {
    const chunk = list.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (item) => {
        const fewshot = await buildFewshot(item, apiKey);
        const inferred = await inferOne(item, apiKey, fewshot);
        const now = new Date().toISOString();
        if (!inferred) {
          await supabaseAdmin
            .from("quote_items")
            .update({
              valor_inferido_status: "failed",
              valor_inferido_at: now,
              valor_inferido_reason: "no_response",
            })
            .eq("id", item.id);
          return;
        }
        const ok =
          inferred.valor_unitario != null &&
          inferred.valor_unitario > 0 &&
          inferred.confianca >= 0.5;
        await supabaseAdmin
          .from("quote_items")
          .update({
            valor_inferido: ok ? inferred.valor_unitario : null,
            valor_inferido_confianca: inferred.confianca,
            valor_inferido_status: ok ? "ok" : "skipped",
            valor_inferido_at: now,
            valor_inferido_reason: inferred.motivo,
          })
          .eq("id", item.id);
        processed += 1;
      }),
    );
  }
  return processed;
}

/**
 * Roda em background depois de uma busca: pega itens da busca atual que
 * não têm valor unitário e tenta inferir via Lovable AI. Tolerante a falhas.
 */
export async function healValuesBackground(
  searchId: string | null,
): Promise<void> {
  if (!searchId) return;
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[heal] LOVABLE_API_KEY missing — skip self-healing");
    return;
  }

  try {
    // Candidatos: itens sem valor unitário OU itens cuja matemática divergiu
    // (Qtd × Unitário ≠ Total > 2%) e que ainda não foram processados pelo healer.
    const { data: candidates, error } = await supabaseAdmin
      .from("quote_items")
      .select(
        "id, titulo, descricao, unidade, quantidade, valor_total, source_excerpt, url, query_norm",
      )
      .eq("search_id", searchId)
      .is("valor_inferido_status", null)
      .not("source_excerpt", "is", null)
      .or("valor.is.null,math_status.eq.divergente")
      .not("valor_total", "is", null)
      .limit(MAX_ITEMS_PER_RUN);

    if (error) {
      console.warn("[heal] select failed", error.message);
      return;
    }
    const list = (candidates ?? []) as HealCandidate[];
    if (list.length === 0) return;
    console.info(`[heal] processing ${list.length} item(s) for search ${searchId}`);
    await healItemsBatch(list, apiKey);
  } catch (e) {
    console.warn("[heal] background run failed", (e as Error).message);
  }
}