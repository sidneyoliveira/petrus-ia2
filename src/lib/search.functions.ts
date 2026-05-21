import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PriceResult, SearchResponse, SearchSourceStatus } from "./types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

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
    const cnpj = (r.orgao_cnpj ?? parsed?.cnpj ?? "").replace(/\D/g, "");
    const ano = r.ano ?? parsed?.ano;
    const seqRaw = r.numero_sequencial_compra_ata ?? r.numero_sequencial ?? r.numero ?? parsed?.sequencial ?? "";
    const seq = String(seqRaw).replace(/\D/g, "");
    const isPNCP = !r._source || r._source === "PNCP" || r._source === "Transparência" || r._source === "Compras.gov.br";
    if ((isPNCP || parsed) && cnpj.length === 14 && ano && seq && enrichable.length < limit) {
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
async function fetchFirecrawlWeb(query: string, siteFilters: string[]): Promise<RawItem[]> {
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
    return arr.map((r, i): RawItem => ({
      id: `fc-${i}-${(r.url ?? "").slice(-40)}`,
      title: r.title ?? r.url ?? "Resultado web",
      description: r.description ?? "",
      url: r.url,
      tipo_documento: /ata/i.test(`${r.title} ${r.url}`) ? "ata" : /contrato/i.test(`${r.title} ${r.url}`) ? "contrato" : /edital|pregao|preg%C3%A3o/i.test(`${r.title} ${r.url}`) ? "edital" : "outro",
      _source: "Outro",
    }));
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
          _source: "Outro",
          _supplier: true,
        } as RawItem;
      });
  } catch (e) {
    console.warn("Firecrawl suppliers error", (e as Error).message);
    return [];
  }
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
    origem: (raw["_source"] as PriceResult["origem"]) || "PNCP",
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
    }
    // Firecrawl — chama com vários conjuntos de domínios para diversificar
    const tceDomains = catalog.filter((s) => s.domain.startsWith("tce.")).map((s) => s.domain);
    const govFederal = catalog
      .filter((s) => /(^|\.)gov\.br$/.test(s.domain) && !s.domain.startsWith("tce."))
      .map((s) => s.domain);
    for (const v of variants.slice(0, 3)) {
      // PNCP público via web: encontra páginas de processos e, em seguida,
      // o enrich transforma essas páginas em ITENS granulares via /itens.
      tasks.push(fetchFirecrawlWeb(v, ["pncp.gov.br"]));
      tasks.push(fetchFirecrawlWeb(v, siteFilters));
      if (tceDomains.length > 0) tasks.push(fetchFirecrawlWeb(v, tceDomains));
      if (govFederal.length > 0) tasks.push(fetchFirecrawlWeb(v, govFederal));
      // Cotação com fornecedores reais (catálogos / fabricantes / distribuidores)
      tasks.push(fetchFirecrawlSuppliers(v));
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
    // Aumentamos bastante o limite para garantir cobertura por item.
    raw = await enrichWithPNCPItems(raw, data.query, 120);

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
    };
  });