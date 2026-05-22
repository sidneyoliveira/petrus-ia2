/**
 * Compras.gov.br — API de Dados Abertos v2.0
 * https://dadosabertos.compras.gov.br
 *
 * Cobre as 3 trilhas oficiais de extração de VALOR HOMOLOGADO:
 *   Trilha 1: Nova Lei 14.133  — /modulo-contratacoes/3_consultarResultadoItensContratacoes_PNCP_14133
 *   Trilha 2: Pregões legado    — /modulo-legado/4_consultarItensPregoes
 *   Trilha 3: ARP (Atas RP)     — /modulo-arp/2_consultarARPItem
 *
 * As 3 trilhas são SOMENTE por janela de data (não aceitam ?q=...). O fluxo
 * típico é: fetchAll(dataIni, dataFim) → adapter → filtro por keyword no
 * caller. Os 3 endpoints retornam JSON com `{ totalPaginas, paginasRestantes,
 * resultado: [...] }`; este módulo faz a paginação automática com `while
 * paginasRestantes > 0`, com retry+backoff em falhas transitórias.
 */

const BASE = "https://dadosabertos.compras.gov.br";
const PAGE_SIZE = 500;
const MAX_PAGES_HARD = 20; // proteção: 20 × 500 = 10k itens por chamada
const HTTP_TIMEOUT_MS = 20_000;

// ============================================================
// Tipos brutos (refletem o JSON da API)
// ============================================================

interface PagedResponse<T> {
  totalRegistros?: number;
  totalPaginas?: number;
  paginasRestantes?: number;
  resultado?: T[];
  // alguns endpoints usam `_embedded` ou `data`; mantém flexível
  data?: T[];
}

export interface Raw14133Item {
  idCompraItem?: string | number;
  descricaoResumida?: string;
  descricaodetalhada?: string;
  unidadeMedida?: string;
  quantidadeHomologada?: number;
  valorUnitarioHomologado?: number;
  valorTotalHomologado?: number;
  niFornecedor?: string;
  nomeRazaoSocialFornecedor?: string;
  numeroControlePNCP?: string;
  nomeUnidadeOrgao?: string;
  cnpjOrgao?: string;
  ufOrgao?: string;
  municipioOrgao?: string;
  dataResultadoPncp?: string;
  [k: string]: unknown;
}

export interface RawPregaoItem {
  numero_item?: string | number;
  descricao_item?: string;
  descricao_detalhada_item?: string;
  unidade_fornecimento?: string;
  quantidade?: number;
  valorHomologadoItem?: number;
  fornecedor_vencedor?: string;
  cnpj_fornecedor?: string;
  numero_pregao?: string;
  uasg?: string | number;
  nome_uasg?: string;
  uf?: string;
  municipio?: string;
  data_homologacao?: string;
  [k: string]: unknown;
}

export interface RawARPItem {
  numeroAtaRegistroPreco?: string;
  numeroItem?: string | number;
  descricaoItem?: string;
  unidadeMedida?: string;
  quantidadeHomologadaItem?: number;
  valorUnitario?: number;
  valorTotal?: number;
  niFornecedor?: string;
  nomeRazaoSocialFornecedor?: string;
  nomeUnidadeGerenciadora?: string;
  cnpjUnidadeGerenciadora?: string;
  ufUnidadeGerenciadora?: string;
  municipioUnidadeGerenciadora?: string;
  dataVigenciaInicial?: string;
  dataVigenciaFinal?: string;
  [k: string]: unknown;
}

/** Formato unificado normalizado — consumido pelo adapter para RawItem. */
export interface ComprasGovUnified {
  origem_lei: "14133" | "8666_pregao" | "arp";
  orgao_gerenciador?: string;
  cnpj_orgao?: string;
  numero_processo_ou_ata?: string;
  descricao_item: string;
  descricao_detalhada?: string;
  unidade?: string;
  quantidade?: number;
  valor_unitario?: number;
  valor_total?: number;
  fornecedor_nome?: string;
  fornecedor_cnpj?: string;
  uf?: string;
  municipio?: string;
  data?: string;
  id_externo?: string;
}

// ============================================================
// HTTP helper com retry/backoff exponencial
// ============================================================

