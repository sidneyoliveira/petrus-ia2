/**
 * Stream de busca via Server-Sent Events.
 *
 * O serverFn `searchPrices` espera TODAS as fontes terminarem antes de
 * devolver qualquer item (até 5 min). Esta rota faz a MESMA orquestração
 * mas empurra parciais ao navegador conforme cada fonte responde:
 *
 *   event: source     -> {name, status, count}
 *   event: snapshot   -> {items: PriceResult[], total, sources}
 *   event: done       -> SearchResponse final + tookMs
 *   event: error      -> {message}
 *
 * Cache + telemetria + enrich /itens continuam idênticos ao serverFn.
 */
import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import type { PriceResult, SearchResponse } from "@/lib/types";
import {
  normalizeQueryNorm,
  filtersHash,
  readCachedSearch,
  writeCachedSearch,
} from "@/lib/search/cache.server";
import {
  FORBIDDEN,
  looksLikeMultiItem,
  looksLikeRawDocumentText,
  looksLikeProcessObject,
  tokenize,
  jaccard,
  cosine,
  getEmbeddings,
  fetchPNCP,
  fetchM2A,
  fetchPortalComprasPublicas,
  enrichWithPNCPItems,
  fetchComprasGov,
  fetchTransparencia,
  fetchTCECE,
  expandQuery,
  fetchFirecrawlWeb,
  fetchFirecrawlPerDomain,
  fetchFirecrawlSuppliers,
  mineAttachments,
  minePortais,
  loadActiveSources,
  isGranularItemResult,
  summarizeSources,
  toResult,
  applyJuridicScore,
  type RawItem,
} from "@/lib/search/pipeline.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const FilterSchema = z.object({
  query: z.string().trim().min(1).max(200),
  tema: z.string().trim().min(1).max(120).optional(),
  uf: z.string().optional(),
  modalidade: z.string().optional(),
  unidade: z.string().optional(),
  apenasHomologados: z.boolean().optional(),
  ultimosMeses: z.number().int().min(1).max(36).optional(),
  valorMin: z.number().optional(),
  valorMax: z.number().optional(),
  pagina: z.number().int().min(1).max(50).optional(),
  keywords: z.array(z.string().min(1).max(60)).max(20).optional(),
  mode: z.enum(["semantic", "exact", "all_keywords"]).optional(),
  forceRefresh: z.boolean().optional(),
});

type Filters = z.infer<typeof FilterSchema>;

/**
 * Rank "leve" para snapshots intermediários: dedupe + toResult + Jaccard +
 * jurídico + flags básicas. SEM embeddings (caro) e SEM learning boost.
 * O snapshot final (`done`) usa o ranking pesado completo.
 */
