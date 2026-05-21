import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PriceResult, SearchResponse, SearchSourceStatus } from "./types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ============================================================
// CACHE — quote_searches + quote_items
// ============================================================
// Janela de frescor padrão: 24h. Resultados mais novos são servidos do cache
// imediatamente; resultados velhos ainda são servidos do cache mas a UI
// dispara um refresh em background.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeQueryNorm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function filtersHash(d: {
  uf?: string; modalidade?: string; unidade?: string;
  apenasHomologados?: boolean; valorMin?: number; valorMax?: number;
  mode?: string; keywords?: string[]; pagina?: number;
}): string {
  return JSON.stringify({
    uf: d.uf ?? null,
    modalidade: d.modalidade ?? null,
    unidade: d.unidade ?? null,
    apenasHomologados: !!d.apenasHomologados,
    valorMin: d.valorMin ?? null,
    valorMax: d.valorMax ?? null,
    mode: d.mode ?? "semantic",
    keywords: (d.keywords ?? []).slice().sort(),
    pagina: d.pagina ?? 1,
  });
}

async function readCachedSearch(
  query_norm: string,
  filters_hash: string,
): Promise<{ search: {
  id: string; computed_at: string; fresh_until: string;
  sources: SearchSourceStatus[] | null; took_ms: number;
}; results: PriceResult[] } | null> {
  try {
    const { data: search, error } = await supabaseAdmin
      .from("quote_searches")
      .select("id, computed_at, fresh_until, sources, took_ms")
      .eq("query_norm", query_norm)
      .eq("filters_hash", filters_hash)
      .maybeSingle();
    if (error || !search) return null;
    const { data: items } = await supabaseAdmin
      .from("quote_items")
      .select("payload")
      .eq("search_id", search.id)
      .order("score_final", { ascending: false })
      .limit(500);
    const results = (items ?? [])
      .map((r) => r.payload as unknown as PriceResult)
      .filter((r) => r && typeof r === "object" && r.id);
    return {
      search: search as {
        id: string; computed_at: string; fresh_until: string;
        sources: SearchSourceStatus[] | null; took_ms: number;
      },
      results,
    };
  } catch (e) {
    console.warn("readCachedSearch failed", (e as Error).message);
    return null;
  }
}

async function writeCachedSearch(opts: {
  query_norm: string;
  query_raw: string;
  filters_hash: string;
  filters: Record<string, unknown>;
  sources: SearchSourceStatus[];
  tookMs: number;
  results: PriceResult[];
}): Promise<void> {
  try {
    const { data: search, error } = await supabaseAdmin
      .from("quote_searches")
      .upsert(
        {
          query_norm: opts.query_norm,
          query_raw: opts.query_raw.slice(0, 500),
          filters_hash: opts.filters_hash,
          filters: opts.filters,
          total: opts.results.length,
          took_ms: opts.tookMs,
          sources: opts.sources,
          computed_at: new Date().toISOString(),
          fresh_until: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
        },
        { onConflict: "query_norm,filters_hash" },
      )
      .select("id")
      .single();
    if (error || !search) {
      console.warn("write quote_searches err", error?.message);
      return;
    }
    await supabaseAdmin.from("quote_items").delete().eq("search_id", search.id);
    const rows = opts.results.slice(0, 500).map((r) => ({
      fingerprint: `${opts.query_norm}|${r.id}`.slice(0, 240),
      search_id: search.id,
      query_norm: opts.query_norm,
      titulo: (r.titulo || "").slice(0, 500),
      descricao: (r.descricao || "").slice(0, 3000),
      unidade: r.unidade ?? null,
      quantidade: r.quantidade ?? null,
      valor: r.valor ?? null,
      valor_total: r.valorTotal ?? null,
      valor_tipo: r.valorTipo ?? null,
      fornecedor: r.fornecedor ?? null,
      cnpj: r.cnpj ?? null,
      orgao: r.orgao ?? null,
      municipio: r.municipio ?? null,
      uf: r.uf ?? null,
      data:
        r.data && /^\d{4}-\d{2}-\d{2}/.test(r.data) ? r.data.slice(0, 10) : null,
      modalidade: r.modalidade ?? null,
      homologado: !!r.homologado,
      origem: r.origem ?? null,
      url: r.url ?? null,
      documento: r.documento ?? null,
      score_final: r.scoreFinal ?? null,
      payload: r as unknown as Record<string, unknown>,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error: e2 } = await supabaseAdmin
        .from("quote_items")
        .upsert(chunk, { onConflict: "fingerprint" });
      if (e2) console.warn("write quote_items err", e2.message);
    }
    console.info(
      `[cache] wrote search id=${search.id} items=${rows.length} q="${opts.query_raw.slice(0, 60)}"`,
    );
  } catch (e) {
    console.warn("writeCachedSearch failed", (e as Error).message);
  }
}

const FilterSchema = z.object({
  query: z.string().trim().min(1).max(200),
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

const FORBIDDEN = [
  "mercadolivre",
  "mercado livre",
  "shopee",
  "aliexpress",
  "olx",
  "facebook",
];

// Heurística para detectar resultados que misturam múltiplos itens distintos
// (ex.: "CALÇA COM ELÁSTICO, CALÇA SEM ELÁSTICO"). Resultados assim viram lote
// e não servem para cotação unitária — devem ser filtrados.
function looksLikeMultiItem(text: string): boolean {
  const t = text.toLowerCase();
  // separadores explícitos de listagem
  const seps = (t.match(/[;\/]|(?:^|\s)e\s|\bcom\s+e\s+sem\b|,\s*[a-z]{4,}/g) ?? []).length;
  if (seps >= 2) return true;
  // "item 01", "item 02"
  if (/item\s*\d+.*item\s*\d+/i.test(text)) return true;
  // múltiplos preços no mesmo título indica lote
  if ((t.match(/r\$\s*\d/g) ?? []).length >= 2) return true;
  return false;
}

// Remove preâmbulos comuns ("TERMO DE REFERÊNCIA", "EDITAL Nº", "CONCORRÊNCIA",
// "PREGÃO ELETRÔNICO Nº ...", numeração de item "16 ", trailing object descriptions)
// e extrai apenas a descrição limpa do item. Trata também o caso em que o
// "objeto_compra" do PNCP traz blocos inteiros de texto (frases concatenadas
// com valores, unidades e código do item).
function cleanItemTitle(raw: string | undefined): string {
  if (!raw) return "Sem título";
  let s = String(raw).replace(/\s+/g, " ").trim();

  // 1) Remove preâmbulos jurídico-administrativos
  s = s.replace(
    /^(?:termo\s+de\s+refer[eê]ncia|edital|concorr[eê]ncia|preg[aã]o(?:\s+eletr[oô]nico|\s+presencial)?|tomada\s+de\s+pre[cç]os|dispensa\s+de\s+licita[cç][aã]o|inexigibilidade|chamada\s+p[uú]blica|ata\s+de\s+registro\s+de\s+pre[cç]os?|contrato|processo)\b[:\s\-nº°.\d\/]*?/i,
    "",
  ).trim();

  // 2) Remove numeração de item no início ("16 ", "16- ", "16. ", "Item 16 - ")
  s = s.replace(/^(?:item\s*)?\d{1,4}\s*[-–.)]\s*/i, "").trim();
  s = s.replace(/^\d{1,4}\s+(?=[A-Za-zÀ-ÿ])/, "").trim();

  // 3) Corta no primeiro separador forte que indica início de outro item / texto
  //    livre ("... É objeto do presente contrato ...", "...34.500. 17.250. UN. 17...")
  const stopMarkers = [
    /\.\s+[ÉÈEe]\s+objeto\b/,
    /\.\s+[Ff]ica\s+/,
    /\.\s+[OoAa]\s+presente\s+/,
    /\bUN\.\s+\d{1,4}\b/, // bloco tipo "UN. 17"
    /\b\d+\.\d{3}\.\s+\d+\.\d{3}\.\s+UN\./, // padrão "34.500. 17.250. UN."
  ];
  for (const re of stopMarkers) {
    const m = s.match(re);
    if (m && typeof m.index === "number" && m.index > 12) {
      s = s.slice(0, m.index).trim();
    }
  }

  // 4) Se ainda for muito longo, corta no primeiro ponto final após 24 chars
  if (s.length > 140) {
    const idx = s.indexOf(". ", 24);
    if (idx > 0 && idx < 140) s = s.slice(0, idx).trim();
  }

  // 5) Hard-cap final
  if (s.length > 180) s = s.slice(0, 177).trimEnd() + "…";

  // 6) Remove caracteres residuais
  s = s.replace(/^[\s\-–:.,;]+/, "").replace(/[\s\-–:.,;]+$/, "");
  return s.length >= 4 ? s : (raw.slice(0, 120) || "Sem título");
}

// Detecta blocos de texto que claramente são corpo de PDF, não o nome do item.
// Usado para descartar resultados onde nem o título nem a descrição são utilizáveis.
function looksLikeRawDocumentText(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (t.length > 350) return true;
  if (/\b(é\s+objeto\s+do\s+presente|cl[aá]usula|p[aá]ragrafo\s+[uú]nico|considerando\s+que|nos\s+termos\s+da\s+lei)\b/.test(t)) return true;
  return false;
}

// Detecta descrição de PROCESSO (não-item): "O objeto do presente contrato é
// a compra/aquisição de X". Não traz especificação técnica de um item único.
function looksLikeProcessObject(text: string): boolean {
  const t = (text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\bobjeto\s+(do|deste|da|desta)\s+(presente\s+)?(contrato|procedimento|certame|ata|edital|pregao|licitacao|chamamento|dispensa|inexigibilidade)\b/.test(t)) return true;
  if (/^(o|a)\s+(presente\s+)?(contrato|ata|edital|pregao|procedimento)\b/.test(t)) return true;
  if (/\b(aquisicao|contratacao|compra|fornecimento|registro\s+de\s+precos)\s+de\b/.test(t) && t.length > 180) return true;
  return false;
}

// Detecta strings que são apenas IDENTIFICADORES de processo/ata/contrato
// (ex.: "nº 20260186 SEMED/2026", "Ata 12/2024", "PCP 3/2026 - Portal...",
// "Pregão Eletrônico 045/2025"). Esses NUNCA devem virar título do item —
// servem só como metadado (já temos campos numero/ano).
function looksLikeProcessNumberTitle(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (t.length < 4) return true;
  if (/portal\s+nacional\s+de\s+contrata[cç][oõ]es\s+p[uú]blicas/i.test(t)) return true;
  if (/^n[º°o.]?\s*(?:pe|pp|preg[aã]o|dispensa|concorr[eê]ncia|edital|ata|contrato|processo)\s*\d+\s*\/\s*\d{4}/i.test(t)) return true;
  // Padrões: "nº 123456", "n° 12/2024", "Ata 12/2024", "PCP 3/2026 - ..."
  const re = /^(?:n[º°o.]?\s*)?(?:ata|edital|preg[aã]o(?:\s+eletr[oô]nico)?|pcp|tp|rdc|concorr[eê]ncia|dispensa|inexigibilidade|contrato|processo|empenho)?\s*[nº°.]*\s*\d{1,8}\s*[\/\-]?\s*\d{0,6}(?:\s*[-–]\s*[A-Za-zÀ-ÿ ]{0,40})?$/i;
  if (re.test(t)) return true;
  // Só dígitos, barras, hifens, letras de sigla curta
  if (/^[\d\s\/\-.\u00BA\u00B0nN°º]+$/.test(t)) return true;
  // Predominantemente dígitos (>= 50%) e curto
  const digits = (t.match(/\d/g) ?? []).length;
  if (t.length <= 40 && digits / t.length >= 0.4) return true;
  return false;
}

function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function getEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-embedding-001",
        input: texts,
        dimensions: 768,
      }),
    });
    if (!res.ok) {
      console.warn("Embeddings failed:", res.status, await res.text().catch(() => ""));
      return [];
    }
    const data = (await res.json()) as { data?: Array<{ embedding: number[] }> };
    return (data.data ?? []).map((d) => d.embedding);
  } catch (e) {
    console.error("Embedding error", e);
    return [];
  }
}

