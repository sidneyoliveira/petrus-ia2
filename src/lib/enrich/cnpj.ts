import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Enriquecimento de CNPJ via BrasilAPI (gratuita, sem chave) com cache de 30 dias
 * em public.cnpj_cache. Fire-and-forget — falha silenciosa não bloqueia a busca.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface CnpjData {
  cnpj: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cnae_principal: string | null;
  cnae_descricao: string | null;
  situacao: string | null;
  uf: string | null;
  municipio: string | null;
  ativo: boolean | null;
}

function onlyDigits(s: string): string {
  return (s || "").replace(/\D/g, "");
}

export async function getCnpjCached(rawCnpj: string): Promise<CnpjData | null> {
  const cnpj = onlyDigits(rawCnpj);
  if (cnpj.length !== 14) return null;

  try {
    const { data: cached } = await supabaseAdmin
      .from("cnpj_cache")
      .select("*")
      .eq("cnpj", cnpj)
      .maybeSingle();
    if (cached) {
      const age = Date.now() - new Date(cached.fetched_at as string).getTime();
      if (age < TTL_MS) {
        return {
          cnpj,
          razao_social: cached.razao_social,
          nome_fantasia: cached.nome_fantasia,
          cnae_principal: cached.cnae_principal,
          cnae_descricao: cached.cnae_descricao,
          situacao: cached.situacao,
          uf: cached.uf,
          municipio: cached.municipio,
          ativo: cached.ativo,
        };
      }
    }
  } catch (e) {
    console.warn("cnpj_cache read err", (e as Error).message);
  }

  // Fetch BrasilAPI
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const payload = (await res.json()) as Record<string, unknown>;

    const norm: CnpjData = {
      cnpj,
      razao_social: (payload.razao_social as string) ?? null,
      nome_fantasia: (payload.nome_fantasia as string) ?? null,
      cnae_principal: (payload.cnae_fiscal as number | string)?.toString() ?? null,
      cnae_descricao: (payload.cnae_fiscal_descricao as string) ?? null,
      situacao: (payload.descricao_situacao_cadastral as string) ?? null,
      uf: (payload.uf as string) ?? null,
      municipio: (payload.municipio as string) ?? null,
      ativo: (payload.descricao_situacao_cadastral as string)?.toUpperCase() === "ATIVA",
    };

    await supabaseAdmin.from("cnpj_cache").upsert(
      { ...norm, payload: payload as never, fetched_at: new Date().toISOString() },
      { onConflict: "cnpj" },
    );
    return norm;
  } catch (e) {
    console.warn("BrasilAPI CNPJ fetch err", cnpj, (e as Error).message);
    return null;
  }
}

/**
 * Enriquece um conjunto de CNPJs únicos em paralelo. Limita concorrência a 5
 * pra não estourar rate limit da BrasilAPI.
 */
export async function enrichCnpjsBackground(cnpjs: string[]): Promise<void> {
  const unique = Array.from(new Set(cnpjs.map(onlyDigits).filter((c) => c.length === 14)));
  const CONCURRENCY = 5;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    const batch = unique.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map((c) => getCnpjCached(c)));
  }
}