import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const colorRe = /^#[0-9a-fA-F]{6}$/;

const ThemeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: z.string().regex(colorRe).default("#10b981"),
  icon: z.string().trim().max(40).nullable().optional(),
});

export const listThemes = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("search_themes")
      .select("id, name, color, icon, created_at, updated_at")
      .order("name", { ascending: true });
    if (error) throw new Error(error.message);
    return { themes: data ?? [] };
  });

export const createTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => ThemeInputSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { data: row, error } = await context.supabase
      .from("search_themes")
      .insert({
        user_id: context.userId,
        name: data.name,
        color: data.color,
        icon: data.icon ?? null,
      })
      .select("id, name, color, icon, created_at, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const updateTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ id: z.string().uuid() })
      .merge(ThemeInputSchema.partial())
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.color !== undefined) patch.color = data.color;
    if (data.icon !== undefined) patch.icon = data.icon;
    const { data: row, error } = await context.supabase
      .from("search_themes")
      .update(patch)
      .eq("id", data.id)
      .select("id, name, color, icon, updated_at")
      .single();
    if (error) throw new Error(error.message);
    return row;
  });

export const deleteTheme = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("search_themes")
      .delete()
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });