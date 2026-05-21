import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const EMBED_MODEL = "google/gemini-embedding-001";
const EMBED_DIMS = 768;

function normalize(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 8)
    .join(" ");
}

function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function embedOne(text: string): Promise<number[] | null> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: [text.slice(0, 4000)], dimensions: EMBED_DIMS }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

const FIELDS = [
  "valor",
  "valor_total",
  "quantidade",
  "unidade",
  "titulo",
  "descricao",
  "fornecedor",
  "orgao",
  "uf",
  "data",
  "outro",
] as const;

const CorrectionSchema = z.object({
  itemId: z.string().uuid().optional(),
  query: z.string().min(1).max(500),
  sourceUrl: z.string().max(2000).optional(),
  field: z.enum(FIELDS),
  valueBefore: z.string().max(2000).optional(),
  valueAfter: z.string().min(1).max(2000),
  sourceExcerpt: z.string().max(4000).optional(),
  userNote: z.string().max(2000).optional(),
});

export const submitCorrection = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CorrectionSchema.parse(input))
  .handler(async ({ data }) => {
    const domain = domainOf(data.sourceUrl);
    const embedInput = [
      data.query,
      data.field,
      data.valueAfter,
      data.userNote ?? "",
      data.sourceExcerpt ?? "",
    ]
      .filter(Boolean)
      .join("\n");
    const embedding = await embedOne(embedInput);

    const { error } = await supabaseAdmin.from("extraction_corrections").insert({
      item_id: data.itemId ?? null,
      query_norm: normalize(data.query),
      source_domain: domain,
      source_url: data.sourceUrl ?? null,
      field: data.field,
      value_before: data.valueBefore ?? null,
      value_after: data.valueAfter,
      source_excerpt: data.sourceExcerpt ?? null,
      user_note: data.userNote ?? null,
      embedding: embedding as unknown as never,
    });
    if (error) {
      console.error("[corrections] insert error", error);
      return { ok: false as const, error: error.message };
    }
    return { ok: true as const };
  });

const StatsSchema = z.object({ itemIds: z.array(z.string()).min(1).max(200) });

export const getCorrectionCounts = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => StatsSchema.parse(input))
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("extraction_corrections")
      .select("item_id")
      .in("item_id", data.itemIds);
    if (error) return { counts: {} as Record<string, number> };
    const counts: Record<string, number> = {};
    for (const r of rows ?? []) {
      if (!r.item_id) continue;
      counts[r.item_id] = (counts[r.item_id] ?? 0) + 1;
    }
    return { counts };
  });