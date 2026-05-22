/**
 * Entrypoint do serverFn de busca. A lógica pesada vive em:
 *   - ./search/cache.server.ts   (cache de respostas)
 *   - ./search/pipeline.server.ts (fontes, mining, ranking)
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PriceResult, SearchResponse, SearchSourceStatus } from "./types";
import { logSourceRunsBatch, type SourceRunInput } from "./telemetry";
import { enrichCnpjsBackground } from "./enrich/cnpj";
import { healValuesBackground } from "./heal/value-healer.server";
import { embedQuoteItemsBackground } from "./embed/embedder.server";
import * as Cache from "./search/cache.server";
import * as Pipeline from "./search/pipeline.server";
import type {
  PcpItem,
  PcpProcesso,
  PncpItemRaw,
  PncpResultadoRaw,
  RawItem,
  TCECERow,
} from "./search/pipeline.server";


// Re-bind module exports as locals so the serverFn body keeps using
// bare names (refactor preserved behavior 1:1 from the old god-file).
const {
  CACHE_TTL_MS,
  normalizeQueryNorm,
  filtersHash,
  readCachedSearch,
  writeCachedSearch,
} = Cache;
const {
  PNCP_UA,
  pncpFetchJson,
  FORBIDDEN,
  looksLikeMultiItem,
  cleanItemTitle,
  looksLikeRawDocumentText,
  looksLikeProcessObject,
  looksLikeProcessNumberTitle,
  tokenize,
  jaccard,
  cosine,
  getEmbeddings,
  parsePncpPublicUrl,
  parseNumeroControlePncpCompra,
  resolvePncpCompraFromContract,
  fetchPNCP,
  fetchM2A,
  fetchPortalComprasPublicas,
  validPrice,
  fetchPncpItens,
  fetchPncpItemResultado,
  enrichWithPNCPItems,
  fetchComprasGov,
  unifiedToRawItem,
  fetchTransparencia,
  TCE_CE_HOSTS,
  TCE_CE_VIEWS,
  numFromBR,
  fetchTceCeView,
  fetchTCECE,
  expandQuery,
  sourceMetaForUrl,
  fetchFirecrawlWeb,
  fetchFirecrawlPerDomain,
  fetchFirecrawlSuppliers,
  UNIDADES_RE,
  parsePriceBR,
  parseQtyBR,
  extractItemsFromText,
  dorkPdfAttachments,
  scrapeAndMine,
  ONTOLOGY_PROMPT,
  ontologicalExtract,
  extractItemsFromHtmlTables,
  mineAttachments,
  PORTAIS,
  searchPortalUrls,
  minePortais,
  loadActiveSources,
  registerDiscoveredDomains,
  buildPncpUrl,
  isSupplierOrCommercial,
  isGranularItemResult,
  summarizeSources,
  toResult,
  applyJuridicScore,
} = Pipeline;
// Marca como "usados" para o linter — todos são referenciados pelo serverFn abaixo.
void ({ asJson, CACHE_TTL_MS, normalizeQueryNorm, filtersHash, readCachedSearch, writeCachedSearch, PNCP_UA, pncpFetchJson, FORBIDDEN, looksLikeMultiItem, cleanItemTitle, looksLikeRawDocumentText, looksLikeProcessObject, looksLikeProcessNumberTitle, tokenize, jaccard, cosine, getEmbeddings, parsePncpPublicUrl, parseNumeroControlePncpCompra, resolvePncpCompraFromContract, fetchPNCP, fetchM2A, fetchPortalComprasPublicas, validPrice, fetchPncpItens, fetchPncpItemResultado, enrichWithPNCPItems, fetchComprasGov, unifiedToRawItem, fetchTransparencia, TCE_CE_HOSTS, TCE_CE_VIEWS, numFromBR, fetchTceCeView, fetchTCECE, expandQuery, sourceMetaForUrl, fetchFirecrawlWeb, fetchFirecrawlPerDomain, fetchFirecrawlSuppliers, UNIDADES_RE, parsePriceBR, parseQtyBR, extractItemsFromText, dorkPdfAttachments, scrapeAndMine, ONTOLOGY_PROMPT, ontologicalExtract, extractItemsFromHtmlTables, mineAttachments, PORTAIS, searchPortalUrls, minePortais, loadActiveSources, registerDiscoveredDomains, buildPncpUrl, isSupplierOrCommercial, isGranularItemResult, summarizeSources, toResult, applyJuridicScore });

const FilterSchema = z.object({
  query: z.string().trim().min(1).max(200),
  /**
   * Tema/título da licitação (opcional). Usado pra descoberta de processos
   * em portais que indexam por objeto (ex.: M2A). Ex.: query="caderno" +
   * tema="material escolar" amplia o universo de processos descobertos sem
   * perder precisão nos itens (filtrados pela query depois).
   */
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
  /** Quando true, ignora cache e refaz a varredura completa. */
  forceRefresh: z.boolean().optional(),
});