interface RawItem {
  id?: string | number;
  numero?: string;
  numero_sequencial?: string | number | null;
  numero_sequencial_compra_ata?: string | number | null;
  numero_controle_pncp?: string | null;
  ano?: string | number;
  title?: string;
  description?: string;
  descricao?: string;
  objeto_compra?: string;
  valor_global?: number;
  valorTotalEstimado?: number;
  valor_estimado?: number;
  valor_unitario_estimado?: number;
  valor_unitario_homologado?: number;
  valor_homologado?: number;
  valor_unitario?: number;
  valor_total_item?: number;
  unidade_medida?: string;
  quantidade?: number;
  fornecedor?: string;
  orgao_nome?: string;
  orgao_cnpj?: string;
  unidade_nome?: string;
  municipio_nome?: string;
  uf?: string;
  data_publicacao_pncp?: string;
  data?: string;
  modalidade_licitacao_nome?: string;
  situacao_nome?: string;
  situacao?: string;
  tipo_documento?: string;
  document_type?: string;
  item_url?: string;
  url?: string;
  /** Marca explicitamente o tipo do valor (preenchido pelo enrichWithPNCPItems). */
  _valorTipo?: PriceResult["valorTipo"];
  _supplier?: boolean;
  _sourceDomain?: string;
  _sourceName?: string;
  [k: string]: unknown;
}

function parsePncpPublicUrl(url?: string): { cnpj: string; ano: string; sequencial: string; tipo?: string } | null {
  if (!url) return null;
  try {
    const u = /^https?:\/\//i.test(url) ? new URL(url) : new URL(url, "https://pncp.gov.br/app");
    const m = u.pathname.match(/\/(?:app\/)?(editais|compras|atas|contratos)\/(\d{14})\/(\d{4})\/(\d+)/i);
    if (!m) return null;
    return { tipo: m[1], cnpj: m[2], ano: m[3], sequencial: String(Number(m[4])) };
  } catch {
    return null;
  }
}

function parseNumeroControlePncpCompra(value?: unknown): { cnpj: string; ano: string; sequencial: string } | null {
  const s = String(value ?? "").trim();
  const m = s.match(/(\d{14})-1-0*(\d+)\/(\d{4})/);
  if (!m) return null;
  return { cnpj: m[1], sequencial: String(Number(m[2])), ano: m[3] };
}

async function resolvePncpCompraFromContract(
  cnpj: string,
  ano: string | number,
  sequencialContrato: string | number,
): Promise<{ cnpj: string; ano: string; sequencial: string; fornecedor?: string } | null> {
  const seq = String(Number(String(sequencialContrato).replace(/\D/g, "")) || sequencialContrato);
  const url = `https://pncp.gov.br/pncp-api/v1/orgaos/${cnpj}/contratos/${ano}/${seq}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const compra = parseNumeroControlePncpCompra(data.numeroControlePncpCompra ?? data.numeroControlePNCPCompra);
    if (!compra) return null;
    return {
      ...compra,
      fornecedor: typeof data.nomeRazaoSocialFornecedor === "string" ? data.nomeRazaoSocialFornecedor : undefined,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPNCP(query: string, pagina: number, tamanho = 50): Promise<RawItem[]> {
  const tipos = "edital,ata,contrato";
  const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(query)}&tipos_documento=${tipos}&ordenacao=-data&pagina=${pagina}&pagina_tam=${tamanho}&status=todos`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
    });
    if (!res.ok) {
      console.warn("PNCP search HTTP", res.status);
      return [];
    }
    const data = (await res.json()) as { items?: RawItem[]; resultados?: RawItem[] };
    return data.items ?? data.resultados ?? [];
  } catch (e) {
    console.error("PNCP fetch error", e);
    return [];
  }
}

// PNCP API de consulta — retorna ITENS individuais de uma contratação/ata/contrato,
// cada um com valor UNITÁRIO (estimado e/ou homologado), unidade e quantidade.
// Isto resolve o problema do "valor global do processo" aparecer como cotação.
interface PncpItemRaw {
  numeroItem?: number;
  descricao?: string;
  unidadeMedida?: string;
  quantidade?: number;
  valorUnitarioEstimado?: number;
  valorUnitarioHomologado?: number;
  valorTotal?: number;
  valorTotalHomologado?: number;
  situacaoCompraItemNome?: string;
  ncmNbsCodigo?: string;
}

function validPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function fetchPncpItens(
  cnpj: string,
  ano: string | number,
  sequencial: string | number,
  _tipo: string,
): Promise<PncpItemRaw[]> {
  // Os itens granulares ficam na API pública do PNCP em /pncp-api/v1/.../compras/.../itens.
  // A rota antiga /api/consulta/v1 não responde de forma confiável e fazia o sistema manter
  // o processo inteiro como fallback, exatamente o comportamento incorreto reportado.
  const seq = String(Number(String(sequencial).replace(/\D/g, "")) || sequencial);
  const all: PncpItemRaw[] = [];
  for (let pagina = 1; pagina <= 5; pagina++) {
    const url = `https://pncp.gov.br/pncp-api/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens?pagina=${pagina}&tamanhoPagina=100`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
        signal: ctrl.signal,
      });
      if (!res.ok) break;
      const j = (await res.json()) as PncpItemRaw[] | { data?: PncpItemRaw[] };
      const page = Array.isArray(j) ? j : (j.data ?? []);
      all.push(...page);
      if (page.length < 100) break;
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return all;
}

/**
 * Para cada resultado PNCP (que representa um PROCESSO inteiro), tenta buscar
 * os ITENS individuais e EXPANDIR em múltiplos RawItem — cada item com seu
 * próprio valor unitário, unidade, quantidade e descrição.
 *
 * Limitado aos top-N por custo. Resultados sem cnpj/ano/sequencial ficam como estão.
 */
async function enrichWithPNCPItems(raw: RawItem[], query: string, limit = 12): Promise<RawItem[]> {
  const qLower = query.toLowerCase();
  const qTokens = qLower.split(/\s+/).filter((t) => t.length > 2);
  const enrichable: RawItem[] = [];
  const passthrough: RawItem[] = [];
  for (const r of raw) {
    const parsed = parsePncpPublicUrl((r.item_url as string | undefined) || (r.url as string | undefined));
    // numero_controle_pncp = "CNPJ-1-SEQ/ANO" — única fonte confiável p/ resultados
    // da busca PNCP que não trazem cnpj/ano/seq separados nos campos diretos.
    const fromControle = parseNumeroControlePncpCompra(r.numero_controle_pncp);
    const cnpj = (r.orgao_cnpj ?? parsed?.cnpj ?? fromControle?.cnpj ?? "").replace(/\D/g, "");
    const ano = r.ano ?? parsed?.ano ?? fromControle?.ano;
    const seqRaw =
      r.numero_sequencial_compra_ata ??
      r.numero_sequencial ??
      r.numero ??
      parsed?.sequencial ??
      fromControle?.sequencial ??
      "";
    const seq = String(seqRaw).replace(/\D/g, "");
    const isPNCP = !r._source || r._source === "PNCP" || r._source === "Transparência" || r._source === "Compras.gov.br";
    if ((isPNCP || parsed || fromControle) && cnpj.length === 14 && ano && seq && enrichable.length < limit) {
      const tipo = String(r.document_type ?? r.tipo_documento ?? parsed?.tipo ?? "").toLowerCase();
      enrichable.push({
        ...r,
        orgao_cnpj: cnpj,
        ano,
        numero: seq,
        tipo_documento: tipo.includes("contrato") || parsed?.tipo === "contratos" ? "contrato" : (r.tipo_documento ?? r.document_type ?? parsed?.tipo),
      });
    } else {
      passthrough.push(r);
    }
  }
  console.info(
    `[enrichPNCP] raw=${raw.length} enrichable=${enrichable.length} passthrough=${passthrough.length} limit=${limit}`,
  );

  // Concorrência limitada para não estourar o gateway do PNCP
  const CONCURRENCY = 8;
  const fetched: PromiseSettledResult<{ parent: RawItem; items: PncpItemRaw[] }>[] = [];
  for (let i = 0; i < enrichable.length; i += CONCURRENCY) {
    const chunk = enrichable.slice(i, i + CONCURRENCY);
    const part = await Promise.allSettled(
      chunk.map(async (r) => {
        let parent = r;
        let target = {
          cnpj: (r.orgao_cnpj ?? "").replace(/\D/g, ""),
          ano: String(r.ano ?? ""),
          sequencial: String(r.numero).replace(/\D/g, ""),
        };

        if (String(r.tipo_documento ?? "").toLowerCase().includes("contrato")) {
          const compra = await resolvePncpCompraFromContract(target.cnpj, target.ano, target.sequencial);
          if (!compra) return { parent: r, items: [] };
          target = compra;
          parent = {
            ...r,
            orgao_cnpj: compra.cnpj,
            ano: compra.ano,
            numero: compra.sequencial,
            fornecedor: r.fornecedor ?? compra.fornecedor,
            tipo_documento: "edital",
            item_url: `/editais/${compra.cnpj}/${compra.ano}/${compra.sequencial}`,
          };
        }

        const items = await fetchPncpItens(target.cnpj, target.ano, target.sequencial, String(parent.tipo_documento ?? ""));
        return { parent, items };
      }),
    );
    fetched.push(...part);
  }

  const expanded: RawItem[] = [];
  const parentsFallback: RawItem[] = [];
  for (const s of fetched) {
    if (s.status !== "fulfilled") continue;
    const { parent, items } = s.value;
    if (!items || items.length === 0) {
      // Resultado oficial do PNCP sem itens individuais não deve virar card:
      // o usuário pediu lista de ITENS, não lista de processos/atas/editais.
      if (parent._source === "Outro" || parent._supplier) parentsFallback.push(parent);
      continue;
    }
    // Filtra itens cuja descrição tem ao menos 1 token da consulta
    const relevant = items.filter((it) => {
      const d = (it.descricao ?? "").toLowerCase();
      if (!d) return false;
      if (qTokens.length === 0) return true;
      return qTokens.some((t) => d.includes(t));
    });
    // Se nenhum item bater com a query, NÃO descarta: pega os itens com
    // valor unitário mesmo assim (podem ser variantes/sinônimos) e marca
    // como fallback de menor prioridade.
    const useItems = relevant.length > 0 ? relevant : items;
    for (const it of useItems) {
      const homologado = validPrice(it.valorUnitarioHomologado);
      const estimado = validPrice(it.valorUnitarioEstimado);
      const unit = homologado ?? estimado;
      const tipoVal: PriceResult["valorTipo"] = homologado
        ? "unitario_homologado"
        : estimado
          ? "unitario_estimado"
          : "desconhecido";
      // Sem valor unitário extraível: mantém só se descrição é específica
      // (o cliente ainda pode usar como evidência manual).
      if ((typeof unit !== "number" || unit <= 0) && !it.descricao) continue;
      expanded.push({
        ...parent,
        id: `${parent.id ?? `${parent.orgao_cnpj}-${parent.ano}-${parent.numero}`}-it${it.numeroItem ?? Math.random().toString(36).slice(2, 6)}`,
        objeto_compra: it.descricao ?? parent.objeto_compra,
        descricao: it.descricao ?? parent.descricao,
        valor_unitario_homologado: homologado,
        valor_unitario_estimado: estimado,
        valor_unitario: typeof unit === "number" ? unit : undefined,
        valor_total_item: it.valorTotalHomologado ?? it.valorTotal,
        unidade_medida: it.unidadeMedida ?? parent.unidade_medida,
        quantidade: it.quantidade,
        situacao: it.situacaoCompraItemNome ?? parent.situacao,
        _valorTipo: tipoVal,
      });
    }
  }

  // Passthrough (Firecrawl/web): SEMPRE mantém. Resultado web é evidência
  // qualitativa — o usuário pode abrir a fonte e validar o preço manualmente.
  // O ranqueador vai empurrar resultados sem unitário pra baixo.
  const kept = passthrough.map((r) => ({
    ...r,
    _valorTipo:
      (r._valorTipo ??
        (typeof r.valor_unitario_homologado === "number"
          ? "unitario_homologado"
          : typeof r.valor_unitario_estimado === "number" || typeof r.valor_unitario === "number"
            ? "unitario_estimado"
            : "desconhecido")) as PriceResult["valorTipo"],
  }));

  return [...expanded, ...parentsFallback, ...kept];
}