function lightRank(
  raw: RawItem[],
  filters: Filters,
): PriceResult[] {
  // dedupe raw
  const seenRaw = new Set<string>();
  const dedupRaw = raw.filter((r) => {
    const k = `${r.orgao_cnpj ?? ""}|${r.ano ?? ""}|${r.numero ?? ""}|${(r.title ?? "").slice(0, 60)}`;
    if (seenRaw.has(k)) return false;
    seenRaw.add(k);
    return true;
  });

  let results = dedupRaw.map(toResult);
  const ultimosMeses = filters.ultimosMeses ?? 12;

  // flags + penalidades suaves
  const softPenalty = new Map<string, number>();
  const addPen = (id: string, p: number) =>
    softPenalty.set(id, (softPenalty.get(id) ?? 0) + p);

  for (const r of results) {
    const blobTitle = `${r.titulo} ${r.descricao}`;
    if (looksLikeRawDocumentText(r.titulo) && looksLikeRawDocumentText(r.descricao)) addPen(r.id, 0.25);
    if (looksLikeProcessObject(r.titulo) || looksLikeProcessObject(r.descricao)) addPen(r.id, 0.15);
    if (looksLikeMultiItem(blobTitle)) addPen(r.id, 0.2);
    if (typeof r.valor !== "number") addPen(r.id, 0.15);
    if (r.valorTipo === "global") addPen(r.id, 0.2);
  }

  // dedupe cruzada por url/titulo/valor
  const seen = new Set<string>();
  results = results.filter((r) => {
    const k = `${r.url || r.origem}|${r.titulo}|${r.valor ?? ""}|${r.quantidade ?? ""}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // forbidden
  results = results.filter((r) => {
    const blob = `${r.titulo} ${r.descricao} ${r.url ?? ""}`.toLowerCase();
    return !FORBIDDEN.some((f) => blob.includes(f));
  });

  // se há granulares, prefere
  const granular = results.filter(isGranularItemResult);
  if (granular.length > 0) results = granular;

  // filtros como sinais suaves
  if (filters.uf) {
    const uf = filters.uf.toUpperCase();
    for (const r of results) if ((r.uf ?? "").toUpperCase() !== uf) addPen(r.id, 0.15);
  }
  if (filters.modalidade) {
    const md = filters.modalidade.toLowerCase();
    for (const r of results) if (!(r.modalidade ?? "").toLowerCase().includes(md)) addPen(r.id, 0.1);
  }
  if (filters.unidade) {
    const un = filters.unidade.toLowerCase();
    for (const r of results) if (!(r.unidade ?? "").toLowerCase().includes(un)) addPen(r.id, 0.1);
  }
  if (filters.apenasHomologados) {
    for (const r of results) if (!r.homologado) addPen(r.id, 0.2);
  }
  if (typeof filters.valorMin === "number") {
    for (const r of results) if ((r.valor ?? 0) < filters.valorMin) addPen(r.id, 0.15);
  }
  if (typeof filters.valorMax === "number") {
    for (const r of results) if ((r.valor ?? Infinity) > filters.valorMax) addPen(r.id, 0.15);
  }

  const qTokens = tokenize(filters.query);
  results = results
    .map((r) => ({ ...r, scoreTextual: jaccard(qTokens, tokenize(`${r.titulo} ${r.descricao}`)) }))
    .map((r) => applyJuridicScore(r, ultimosMeses))
    .map((r) => ({ ...r, scoreGeografico: r.uf ? 0.6 : 0.4 }))
    .map((r) => {
      const penalty = softPenalty.get(r.id) ?? 0;
      const base =
        0.35 * r.scoreSemantico +
        0.2 * r.scoreTextual +
        0.25 * r.scoreJuridico +
        0.1 * r.scoreGeografico +
        0.1 * r.scoreTecnico;
      const final = Math.max(0, base - penalty);
      return { ...r, scoreFinal: Math.round(final * 1000) / 1000 };
    });

  results.sort((a, b) => b.scoreFinal - a.scoreFinal);
  return results;
}

/**
 * Ranking PESADO final — embeddings + learning boost. Executado uma vez
 * ao final, antes do evento `done`.
 */
async function heavyRank(
  base: PriceResult[],
  filters: Filters,
  apiKey: string | undefined,
): Promise<PriceResult[]> {
  let results = base;

  // embeddings (top 30)
  const topForEmbed = results.slice(0, 30);
  if (apiKey && topForEmbed.length > 0) {
    try {
      const inputs = [filters.query, ...topForEmbed.map((r) => `${r.titulo}. ${r.descricao}`.slice(0, 800))];
      const embs = await getEmbeddings(inputs, apiKey);
      if (embs.length === inputs.length) {
        const qVec = embs[0];
        topForEmbed.forEach((r, i) => {
          r.scoreSemantico = Math.max(0, cosine(qVec, embs[i + 1]));
          r.scoreTecnico = 0.6 * r.scoreSemantico + 0.4 * r.scoreTextual;
        });
        // recalcula final dos top 30
        results = results.map((r, i) => {
          if (i >= 30) return r;
          const base =
            0.35 * r.scoreSemantico +
            0.2 * r.scoreTextual +
            0.25 * r.scoreJuridico +
            0.1 * r.scoreGeografico +
            0.1 * r.scoreTecnico;
          return { ...r, scoreFinal: Math.round(Math.max(0, base) * 1000) / 1000 };
        });
        results.sort((a, b) => b.scoreFinal - a.scoreFinal);
      }
    } catch (e) {
      console.warn("[stream] embeddings failed", (e as Error).message);
    }
  }

  // learning boost
  try {
    const qNorm = tokenize(filters.query).slice(0, 8).join(" ");
    if (qNorm) {
      const { data: fb } = await supabaseAdmin
        .from("search_feedback")
        .select("item_id, action")
        .eq("query_norm", qNorm)
        .limit(500);
      if (fb && fb.length > 0) {
        const score = new Map<string, number>();
        for (const row of fb) {
          const delta = row.action === "accept" ? 0.05 : -0.08;
          score.set(row.item_id, (score.get(row.item_id) ?? 0) + delta);
        }
        results = results.map((r) => {
          const delta = score.get(r.id);
          if (!delta) return r;
          const adj = Math.max(0, Math.min(1, r.scoreFinal + delta));
          return { ...r, scoreFinal: Math.round(adj * 1000) / 1000 };
        });
        results.sort((a, b) => b.scoreFinal - a.scoreFinal);
      }
    }
  } catch (e) {
    console.warn("[stream] learning boost skipped:", (e as Error).message);
  }

  return results;
}

function sseEncode(event: string, data: unknown): Uint8Array {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

export const Route = createFileRoute("/api/public/search/stream")({
  server: {
    handlers: {
      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        }),
      POST: async ({ request }) => {
        let filters: Filters;
        try {
          const body = await request.json();
          filters = FilterSchema.parse(body);
        } catch (e) {
          return new Response(
            JSON.stringify({ error: (e as Error).message }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const t0 = Date.now();
        const apiKey = process.env.LOVABLE_API_KEY;
        const pagina = filters.pagina ?? 1;

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const safeEnqueue = (event: string, data: unknown) => {
              try {
                controller.enqueue(sseEncode(event, data));
              } catch {
                /* cliente desconectou */
              }
            };

            try {
              // 0) cache opcional: no stream público, o clique em "Buscar"
              // envia forceRefresh=true para sempre revarrer as fontes. A UI
              // já mostra o banco local em paralelo enquanto a varredura roda.
              const query_norm = normalizeQueryNorm(filters.query);
              const fHash = filtersHash(filters);
              if (!filters.forceRefresh) {
                const cached = await readCachedSearch(query_norm, fHash);
                if (cached && cached.results.length > 0) {
                  const fresh = new Date(cached.search.fresh_until).getTime() > Date.now();
                  const payload: SearchResponse = {
                    results: cached.results,
                    total: cached.results.length,
                    pagina,
                    pageSize: 20,
                    query: filters.query,
                    tookMs: Date.now() - t0,
                    sources: cached.search.sources ?? [],
                    fromCache: true,
                    cachedAt: cached.search.computed_at,
                    stale: !fresh,
                  };
                  safeEnqueue("done", payload);
                  controller.close();
                  return;
                }
              }

              // 1) expansão + catálogo. Padrão = literal; só expandimos via IA
              // quando o usuário pediu explicitamente o modo "semantic".
              const mode = filters.mode ?? "exact";
              const baseVariants =
                mode === "exact" || mode === "all_keywords"
                  ? [filters.query]
                  : await expandQuery(filters.query, apiKey);
              // Quando o usuário informa um TEMA (ex.: "fardamento") junto do
              // item específico (ex.: "camiseta polo"), buscamos por AMBOS em
              // todas as fontes — tema costuma aparecer no objeto do processo
              // enquanto o item específico só aparece dentro dos /itens.
              const variants =
                filters.tema && filters.tema.length >= 2 && filters.tema !== filters.query
                  ? [...baseVariants, filters.tema]
                  : baseVariants;
              const catalog = await loadActiveSources();
              const siteFilters = catalog.map((s) => s.domain);
              const tceDomains = catalog
                .filter((s) => s.domain.startsWith("tce."))
                .map((s) => s.domain);
              const govFederal = catalog
                .filter((s) => /(^|\.)gov\.br$/.test(s.domain) && !s.domain.startsWith("tce."))
                .map((s) => s.domain);
              const namedDomains = catalog
                .filter((s) => !/^pncp\.gov\.br$|^compras\.gov\.br$/.test(s.domain))
                .slice(0, 6)
                .map((s) => s.domain);

              // 2) tarefas NOMEADAS
              type Task = { name: string; run: () => Promise<RawItem[]> };
              const tasks: Task[] = [];
              for (const v of variants) {
                tasks.push({ name: `PNCP "${v}" p${pagina}`, run: () => fetchPNCP(v, pagina, 50) });
                tasks.push({ name: `PNCP "${v}" p${pagina + 1}`, run: () => fetchPNCP(v, pagina + 1, 50) });
                tasks.push({ name: `PNCP "${v}" p${pagina + 2}`, run: () => fetchPNCP(v, pagina + 2, 50) });
                tasks.push({ name: `Compras.gov "${v}"`, run: () => fetchComprasGov(v) });
                tasks.push({ name: `Transparência "${v}"`, run: () => fetchTransparencia(v) });
                tasks.push({ name: `TCE-CE "${v}"`, run: () => fetchTCECE(v) });
              }
              for (const v of variants.slice(0, 3)) {
                tasks.push({ name: `Firecrawl PNCP "${v}"`, run: () => fetchFirecrawlWeb(v, ["pncp.gov.br"], catalog) });
                tasks.push({ name: `Firecrawl portais "${v}"`, run: () => fetchFirecrawlWeb(v, siteFilters, catalog) });
                if (tceDomains.length > 0)
                  tasks.push({ name: `Firecrawl TCEs "${v}"`, run: () => fetchFirecrawlWeb(v, tceDomains, catalog) });
                if (govFederal.length > 0)
                  tasks.push({ name: `Firecrawl gov "${v}"`, run: () => fetchFirecrawlWeb(v, govFederal, catalog) });
                tasks.push({ name: `Firecrawl fornecedores "${v}"`, run: () => fetchFirecrawlSuppliers(v) });
              }
              tasks.push({
                name: `Firecrawl por domínio`,
                run: () => fetchFirecrawlPerDomain(filters.query, namedDomains, catalog),
              });
              tasks.push({ name: "Mineração de anexos", run: () => mineAttachments(filters.query) });
              tasks.push({ name: "Portais privados", run: () => minePortais(filters.query) });
              const addM2aPages = (term: string, cap = 10) => {
                for (let p = 1; p <= 3; p++) {
                  tasks.push({ name: `M2A "${term}" p${p}`, run: () => fetchM2A(term, cap, 18_000, 1, p) });
                }
              };
              const m2aTerm = filters.tema && filters.tema.length >= 2 ? filters.tema : filters.query;
              addM2aPages(m2aTerm, 10);
              if (filters.tema && filters.tema !== filters.query) {
                addM2aPages(filters.query, 8);
              }
              tasks.push({
                name: `Portal CP "${filters.query}"`,
                run: () => fetchPortalComprasPublicas(filters.query, 10),
              });
              if (filters.tema && filters.tema.length >= 2 && filters.tema !== filters.query) {
                const temaQ = filters.tema;
                tasks.push({
                  name: `Portal CP "${filters.tema}"`,
                  run: () => fetchPortalComprasPublicas(temaQ, 10),
                });
              }

              safeEnqueue("start", { totalSources: tasks.length, variants });

              // 3) loop streaming
              const accRaw: RawItem[] = [];
              const sourcesDone: { name: string; status: "ok" | "empty" | "error"; count: number }[] = [];
              let pendingSnapshot = false;
              let lastSnapshot = 0;
              const SNAPSHOT_MIN_MS = 400;

              const emitSnapshot = (force = false) => {
                const now = Date.now();
                if (!force && now - lastSnapshot < SNAPSHOT_MIN_MS) {
                  if (!pendingSnapshot) {
                    pendingSnapshot = true;
                    setTimeout(() => {
                      pendingSnapshot = false;
                      emitSnapshot(true);
                    }, SNAPSHOT_MIN_MS);
                  }
                  return;
                }
                lastSnapshot = now;
                const ranked = lightRank(accRaw, filters);
                safeEnqueue("snapshot", {
                  items: ranked.slice(0, 200),
                  total: ranked.length,
                  sourcesDone: sourcesDone.length,
                  totalSources: tasks.length,
                });
              };

              const wrapped = tasks.map((t) =>
                (() => {
                  safeEnqueue("source:start", {
                    name: t.name,
                    started: sourcesDone.length,
                    total: tasks.length,
                  });
                  return t.run();
                })()
                  .then((items) => {
                    accRaw.push(...items);
                    sourcesDone.push({
                      name: t.name,
                      status: items.length > 0 ? "ok" : "empty",
                      count: items.length,
                    });
                    safeEnqueue("source", {
                      name: t.name,
                      status: items.length > 0 ? "ok" : "empty",
                      count: items.length,
                      done: sourcesDone.length,
                      total: tasks.length,
                    });
                    emitSnapshot();
                  })
                  .catch((err: unknown) => {
                    sourcesDone.push({ name: t.name, status: "error", count: 0 });
                    safeEnqueue("source", {
                      name: t.name,
                      status: "error",
                      count: 0,
                      error: (err as Error)?.message?.slice(0, 200),
                      done: sourcesDone.length,
                      total: tasks.length,
                    });
                  }),
              );

              await Promise.allSettled(wrapped);

              // 4) enrich /itens (custoso mas faz toda a diferença para granularidade)
              safeEnqueue("phase", { name: "enriquecendo itens do PNCP" });
              const enriched = await enrichWithPNCPItems(accRaw, filters.query, 250);
              safeEnqueue("snapshot", {
                items: lightRank(enriched, filters).slice(0, 200),
                total: enriched.length,
                sourcesDone: sourcesDone.length,
                totalSources: tasks.length,
              });

              // 5) ranking pesado final
              safeEnqueue("phase", { name: "ranqueamento final" });
              const lightFinal = lightRank(enriched, filters);
              const finalResults = await heavyRank(lightFinal, filters, apiKey);

              const sourcesSummary = summarizeSources(finalResults, catalog);
              const tookMs = Date.now() - t0;

              // 6) cache (não bloqueia muito tempo, mas aguarda como o serverFn)
              try {
                await writeCachedSearch({
                  query_norm,
                  query_raw: filters.query,
                  filters_hash: fHash,
                  filters: JSON.parse(fHash) as Record<string, unknown>,
                  sources: sourcesSummary,
                  tookMs,
                  results: finalResults,
                });
              } catch (e) {
                console.warn("[stream] cache write failed", (e as Error).message);
              }

              const finalPayload: SearchResponse = {
                results: finalResults,
                total: finalResults.length,
                pagina,
                pageSize: 20,
                query: filters.query,
                tookMs,
                sources: sourcesSummary,
                fromCache: false,
              };
              safeEnqueue("done", finalPayload);
              controller.close();
            } catch (err) {
              console.error("[stream] fatal", err);
              safeEnqueue("error", { message: (err as Error).message });
              controller.close();
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
          },
        });
      },
    },
  },
});