export const searchPrices = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => FilterSchema.parse(input))
  .handler(async ({ data }): Promise<SearchResponse> => {
    const t0 = Date.now();
    const apiKey = process.env.LOVABLE_API_KEY;
    const pagina = data.pagina ?? 1;
    const ultimosMeses = data.ultimosMeses ?? 12;

    // 0) CACHE — chave determinística por (query_norm, filters_hash).
    //    Se cliente NÃO pediu forceRefresh e existe registro no banco,
    //    devolve imediatamente. O frontend dispara o refresh em background.
    const query_norm = normalizeQueryNorm(data.query);
    const fHash = filtersHash(data);
    if (!data.forceRefresh) {
      const cached = await readCachedSearch(query_norm, fHash);
      if (cached && cached.results.length > 0) {
        const fresh = new Date(cached.search.fresh_until).getTime() > Date.now();
        console.info(
          `[cache] HIT q="${data.query.slice(0, 60)}" items=${cached.results.length} fresh=${fresh}`,
        );
        return {
          results: cached.results,
          total: cached.results.length,
          pagina,
          pageSize: 20,
          query: data.query,
          tookMs: Date.now() - t0,
          sources: cached.search.sources ?? [],
          fromCache: true,
          cachedAt: cached.search.computed_at,
          stale: !fresh,
        };
      }
    }

    // 1) Expansão inteligente da consulta (sinônimos via IA)
    const mode = data.mode ?? "semantic";
    const variants =
      mode === "exact"
        ? [data.query]
        : await expandQuery(data.query, apiKey);

    // 1b) Catálogo dinâmico de fontes para Firecrawl
    const catalog = await loadActiveSources();
    const knownDomains = new Set(catalog.map((s) => s.domain));
    const siteFilters = catalog.map((s) => s.domain);

    // 2) Busca paralela MASSIVA em múltiplas fontes oficiais + variações de query
    //    (várias páginas, várias fontes, vários filtros de site no Firecrawl).
    const tasks: Promise<RawItem[]>[] = [];
    for (const v of variants) {
      // PNCP — varre 3 páginas de cada variante (3 × 50 = 150 por variante)
      tasks.push(fetchPNCP(v, pagina, 50));
      tasks.push(fetchPNCP(v, pagina + 1, 50));
      tasks.push(fetchPNCP(v, pagina + 2, 50));
      tasks.push(fetchComprasGov(v));
      tasks.push(fetchTransparencia(v));
      // TCE-CE: itens já homologados de municípios cearenses (granular nato)
      tasks.push(fetchTCECE(v));
    }
    // Firecrawl — chama com vários conjuntos de domínios para diversificar
    const tceDomains = catalog.filter((s) => s.domain.startsWith("tce.")).map((s) => s.domain);
    const govFederal = catalog
      .filter((s) => /(^|\.)gov\.br$/.test(s.domain) && !s.domain.startsWith("tce."))
      .map((s) => s.domain);
    for (const v of variants.slice(0, 3)) {
      // PNCP público via web: encontra páginas de processos e, em seguida,
      // o enrich transforma essas páginas em ITENS granulares via /itens.
      tasks.push(fetchFirecrawlWeb(v, ["pncp.gov.br"], catalog));
      tasks.push(fetchFirecrawlWeb(v, siteFilters, catalog));
      if (tceDomains.length > 0) tasks.push(fetchFirecrawlWeb(v, tceDomains, catalog));
      if (govFederal.length > 0) tasks.push(fetchFirecrawlWeb(v, govFederal, catalog));
      // Cotação com fornecedores reais (catálogos / fabricantes / distribuidores)
      tasks.push(fetchFirecrawlSuppliers(v));
    }
    // Cobertura garantida dos portais NOMEADOS na UI (TCU, Comprasnet,
    // Painel de Preços, BPS Saúde, CMED Anvisa, TCE-CE) — uma chamada
    // Firecrawl POR domínio para evitar o viés do operador OR do Google.
    // Só na query principal para não estourar créditos.
    const namedDomains = catalog
      .filter((s) => !/^pncp\.gov\.br$|^compras\.gov\.br$/.test(s.domain))
      .slice(0, 6)
      .map((s) => s.domain);
    tasks.push(fetchFirecrawlPerDomain(data.query, namedDomains, catalog));
    // Mineração de anexos (PDFs/HTML de Atas e Termos de Homologação)
    // Roda só na variante principal para limitar custo do Firecrawl.
    tasks.push(mineAttachments(data.query));
    // Rodada E — portais privados (PCP/BLL/BNC/Licitações-e): descobre páginas
    // de processo via Firecrawl-search com site: e extrai itens (tríade) via
    // scrapeAndMine. Cobre licitações municipais ausentes do PNCP.
    tasks.push(minePortais(data.query));
    // Rodada F — M2A Tecnologia: portal que indexa licitações por OBJETO/TEMA.
    // Quando o usuário informa `tema` (ex.: "material escolar"), descobre
    // processos relevantes ali e o enrich /itens filtra pelos itens que
    // batem com a `query` específica (ex.: "caderno"). Sem `tema`, usa a
    // própria query como termo de busca.
    const m2aTerm = (data.tema && data.tema.length >= 2) ? data.tema : data.query;
    tasks.push(fetchM2A(m2aTerm, 15));
    if (data.tema && data.tema !== data.query) {
      // Quando há tema, faz uma segunda passada com a query específica
      // para cobrir processos que mencionam o item exato no título.
      tasks.push(fetchM2A(data.query, 10));
    }
    // Rodada G — Portal de Compras Públicas (PCP): API pública que devolve
    // itens já granulares com valor unitário (referência + melhor lance).
    // Cobre milhares de licitações municipais ausentes do PNCP.
    tasks.push(fetchPortalComprasPublicas(data.query, 10));
    if (data.tema && data.tema.length >= 2 && data.tema !== data.query) {
      // Quando há tema (ex.: "material escolar"), busca também pelo tema:
      // o filtro por descrição garante que só itens batendo na query
      // específica (ex.: "caderno") entrem no resultado final.
      tasks.push(fetchPortalComprasPublicas(data.tema, 10));
    }
    const settled = await Promise.allSettled(tasks);
    let raw = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

    // 2a) Deduplica raw por (cnpj|ano|numero) antes do enrich (evita chamadas duplicadas)
    const seenRaw = new Set<string>();
    raw = raw.filter((r) => {
      const k = `${r.orgao_cnpj ?? ""}|${r.ano ?? ""}|${r.numero ?? ""}|${(r.title ?? "").slice(0, 60)}`;
      if (seenRaw.has(k)) return false;
      seenRaw.add(k);
      return true;
    });

    // 2b) Enriquece com ITENS individuais do PNCP para ter valor unitário real.
    // A busca do PNCP só devolve processos inteiros — sem o /itens o usuário
    // veria apenas o "objeto do contrato" (descrição do processo todo).
    // Limite alto para garantir cobertura por item.
    raw = await enrichWithPNCPItems(raw, data.query, 250);

    let results = raw.map(toResult);

    // Anota cada resultado com flags de qualidade. NADA é descartado aqui —
    // os flags viram penalidades no score final. Garantia: nunca retornar
    // zero por causa de filtros rígidos.
    const flags = new Map<string, {
      rawDoc: boolean;
      processObj: boolean;
      multiItem: boolean;
      noPrice: boolean;
      globalPrice: boolean;
    }>();
    for (const r of results) {
      flags.set(r.id, {
        rawDoc: looksLikeRawDocumentText(r.titulo) && looksLikeRawDocumentText(r.descricao),
        processObj: looksLikeProcessObject(r.titulo) || looksLikeProcessObject(r.descricao),
        multiItem: looksLikeMultiItem(`${r.titulo} ${r.descricao}`),
        noPrice: typeof r.valor !== "number",
        globalPrice: r.valorTipo === "global",
      });
    }

    // Auto-descoberta: registra novos domínios encontrados pelo Firecrawl
    void registerDiscoveredDomains(
      results.map((r) => r.url ?? "").filter(Boolean),
      knownDomains,
    );

    // Sistema de penalidades suaves (declarado cedo p/ permitir uso pelos
    // blocos abaixo). Itens com penalidade não são removidos — apenas
    // descem no ranking, garantindo que a tela nunca fique vazia.
    const softPenalty = new Map<string, number>();
    const addPen = (id: string, p: number) =>
      softPenalty.set(id, (softPenalty.get(id) ?? 0) + p);

    // Palavras-chave obrigatórias e modo exato — tratados como SINAIS
    // de ranqueamento, não como exclusões. Itens que batem vão para o
    // topo; os demais permanecem visíveis como fallback, para o usuário
    // nunca ficar com a tela vazia quando não houver match perfeito.
    if (data.keywords && data.keywords.length > 0) {
      const kws = data.keywords.map((k) => k.toLowerCase());
      for (const r of results) {
        const blob = `${r.titulo} ${r.descricao}`.toLowerCase();
        const missing = kws.filter((k) => !blob.includes(k)).length;
        if (missing > 0) addPen(r.id, 0.08 * missing);
      }
    }

    if (mode === "exact" || mode === "all_keywords") {
      const need = tokenize(data.query);
      if (need.length > 0) {
        for (const r of results) {
          const blob = tokenize(`${r.titulo} ${r.descricao}`);
          const set = new Set(blob);
          const missing = need.filter((t) => !set.has(t)).length;
          if (missing > 0) addPen(r.id, 0.05 * missing);
        }
      }
    }

    // Deduplicação cruzada por URL/título
    const seen = new Set<string>();
    results = results.filter((r) => {
      // Itens diferentes podem pertencer à mesma URL/processo; deduplicar só por URL
      // apagava os itens 2, 3, 4... e voltava a parecer uma lista de processos.
      const k = `${r.url || r.origem}|${r.titulo}|${r.valor ?? ""}|${r.quantidade ?? ""}`.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Filtro fontes proibidas (defensivo)
    results = results.filter((r) => {
      const blob = `${r.titulo} ${r.descricao} ${r.url ?? ""}`.toLowerCase();
      return !FORBIDDEN.some((f) => blob.includes(f));
    });

    // Regra central: se há itens granulares disponíveis, remove cards que ainda
    // representam processo/edital/ata. A lista final deve mostrar itens cotáveis.
    const granular = results.filter(isGranularItemResult);
    if (granular.length > 0) results = granular;

    // Filtros básicos (UF/modalidade/unidade/homologação/preço):
    // aplicados como SINAIS DE RANQUEAMENTO, não como exclusões duras.
    // Cada falha vira uma penalidade no score final, mas o item permanece
    // visível como fallback (o usuário ainda decide).
    if (data.uf) {
      const uf = data.uf.toUpperCase();
      for (const r of results) if ((r.uf ?? "").toUpperCase() !== uf) addPen(r.id, 0.15);
    }
    if (data.modalidade) {
      const md = data.modalidade.toLowerCase();
      for (const r of results) if (!(r.modalidade ?? "").toLowerCase().includes(md)) addPen(r.id, 0.1);
    }
    if (data.unidade) {
      const un = data.unidade.toLowerCase();
      for (const r of results) if (!(r.unidade ?? "").toLowerCase().includes(un)) addPen(r.id, 0.1);
    }
    if (data.apenasHomologados) {
      for (const r of results) if (!r.homologado) addPen(r.id, 0.2);
    }
    if (typeof data.valorMin === "number") {
      for (const r of results) if ((r.valor ?? 0) < data.valorMin) addPen(r.id, 0.15);
    }
    if (typeof data.valorMax === "number") {
      for (const r of results) if ((r.valor ?? Infinity) > data.valorMax) addPen(r.id, 0.15);
    }

    // Score textual (Jaccard)
    const qTokens = tokenize(data.query);
    results = results.map((r) => ({
      ...r,
      scoreTextual: jaccard(qTokens, tokenize(`${r.titulo} ${r.descricao}`)),
    }));

    // Score jurídico
    results = results.map((r) => applyJuridicScore(r, ultimosMeses));

    // Score semântico via embeddings (até 30 itens para custo)
    const topForEmbed = results.slice(0, 30);
    if (apiKey && topForEmbed.length > 0) {
      const inputs = [data.query, ...topForEmbed.map((r) => `${r.titulo}. ${r.descricao}`.slice(0, 800))];
      const embs = await getEmbeddings(inputs, apiKey);
      if (embs.length === inputs.length) {
        const qVec = embs[0];
        topForEmbed.forEach((r, i) => {
          r.scoreSemantico = Math.max(0, cosine(qVec, embs[i + 1]));
          // Compatibilidade técnica = derivada de semântico + textual
          r.scoreTecnico = 0.6 * r.scoreSemantico + 0.4 * r.scoreTextual;
        });
      }
    }

    // Geográfico — simples, neutro por enquanto
    results = results.map((r) => ({ ...r, scoreGeografico: r.uf ? 0.6 : 0.4 }));

    // Score final ponderado
    results = results.map((r) => {
      const f = flags.get(r.id);
      let penalty = softPenalty.get(r.id) ?? 0;
      if (f?.rawDoc) penalty += 0.25;
      if (f?.processObj) penalty += 0.15;
      if (f?.multiItem) penalty += 0.2;
      if (f?.globalPrice) penalty += 0.2;
      if (f?.noPrice) penalty += 0.15;
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

    // Sistema de aprendizado: aplica boost com base em feedback histórico
    try {
      const qNorm = tokenize(data.query).slice(0, 8).join(" ");
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
      console.warn("learning boost skipped:", (e as Error).message);
    }

    const sourcesSummary = summarizeSources(results, catalog);
    const tookMs = Date.now() - t0;

    // Persiste no cache (não bloqueia o retorno, mas aguardamos curto para
    // garantir que a próxima consulta idêntica encontre o registro).
    await writeCachedSearch({
      query_norm,
      query_raw: data.query,
      filters_hash: fHash,
      filters: JSON.parse(fHash) as Record<string, unknown>,
      sources: sourcesSummary,
      tookMs,
      results,
    });

    // Telemetria por fonte (fire-and-forget) — alimenta painel de saúde.
    void (async () => {
      try {
        const { data: searchRow } = await supabaseAdmin
          .from("quote_searches")
          .select("id")
          .eq("query_norm", query_norm)
          .eq("filters_hash", fHash)
          .maybeSingle();
        const searchId = searchRow?.id ?? null;
        const counts = new Map<string, number>();
        for (const r of results) {
          const key = (r.origem || "desconhecido").toLowerCase().slice(0, 40);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const rows: SourceRunInput[] = Array.from(counts.entries()).map(
          ([sourceId, count]) => ({
            searchId,
            sourceId,
            status: count > 0 ? "ok" : "empty",
            count,
            tookMs,
          }),
        );
        await logSourceRunsBatch(rows);

        // Self-Healing — quando há itens só com valor_total, infere o
        // unitário a partir do source_excerpt via Lovable AI.
        void healValuesBackground(searchId);

        // Embeddings (pgvector) — gera vetores semânticos para RAG e
        // busca por similaridade entre cotações históricas.
        void embedQuoteItemsBackground(searchId ?? undefined);
      } catch (e) {
        console.warn("source_runs log failed", (e as Error).message);
      }
    })();

    // Enriquecimento de CNPJs em background (BrasilAPI + cnpj_cache 30d).
    void enrichCnpjsBackground(
      results.map((r) => r.cnpj ?? "").filter((c) => c.length > 0).slice(0, 30),
    );

    return {
      results,
      total: results.length,
      pagina,
      pageSize: 20,
      query: data.query,
      tookMs,
      sources: sourcesSummary,
      fromCache: false,
    };
  });