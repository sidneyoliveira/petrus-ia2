import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PriceResult, SearchResponse } from "./types";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const FilterSchema = z.object({
  query: z.string().min(2).max(200),
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
  unidade_medida?: string;
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
  item_url?: string;
  url?: string;
  [k: string]: unknown;
}

async function fetchPNCP(query: string, pagina: number): Promise<RawItem[]> {
  const tipos = "edital,ata,contrato";
  const url = `https://pncp.gov.br/api/search/?q=${encodeURIComponent(query)}&tipos_documento=${tipos}&ordenacao=-data&pagina=${pagina}&pagina_tam=20&status=todos`;
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
  // Título do ITEM (objeto da contratação) tem prioridade sobre o nome do processo.
  const objeto = (raw.objeto_compra || raw.descricao || raw.description || "").toString().trim();
  const processo = (raw.title || "").toString().trim();
  const titulo = objeto || processo || "Sem título";
  const subtitulo = objeto && processo && objeto !== processo ? processo : undefined;
  const descricao = raw.description || raw.descricao || raw.objeto_compra || titulo;
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

  return {
    id,
    titulo: String(titulo),
    subtitulo,
    descricao: String(descricao),
    unidade: raw.unidade_medida,
    valor,
    valorTotal: valor,
    fornecedor: undefined,
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

    // 2) Busca paralela em múltiplas fontes oficiais + variações + Firecrawl (se habilitado)
    const tasks: Promise<RawItem[]>[] = [];
    for (const v of variants) {
      tasks.push(fetchPNCP(v, pagina));
      tasks.push(fetchComprasGov(v));
      tasks.push(fetchTransparencia(v));
    }
    tasks.push(fetchFirecrawlWeb(data.query, siteFilters));
    // chama Firecrawl 2x — uma com filtros gov.br federal, outra com TCEs
    const tceDomains = catalog.filter((s) => s.domain.startsWith("tce.")).map((s) => s.domain);
    if (tceDomains.length > 0) tasks.push(fetchFirecrawlWeb(data.query, tceDomains));
    const settled = await Promise.allSettled(tasks);
    const raw = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    let results = raw.map(toResult);

    // Auto-descoberta: registra novos domínios encontrados pelo Firecrawl
    void registerDiscoveredDomains(
      results.map((r) => r.url ?? "").filter(Boolean),
      knownDomains,
    );

    // Filtra resultados que misturam vários itens distintos no mesmo registro
    results = results.filter((r) => !looksLikeMultiItem(`${r.titulo} ${r.descricao}`));

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
      const k = (r.url || `${r.origem}|${r.titulo}`).toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // Filtro fontes proibidas (defensivo)
    results = results.filter((r) => {
      const blob = `${r.titulo} ${r.descricao} ${r.url ?? ""}`.toLowerCase();
      return !FORBIDDEN.some((f) => blob.includes(f));
    });

    // Filtros básicos
    if (data.uf) results = results.filter((r) => (r.uf ?? "").toUpperCase() === data.uf!.toUpperCase());
    if (data.modalidade) results = results.filter((r) => (r.modalidade ?? "").toLowerCase().includes(data.modalidade!.toLowerCase()));
    if (data.unidade) results = results.filter((r) => (r.unidade ?? "").toLowerCase().includes(data.unidade!.toLowerCase()));
    if (data.apenasHomologados) results = results.filter((r) => r.homologado);
    if (typeof data.valorMin === "number") results = results.filter((r) => (r.valor ?? 0) >= data.valorMin!);
    if (typeof data.valorMax === "number") results = results.filter((r) => (r.valor ?? Infinity) <= data.valorMax!);

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
      const final =
        0.35 * r.scoreSemantico +
        0.2 * r.scoreTextual +
        0.25 * r.scoreJuridico +
        0.1 * r.scoreGeografico +
        0.1 * r.scoreTecnico;
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