/**
 * Núcleo do pipeline de busca: helpers HTTP/PNCP, fontes externas,
 * mining, ontologia e ranking. Extraído de search.functions.ts para
 * que o arquivo do serverFn fique focado só no entrypoint.
 *
 * NÃO mistura serverFns aqui — só funções puras/server-only chamadas
 * pelo searchPrices.
 */
import { z } from "zod";
import type { PriceResult, SearchSourceStatus } from "../types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import { safeUnitValue } from "../pncp-rules";
import { searchComprasGovByKeyword, type ComprasGovUnified } from "../compras-gov.server";
import { fetchM2aListing, fetchM2aPncpRef } from "../crawler/m2a-client.server";

// Suprime "unused" enquanto o split é parcial — z é usado em validações inline.
void z;


export const asJson = <T,>(v: T): Json => v as unknown as Json;

// ============================================================
// PNCP HTTP helper — User-Agent profissional + exp-backoff em 429/5xx
// ============================================================
// A API do PNCP é instável sob carga (429/502/503/504 frequentes).
// Centraliza headers, timeout e retry para todas as chamadas PNCP.
export const PNCP_UA = "Petrus-IA-DataEngine/1.0 (+cotacao)";

export async function pncpFetchJson<T>(
  url: string,
  opts: { timeoutMs?: number; attempts?: number } = {},
): Promise<T | null> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let delay = 700;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": PNCP_UA },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      // Retry em 429 e 5xx (com backoff exponencial + jitter leve)
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        if (i === attempts - 1) {
          console.warn(`[pncp] giving up url=${url.slice(0, 120)} status=${res.status}`);
          return null;
        }
        await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * 250)));
        delay *= 2;
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(timer);
      if (i === attempts - 1) {
        console.warn(`[pncp] fetch err url=${url.slice(0, 120)} err=${(e as Error).message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * 250)));
      delay *= 2;
    }
  }
  return null;
}
export const FORBIDDEN = [
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
export function looksLikeMultiItem(text: string): boolean {
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
export function cleanItemTitle(raw: string | undefined): string {
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
export function looksLikeRawDocumentText(text: string): boolean {
  const t = (text || "").toLowerCase();
  if (t.length > 350) return true;
  if (/\b(é\s+objeto\s+do\s+presente|cl[aá]usula|p[aá]ragrafo\s+[uú]nico|considerando\s+que|nos\s+termos\s+da\s+lei)\b/.test(t)) return true;
  return false;
}

// Detecta descrição de PROCESSO (não-item): "O objeto do presente contrato é
// a compra/aquisição de X". Não traz especificação técnica de um item único.
export function looksLikeProcessObject(text: string): boolean {
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
export function looksLikeProcessNumberTitle(text: string): boolean {
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

export function tokenize(s: string): string[] {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

export function cosine(a: number[], b: number[]): number {
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

export async function getEmbeddings(texts: string[], apiKey: string): Promise<number[][]> {
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

export interface RawItem {
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

export function parsePncpPublicUrl(url?: string): { cnpj: string; ano: string; sequencial: string; tipo?: string } | null {
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

export function parseNumeroControlePncpCompra(value?: unknown): { cnpj: string; ano: string; sequencial: string } | null {
  const s = String(value ?? "").trim();
  const m = s.match(/(\d{14})-1-0*(\d+)\/(\d{4})/);
  if (!m) return null;
  return { cnpj: m[1], sequencial: String(Number(m[2])), ano: m[3] };
}

export async function resolvePncpCompraFromContract(
  cnpj: string,
  ano: string | number,
  sequencialContrato: string | number,
): Promise<{ cnpj: string; ano: string; sequencial: string; fornecedor?: string } | null> {
  const seq = String(Number(String(sequencialContrato).replace(/\D/g, "")) || sequencialContrato);
  const url = `https://pncp.gov.br/pncp-api/v1/orgaos/${cnpj}/contratos/${ano}/${seq}`;
  const data = await pncpFetchJson<Record<string, unknown>>(url);
  if (!data) return null;
  const compra = parseNumeroControlePncpCompra(data.numeroControlePncpCompra ?? data.numeroControlePNCPCompra);
  if (!compra) return null;
  return {
    ...compra,
    fornecedor: typeof data.nomeRazaoSocialFornecedor === "string" ? data.nomeRazaoSocialFornecedor : undefined,
  };
}

export async function fetchPNCP(query: string, pagina: number, tamanho = 50): Promise<RawItem[]> {
  // A API do PNCP NÃO aceita lista separada por vírgula em tipos_documento.
  // Usar apenas "edital" (contém valor estimado + homologado dos itens via enrichWithPNCPItems).
  const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(query)}&tipos_documento=edital&ordenacao=-data&pagina=${pagina}&pagina_tam=${tamanho}&status=todos`;
  const data = await pncpFetchJson<{ items?: RawItem[]; resultados?: RawItem[] }>(url, {
    timeoutMs: 15_000,
  });
  if (!data) return [];
  const items = (data.items ?? data.resultados ?? []) as Array<RawItem & {
    tem_resultado?: boolean;
    cancelado?: boolean;
    data_fim_vigencia?: string;
  }>;
  // PNCP /api/search ignora o parâmetro `status` (testado empiricamente:
  // qualquer valor exceto `recebendo_proposta` devolve o total). Filtramos
  // localmente para manter apenas processos ENCERRADOS com resultado real:
  //   • tem_resultado === true (existe homologação/resultado registrado)
  //   • !cancelado
  //   • data_fim_vigencia já passou (sessão pública encerrada)
  const now = Date.now();
  const filtered = items.filter((it) => {
    if (it.cancelado === true) return false;
    const hasResult = it.tem_resultado === true;
    const dtFim = typeof it.data_fim_vigencia === "string" ? Date.parse(it.data_fim_vigencia) : NaN;
    const closed = Number.isFinite(dtFim) ? dtFim < now : false;
    // Aceita se tem resultado homologado OU se a sessão já encerrou.
    return hasResult || closed;
  });
  console.info(`[pncp] query="${query}" p${pagina} bruto=${items.length} encerrados=${filtered.length}`);
  return filtered;
}

/**
 * Discovery via portal compras.m2atecnologia.com.br.
 * Pagina a listagem (situacao=7 = finalizadas) pelo termo, abre cada processo
 * em paralelo, extrai a URL canônica do PNCP e devolve RawItem stubs com
 * `url` PNCP — o `enrichWithPNCPItems` se encarrega de expandir em itens
 * granulares com valor unitário homologado.
 *
 * Custo controlado: 1 página × até `cap` processos × 1 GET cada.
 * Default cap=15 para inline (search ao vivo). Crawler em background usa 60.
 */
export async function fetchM2A(
  searchTerm: string,
  cap = 15,
  budgetMs = 18_000,
  pages = 1,
  pageStart = 1,
): Promise<RawItem[]> {
  const term = searchTerm.trim();
  if (term.length < 2) return [];
  const deadline = Date.now() + budgetMs;
  const collected: { id: string; slug: string; url: string }[] = [];
  const seenIds = new Set<string>();
  for (let p = pageStart; p < pageStart + pages; p++) {
    if (Date.now() > deadline) break;
    let pageHits: { id: string; slug: string; url: string }[] = [];
    try {
      pageHits = await fetchM2aListing({ search: term, situacao: 7, page: p });
      console.info(`[m2a] term="${term}" p${p} processos=${pageHits.length}`);
    } catch (e) {
      console.warn(`[m2a] listing err term="${term}" p${p} err=${(e as Error).message}`);
      continue;
    }
    for (const h of pageHits) {
      if (seenIds.has(h.id)) continue;
      seenIds.add(h.id);
      collected.push(h);
    }
    if (collected.length >= cap) break;
  }
  if (collected.length === 0) return [];
  const capped = collected.slice(0, cap);

  const out: RawItem[] = [];
  const CONC = 5;
  for (let i = 0; i < capped.length; i += CONC) {
    if (Date.now() > deadline) {
      console.warn(`[m2a] budget exceeded term="${term}" processed=${out.length}/${capped.length}`);
      break;
    }
    const chunk = capped.slice(i, i + CONC);
    const settled = await Promise.allSettled(chunk.map((p) => fetchM2aPncpRef(p.url)));
    settled.forEach((s, idx) => {
      if (s.status !== "fulfilled" || !s.value) return;
      const ref = s.value;
      const proc = chunk[idx];
      const objeto = proc.slug.replace(/-/g, " ").slice(0, 200);
      out.push({
        id: `m2a-${ref.cnpj}-${ref.ano}-${ref.sequencial}`,
        numero: ref.sequencial,
        ano: ref.ano,
        orgao_cnpj: ref.cnpj,
        title: objeto,
        objeto_compra: objeto,
        url: ref.url,
        item_url: ref.url,
        situacao: "Finalizada",
        _source: "M2A",
        _sourceDomain: "compras.m2atecnologia.com.br",
        _sourceName: "M2A Tecnologia",
      });
    });
  }
  console.info(`[m2a] term="${term}" refsPNCP=${out.length}/${capped.length}`);
  return out;
}

// PNCP API de consulta — retorna ITENS individuais de uma contratação/ata/contrato,
// cada um com valor UNITÁRIO (estimado e/ou homologado), unidade e quantidade.
// Isto resolve o problema do "valor global do processo" aparecer como cotação.
export interface PncpItemRaw {
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

/**
 * Portal de Compras Públicas (portaldecompraspublicas.com.br) — fonte
 * alternativa que indexa licitações de centenas de prefeituras e órgãos.
 * Diferente do PNCP, esta API devolve ITENS já granulares com valor
 * unitário (valorReferencia) e melhor lance — não precisa de /itens
 * de segundo nível nem do enrich do PNCP.
 *
 * Fluxo:
 *  1. Endpoint A: lista processos por `objeto` (até 10 por página).
 *  2. Endpoint B: para cada processo, baixa itens em paralelo (lote 10).
 *  3. Filtra itens cuja descrição contenha algum token da query.
 */
export interface PcpProcesso {
  codigoLicitacao?: number | string;
  razaoSocial?: string;
  uf?: string;
  municipio?: string;
  dataAbertura?: string;
  dataLicitacao?: string;
  numero?: string;
  ano?: string | number;
  modalidade?: string;
}
export interface PcpItem {
  codigoItem?: number | string;
  codigo?: number | string;
  descricao?: string;
  unidade?: string;
  quantidade?: number;
  valorReferencia?: number;
  melhorLance?: number;
  valorTotal?: number;
  situacao?: string | { codigo?: number; descricao?: string };
}
export async function fetchPortalComprasPublicas(
  query: string,
  maxProcessos = 10,
  budgetMs = 18_000,
  pages = 3,
): Promise<RawItem[]> {
  const term = query.trim();
  if (term.length < 2) return [];
  const deadline = Date.now() + budgetMs;
  const SOURCE_NAME = "Portal de Compras Públicas";
  const SOURCE_DOMAIN = "portaldecompraspublicas.com.br";
  const BASE = "https://compras.api.portaldecompraspublicas.com.br/v2/licitacao";

  // Endpoint A — processos por objeto. NÃO filtramos por codigoStatus: o
  // status 3 devolve majoritariamente processos cancelados/encerrados sem
  // valores; sem filtro pegamos publicados/abertos/homologados em ordem
  // decrescente de data, que é o que queremos para cotação.
  // Pagina `pages` páginas (limite por página = maxProcessos), dedup por
  // codigoLicitacao.
  const processos: PcpProcesso[] = [];
  const seenLic = new Set<string>();
  for (let p = 1; p <= pages; p++) {
    if (Date.now() > deadline) break;
    const listUrl =
      `${BASE}/processos?objeto=${encodeURIComponent(term)}` +
      `&limitePagina=${maxProcessos}&pagina=${p}`;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 8_000);
      const res = await fetch(listUrl, {
        headers: { Accept: "application/json", "User-Agent": "LicitaPro/1.0" },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) {
        console.warn(`[pcp] listing status=${res.status} term="${term}" page=${p}`);
        break;
      }
      const json = (await res.json()) as { result?: PcpProcesso[]; data?: PcpProcesso[] } | PcpProcesso[];
      const pageProc: PcpProcesso[] = Array.isArray(json) ? json : (json.result ?? json.data ?? []);
      if (!pageProc.length) break;
      let novos = 0;
      for (const pr of pageProc) {
        const k = String(pr.codigoLicitacao ?? "");
        if (!k || seenLic.has(k)) continue;
        seenLic.add(k);
        processos.push(pr);
        novos++;
      }
      if (novos === 0) break; // página repetiu — para de paginar
    } catch (e) {
      console.warn(`[pcp] listing err term="${term}" page=${p} err=${(e as Error).message}`);
      break;
    }
  }
  if (!processos.length) return [];

  // Endpoint B — itens por processo, em lotes de 10 concorrentes
  const qLower = term.toLowerCase();
  const qTokens = qLower.split(/\s+/).filter((t) => t.length > 2);
  const out: RawItem[] = [];
  const CONC = 10;
  for (let i = 0; i < processos.length; i += CONC) {
    if (Date.now() > deadline) {
      console.warn(`[pcp] budget exceeded term="${term}" processed=${i}/${processos.length}`);
      break;
    }
    const chunk = processos.slice(i, i + CONC);
    const settled = await Promise.allSettled(
      chunk.map(async (p) => {
        const code = p.codigoLicitacao;
        if (!code) return { processo: p, itens: [] as PcpItem[] };
        const url = `${BASE}/${code}/itens?pagina=1`;
        const ctl = new AbortController();
        const to = setTimeout(() => ctl.abort(), 8_000);
        try {
          const res = await fetch(url, {
            headers: { Accept: "application/json", "User-Agent": "LicitaPro/1.0" },
            signal: ctl.signal,
          });
          clearTimeout(to);
          if (!res.ok) return { processo: p, itens: [] as PcpItem[] };
          const j = (await res.json()) as
            | {
                isLote?: boolean;
                itens?: { result?: PcpItem[] } | null;
                lotes?: { result?: { itens?: PcpItem[] }[] } | null;
                result?: PcpItem[];
              }
            | PcpItem[];
          let itens: PcpItem[];
          if (Array.isArray(j)) {
            itens = j;
          } else if (j.isLote && j.lotes?.result) {
            // Quando o processo é organizado em lotes, os itens estão dentro
            // de cada lote: lotes.result[].itens[]
            itens = j.lotes.result.flatMap((lote) => lote.itens ?? []);
          } else {
            itens = j.itens?.result ?? j.result ?? [];
          }
          return { processo: p, itens };
        } catch {
          clearTimeout(to);
          return { processo: p, itens: [] as PcpItem[] };
        }
      }),
    );

    for (const s of settled) {
      if (s.status !== "fulfilled") continue;
      const { processo, itens } = s.value;
      if (!itens.length) continue;
      const relevant = qTokens.length
        ? itens.filter((it) => {
            const d = (it.descricao ?? "").toLowerCase();
            return d && qTokens.some((t) => d.includes(t));
          })
        : itens;
      const useItems = relevant.length > 0 ? relevant : [];
      for (const it of useItems) {
        const unit = validPrice(it.melhorLance) ?? validPrice(it.valorReferencia);
        if (!unit && !validPrice(it.valorReferencia)) continue;
        const itemCode = it.codigoItem ?? it.codigo ?? out.length;
        const id = `pcp-${processo.codigoLicitacao}-${itemCode}`;
        const situacaoStr =
          typeof it.situacao === "string"
            ? it.situacao
            : it.situacao?.descricao;
        out.push({
          id,
          numero: String(processo.numero ?? processo.codigoLicitacao ?? ""),
          ano: processo.ano,
          orgao_nome: processo.razaoSocial,
          municipio_nome: processo.municipio,
          uf: processo.uf,
          descricao: it.descricao,
          objeto_compra: it.descricao,
          unidade_medida: it.unidade,
          quantidade: typeof it.quantidade === "number" ? it.quantidade : undefined,
          valor_unitario: unit,
          valor_unitario_estimado: validPrice(it.valorReferencia),
          valor_unitario_homologado: validPrice(it.melhorLance),
          valor_total_item: validPrice(it.valorTotal),
          modalidade_licitacao_nome: processo.modalidade,
          situacao_nome: situacaoStr ?? processo.modalidade,
          data: processo.dataAbertura ?? processo.dataLicitacao,
          tipo_documento: "outro",
          url: `https://compras.publicas.gov.br/ProcessoEletronico/Acompanhamento/${processo.codigoLicitacao}`,
          item_url: `https://compras.publicas.gov.br/ProcessoEletronico/Acompanhamento/${processo.codigoLicitacao}`,
          _source: "PortalComprasPublicas",
          _sourceName: SOURCE_NAME,
          _sourceDomain: SOURCE_DOMAIN,
          _valorTipo: validPrice(it.melhorLance) ? "unitario_homologado" : "unitario_estimado",
        });
      }
    }
  }
  console.info(`[pcp] term="${term}" processos=${processos.length} items=${out.length}`);
  return out;
}