// Compras.gov.br — endpoint público de contratos (Dados Abertos)
// Faz busca alternativa por palavra-chave em contratos, com fallback silencioso.
async function fetchComprasGov(query: string): Promise<RawItem[]> {
  const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(query)}&tipos_documento=contrato&ordenacao=-data&pagina=1&pagina_tam=15&status=todos`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: RawItem[]; resultados?: RawItem[] };
    const items = data.items ?? data.resultados ?? [];
    return items.map((it) => ({ ...it, _source: "Compras.gov.br" }));
  } catch (e) {
    console.warn("Compras.gov.br fetch error", e);
    return [];
  }
}

// Portal da Transparência — atas/registros de preço (variante PNCP filtrada)
async function fetchTransparencia(query: string): Promise<RawItem[]> {
  const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(query)}&tipos_documento=ata&ordenacao=-data&pagina=1&pagina_tam=15&status=todos`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: RawItem[]; resultados?: RawItem[] };
    const items = data.items ?? data.resultados ?? [];
    return items.map((it) => ({ ...it, _source: "Transparência" }));
  } catch (e) {
    console.warn("Transparência fetch error", e);
    return [];
  }
}

// ============================================================
// TCE-CE — API de Dados Abertos do SIM (Sistema de Informação Municipal)
// ============================================================
// Retorna ITENS LICITADOS individuais de municípios cearenses já homologados.
// É a fonte de granularidade mais alta para o Ceará: cada linha é um item
// (descrição, unidade, quantidade, valor unitário, fornecedor vencedor).
//
// Estratégia tolerante: tentamos dois hosts candidatos e duas views.
// Se nenhuma responder (rede/geo-block), devolve [] silenciosamente.
const TCE_CE_HOSTS = [
  "https://api-dados-abertos.tce.ce.gov.br/sim",
  "https://api.tce.ce.gov.br/index.php/sim/1_0",
];
const TCE_CE_VIEWS = ["queryView_dv_itens_licitados", "queryView_dv_contratados"];

interface TCECERow {
  // nomes alternativos cobrindo as duas views — só os que existirem são usados
  id_item?: string | number;
  descricao_item?: string;
  objeto?: string;
  unidade_medida?: string;
  unidade?: string;
  quantidade?: number | string;
  quantidade_homologada?: number | string;
  valor_unitario?: number | string;
  valor_unitario_homologado?: number | string;
  valor_total?: number | string;
  valor_total_homologado?: number | string;
  nome_fornecedor?: string;
  razao_social_fornecedor?: string;
  cnpj_fornecedor?: string;
  cpf_cnpj_fornecedor?: string;
  nome_municipio?: string;
  municipio?: string;
  nome_orgao?: string;
  orgao?: string;
  cnpj_orgao?: string;
  numero_procedimento?: string | number;
  numero_licitacao?: string | number;
  ano_exercicio?: string | number;
  data_homologacao?: string;
  data?: string;
  modalidade?: string;
  [k: string]: unknown;
}

