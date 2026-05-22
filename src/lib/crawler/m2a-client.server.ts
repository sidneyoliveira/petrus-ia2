/**
 * Cliente para o portal compras.m2atecnologia.com.br.
 * Estratégia: usar /processos/tabela/ como índice (paginado, suporta filtros
 * de UF/modalidade/situação direto via querystring), extrair os links de cada
 * processo (/processos/publicacao/{id}/{slug}/), e em cada página de processo
 * encontrar o link canônico do edital no PNCP
 * (https://pncp.gov.br/app/editais/{cnpj}/{ano}/{sequencial}).
 *
 * Saída: lista de PncpCompraRef pronta pra alimentar `crawler/extract.compra`
 * — reaproveita 100% do pipeline PNCP existente (itens + resultados + golden
 * schema). Custo: 1 GET por página de listagem + 1 GET por processo.
 */

const M2A_BASE = "https://compras.m2atecnologia.com.br";
const UA = "Petrus-IA-DataEngine/1.0 (+cotacao)";

async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html,application/json,*/*", "User-Agent": UA },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(t);
    return null;
  }
}

/** Extrai todos os pares {id, slug} de links /processos/publicacao/.../ */
export function extractProcessRefs(html: string): { id: string; slug: string; url: string }[] {
  // O endpoint /tabela/ devolve JSON com HTML embutido (com escapes \"); por
  // isso o regex é tolerante a aspas escapadas.
  const re = /\/processos\/publicacao\/([a-f0-9]{16,64})\/([a-zA-Z0-9\-_]+)\/?/g;
  const seen = new Set<string>();
  const out: { id: string; slug: string; url: string }[] = [];
  for (const m of html.matchAll(re)) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, slug: m[2], url: `${M2A_BASE}/processos/publicacao/${id}/${m[2]}/` });
  }
  return out;
}

/** Extrai a primeira URL canônica do PNCP encontrada no HTML do processo. */
export function extractPncpRef(html: string): { cnpj: string; ano: string; sequencial: string; url: string } | null {
  const re = /https?:\/\/pncp\.gov\.br\/app\/editais\/(\d{14})\/(\d{4})\/(\d+)/i;
  const m = html.match(re);
  if (!m) return null;
  return {
    cnpj: m[1],
    ano: m[2],
    sequencial: m[3],
    url: `https://pncp.gov.br/app/editais/${m[1]}/${m[2]}/${m[3]}`,
  };
}

export interface M2aDiscoverOpts {
  search: string;
  /** Situação M2A: 7 = finalizado/homologado (padrão). */
  situacao?: number;
  page: number;
}

/** Faz 1 GET na listagem do M2A e devolve os links de processo. */
export async function fetchM2aListing(opts: M2aDiscoverOpts): Promise<{ id: string; slug: string; url: string }[]> {
  const qs = new URLSearchParams({
    search: opts.search,
    regiao: "",
    uf: "",
    municipio: "",
    modalidade: "",
    todos: "1",
    modo_disputa: "",
    situacao: String(opts.situacao ?? 7),
    page: String(opts.page),
  });
  const html = await fetchText(`${M2A_BASE}/processos/tabela/?${qs}`);
  if (!html) return [];
  return extractProcessRefs(html);
}

/** Busca a página do processo no M2A e devolve a ref PNCP (ou null). */
export async function fetchM2aPncpRef(processUrl: string): Promise<{ cnpj: string; ano: string; sequencial: string; url: string } | null> {
  const html = await fetchText(processUrl);
  if (!html) return null;
  return extractPncpRef(html);
}
