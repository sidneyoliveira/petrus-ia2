import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  pncpFetchJson,
  fetchCompraItens,
  fetchItemResultado,
  type PncpItemRaw,
  type PncpResultadoRaw,
} from "@/lib/crawler/pncp-client.server";

/** Parser local pra evitar puxar todo o pipeline.server.ts. */
function parsePncpPublicUrl(url?: string | null) {
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

export interface ProcessDossierArquivo {
  titulo: string;
  tipo: string;
  url: string;
  data?: string;
}

export interface ProcessDossierItem {
  numeroItem: number;
  descricao: string;
  unidade?: string;
  quantidade?: number;
  valorUnitarioEstimado?: number;
  valorUnitarioHomologado?: number;
  valorTotal?: number;
  situacao?: string;
  fornecedor?: string;
  cnpjFornecedor?: string;
}

export interface ProcessDossier {
  origem: string;
  urlCanonica?: string;
  cnpj?: string;
  ano?: string;
  sequencial?: string;
  numeroControlePNCP?: string;
  orgao?: string;
  modalidade?: string;
  situacao?: string;
  municipio?: string;
  uf?: string;
  dataPublicacao?: string;
  objetoCompra?: string;
  valorTotalEstimado?: number;
  valorTotalHomologado?: number;
  itens: ProcessDossierItem[];
  arquivos: ProcessDossierArquivo[];
  /** True se conseguimos buscar dados oficiais ao vivo na API do PNCP. */
  liveData: boolean;
  warnings: string[];
}

interface PncpArquivoRaw {
  url?: string;
  uri?: string;
  titulo?: string;
  tipoDocumentoNome?: string;
  tipoDocumentoDescricao?: string;
  dataPublicacaoPncp?: string;
  statusAtivo?: boolean;
  sequencialDocumento?: number;
}

interface PncpCompraDetalhe {
  orgaoEntidade?: { cnpj?: string; razaoSocial?: string };
  unidadeOrgao?: { nomeUnidade?: string; municipioNome?: string; ufSigla?: string };
  anoCompra?: number;
  sequencialCompra?: number;
  numeroControlePNCP?: string;
  objetoCompra?: string;
  modalidadeNome?: string;
  situacaoCompraNome?: string;
  dataPublicacaoPncp?: string;
  valorTotalEstimado?: number;
  valorTotalHomologado?: number;
}

async function fetchCompraDetalhe(
  cnpj: string,
  ano: string,
  sequencial: string,
): Promise<PncpCompraDetalhe | null> {
  const seq = String(Number(sequencial.replace(/\D/g, "")) || sequencial);
  // Endpoint público de consulta
  const url = `https://pncp.gov.br/api/consulta/v1/orgaos/${cnpj}/compras/${ano}/${seq}`;
  return pncpFetchJson<PncpCompraDetalhe>(url, { timeoutMs: 10_000, attempts: 2 });
}

async function fetchCompraArquivos(
  cnpj: string,
  ano: string,
  sequencial: string,
): Promise<ProcessDossierArquivo[]> {
  const seq = String(Number(sequencial.replace(/\D/g, "")) || sequencial);
  const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/arquivos`;
  const j = await pncpFetchJson<PncpArquivoRaw[] | { data?: PncpArquivoRaw[] }>(url, {
    timeoutMs: 10_000,
    attempts: 2,
  });
  if (!j) return [];
  const arr = Array.isArray(j) ? j : (j.data ?? []);
  return arr
    .filter((a) => a && (a.statusAtivo ?? true))
    .map((a) => ({
      titulo: (a.titulo || a.tipoDocumentoNome || "Documento").trim(),
      tipo: a.tipoDocumentoNome || a.tipoDocumentoDescricao || "Documento",
      url: a.url || a.uri || "",
      data: a.dataPublicacaoPncp,
    }))
    .filter((a) => a.url);
}

function brl(n?: number | null) {
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return n;
}

async function enrichItemsWithResultado(
  cnpj: string,
  ano: string,
  sequencial: string,
  itens: PncpItemRaw[],
): Promise<ProcessDossierItem[]> {
  // Limita concorrência a 6 pra não derrubar a API
  const out: ProcessDossierItem[] = new Array(itens.length);
  let cursor = 0;
  async function worker() {
    while (cursor < itens.length) {
      const i = cursor++;
      const it = itens[i];
      const numero = typeof it.numeroItem === "number" ? it.numeroItem : i + 1;
      let resultado: PncpResultadoRaw | null = null;
      if (typeof it.valorUnitarioHomologado !== "number") {
        resultado = await fetchItemResultado(cnpj, ano, sequencial, numero);
      }
      out[i] = {
        numeroItem: numero,
        descricao: (it.descricao || "").trim(),
        unidade: it.unidadeMedida,
        quantidade: brl(it.quantidade),
        valorUnitarioEstimado: brl(it.valorUnitarioEstimado),
        valorUnitarioHomologado:
          brl(it.valorUnitarioHomologado) ?? brl(resultado?.valorUnitarioHomologado),
        valorTotal: brl(it.valorTotalHomologado) ?? brl(it.valorTotal),
        situacao: it.situacaoCompraItemNome,
        fornecedor: resultado?.nomeRazaoSocialFornecedor,
        cnpjFornecedor: resultado?.niFornecedor,
      };
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, itens.length) }, worker));
  return out;
}

const DossierInput = z.object({
  origem: z.string().min(1).max(50),
  url: z.string().url().optional().nullable(),
  cnpj: z.string().regex(/^\d{14}$/).optional().nullable(),
  ano: z.string().regex(/^\d{4}$/).optional().nullable(),
  sequencial: z.string().regex(/^\d+$/).optional().nullable(),
  /** Dados já conhecidos (fallback se a API não responder). */
  fallback: z
    .object({
      orgao: z.string().optional(),
      modalidade: z.string().optional(),
      municipio: z.string().optional(),
      uf: z.string().optional(),
      dataPublicacao: z.string().optional(),
      objetoCompra: z.string().optional(),
    })
    .optional(),
});

export const buildProcessDossier = createServerFn({ method: "POST" })
  .inputValidator((input: z.input<typeof DossierInput>) => DossierInput.parse(input))
  .handler(async ({ data }): Promise<ProcessDossier> => {
    const warnings: string[] = [];
    let cnpj = data.cnpj ?? undefined;
    let ano = data.ano ?? undefined;
    let sequencial = data.sequencial ?? undefined;

    // Resolve cnpj/ano/seq a partir da URL pública se não vierem prontos
    if ((!cnpj || !ano || !sequencial) && data.url) {
      const parsed = parsePncpPublicUrl(data.url);
      if (parsed) {
        cnpj = cnpj ?? parsed.cnpj;
        ano = ano ?? parsed.ano;
        sequencial = sequencial ?? parsed.sequencial;
      }
    }

    const isPncp = /pncp/i.test(data.origem) || /pncp\.gov\.br/i.test(data.url ?? "");
    const urlCanonica =
      cnpj && ano && sequencial
        ? `https://pncp.gov.br/app/editais/${cnpj}/${ano}/${sequencial}`
        : data.url ?? undefined;

    if (!isPncp || !cnpj || !ano || !sequencial) {
      warnings.push(
        "Sem dados estruturados ao vivo — fonte não-PNCP ou identificadores ausentes. Espelho será montado com os dados já extraídos.",
      );
      return {
        origem: data.origem,
        urlCanonica,
        cnpj: cnpj ?? undefined,
        ano: ano ?? undefined,
        sequencial: sequencial ?? undefined,
        orgao: data.fallback?.orgao,
        modalidade: data.fallback?.modalidade,
        municipio: data.fallback?.municipio,
        uf: data.fallback?.uf,
        dataPublicacao: data.fallback?.dataPublicacao,
        objetoCompra: data.fallback?.objetoCompra,
        itens: [],
        arquivos: [],
        liveData: false,
        warnings,
      };
    }

    // PNCP: busca paralela detalhe + itens + arquivos
    const [detalhe, itensRaw, arquivos] = await Promise.all([
      fetchCompraDetalhe(cnpj, ano, sequencial),
      fetchCompraItens(cnpj, ano, sequencial),
      fetchCompraArquivos(cnpj, ano, sequencial),
    ]);

    if (!detalhe) {
      warnings.push(
        "API de detalhe do PNCP não respondeu — usando dados do índice de busca.",
      );
    }
    if (itensRaw.length === 0) {
      warnings.push("Nenhum item retornado pelo endpoint /itens do PNCP.");
    }
    if (arquivos.length === 0) {
      warnings.push("Sem documentos oficiais publicados no PNCP até o momento.");
    }

    const itens = itensRaw.length
      ? await enrichItemsWithResultado(cnpj, ano, sequencial, itensRaw)
      : [];

    return {
      origem: data.origem,
      urlCanonica,
      cnpj,
      ano,
      sequencial,
      numeroControlePNCP: detalhe?.numeroControlePNCP,
      orgao: detalhe?.orgaoEntidade?.razaoSocial ?? data.fallback?.orgao,
      modalidade: detalhe?.modalidadeNome ?? data.fallback?.modalidade,
      situacao: detalhe?.situacaoCompraNome,
      municipio: detalhe?.unidadeOrgao?.municipioNome ?? data.fallback?.municipio,
      uf: detalhe?.unidadeOrgao?.ufSigla ?? data.fallback?.uf,
      dataPublicacao: detalhe?.dataPublicacaoPncp ?? data.fallback?.dataPublicacao,
      objetoCompra: detalhe?.objetoCompra ?? data.fallback?.objetoCompra,
      valorTotalEstimado: brl(detalhe?.valorTotalEstimado),
      valorTotalHomologado: brl(detalhe?.valorTotalHomologado),
      itens,
      arquivos,
      liveData: Boolean(detalhe) || itens.length > 0,
      warnings,
    };
  });