function numFromBR(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const cleaned = v.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function fetchTceCeView(host: string, view: string, query: string): Promise<TCECERow[]> {
  // Parametros heurísticos: tentamos `descricao_item` como filtro de texto.
  // Algumas instâncias usam `q` ou `objeto` — incluímos os dois.
  const params = new URLSearchParams({
    descricao_item: query,
    objeto: query,
    q: query,
    limit: "30",
  });
  const url = `${host}/${view}?${params.toString()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const j = (await res.json().catch(() => null)) as unknown;
    if (Array.isArray(j)) return j as TCECERow[];
    if (j && typeof j === "object") {
      const obj = j as Record<string, unknown>;
      for (const key of ["data", "items", "resultados", "rows", "result"]) {
        const arr = obj[key];
        if (Array.isArray(arr)) return arr as TCECERow[];
      }
    }
    return [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTCECE(query: string): Promise<RawItem[]> {
  const tasks: Promise<TCECERow[]>[] = [];
  for (const host of TCE_CE_HOSTS) {
    for (const view of TCE_CE_VIEWS) {
      tasks.push(fetchTceCeView(host, view, query));
    }
  }
  const settled = await Promise.allSettled(tasks);
  const rows: TCECERow[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") rows.push(...s.value);
    if (rows.length >= 120) break;
  }
  return rows.map((row, i): RawItem => {
    const descricao = (row.descricao_item ?? row.objeto ?? "").toString().trim();
    const unidade = (row.unidade_medida ?? row.unidade ?? "").toString().trim() || undefined;
    const qtd = numFromBR(row.quantidade_homologada ?? row.quantidade);
    const valUnit = numFromBR(row.valor_unitario_homologado ?? row.valor_unitario);
    const valTotal = numFromBR(row.valor_total_homologado ?? row.valor_total) ?? (qtd && valUnit ? qtd * valUnit : undefined);
    const fornecedor = (row.razao_social_fornecedor ?? row.nome_fornecedor ?? "").toString().trim() || undefined;
    const cnpjForn = (row.cpf_cnpj_fornecedor ?? row.cnpj_fornecedor ?? "").toString().replace(/\D/g, "");
    const orgao = (row.nome_orgao ?? row.orgao ?? row.nome_municipio ?? row.municipio ?? "").toString().trim() || undefined;
    const cnpjOrgao = (row.cnpj_orgao ?? "").toString().replace(/\D/g, "") || undefined;
    const municipio = (row.nome_municipio ?? row.municipio ?? "").toString().trim() || undefined;
    const numero = row.numero_procedimento ?? row.numero_licitacao;
    const ano = row.ano_exercicio;
    const data = (row.data_homologacao ?? row.data ?? "").toString();
    return {
      id: `tce-ce-${row.id_item ?? `${ano ?? ""}-${numero ?? ""}-${i}`}`,
      objeto_compra: descricao || undefined,
      descricao: descricao || undefined,
      unidade_medida: unidade,
      quantidade: qtd,
      valor_unitario_homologado: valUnit,
      valor_unitario: valUnit,
      valor_total_item: valTotal,
      fornecedor: fornecedor ?? (cnpjForn ? `CNPJ ${cnpjForn}` : undefined),
      orgao_nome: orgao,
      orgao_cnpj: cnpjOrgao,
      municipio_nome: municipio,
      uf: "CE",
      numero: numero ? String(numero) : undefined,
      ano: ano ? String(ano) : undefined,
      data_publicacao_pncp: data,
      modalidade_licitacao_nome: typeof row.modalidade === "string" ? row.modalidade : undefined,
      situacao_nome: "Homologado",
      tipo_documento: "ata",
      _source: "TCE-CE",
      _sourceName: "TCE-CE",
      _sourceDomain: "api-dados-abertos.tce.ce.gov.br",
      _valorTipo: valUnit ? "unitario_homologado" : "desconhecido",
    } as RawItem;
  }).filter((r) => Boolean(r.descricao || r.objeto_compra));
}

// Expansão inteligente de consulta: gera variações sinônimas via Lovable AI.
// Falha silenciosamente — devolve apenas a query original em caso de erro.
async function expandQuery(query: string, apiKey: string | undefined): Promise<string[]> {
  const base = query.trim();
  if (!apiKey) return [base];
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content:
              "Você é um especialista em compras públicas brasileiras. Gere 4 variações curtas (3-6 palavras) do termo, usando sinônimos técnicos, plural/singular, e termos equivalentes que aparecem em editais e atas de registro de preço. Responda APENAS um JSON array de strings, sem texto extra. Exemplo: [\"calça juvenil\", \"uniforme escolar calça\", ...]",
          },
          { role: "user", content: base },
        ],
        temperature: 0.2,
      }),
    });
    if (!res.ok) return [base];
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = data.choices?.[0]?.message?.content ?? "[]";
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [base];
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [base];
    const variants = arr
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 80);
    return Array.from(new Set([base, ...variants])).slice(0, 5);
  } catch (e) {
    console.warn("expandQuery failed:", (e as Error).message);
    return [base];
  }
}

// Busca aberta via Firecrawl em portais oficiais .gov.br (quando o conector estiver ativo).
// Caso FIRECRAWL_API_KEY não esteja configurada, retorna [] silenciosamente.
function sourceMetaForUrl(url: string | undefined, catalog: { domain: string; name: string }[]) {
  if (!url) return { domain: undefined, name: undefined };
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    const match = catalog.find((s) => {
      const domainHost = s.domain.split("/")[0].replace(/^www\./, "");
      return host === domainHost || host.endsWith(`.${domainHost}`) || domainHost.endsWith(`.${host}`);
    });
    return { domain: match?.domain ?? host, name: match?.name ?? host };
  } catch {
    return { domain: undefined, name: undefined };
  }
}

async function fetchFirecrawlWeb(query: string, siteFilters: string[], catalog: { domain: string; name: string }[] = []): Promise<RawItem[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];
  // Constrói consulta com OR de domínios priorizados pelo catálogo (price_sources)
  const sites =
    siteFilters.length > 0
      ? `(${siteFilters.slice(0, 8).map((d) => `site:${d}`).join(" OR ")})`
      : "site:gov.br";
  const q = `${query} (contrato OR ata OR pregão OR licitação OR homologação) ${sites}`;
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q, limit: 20, lang: "pt", country: "br" }),
    });
    if (!res.ok) {
      console.warn("Firecrawl search HTTP", res.status);
      return [];
    }
    const json = (await res.json()) as {
      data?: { web?: Array<{ url?: string; title?: string; description?: string }> } | Array<{ url?: string; title?: string; description?: string }>;
      web?: Array<{ url?: string; title?: string; description?: string }>;
    };
    const arr = Array.isArray(json.data)
      ? json.data
      : (json.data?.web ?? json.web ?? []);
    return arr.map((r, i): RawItem => {
      const meta = sourceMetaForUrl(r.url, catalog);
      return {
        id: `fc-${i}-${(r.url ?? "").slice(-40)}`,
        title: r.title ?? r.url ?? "Resultado web",
        description: r.description ?? "",
        url: r.url,
        tipo_documento: /ata/i.test(`${r.title} ${r.url}`) ? "ata" : /contrato/i.test(`${r.title} ${r.url}`) ? "contrato" : /edital|pregao|preg%C3%A3o/i.test(`${r.title} ${r.url}`) ? "edital" : "outro",
        _source: meta.name ?? "Web oficial",
        _sourceDomain: meta.domain,
        _sourceName: meta.name,
      };
    });
  } catch (e) {
    console.warn("Firecrawl error", (e as Error).message);
    return [];
  }
}

// Busca FORNECEDORES REAIS na internet (fabricantes/distribuidores B2B,
// catálogos, e-commerces especializados). Exclui marketplaces proibidos.
// Inciso V da Lei 14.133/2021 — cotação direta com fornecedores.
async function fetchFirecrawlSuppliers(query: string): Promise<RawItem[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];
  // Operadores de exclusão para banir marketplaces poluentes
  const excludes = "-site:mercadolivre.com.br -site:shopee.com.br -site:aliexpress.com -site:olx.com.br -site:facebook.com -site:amazon.com.br";
  const q = `${query} preço "R$" (fornecedor OR fabricante OR distribuidor OR atacado OR catálogo OR cotação) ${excludes}`;
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: q, limit: 15, lang: "pt", country: "br" }),
    });
    if (!res.ok) {
      console.warn("Firecrawl suppliers HTTP", res.status);
      return [];
    }
    const json = (await res.json()) as {
      data?: { web?: Array<{ url?: string; title?: string; description?: string }> } | Array<{ url?: string; title?: string; description?: string }>;
      web?: Array<{ url?: string; title?: string; description?: string }>;
    };
    const arr = Array.isArray(json.data) ? json.data : (json.data?.web ?? json.web ?? []);
    return arr
      .filter((r) => {
        const blob = `${r.url ?? ""} ${r.title ?? ""}`.toLowerCase();
        return !FORBIDDEN.some((f) => blob.includes(f));
      })
      .map((r, i): RawItem => {
        // Tenta extrair preço do snippet ("R$ 1.234,56" / "R$1234,56")
        const txt = `${r.title ?? ""} ${r.description ?? ""}`;
        const m = txt.match(/R\$\s*([\d.]+,\d{2}|\d+(?:[.,]\d{2})?)/i);
        let priceNum: number | undefined;
        if (m) {
          const norm = m[1].replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
          const p = parseFloat(norm);
          if (isFinite(p) && p > 0 && p < 10_000_000) priceNum = p;
        }
        let host = "";
        try { host = r.url ? new URL(r.url).hostname.replace(/^www\./, "") : ""; } catch { /* noop */ }
        return {
          id: `sup-${i}-${(r.url ?? "").slice(-40)}`,
          title: r.title ?? r.url ?? "Fornecedor",
          description: r.description ?? "",
          url: r.url,
          orgao_nome: host || "Fornecedor",
          valor_unitario: priceNum,
          tipo_documento: "outro",
          _source: host || "Fornecedor",
          _sourceDomain: host || undefined,
          _sourceName: host || "Fornecedor",
          _supplier: true,
        } as RawItem;
      });
  } catch (e) {
    console.warn("Firecrawl suppliers error", (e as Error).message);
    return [];
  }
}

// ============================================================
// MINERAÇÃO DE ANEXOS (PDFs de Atas / Termos de Homologação) e
// TABELAS HTML em portais de transparência municipal/estadual.
// ============================================================
// Três estratégias plugáveis ao pipeline:
//   (A) Google Dorking via Firecrawl  → encontra PDFs oficiais
//   (B) Scrape de PDF/markdown        → regex de itens (ancoragem reversa)
//   (C) Scrape de tabelas HTML        → <tr><td> com descrição/qtd/valor

// Heurística: linhas de tabela em texto livre seguem o padrão
// "<desc...> <UN|CX|KG|...> <qtd> <R$ unit> <R$ total>"
// Parser de ancoragem reversa: localiza pares de R$, recua para qtd/unidade
// e pega a descrição imediatamente anterior.
const UNIDADES_RE = /\b(UN|UND|UNID|CX|KG|PC|PCT|PAR|MT|ML|LT|L|CM|M|M2|M3|SC|GL|RL|RES|FR|CJ|SRV|HR|DZ|KIT)\b/i;
function parsePriceBR(s: string): number | undefined {
  if (!s) return undefined;
  const norm = s.replace(/\s/g, "").replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
function parseQtyBR(s: string): number | undefined {
  if (!s) return undefined;
  const norm = s.replace(/\s/g, "").replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Extrai itens estruturados de um texto bruto (markdown ou texto extraído de PDF).
 * Estratégia: para cada par "<num1> <num2>" que pareça (R$ unitário, R$ total),
 * recua tokens à esquerda procurando quantidade + unidade + descrição.
 */
function extractItemsFromText(text: string, sourceUrl: string, sourceLabel: string): RawItem[] {
  if (!text || text.length < 60) return [];
  // Normaliza espaços/quebras
  const cleaned = text.replace(/\u00A0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n");
  const lines = cleaned.split("\n").map((l) => l.trim()).filter((l) => l.length > 8);
  const items: RawItem[] = [];
  // Padrão 1: linha única "<desc> <UN> <qtd> R$ <unit> R$ <total>"
  const reLine =
    /^(?<desc>.+?)\s+(?<un>UN|UND|UNID|CX|KG|PC|PCT|PAR|MT|ML|LT|L|CM|M|M2|M3|SC|GL|RL|RES|FR|CJ|SRV|HR|DZ|KIT)\s+(?<qtd>[\d.]+(?:,\d+)?)\s+(?:R\$\s*)?(?<unit>[\d.]+,\d{2})\s+(?:R\$\s*)?(?<total>[\d.]+,\d{2})\s*$/i;
  // Padrão 2: separado por |  (tabelas markdown)
  const reTable =
    /^\|\s*(?<n>\d+)?\s*\|\s*(?<desc>[^|]{8,400})\|\s*(?<un>[A-Za-z./]{1,8})\s*\|\s*(?<qtd>[\d.,]+)\s*\|\s*R?\$?\s*(?<unit>[\d.]+,\d{2})\s*\|\s*R?\$?\s*(?<total>[\d.]+,\d{2})\s*\|/i;

  let counter = 0;
  for (const line of lines) {
    if (counter > 200) break;
    const mTable = line.match(reTable);
    const m = mTable ?? line.match(reLine);
    if (!m || !m.groups) continue;
    const g = m.groups;
    const desc = cleanItemTitle(g.desc);
    if (!desc || desc.length < 6) continue;
    if (looksLikeProcessNumberTitle(desc)) continue;
    const valUnit = parsePriceBR(g.unit);
    const valTotal = parsePriceBR(g.total);
    const qtd = parseQtyBR(g.qtd);
    if (!valUnit && !valTotal) continue;
    counter++;
    items.push({
      id: `mined-${counter}-${sourceUrl.slice(-30)}`,
      objeto_compra: desc,
      descricao: desc,
      unidade_medida: g.un?.toUpperCase(),
      quantidade: qtd,
      valor_unitario_homologado: valUnit,
      valor_unitario: valUnit,
      valor_total_item: valTotal ?? (qtd && valUnit ? qtd * valUnit : undefined),
      tipo_documento: /ata/i.test(sourceUrl) ? "ata" : /contrato/i.test(sourceUrl) ? "contrato" : "outro",
      url: sourceUrl,
      _source: sourceLabel,
      _sourceName: sourceLabel,
      _sourceDomain: (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { return undefined; } })(),
      _valorTipo: valUnit ? "unitario_homologado" : "global",
      situacao_nome: "Homologado",
    });
  }
  return items;
}

/**
 * (A) Google Dorking via Firecrawl — busca PDFs oficiais de Atas/Homologação
 * em portais .gov.br (foco prefeituras / transparência). Devolve URLs candidatas.
 */
async function dorkPdfAttachments(query: string): Promise<string[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];
  const q = `${query} ("Ata de Registro de Preços" OR "Termo de Homologação" OR "Mapa de Apuração") filetype:pdf site:gov.br`;
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, limit: 8, lang: "pt", country: "br" }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      data?: { web?: Array<{ url?: string }> } | Array<{ url?: string }>;
      web?: Array<{ url?: string }>;
    };
    const arr = Array.isArray(j.data) ? j.data : (j.data?.web ?? j.web ?? []);
    return arr
      .map((r) => r.url)
      .filter((u): u is string => Boolean(u) && /\.pdf(\?|$)/i.test(u!) && !FORBIDDEN.some((f) => u!.toLowerCase().includes(f)));
  } catch (e) {
    console.warn("dorkPdfAttachments error", (e as Error).message);
    return [];
  }
}

/**
 * (B) Scrape de um PDF → markdown via Firecrawl, e roda extractItemsFromText.
 * Firecrawl entrega texto extraído de PDF como markdown.
 */
async function scrapeAndMine(url: string, label: string): Promise<RawItem[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown", "html"], onlyMainContent: true }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      data?: { markdown?: string; html?: string };
      markdown?: string;
      html?: string;
    };
    const md = j.data?.markdown ?? j.markdown ?? "";
    const html = j.data?.html ?? j.html ?? "";
    const fromText = extractItemsFromText(md, url, label);
    const fromTable = extractItemsFromHtmlTables(html, url, label);
    // Dedup simples por (desc|valor)
    const seen = new Set<string>();
    const merged = [...fromTable, ...fromText].filter((it) => {
      const k = `${(it.descricao ?? "").slice(0, 80)}|${it.valor_unitario ?? ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // Camada de inferência ontológica (LLM): se regex/HTML extraíram pouco,
    // delega para o motor de ontologia o trabalho de identificar itens reais
    // dentro do "lixo textual" (PDFs aglutinados, layouts não-tabulares).
    if (merged.length < 5 && (md.length > 400 || html.length > 1000)) {
      const corpus = md && md.length > 400 ? md : html.replace(/<[^>]+>/g, " ");
      const fromLlm = await ontologicalExtract(corpus, url, label);
      for (const it of fromLlm) {
        const k = `${(it.descricao ?? "").slice(0, 80)}|${it.valor_unitario ?? ""}`;
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(it);
      }
    }
    return merged.slice(0, 60);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// MOTOR DE INFERÊNCIA ONTOLÓGICA (LLM)
// ============================================================
// Recebe texto bruto (markdown de PDF ou HTML denudado) e usa Lovable AI
// para identificar a "assinatura genética" de itens reais (entidade material
// + entidade quantitativa + entidade financeira), ignorando objetos de
// edital, valores globais e ruído jurídico.

const ONTOLOGY_PROMPT = `Você é um Motor de Inferência Ontológica especializado em Contratos Públicos.

Você receberá um texto bruto extraído de PDFs ou HTMLs desestruturados de diversas prefeituras. O texto pode estar quebrado, aglutinado, em formato de tabela ou texto corrido.

Sua missão é escanear o texto e identificar a "Assinatura Genética" de itens de compra. Ignore layouts e foque puramente nas entidades conceituais.

A ONTOLOGIA DE UM ITEM (intersecção OBRIGATÓRIA de 3 atributos):
1. ENTIDADE MATERIAL/SERVIÇO ESPECÍFICO: algo que pode ser entregue, estocado ou medido (ex.: "Papel A4", "Locação de Impressora 50ppm", "Calça em helanca branca"). NUNCA conceitos abstratos como "Contratação de empresa para...".
2. ENTIDADE QUANTITATIVA: unidade de medida clara (UN, KG, M2, LOTE, MÊS, SERVIÇO, PCT) atrelada a uma quantidade numérica.
3. ENTIDADE FINANCEIRA: valor monetário (R$, vírgula com 2 casas). Pode ser unitário e/ou total.

Se o bloco não tiver os 3 juntos, NÃO É UM ITEM (provavelmente é o objeto do edital ou texto jurídico).

HEURÍSTICA AGLUTINADO: PDFs frequentemente juntam tudo em uma linha só, ex.:
"01 LOCAÇÃO DE IMPRESSORA MULTIFUNCIONAL UND 12 150,00 1800,00 HP M428FDW"
→ desc="LOCAÇÃO DE IMPRESSORA MULTIFUNCIONAL HP M428FDW", unidade="UND", quantidade=12, valor_unitario=150.00, valor_total=1800.00.

EXCLUSÕES:
- Valores globais de ata/processo sem produto específico → IGNORE.
- Se Quantidade × Unitário não bater nem aproximadamente com Total e não houver explicação lógica → descarte.

SAÍDA: retorne APENAS um JSON no formato {"itens": [...]} onde cada item tem as chaves: "descricao" (string), "unidade" (string), "quantidade" (number), "valor_unitario" (number), "valor_total" (number). Use ponto como separador decimal. Se nenhum item válido for detectado, retorne {"itens": []}.`;

async function ontologicalExtract(
  text: string,
  sourceUrl: string,
  sourceLabel: string,
): Promise<RawItem[]> {
  const apiKey = process.env.LOVABLE_API_KEY;
  if (!apiKey || !text) return [];
  // Janela: foca trechos com densidade de tabela / preços.
  const MAX = 18_000;
  let corpus = text;
  if (corpus.length > MAX) {
    const re = /\b(item|descric[aã]o|especifica[cç][aã]o|quantidade|qtd|valor\s+unit|valor\s+total|unidade|und|pre[cç]o|r\$)\b/gi;
    const wins: string[] = [];
    const W = 2500;
    let lastEnd = -W;
    let m: RegExpExecArray | null;
    while ((m = re.exec(corpus)) !== null) {
      const s = Math.max(0, m.index - W / 2);
      if (s < lastEnd) continue;
      const e = Math.min(corpus.length, m.index + W / 2);
      wins.push(corpus.slice(s, e));
      lastEnd = e;
      if (wins.join("\n---\n").length > MAX) break;
    }
    corpus = wins.length > 0 ? wins.join("\n---\n").slice(0, MAX) : corpus.slice(0, MAX);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  let content = "";
  try {
    const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: ONTOLOGY_PROMPT },
          { role: "user", content: `Texto bruto:\n\n${corpus}` },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
    content = j.choices?.[0]?.message?.content ?? "";
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
  let parsed: { itens?: Array<Record<string, unknown>> } = {};
  try {
    const m = content.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(m ? m[0] : content);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed.itens) ? parsed.itens : [];
  const host = (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { return undefined; } })();
  const docType: RawItem["tipo_documento"] = /ata/i.test(sourceUrl)
    ? "ata"
    : /contrato/i.test(sourceUrl)
      ? "contrato"
      : "outro";
  const out: RawItem[] = [];
  for (let i = 0; i < arr.length && out.length < 80; i++) {
    const it = arr[i];
    const desc = cleanItemTitle(String(it.descricao ?? "").trim());
    if (!desc || desc.length < 6) continue;
    if (looksLikeProcessNumberTitle(desc)) continue;
    const toNum = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
      if (typeof v === "string") return parsePriceBR(v) ?? parseQtyBR(v);
      return undefined;
    };
    const valUnit = toNum(it.valor_unitario);
    const valTotal = toNum(it.valor_total);
    const qtd = toNum(it.quantidade);
    const un = it.unidade ? String(it.unidade).toUpperCase().slice(0, 8) : undefined;
    if (!valUnit && !valTotal) continue;
    if (!qtd && !un) continue; // exige entidade quantitativa
    out.push({
      id: `mined-llm-${i}-${sourceUrl.slice(-30)}`,
      objeto_compra: desc,
      descricao: desc,
      unidade_medida: un,
      quantidade: qtd,
      valor_unitario_homologado: valUnit,
      valor_unitario: valUnit,
      valor_total_item: valTotal ?? (qtd && valUnit ? qtd * valUnit : undefined),
      tipo_documento: docType,
      url: sourceUrl,
      _source: sourceLabel,
      _sourceName: sourceLabel,
      _sourceDomain: host,
      _valorTipo: valUnit ? "unitario_homologado" : "global",
      situacao_nome: "Homologado",
    });
  }
  return out;
}

/**
 * (C) Mineração de tabelas HTML: percorre <table><tr><td> e identifica
 * colunas plausíveis de descrição/unidade/quantidade/valor unitário/valor total.
 */
function extractItemsFromHtmlTables(html: string, sourceUrl: string, sourceLabel: string): RawItem[] {
  if (!html || html.length < 200) return [];
  const items: RawItem[] = [];
  // Tira scripts/styles para reduzir ruído
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const tables = stripped.match(/<table[\s\S]*?<\/table>/gi) ?? [];
  for (const table of tables) {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
    if (rows.length < 2) continue;
    for (const row of rows) {
      const cellsRaw = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [];
      if (cellsRaw.length < 3 || cellsRaw.length > 12) continue;
      const cells = cellsRaw.map((c) =>
        c.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim(),
      );
      // Identifica colunas de preço (BR): contém "R$" ou padrão "X,YY"
      const priceIdx: number[] = [];
      cells.forEach((c, i) => {
        if (/r\$\s*[\d.]+,\d{2}/i.test(c) || /^[\d.]+,\d{2}$/.test(c)) priceIdx.push(i);
      });
      if (priceIdx.length === 0) continue;
      // Descrição = primeira célula longa com letras (não-numérica)
      const descIdx = cells.findIndex((c) => c.length >= 10 && /[a-zà-ÿ]{4,}/i.test(c) && !/r\$/i.test(c));
      if (descIdx < 0) continue;
      const desc = cleanItemTitle(cells[descIdx]);
      if (!desc || desc.length < 6 || looksLikeProcessNumberTitle(desc)) continue;
      // Unidade = primeira célula curta que case com UNIDADES_RE
      let un: string | undefined;
      for (let i = 0; i < cells.length; i++) {
        if (i === descIdx) continue;
        if (UNIDADES_RE.test(cells[i]) && cells[i].length <= 8) { un = cells[i].toUpperCase(); break; }
      }
      // Quantidade = célula numérica entre desc e primeiro preço (não-monetária)
      let qtd: number | undefined;
      for (let i = descIdx + 1; i < priceIdx[0]; i++) {
        if (i === descIdx) continue;
        if (/^[\d.]+(?:,\d+)?$/.test(cells[i]) && !/,\d{2}$/.test(cells[i])) {
          qtd = parseQtyBR(cells[i]);
          break;
        }
      }
      const valUnit = parsePriceBR(cells[priceIdx[0]].replace(/^r\$\s*/i, ""));
      const valTotal =
        priceIdx.length > 1 ? parsePriceBR(cells[priceIdx[priceIdx.length - 1]].replace(/^r\$\s*/i, "")) : undefined;
      if (!valUnit && !valTotal) continue;
      items.push({
        id: `mined-html-${items.length}-${sourceUrl.slice(-30)}`,
        objeto_compra: desc,
        descricao: desc,
        unidade_medida: un,
        quantidade: qtd,
        valor_unitario_homologado: valUnit,
        valor_unitario: valUnit,
        valor_total_item: valTotal ?? (qtd && valUnit ? qtd * valUnit : undefined),
        tipo_documento: /ata/i.test(sourceUrl) ? "ata" : /contrato/i.test(sourceUrl) ? "contrato" : "outro",
        url: sourceUrl,
        _source: sourceLabel,
        _sourceName: sourceLabel,
        _sourceDomain: (() => { try { return new URL(sourceUrl).hostname.replace(/^www\./, ""); } catch { return undefined; } })(),
        _valorTipo: valUnit ? "unitario_homologado" : "global",
        situacao_nome: "Homologado",
      });
      if (items.length > 200) return items;
    }
  }
  return items;
}

/**
 * Orquestrador: dorking de PDFs + scrape paralelo com limite de concorrência.
 * Time-boxed para não estourar o budget do servidor.
 */
async function mineAttachments(query: string, extraUrls: string[] = []): Promise<RawItem[]> {
  if (!process.env.FIRECRAWL_API_KEY) return [];
  const dorked = await dorkPdfAttachments(query);
  const urls = Array.from(new Set([...dorked, ...extraUrls])).slice(0, 6);
  if (urls.length === 0) return [];
  const CONCURRENCY = 3;
  const out: RawItem[] = [];
  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    const chunk = urls.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((u) => {
        let host = "";
        try { host = new URL(u).hostname.replace(/^www\./, ""); } catch { /* noop */ }
        return scrapeAndMine(u, host || "Anexo");
      }),
    );
    for (const s of settled) if (s.status === "fulfilled") out.push(...s.value);
    if (out.length > 150) break;
  }
  return out;
}