export function validPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export async function fetchPncpItens(
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
    const j = await pncpFetchJson<
      PncpItemRaw[] | { data?: PncpItemRaw[]; totalPaginas?: number; totalRegistros?: number }
    >(url);
    if (!j) break;
    const page = Array.isArray(j) ? j : (j.data ?? []);
    all.push(...page);
    // Respeita totalPaginas do PNCP quando disponível; senão usa heurística por tamanho.
    const totalPaginas = !Array.isArray(j) ? j.totalPaginas : undefined;
    if (typeof totalPaginas === "number" && pagina >= totalPaginas) break;
    if (page.length < 100) break;
  }
  return all;
}

// Endpoint `/itens/{numeroItem}/resultados` — devolve o valor efetivamente
// HOMOLOGADO do item (valorUnitarioHomologado, valorTotalHomologado,
// quantidadeHomologada e o fornecedor vencedor). Quando disponível, é a
// fonte mais confiável de preço — supera estimado e supera o que vem em
// /itens, que muitas vezes só traz `valorUnitarioEstimado`.
export interface PncpResultadoRaw {
  numeroItem?: number;
  sequencialResultado?: number;
  valorUnitarioHomologado?: number;
  valorTotalHomologado?: number;
  quantidadeHomologada?: number;
  nomeRazaoSocialFornecedor?: string;
  niFornecedor?: string;
  situacaoCompraItemResultadoNome?: string;
  dataCancelamento?: string | null;
}

