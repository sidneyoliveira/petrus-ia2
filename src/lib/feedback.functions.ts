import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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

const FeedbackSchema = z.object({
  query: z.string().min(1).max(500),
  itemId: z.string().min(1).max(200),
  source: z.string().min(1).max(50),
  action: z.enum(["accept", "reject"]),
  reason: z.string().max(500).optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

export const submitFeedback = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => FeedbackSchema.parse(input))
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin.from("search_feedback").insert({
      query: data.query,
      query_norm: normalize(data.query),
      item_id: data.itemId,
      source: data.source,
      action: data.action,
      reason: data.reason ?? null,
      snapshot: data.snapshot ?? null,
    });
    if (error) {
      console.error("feedback insert error", error);
      return { ok: false as const, error: error.message };
    }
    return { ok: true as const };
  });

const StatsSchema = z.object({ itemIds: z.array(z.string()).min(1).max(100) });

export const getItemFeedbackStats = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => StatsSchema.parse(input))
  .handler(async ({ data }) => {
    const { data: rows, error } = await supabaseAdmin
      .from("search_feedback")
      .select("item_id, action")
      .in("item_id", data.itemIds);
    if (error) return { stats: {} as Record<string, { accepts: number; rejects: number }> };
    const map: Record<string, { accepts: number; rejects: number }> = {};
    for (const r of rows ?? []) {
      const k = r.item_id;
      if (!map[k]) map[k] = { accepts: 0, rejects: 0 };
      if (r.action === "accept") map[k].accepts++;
      else map[k].rejects++;
    }
    return { stats: map };
  });