// Lê catálogo de fontes (price_sources) ordenado por prioridade e taxa de sucesso.
async function loadActiveSources(): Promise<{ domain: string; name: string }[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("price_sources")
      .select("domain, name, priority, hits, successes")
      .eq("enabled", true)
      .order("priority", { ascending: false })
      .limit(60);
    if (error || !data) return [];
    return data.map((d) => ({ domain: d.domain, name: d.name }));
  } catch {
    return [];
  }
}

// Descobre novos domínios .gov.br a partir das URLs retornadas e os salva no catálogo.
async function registerDiscoveredDomains(urls: string[], known: Set<string>) {
  const news = new Map<string, string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const host = new URL(u).hostname.replace(/^www\./, "");
      if (!host.endsWith(".gov.br") && !host.endsWith(".org.br") && !host.endsWith(".com.br")) continue;
      if (known.has(host)) continue;
      news.set(host, host);
      if (news.size >= 5) break;
    } catch { /* ignore */ }
  }
  if (news.size === 0) return;
  try {
    const rows = Array.from(news.values()).map((d) => ({
      name: d,
      domain: d,
      category: d.endsWith(".gov.br") ? "auto-gov" : "auto",
      inciso: "III",
      priority: 30,
      discovered_auto: true,
    }));
    await supabaseAdmin.from("price_sources").upsert(rows, { onConflict: "domain", ignoreDuplicates: true });
  } catch (e) {
    console.warn("registerDiscoveredDomains failed", (e as Error).message);
  }
}