export async function fetchPncpItemResultado(
  cnpj: string,
  ano: string | number,
  sequencial: string | number,
  numeroItem: number,
): Promise<PncpResultadoRaw | null> {
  const seq = String(Number(String(sequencial).replace(/\D/g, "")) || sequencial);
  const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/${numeroItem}/resultados`;
  const j = await pncpFetchJson<PncpResultadoRaw[] | { data?: PncpResultadoRaw[] }>(url, {
    timeoutMs: 10_000,
  });
  if (!j) return null;
  const arr = Array.isArray(j) ? j : (j.data ?? []);
  // Filtra cancelados e mantém o vencedor (sequencialResultado === 1, ou o de menor preço unitário).
  const ativos = arr.filter((r) => !r.dataCancelamento && validPrice(r.valorUnitarioHomologado));
  if (ativos.length === 0) return null;
  ativos.sort((a, b) => {
    const sa = a.sequencialResultado ?? 999;
    const sb = b.sequencialResultado ?? 999;
    if (sa !== sb) return sa - sb;
    return (a.valorUnitarioHomologado ?? Infinity) - (b.valorUnitarioHomologado ?? Infinity);
  });
  return ativos[0];
}

/**
 * Para cada resultado PNCP (que representa um PROCESSO inteiro), tenta buscar
 * os ITENS individuais e EXPANDIR em múltiplos RawItem — cada item com seu
 * próprio valor unitário, unidade, quantidade e descrição.
 *
 * Limitado aos top-N por custo. Resultados sem cnpj/ano/sequencial ficam como estão.
 */
export async function enrichWithPNCPItems(raw: RawItem[], query: string, limit = 12): Promise<RawItem[]> {
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
    const isPNCP = !r._source || r._source === "PNCP" || r._source === "Transparência" || r._source === "Compras.gov.br" || r._source === "M2A";
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
  const t0Total = Date.now();

  // Concorrência limitada para não estourar o gateway do PNCP.
  // 12 paralelos: testado contra o gateway sem 429.
  const CONCURRENCY = 12;
  const fetched: PromiseSettledResult<{ parent: RawItem; items: PncpItemRaw[] }>[] = [];
  for (let i = 0; i < enrichable.length; i += CONCURRENCY) {
    const chunk = enrichable.slice(i, i + CONCURRENCY);
    const tChunk = Date.now();
    const part = await Promise.allSettled(
      chunk.map(async (r) => {
        const tItem = Date.now();
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
        console.info(
          `[enrichPNCP] itens ${target.cnpj}/${target.ano}/${target.sequencial} -> ${items.length} (${Date.now() - tItem}ms)`,
        );
        return { parent, items };
      }),
    );
    fetched.push(...part);
    console.info(
      `[enrichPNCP] chunk ${i / CONCURRENCY + 1}/${Math.ceil(enrichable.length / CONCURRENCY)} concluído em ${Date.now() - tChunk}ms`,
    );
  }
  console.info(`[enrichPNCP] etapa /itens concluída em ${Date.now() - t0Total}ms`);

  const expanded: RawItem[] = [];
  const parentsFallback: RawItem[] = [];
  let resultsFetched = 0;
  for (const s of fetched) {
    if (s.status !== "fulfilled") continue;
    const { parent, items } = s.value;
    const isM2A = parent._source === "M2A";
    if (!items || items.length === 0) {
      // Resultado oficial do PNCP sem itens individuais não deve virar card:
      // o usuário pediu lista de ITENS, não lista de processos/atas/editais.
      // M2A: descobre processos por TEMA — sem itens reais do PNCP, descarta
      // (nunca mostrar o objeto da contratação como se fosse o item).
      if (isM2A) continue;
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
    // EXCEÇÃO M2A: o portal foi consultado por TEMA amplo (ex.: "material
    // escolar"); se nenhum item bate com a query específica (ex.: "caderno"),
    // o processo inteiro é irrelevante — descarta.
    if (isM2A && relevant.length === 0) continue;
    const useItems = relevant.length > 0 ? relevant : items;
    // Tenta enriquecer com /resultados (valor HOMOLOGADO real) para itens
    // que ainda não trazem valorUnitarioHomologado direto na lista /itens.
    const targetForResultados = {
      cnpj: String(parent.orgao_cnpj ?? "").replace(/\D/g, ""),
      ano: String(parent.ano ?? ""),
      seq: String(parent.numero ?? "").replace(/\D/g, ""),
    };
    if (targetForResultados.cnpj.length === 14 && targetForResultados.ano && targetForResultados.seq) {
      const RES_CONCURRENCY = 10;
      const needsResultado = useItems.filter(
        (it) => typeof it.numeroItem === "number" && !validPrice(it.valorUnitarioHomologado),
      );
      if (needsResultado.length > 0) {
        console.info(
          `[enrichPNCP] /resultados ${targetForResultados.cnpj}/${targetForResultados.ano}/${targetForResultados.seq} -> ${needsResultado.length} itens precisam de homologação`,
        );
      }
      for (let i = 0; i < needsResultado.length; i += RES_CONCURRENCY) {
        const chunk = needsResultado.slice(i, i + RES_CONCURRENCY);
        const settled = await Promise.allSettled(
          chunk.map((it) =>
            fetchPncpItemResultado(
              targetForResultados.cnpj,
              targetForResultados.ano,
              targetForResultados.seq,
              it.numeroItem as number,
            ).then((res) => ({ it, res })),
          ),
        );
        for (const s of settled) {
          if (s.status !== "fulfilled" || !s.value.res) continue;
          resultsFetched++;
          const { it, res } = s.value;
          if (validPrice(res.valorUnitarioHomologado)) {
            it.valorUnitarioHomologado = res.valorUnitarioHomologado;
            if (validPrice(res.valorTotalHomologado)) it.valorTotalHomologado = res.valorTotalHomologado;
            if (typeof res.quantidadeHomologada === "number" && res.quantidadeHomologada > 0)
              it.quantidade = res.quantidadeHomologada;
            // Vincula fornecedor vencedor ao item via parent (será propagado abaixo).
            if (res.nomeRazaoSocialFornecedor && !parent.fornecedor) {
              parent.fornecedor = res.nomeRazaoSocialFornecedor;
            }
          }
        }
      }
    }
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
        // Sobrescreve o `title` herdado do parent (no M2A é o slug do processo,
        // ex.: "aquisicao de material de expediente") com a descrição real do
        // ITEM — caso contrário o toResult escolhe o slug como título por ter
        // tamanho "bonito" e a descrição real (longa) perde no ranking.
        title: it.descricao ?? parent.title,
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
  console.info(
    `[enrichPNCP] FIM total=${Date.now() - t0Total}ms expanded=${expanded.length} resultadosHomologados=${resultsFetched}`,
  );

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
export async function fetchComprasGov(query: string): Promise<RawItem[]> {
  // API oficial de Dados Abertos do Compras.gov.br v2.0
  // Cobre Trilha 3 (ARP) + Trilha 1 (Nova Lei 14.133); pregões legados ficam
  // de fora por padrão (volume alto e dado redundante com o que já vem do PNCP).
  try {
    const unified = await searchComprasGovByKeyword(query, {
      dias: 7,
      incluirPregoes: false,
      maxResultados: 80,
    });
    return unified.map((u): RawItem => unifiedToRawItem(u));
  } catch (e) {
    console.warn("Compras.gov.br (dadosabertos) fetch error", e);
    return [];
  }
}

/** Converte o formato unificado do compras.gov para o RawItem do pipeline. */
export function unifiedToRawItem(u: ComprasGovUnified): RawItem {
  const sourceLabel =
    u.origem_lei === "arp"
      ? "Compras.gov ARP"
      : u.origem_lei === "14133"
        ? "Compras.gov 14.133"
        : "Compras.gov Pregão";
  // Tipo de documento usado pelo toResult/buildPncpUrl
  const tipo_documento = u.origem_lei === "arp" ? "ata" : "contrato";
  return {
    id: u.id_externo ?? `cg-${u.origem_lei}-${Math.random().toString(36).slice(2, 10)}`,
    numero: u.numero_processo_ou_ata,
    title: u.descricao_item,
    description: u.descricao_detalhada ?? u.descricao_item,
    descricao: u.descricao_detalhada ?? u.descricao_item,
    objeto_compra: u.descricao_item,
    unidade_medida: u.unidade,
    quantidade: u.quantidade,
    valor_unitario_homologado: u.valor_unitario,
    valor_total_item: u.valor_total,
    fornecedor: u.fornecedor_nome,
    orgao_nome: u.orgao_gerenciador,
    orgao_cnpj: u.cnpj_orgao ?? u.fornecedor_cnpj,
    uf: u.uf,
    municipio_nome: u.municipio,
    data: u.data,
    data_publicacao_pncp: u.data,
    situacao_nome: "Homologado",
    tipo_documento,
    _valorTipo: "unitario_homologado",
    _sourceName: sourceLabel,
    _sourceDomain: "dadosabertos.compras.gov.br",
  };
}

// Portal da Transparência — atas/registros de preço (variante PNCP filtrada)
export async function fetchTransparencia(query: string): Promise<RawItem[]> {
  // Usuário pediu para se concentrar em EDITAIS encerrados — não buscamos
  // mais atas. A "Transparência" passa a complementar a busca de editais
  // com ordenação diferente (relevância) para cobrir resultados que o
  // fetchPNCP pode ter empurrado para outras páginas.
  const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(query)}&tipos_documento=edital&ordenacao=-relevance&pagina=1&pagina_tam=20&status=todos`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "CotacaoIA/1.0" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { items?: Array<RawItem & { tem_resultado?: boolean; cancelado?: boolean; data_fim_vigencia?: string }>; resultados?: RawItem[] };
    const items = (data.items ?? (data.resultados as RawItem[] | undefined) ?? []) as Array<RawItem & { tem_resultado?: boolean; cancelado?: boolean; data_fim_vigencia?: string }>;
    const now = Date.now();
    const filtered = items.filter((it) => {
      if (it.cancelado === true) return false;
      const dtFim = typeof it.data_fim_vigencia === "string" ? Date.parse(it.data_fim_vigencia) : NaN;
      const closed = Number.isFinite(dtFim) ? dtFim < now : false;
      return it.tem_resultado === true || closed;
    });
    return filtered.map((it) => ({ ...it, _source: "Transparência", tipo_documento: "edital" } as RawItem));
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
export const TCE_CE_HOSTS = [
  "https://api-dados-abertos.tce.ce.gov.br/sim",
];
export const TCE_CE_VIEWS = ["queryView_dv_itens_licitados", "queryView_dv_contratados"];

export interface TCECERow {
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

export function numFromBR(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v > 0 ? v : undefined;
  if (typeof v !== "string") return undefined;
  const cleaned = v.trim().replace(/\s/g, "").replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export async function fetchTceCeView(host: string, view: string, query: string): Promise<TCECERow[]> {
  // A API de Dados Abertos do TCE-CE segue o estilo OData v2 (mesmo padrão
  // do endpoint público /sim/municipios?$format=json&$count=...).
  // Para filtrar por texto usamos `$filter=substringof('<termo>',descricao_item)`.
  // Caso o filtro seja rejeitado, fazemos um fallback sem filtro e tratamos
  // a filtragem por keyword localmente no fetchTCECE.
  const safe = query.replace(/'/g, "''");
  const filterField = view.includes("itens") ? "descricao_item" : "objeto";
  const params = new URLSearchParams();
  params.set("$format", "json");
  params.set("$count", "60");
  params.set("$start_index", "0");
  params.set("$filter", `substringof('${safe}',${filterField})`);
  const url = `${host}/${view}?${params.toString()}`;
  const ctrl = new AbortController();
  // O host responde em ~1-3s quando alcançável (testado via navegador do
  // usuário). Damos 8s para tolerar congestionamento do gateway do TCE.
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": PNCP_UA },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[tce-ce] ${view} HTTP ${res.status} em ${host} (${Date.now() - t0}ms)`);
      return [];
    }
    const j = (await res.json().catch(() => null)) as unknown;
    let rows: TCECERow[] = [];
    if (Array.isArray(j)) rows = j as TCECERow[];
    else if (j && typeof j === "object") {
      const obj = j as Record<string, unknown>;
      for (const key of ["data", "items", "resultados", "rows", "result", "d"]) {
        const arr = obj[key];
        if (Array.isArray(arr)) { rows = arr as TCECERow[]; break; }
        // OData wrapper: { d: { results: [...] } }
        if (arr && typeof arr === "object" && Array.isArray((arr as Record<string, unknown>).results)) {
          rows = (arr as { results: TCECERow[] }).results;
          break;
        }
      }
    }
    console.info(`[tce-ce] ${view} ok: ${rows.length} linhas em ${Date.now() - t0}ms`);
    return rows;
  } catch (e) {
    const msg = (e as Error)?.message ?? "erro";
    console.warn(`[tce-ce] ${view} falhou em ${host} após ${Date.now() - t0}ms: ${msg.slice(0, 80)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTCECE(query: string): Promise<RawItem[]> {
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
export async function expandQuery(query: string, apiKey: string | undefined): Promise<string[]> {
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
export function sourceMetaForUrl(url: string | undefined, catalog: { domain: string; name: string }[]) {
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

export async function fetchFirecrawlWeb(query: string, siteFilters: string[], catalog: { domain: string; name: string }[] = []): Promise<RawItem[]> {
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

/**
 * Faz UMA chamada Firecrawl por domínio. Necessário porque o Google enviesa
 * fortemente a forma `(site:A OR site:B OR ...)` para o domínio com maior
 * PageRank (PNCP/Compras.gov), deixando TCU/Comprasnet/Painel de Preços/BPS
 * Saúde sem hits — embora esses portais tenham os dados.
 *
 * Roda em paralelo, com limit baixo (8 resultados/domínio) e só na query
 * principal (não nas variantes) — custo: N calls × 1 crédito por busca do
 * usuário, onde N é o número de portais nomeados (default 6).
 */
export async function fetchFirecrawlPerDomain(
  query: string,
  domains: string[],
  catalog: { domain: string; name: string }[],
): Promise<RawItem[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key || domains.length === 0) return [];
  const tasks = domains.map(async (domain): Promise<RawItem[]> => {
    const q = `${query} (preço OR "R$" OR valor OR contrato OR ata OR homologação OR pregão) site:${domain}`;
    try {
      const res = await fetch("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, limit: 8, lang: "pt", country: "br" }),
      });
      if (!res.ok) {
        console.warn(`Firecrawl per-domain ${domain} HTTP`, res.status);
        return [];
      }
      const json = (await res.json()) as {
        data?: { web?: Array<{ url?: string; title?: string; description?: string }> } | Array<{ url?: string; title?: string; description?: string }>;
        web?: Array<{ url?: string; title?: string; description?: string }>;
      };
      const arr = Array.isArray(json.data) ? json.data : (json.data?.web ?? json.web ?? []);
      return arr.map((r, i): RawItem => {
        const meta = sourceMetaForUrl(r.url, catalog);
        return {
          id: `fcd-${domain}-${i}-${(r.url ?? "").slice(-32)}`,
          title: r.title ?? r.url ?? "Resultado web",
          description: r.description ?? "",
          url: r.url,
          tipo_documento: /ata/i.test(`${r.title} ${r.url}`) ? "ata"
            : /contrato/i.test(`${r.title} ${r.url}`) ? "contrato"
            : /edital|preg/i.test(`${r.title} ${r.url}`) ? "edital" : "outro",
          // Garante que a fonte casa exatamente com o nome do chip
          _source: meta.name ?? domain,
          _sourceDomain: meta.domain ?? domain,
          _sourceName: meta.name ?? domain,
        };
      });
    } catch (e) {
      console.warn(`Firecrawl per-domain ${domain} error`, (e as Error).message);
      return [];
    }
  });
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
}

// Busca FORNECEDORES REAIS na internet (fabricantes/distribuidores B2B,
// catálogos, e-commerces especializados). Exclui marketplaces proibidos.
// Inciso V da Lei 14.133/2021 — cotação direta com fornecedores.
export async function fetchFirecrawlSuppliers(query: string): Promise<RawItem[]> {
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
export const UNIDADES_RE = /\b(UN|UND|UNID|CX|KG|PC|PCT|PAR|MT|ML|LT|L|CM|M|M2|M3|SC|GL|RL|RES|FR|CJ|SRV|HR|DZ|KIT)\b/i;
export function parsePriceBR(s: string): number | undefined {
  if (!s) return undefined;
  const norm = s.replace(/\s/g, "").replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
  const n = parseFloat(norm);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
export function parseQtyBR(s: string): number | undefined {
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
export function extractItemsFromText(text: string, sourceUrl: string, sourceLabel: string): RawItem[] {
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
export async function dorkPdfAttachments(query: string): Promise<string[]> {
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
export async function scrapeAndMine(url: string, label: string): Promise<RawItem[]> {
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

export const ONTOLOGY_PROMPT = `Você é um Motor de Inferência Ontológica especializado em Contratos Públicos.

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

export async function ontologicalExtract(
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
export function extractItemsFromHtmlTables(html: string, sourceUrl: string, sourceLabel: string): RawItem[] {
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
export async function mineAttachments(query: string, extraUrls: string[] = []): Promise<RawItem[]> {
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

// ============================================================
// Rodada E — Portais privados de licitação (PCP / BLL / BNC / Licitações-e)
// ============================================================
// Esses portais agregam licitações municipais/estaduais que NÃO chegam ao
// PNCP, especialmente prefeituras menores. Não há API pública estável —
// estratégia: Firecrawl `search` com filtro `site:` para descobrir páginas
// de processo, depois `scrapeAndMine` extrai tríades (qtd × unitário = total).
//
// Cada portal vira tarefa paralela no orquestrador; falha silenciosa via [].
export const PORTAIS = [
  { domain: "portaldecompraspublicas.com.br", name: "Portal de Compras Públicas" },
  { domain: "bllcompras.com",                 name: "BLL Compras" },
  { domain: "licitacoes-e.com.br",            name: "Licitações-e (BB)" },
  { domain: "bnccompras.com",                 name: "BNC Compras" },
  { domain: "compras.bb.com.br",              name: "Compras BB" },
] as const;

export async function searchPortalUrls(query: string, domain: string, limit = 4): Promise<string[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];
  // Termos que isolam páginas de processo/edital homologado dentro do portal
  const q = `${query} (homologado OR adjudicado OR "ata de registro" OR pregão OR resultado) site:${domain}`;
  try {
    const res = await fetch("https://api.firecrawl.dev/v2/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, limit, lang: "pt", country: "br" }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as {
      data?: { web?: Array<{ url?: string }> } | Array<{ url?: string }>;
      web?: Array<{ url?: string }>;
    };
    const arr = Array.isArray(j.data) ? j.data : (j.data?.web ?? j.web ?? []);
    return arr
      .map((r) => r.url)
      .filter((u): u is string => typeof u === "string" && u.includes(domain));
  } catch (e) {
    console.warn(`[portais] search ${domain} error`, (e as Error).message);
    return [];
  }
}

export async function minePortais(query: string): Promise<RawItem[]> {
  if (!process.env.FIRECRAWL_API_KEY) return [];
  // 1) descobre URLs em paralelo, um Firecrawl-search por portal
  const discovered = await Promise.allSettled(
    PORTAIS.map((p) => searchPortalUrls(query, p.domain, 3).then((urls) => ({ portal: p, urls }))),
  );
  const jobs: Array<{ url: string; label: string }> = [];
  for (const s of discovered) {
    if (s.status !== "fulfilled") continue;
    for (const u of s.value.urls) jobs.push({ url: u, label: s.value.portal.name });
  }
  if (jobs.length === 0) return [];

  // 2) scrape-and-mine cada URL (mesmo pipeline de tabelas/ontologia já usado)
  const CONCURRENCY = 3;
  const out: RawItem[] = [];
  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const chunk = jobs.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((j) => scrapeAndMine(j.url, j.label)),
    );
    for (const s of settled) if (s.status === "fulfilled") out.push(...s.value);
    if (out.length > 200) break;
  }
  return out;
}

// Lê catálogo de fontes (price_sources) ordenado por prioridade e taxa de sucesso.
export async function loadActiveSources(): Promise<{ domain: string; name: string }[]> {
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
export async function registerDiscoveredDomains(urls: string[], known: Set<string>) {
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
export function buildPncpUrl(raw: RawItem): string | undefined {
  // Fontes não-PNCP (TCE-CE, fornecedores, web): preserva url original ou nada.
  if (raw._source && raw._source !== "PNCP" && raw._source !== "Transparência" && raw._source !== "Compras.gov.br") {
    const u = (raw.url as string | undefined) || (raw.item_url as string | undefined);
    return u && /^https?:\/\//i.test(u) ? u : undefined;
  }
  // Usuário pediu: sempre apontar para o EDITAL canônico no PNCP — nunca
  // para a página de ata, contrato ou empenho. Reescreve qualquer path que
  // venha como /atas/... ou /contratos/... para /editais/... usando os
  // mesmos {cnpj}/{ano}/{seq} (mesma compra mãe).
  const rewriteToEdital = (p: string): string => {
    return p.replace(/\/(?:app\/)?(?:atas|contratos|empenhos|compras)\//i, "/app/editais/");
  };
  const path = (raw.item_url as string | undefined) || (raw.url as string | undefined);
  if (path && /^https?:\/\//i.test(path)) return rewriteToEdital(path);
  if (path && path.startsWith("/")) return rewriteToEdital(`https://pncp.gov.br/app${path}`);
  const cnpj = (raw.orgao_cnpj ?? "").replace(/\D/g, "");
  const ano = raw.ano ? String(raw.ano) : "";
  const seq = raw.numero ? String(raw.numero).replace(/\D/g, "") : "";
  if (cnpj && ano && seq) {
    return `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${seq}`;
  }
  return undefined;
}

export function isSupplierOrCommercial(r: PriceResult): boolean {
  const source = (r.origem || "").toLowerCase();
  return Boolean(r.fornecedor) && !/(pncp|compras\.gov|transpar|tce|tribunal|gov\.br)/i.test(source);
}

export function isGranularItemResult(r: PriceResult): boolean {
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

export function summarizeSources(results: PriceResult[], catalog: { domain: string; name: string }[]): SearchSourceStatus[] {
  const base = ["PNCP", "Compras.gov.br", "TCE-CE", "Portal de Compras Públicas", "Anexos (PDF/HTML)", ...catalog.slice(0, 8).map((s) => s.name)];
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

export function toResult(raw: RawItem): PriceResult {
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
  // Prioriza valor UNITÁRIO/HOMOLOGADO. REGRA INVIOLÁVEL: se a linha só tem
  // valor global (lote/processo inteiro) e não há quantidade conhecida para
  // derivar o unitário, `valor` fica null — NUNCA exibimos preço de lote no
  // lugar do unitário. Ver src/lib/pncp-rules.ts + testes.
  const safe = safeUnitValue(raw);
  const valor = safe.valor;
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

  // Tipo de valor — preferência ao já marcado pelo enrich, senão usa a
  // regra pura (safeUnitValue) que já garantiu null no `valor` global.
  const valorTipo: PriceResult["valorTipo"] = raw._valorTipo ?? safe.valorTipo;

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
        : safe.valorTotal,
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

export function applyJuridicScore(r: PriceResult, ultimosMeses: number): PriceResult {
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
