/**
 * Cliente PNCP compartilhado entre o motor de busca live (search.functions.ts)
 * e o crawler em background (Inngest). Centraliza User-Agent, timeout e
 * retry com backoff exponencial para 429/5xx — sem isso a API do PNCP
 * derruba qualquer varredura razoável.
 */

const PNCP_UA = "Petrus-IA-DataEngine/1.0 (+cotacao)";

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
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
        if (i === attempts - 1) return null;
        await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * 250)));
        delay *= 2;
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      clearTimeout(timer);
      if (i === attempts - 1) return null;
      await new Promise((r) => setTimeout(r, delay + Math.floor(Math.random() * 250)));
      delay *= 2;
    }
  }
  return null;
}

// ----- Tipos de domínio mínimos -----

export interface PncpCompraRef {
  cnpj: string;
  ano: string;
  sequencial: string;
  /** Dados básicos da compra para enriquecer os itens sem nova requisição. */
  orgao?: string;
  unidade?: string;
  municipio?: string;
  uf?: string;
  modalidade?: string;
  dataPublicacao?: string;
  objetoCompra?: string;
  url?: string;
}

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

// ----- Discovery (compras por janela de data) -----

/**
 * Modalidades PNCP relevantes para preços. Vide
 * https://www.gov.br/pncp (codigoModalidadeContratacao).
 *  1 = Leilão (descartado), 2 = Convite, 3 = Concorrência,
 *  4 = Pregão (eletrônico), 5 = TP, 6 = Dispensa, 7 = Inexigibilidade,
 *  8 = Concurso. Mantemos as que geram preços de mercado relevantes.
 */
export const RELEVANT_MODALIDADES = [4, 3, 6, 7, 8] as const;

interface PncpCompraDiscoveryRaw {
  orgaoEntidade?: { cnpj?: string; razaoSocial?: string };
  unidadeOrgao?: { nomeUnidade?: string; municipioNome?: string; ufSigla?: string };
  anoCompra?: number;
  sequencialCompra?: number;
  numeroControlePNCP?: string;
  objetoCompra?: string;
  modalidadeNome?: string;
  dataPublicacaoPncp?: string;
}

/**
 * Lista compras de uma janela [inicio, fim] (formato YYYYMMDD) para uma modalidade.
 * Pagina automaticamente respeitando `totalPaginas`.
 */
export async function discoverComprasByWindow(
  dataInicial: string,
  dataFinal: string,
  modalidade: number,
  maxPaginas = 50,
): Promise<PncpCompraRef[]> {
  const out: PncpCompraRef[] = [];
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const url =
      `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao` +
      `?dataInicial=${dataInicial}&dataFinal=${dataFinal}` +
      `&codigoModalidadeContratacao=${modalidade}` +
      `&pagina=${pagina}&tamanhoPagina=50`;
    const j = await pncpFetchJson<{
      data?: PncpCompraDiscoveryRaw[];
      totalPaginas?: number;
    }>(url, { timeoutMs: 20_000 });
    if (!j) break;
    const page = j.data ?? [];
    for (const c of page) {
      const cnpj = c.orgaoEntidade?.cnpj;
      const ano = c.anoCompra;
      const seq = c.sequencialCompra;
      if (!cnpj || !ano || !seq) continue;
      out.push({
        cnpj,
        ano: String(ano),
        sequencial: String(seq),
        orgao: c.orgaoEntidade?.razaoSocial,
        unidade: c.unidadeOrgao?.nomeUnidade,
        municipio: c.unidadeOrgao?.municipioNome,
        uf: c.unidadeOrgao?.ufSigla,
        modalidade: c.modalidadeNome,
        dataPublicacao: c.dataPublicacaoPncp,
        objetoCompra: c.objetoCompra,
        url: `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${seq}`,
      });
    }
    const total = j.totalPaginas ?? 1;
    if (pagina >= total) break;
    if (page.length < 50) break;
  }
  return out;
}

// ----- Itens da compra -----

export async function fetchCompraItens(
  cnpj: string,
  ano: string,
  sequencial: string,
): Promise<PncpItemRaw[]> {
  const seq = String(Number(sequencial.replace(/\D/g, "")) || sequencial);
  const all: PncpItemRaw[] = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const url = `https://pncp.gov.br/pncp-api/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens?pagina=${pagina}&tamanhoPagina=100`;
    const j = await pncpFetchJson<
      PncpItemRaw[] | { data?: PncpItemRaw[]; totalPaginas?: number }
    >(url, { timeoutMs: 15_000 });
    if (!j) break;
    const page = Array.isArray(j) ? j : (j.data ?? []);
    all.push(...page);
    const total = Array.isArray(j) ? undefined : j.totalPaginas;
    if (typeof total === "number" && pagina >= total) break;
    if (page.length < 100) break;
  }
  return all;
}

// ----- Resultado homologado de um item -----

export async function fetchItemResultado(
  cnpj: string,
  ano: string,
  sequencial: string,
  numeroItem: number,
): Promise<PncpResultadoRaw | null> {
  const seq = String(Number(sequencial.replace(/\D/g, "")) || sequencial);
  const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/${numeroItem}/resultados`;
  const j = await pncpFetchJson<PncpResultadoRaw[] | { data?: PncpResultadoRaw[] }>(url, {
    timeoutMs: 10_000,
  });
  if (!j) return null;
  const arr = Array.isArray(j) ? j : (j.data ?? []);
  const ativos = arr.filter(
    (r) =>
      !r.dataCancelamento &&
      typeof r.valorUnitarioHomologado === "number" &&
      r.valorUnitarioHomologado > 0,
  );
  if (ativos.length === 0) return null;
  ativos.sort((a, b) => {
    const sa = a.sequencialResultado ?? 999;
    const sb = b.sequencialResultado ?? 999;
    if (sa !== sb) return sa - sb;
    return (a.valorUnitarioHomologado ?? Infinity) - (b.valorUnitarioHomologado ?? Infinity);
  });
  return ativos[0];
}