// Constrói a URL absoluta da página oficial do PNCP a partir dos campos do item.
function buildPncpUrl(raw: RawItem): string | undefined {
  // Fontes não-PNCP (TCE-CE, fornecedores, web): preserva url original ou nada.
  if (raw._source && raw._source !== "PNCP" && raw._source !== "Transparência" && raw._source !== "Compras.gov.br") {
    const u = (raw.url as string | undefined) || (raw.item_url as string | undefined);
    return u && /^https?:\/\//i.test(u) ? u : undefined;
  }
  const tipo = (raw.tipo_documento ?? "").toLowerCase();
  const path = (raw.item_url as string | undefined) || (raw.url as string | undefined);
  if (path && /^https?:\/\//i.test(path)) return path;
  if (path && path.startsWith("/")) return `https://pncp.gov.br/app${path}`;
  const cnpj = (raw.orgao_cnpj ?? "").replace(/\D/g, "");
  const ano = raw.ano ? String(raw.ano) : "";
  const seq = raw.numero ? String(raw.numero).replace(/\D/g, "") : "";
  if (cnpj && ano && seq) {
    const seg = tipo.includes("ata")
      ? "atas"
      : tipo.includes("contrato")
        ? "contratos"
        : "editais";
    return `https://pncp.gov.br/app/${seg}/${cnpj}/${ano}/${seq}`;
  }
  return undefined;
}

function isSupplierOrCommercial(r: PriceResult): boolean {
  const source = (r.origem || "").toLowerCase();
  return Boolean(r.fornecedor) && !/(pncp|compras\.gov|transpar|tce|tribunal|gov\.br)/i.test(source);
}

function isGranularItemResult(r: PriceResult): boolean {
  const title = r.titulo || "";
  if (!title || looksLikeProcessNumberTitle(title) || looksLikeProcessObject(title) || looksLikeRawDocumentText(title)) {
    return false;
  }
  if (isSupplierOrCommercial(r)) return true;
  if (r.valorTipo === "unitario_homologado" || r.valorTipo === "unitario_estimado") return true;
  // Afrouxa: aceita item se tem qualquer sinal de granularidade — unidade,
  // quantidade, valor total OU apenas um valor unitário visível com título
  // que não parece processo (já filtrado acima). Sem isso, itens minerados
  // de PDF/HTML eram silenciosamente descartados.
  return Boolean(r.unidade || r.quantidade || r.valorTotal || typeof r.valor === "number");
}

function summarizeSources(results: PriceResult[], catalog: { domain: string; name: string }[]): SearchSourceStatus[] {
  const base = ["PNCP", "Compras.gov.br", "TCE-CE", "Anexos (PDF/HTML)", ...catalog.slice(0, 8).map((s) => s.name)];
  const map = new Map<string, SearchSourceStatus>();
  for (const name of base) {
    if (!name) continue;
    map.set(name, { name, domain: catalog.find((s) => s.name === name)?.domain, total: 0 });
  }
  for (const r of results) {
    const name = r.origem || "Outra fonte";
    const current = map.get(name) ?? { name, total: 0 };
    current.total += 1;
    map.set(name, current);
  }
  return Array.from(map.values()).filter((s, i) => s.total > 0 || i < 8).slice(0, 12);
}

function toResult(raw: RawItem): PriceResult {
  // Título do ITEM (descrição do objeto comprado) tem prioridade ABSOLUTA
  // sobre o nome/número do processo. O PNCP costuma retornar o número da
  // contratação em `title` (ex.: "nº 20260186 SEMED/2026") — isso é
  // metadado, não descrição do item.
  const objetoRaw = (raw.objeto_compra || raw.descricao || raw.description || "").toString().trim();
  const processoRaw = (raw.title || "").toString().trim();
  const objeto = cleanItemTitle(objetoRaw);
  const processo = cleanItemTitle(processoRaw);

  // Pontua qualidade de cada candidato: descrição real ganha sobre número.
  const score = (s: string): number => {
    if (!s || s === "Sem título") return -1;
    if (looksLikeProcessNumberTitle(s)) return 0;
    let q = 1;
    if (s.length >= 20 && s.length <= 160) q += 2;
    if (/[a-zà-ÿ]{4,}/i.test(s)) q += 1; // tem palavra real
    if (looksLikeRawDocumentText(s)) q -= 1;
    return q;
  };
  const ranked = [
    { s: objeto, q: score(objeto), src: "objeto" as const },
    { s: processo, q: score(processo), src: "processo" as const },
  ]
    .filter((c) => c.s)
    .sort((a, b) => b.q - a.q || a.s.length - b.s.length);

  const titulo = ranked[0]?.s || "Sem título";
  const subtitulo =
    ranked[1] && ranked[1].s && ranked[1].s !== titulo && ranked[1].q >= 0
      ? ranked[1].s
      : undefined;
  const descricao = objetoRaw || processoRaw || titulo;
  // Prioriza valor UNITÁRIO/HOMOLOGADO do item sobre valor total do processo
  const valor =
    typeof raw.valor_unitario_homologado === "number"
      ? raw.valor_unitario_homologado
      : typeof raw.valor_unitario_estimado === "number"
        ? raw.valor_unitario_estimado
        : typeof raw.valor_unitario === "number"
          ? raw.valor_unitario
          : typeof raw.valor_homologado === "number"
            ? raw.valor_homologado
            : typeof raw.valor_estimado === "number"
              ? raw.valor_estimado
              : typeof raw.valor_global === "number"
                ? raw.valor_global
                : typeof raw.valorTotalEstimado === "number"
                  ? raw.valorTotalEstimado
                  : null;
  const data = raw.data_publicacao_pncp || raw.data || "";
  const situacao = (raw.situacao_nome || raw.situacao || "").toString();
  const homologado = /homologad|adjudicad|conclu/i.test(situacao) || (raw.tipo_documento || "").includes("ata");
  const tipo = (raw.tipo_documento || "").toLowerCase();
  const documento: PriceResult["documento"] = tipo.includes("ata")
    ? "ata"
    : tipo.includes("contrato")
      ? "contrato"
      : tipo.includes("edital")
        ? "edital"
        : "outro";
  const id = String(raw.id ?? `${raw.numero ?? ""}-${raw.ano ?? ""}-${Math.random().toString(36).slice(2, 8)}`);

  // Tipo de valor — preferência ao já marcado pelo enrich
  const valorTipo: PriceResult["valorTipo"] =
    raw._valorTipo ??
    (typeof raw.valor_unitario_homologado === "number"
      ? "unitario_homologado"
      : typeof raw.valor_unitario_estimado === "number" || typeof raw.valor_unitario === "number"
        ? "unitario_estimado"
        : typeof raw.valor_global === "number" || typeof raw.valorTotalEstimado === "number"
          ? "global"
          : "desconhecido");

  return {
    id,
    titulo: String(titulo),
    subtitulo,
    descricao: String(descricao),
    unidade: raw.unidade_medida,
    quantidade: typeof raw.quantidade === "number" ? raw.quantidade : null,
    valor,
    valorTotal:
      typeof raw.valor_total_item === "number"
        ? raw.valor_total_item
        : typeof raw.valor_global === "number"
          ? raw.valor_global
          : typeof raw.valorTotalEstimado === "number"
            ? raw.valorTotalEstimado
            : typeof raw.quantidade === "number" && typeof valor === "number"
              ? raw.quantidade * valor
              : valor,
    valorTipo,
    fornecedor: raw.fornecedor ?? (raw._supplier ? raw.orgao_nome : undefined),
    orgao: raw.orgao_nome,
    cnpj: raw.orgao_cnpj,
    municipio: raw.municipio_nome,
    uf: raw.uf,
    data,
    modalidade: raw.modalidade_licitacao_nome,
    situacao,
    numero: raw.numero,
    ano: raw.ano ? String(raw.ano) : undefined,
    origem: (raw._sourceName || raw["_source"] || "PNCP") as string,
    documento,
    url: buildPncpUrl(raw),
    homologado,
    scoreTextual: 0,
    scoreSemantico: 0,
    scoreJuridico: 0,
    scoreGeografico: 0,
    scoreTecnico: 0,
    scoreFinal: 0,
  };
}

function applyJuridicScore(r: PriceResult, ultimosMeses: number): PriceResult {
  let s = 0.4;
  if (r.homologado) s += 0.35;
  if (r.cnpj && r.cnpj.replace(/\D/g, "").length === 14) s += 0.1;
  if (r.orgao) s += 0.05;
  if (r.data) {
    const d = new Date(r.data);
    if (!isNaN(d.getTime())) {
      const months = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30);
      if (months <= ultimosMeses) s += 0.1;
      if (months > 12) s -= 0.2;
    }
  }
  return { ...r, scoreJuridico: Math.max(0, Math.min(1, s)) };
}