async function fetchJsonWithRetry<T>(url: string, attempts = 3): Promise<T | null> {
  let delay = 800;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: {
          accept: "*/*",
          "User-Agent": "CotacaoIA/1.0 (+compras.gov.br adapter)",
        },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        if (i === attempts - 1) return null;
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (e) {
      clearTimeout(timer);
      if (i === attempts - 1) {
        console.warn(`[compras-gov] fetch failed url=${url.slice(0, 120)} err=${(e as Error).message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
    }
  }
  return null;
}

/**
 * Paginação inteligente: itera `pagina=1..N` enquanto `paginasRestantes > 0`,
 * concatenando o array `resultado`. Para em MAX_PAGES_HARD para evitar abuso.
 */
async function paginateAll<T>(buildUrl: (pagina: number) => string): Promise<T[]> {
  const out: T[] = [];
  let pagina = 1;
  while (pagina <= MAX_PAGES_HARD) {
    const data = await fetchJsonWithRetry<PagedResponse<T>>(buildUrl(pagina));
    if (!data) break;
    const chunk = data.resultado ?? data.data ?? [];
    out.push(...chunk);
    const restantes = typeof data.paginasRestantes === "number" ? data.paginasRestantes : 0;
    if (chunk.length < PAGE_SIZE || restantes <= 0) break;
    pagina += 1;
  }
  return out;
}

// ============================================================
// TRILHA 1 — Nova Lei 14.133
// ============================================================

export async function fetch_itens_homologados_nova_lei(
  dataInicial: string,
  dataFinal: string,
): Promise<Raw14133Item[]> {
  return paginateAll<Raw14133Item>(
    (pagina) =>
      `${BASE}/modulo-contratacoes/3_consultarResultadoItensContratacoes_PNCP_14133` +
      `?dataResultadoPncpInicial=${dataInicial}&dataResultadoPncpFinal=${dataFinal}` +
      `&pagina=${pagina}&tamanhoPagina=${PAGE_SIZE}`,
  );
}

// ============================================================
// TRILHA 2 — Pregões legado (Lei 8.666)
// ============================================================

export async function fetch_itens_pregoes_legado(
  dataInicial: string,
  dataFinal: string,
): Promise<RawPregaoItem[]> {
  return paginateAll<RawPregaoItem>(
    (pagina) =>
      `${BASE}/modulo-legado/4_consultarItensPregoes` +
      `?dt_hom_inicial=${dataInicial}&dt_hom_final=${dataFinal}` +
      `&pagina=${pagina}&tamanhoPagina=${PAGE_SIZE}`,
  );
}

// ============================================================
// TRILHA 3 — Atas de Registro de Preço (a mais relevante p/ cotação)
// ============================================================

export async function fetch_itens_arp(
  dataInicial: string,
  dataFinal: string,
): Promise<RawARPItem[]> {
  return paginateAll<RawARPItem>(
    (pagina) =>
      `${BASE}/modulo-arp/2_consultarARPItem` +
      `?dataVigenciaInicialMin=${dataInicial}&dataVigenciaInicialMax=${dataFinal}` +
      `&pagina=${pagina}&tamanhoPagina=${PAGE_SIZE}`,
  );
}

// ============================================================
// ADAPTERS → formato unificado
// ============================================================

export function adapt14133(it: Raw14133Item): ComprasGovUnified {
  return {
    origem_lei: "14133",
    orgao_gerenciador: it.nomeUnidadeOrgao,
    cnpj_orgao: it.cnpjOrgao,
    numero_processo_ou_ata: it.numeroControlePNCP,
    descricao_item: (it.descricaoResumida || it.descricaodetalhada || "").toString(),
    descricao_detalhada: it.descricaodetalhada,
    unidade: it.unidadeMedida,
    quantidade: typeof it.quantidadeHomologada === "number" ? it.quantidadeHomologada : undefined,
    valor_unitario: typeof it.valorUnitarioHomologado === "number" ? it.valorUnitarioHomologado : undefined,
    valor_total: typeof it.valorTotalHomologado === "number" ? it.valorTotalHomologado : undefined,
    fornecedor_nome: it.nomeRazaoSocialFornecedor,
    fornecedor_cnpj: it.niFornecedor,
    uf: it.ufOrgao,
    municipio: it.municipioOrgao,
    data: it.dataResultadoPncp,
    id_externo: it.idCompraItem != null ? String(it.idCompraItem) : undefined,
  };
}

export function adaptPregao(it: RawPregaoItem): ComprasGovUnified {
  // valorHomologadoItem pode vir como total OU unitário dependendo do registro;
  // se quantidade > 1 e o valor parece grande, calcula unitário derivado.
  const valor = typeof it.valorHomologadoItem === "number" ? it.valorHomologadoItem : undefined;
  const qtd = typeof it.quantidade === "number" ? it.quantidade : undefined;
  let valor_unitario: number | undefined;
  let valor_total: number | undefined;
  if (valor != null && qtd && qtd > 1) {
    valor_total = valor;
    valor_unitario = valor / qtd;
  } else if (valor != null) {
    valor_unitario = valor;
  }
  return {
    origem_lei: "8666_pregao",
    orgao_gerenciador: it.nome_uasg,
    cnpj_orgao: undefined,
    numero_processo_ou_ata: it.numero_pregao,
    descricao_item: (it.descricao_item || it.descricao_detalhada_item || "").toString(),
    descricao_detalhada: it.descricao_detalhada_item,
    unidade: it.unidade_fornecimento,
    quantidade: qtd,
    valor_unitario,
    valor_total,
    fornecedor_nome: it.fornecedor_vencedor,
    fornecedor_cnpj: it.cnpj_fornecedor,
    uf: it.uf,
    municipio: it.municipio,
    data: it.data_homologacao,
    id_externo: it.numero_item != null ? `${it.uasg ?? ""}-${it.numero_pregao ?? ""}-${it.numero_item}` : undefined,
  };
}

export function adaptARP(it: RawARPItem): ComprasGovUnified {
  return {
    origem_lei: "arp",
    orgao_gerenciador: it.nomeUnidadeGerenciadora,
    cnpj_orgao: it.cnpjUnidadeGerenciadora,
    numero_processo_ou_ata: it.numeroAtaRegistroPreco,
    descricao_item: (it.descricaoItem || "").toString(),
    unidade: it.unidadeMedida,
    quantidade: typeof it.quantidadeHomologadaItem === "number" ? it.quantidadeHomologadaItem : undefined,
    valor_unitario: typeof it.valorUnitario === "number" ? it.valorUnitario : undefined,
    valor_total: typeof it.valorTotal === "number" ? it.valorTotal : undefined,
    fornecedor_nome: it.nomeRazaoSocialFornecedor,
    fornecedor_cnpj: it.niFornecedor,
    uf: it.ufUnidadeGerenciadora,
    municipio: it.municipioUnidadeGerenciadora,
    data: it.dataVigenciaInicial,
    id_externo:
      it.numeroAtaRegistroPreco && it.numeroItem != null
        ? `${it.numeroAtaRegistroPreco}-${it.numeroItem}`
        : it.numeroAtaRegistroPreco,
  };
}

/**
 * Roda as 3 trilhas em paralelo e devolve a lista unificada (já adaptada).
 * Usar em harvests / backfills agendados. Para a busca ao vivo por query,
 * prefira `searchComprasGovByKeyword` abaixo.
 */
export async function fetchAllUnified(
  dataInicial: string,
  dataFinal: string,
): Promise<ComprasGovUnified[]> {
  const [t1, t2, t3] = await Promise.allSettled([
    fetch_itens_homologados_nova_lei(dataInicial, dataFinal),
    fetch_itens_pregoes_legado(dataInicial, dataFinal),
    fetch_itens_arp(dataInicial, dataFinal),
  ]);
  const out: ComprasGovUnified[] = [];
  if (t1.status === "fulfilled") out.push(...t1.value.map(adapt14133));
  if (t2.status === "fulfilled") out.push(...t2.value.map(adaptPregao));
  if (t3.status === "fulfilled") out.push(...t3.value.map(adaptARP));
  return out;
}

// ============================================================
// Busca por keyword (filtro client-side sobre janela de data)
// ============================================================

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isoDaysAgo(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * Busca direta por palavra-chave usando Trilha 3 (ARP) + Trilha 1 (14133)
 * em janela curta de dias (default 90), filtrando client-side por todos os
 * tokens da query presentes na descrição do item.
 */
export async function searchComprasGovByKeyword(
  query: string,
  options: { dias?: number; incluirPregoes?: boolean; maxResultados?: number } = {},
): Promise<ComprasGovUnified[]> {
  const dias = options.dias ?? 90;
  const maxResultados = options.maxResultados ?? 200;
  const dataFinal = isoDaysAgo(0);
  const dataInicial = isoDaysAgo(dias);
  const tokens = normalizeText(query)
    .split(" ")
    .filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];

  const tasks: Promise<ComprasGovUnified[]>[] = [
    fetch_itens_arp(dataInicial, dataFinal).then((rs) => rs.map(adaptARP)),
    fetch_itens_homologados_nova_lei(dataInicial, dataFinal).then((rs) => rs.map(adapt14133)),
  ];
  if (options.incluirPregoes) {
    tasks.push(fetch_itens_pregoes_legado(dataInicial, dataFinal).then((rs) => rs.map(adaptPregao)));
  }
  const settled = await Promise.allSettled(tasks);
  const all = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  // Filtro: todos os tokens (>= 3 chars) presentes na descrição.
  const matched = all.filter((u) => {
    const hay = normalizeText(`${u.descricao_item} ${u.descricao_detalhada ?? ""}`);
    return tokens.every((t) => hay.includes(t));
  });

  return matched.slice(0, maxResultados);
}