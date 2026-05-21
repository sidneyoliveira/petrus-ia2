import { supabaseAdmin } from "@/integrations/supabase/client.server";

const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 768;
const BATCH_SIZE = 32;
const MAX_PER_RUN = 96;

interface PendingRow {
  id: string;
  titulo: string | null;
  descricao: string | null;
  source_excerpt: string | null;
}

function buildInput(r: PendingRow): string {
  const parts = [r.titulo, r.descricao, r.source_excerpt]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  const joined = parts.join("\n").slice(0, 4000);
  return joined || (r.titulo ?? "item");
}

async function embedBatch(texts: string[], apiKey: string): Promise<number[][] | null> {
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMS }),
    });
    if (!res.ok) {
      console.warn("[embedder] HTTP", res.status, await res.text().catch(() => ""));
      return null;
    }
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    const vecs = (data.data ?? []).map((d) => d.embedding);
    return vecs.length === texts.length ? vecs : null;
  } catch (e) {
    console.warn("[embedder] error", (e as Error).message);
    return null;
  }
}

async function fetchPending(searchId?: string): Promise<PendingRow[]> {
  let q = supabaseAdmin
    .from("quote_items")
    .select("id,titulo,descricao,source_excerpt")
    .is("embedding", null)
    .or("embedding_status.is.null,embedding_status.eq.pending")
    .order("created_at", { ascending: false })
    .limit(MAX_PER_RUN);
  if (searchId) q = q.eq("search_id", searchId);
  const { data, error } = await q;
  if (error) {
    console.warn("[embedder] fetchPending err", error.message);
    return [];
  }
  return (data ?? []) as PendingRow[];
}

/**
 * Gera embeddings (vetor 768d) para itens pendentes em `quote_items`.
 * Persistido na coluna `embedding` (pgvector) para habilitar RAG e
 * busca semântica via RPC `match_quote_items`.
 */
export async function embedQuoteItemsBackground(searchId?: string): Promise<void> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) {
    console.warn("[embedder] LOVABLE_API_KEY missing, skipping");
    return;
  }
  const pending = await fetchPending(searchId);
  if (pending.length === 0) return;

  console.info(`[embedder] embedding ${pending.length} items (search=${searchId ?? "global"})`);

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const chunk = pending.slice(i, i + BATCH_SIZE);
    const inputs = chunk.map(buildInput);
    const vecs = await embedBatch(inputs, apiKey);
    if (!vecs) {
      // marca falha pra evitar reprocessar em loop
      await supabaseAdmin
        .from("quote_items")
        .update({ embedding_status: "failed", embedding_at: new Date().toISOString() })
        .in("id", chunk.map((r) => r.id));
      continue;
    }
    // pgvector aceita literal string `[a,b,c]` via supabase-js
    await Promise.all(
      chunk.map((row, idx) =>
        supabaseAdmin
          .from("quote_items")
          .update({
            // @ts-expect-error pgvector column accepts number[] via supabase-js
            embedding: vecs[idx],
            embedding_status: "ok",
            embedding_at: new Date().toISOString(),
          })
          .eq("id", row.id),
      ),
    );
  }
  console.info(`[embedder] done (search=${searchId ?? "global"})`);
}

/**
 * Busca semântica (RAG) sobre TODO o histórico de `quote_items` já indexado.
 * Usado pra trazer cotações similares mesmo quando a query não bate
 * exatamente nas fontes ao vivo.
 */
export async function ragSearch(
  queryText: string,
  matchCount = 20,
  minSimilarity = 0.55,
): Promise<Array<Record<string, unknown>>> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || !queryText.trim()) return [];
  const vecs = await embedBatch([queryText.slice(0, 1000)], apiKey);
  if (!vecs || !vecs[0]) return [];
  const { data, error } = await supabaseAdmin.rpc("match_quote_items", {
    // @ts-expect-error pgvector vector(768) accepts number[]
    query_embedding: vecs[0],
    match_count: matchCount,
    min_similarity: minSimilarity,
  });
  if (error) {
    console.warn("[rag] match_quote_items err", error.message);
    return [];
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}