export const searchPrices = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => FilterSchema.parse(input))
  .handler(async ({ data }): Promise<SearchResponse> => {
    const t0 = Date.now();
    const apiKey = process.env.LOVABLE_API_KEY;
    const pagina = data.pagina ?? 1;
    const ultimosMeses = data.ultimosMeses ?? 12;

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
    // Mineração de anexos (PDFs/HTML de Atas e Termos de Homologação)
    // Roda só na variante principal para limitar custo do Firecrawl.
    tasks.push(mineAttachments(data.query));
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

    // Filtro por palavras-chave obrigatórias
    if (data.keywords && data.keywords.length > 0) {
      const kws = data.keywords.map((k) => k.toLowerCase());
      results = results.filter((r) => {
        const blob = `${r.titulo} ${r.descricao}`.toLowerCase();
        return kws.every((k) => blob.includes(k));
      });
    }

    // Filtro modo exato — todos os tokens do título devem aparecer
    if (mode === "exact" || mode === "all_keywords") {
      const need = tokenize(data.query);
      if (need.length > 0) {
        results = results.filter((r) => {
          const blob = tokenize(`${r.titulo} ${r.descricao}`);
          const set = new Set(blob);
          return need.every((t) => set.has(t));
        });
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
    const softPenalty = new Map<string, number>();
    const addPen = (id: string, p: number) =>
      softPenalty.set(id, (softPenalty.get(id) ?? 0) + p);
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

    return {
      results,
      total: results.length,
      pagina,
      pageSize: 20,
      query: data.query,
      tookMs: Date.now() - t0,
      sources: summarizeSources(results, catalog),
    };
  });