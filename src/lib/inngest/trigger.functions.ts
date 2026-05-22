/**
 * Server functions pra acionar manualmente eventos Inngest a partir do admin.
 * Roda no servidor (acesso a LOVABLE_API_KEY / INNGEST_API_KEY via gateway).
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { sendInngestEvent } from "./client";

const BackfillSchema = z.object({
  days: z.number().int().min(1).max(180).default(180),
});

export const triggerBackfill = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => BackfillSchema.parse(input ?? {}))
  .handler(async ({ data }) => {
    await sendInngestEvent("crawler/backfill.start", { days: data.days });
    return { ok: true, dispatched: true, days: data.days };
  });

const M2aSchema = z.object({
  terms: z.array(z.string().min(1).max(120)).min(1).max(20),
  situacao: z.number().int().min(0).max(20).optional(),
  maxPages: z.number().int().min(1).max(10).optional(),
});

export const triggerM2aDiscover = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => M2aSchema.parse(input ?? {}))
  .handler(async ({ data }) => {
    for (const term of data.terms) {
      await sendInngestEvent("crawler/m2a.discover", {
        search: term,
        situacao: data.situacao ?? 7,
        maxPages: data.maxPages ?? 3,
      });
    }
    return { ok: true, dispatched: data.terms.length };
  });