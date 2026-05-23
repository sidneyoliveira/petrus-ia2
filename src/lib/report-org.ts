/**
 * Metadados de identificação do órgão e do processo, usados pelos relatórios.
 *
 * Armazenado em localStorage (escopo do navegador do usuário) — não trafega
 * para o servidor. Lido pelos builders de PDF no momento da renderização.
 */

export interface OrgMetadata {
  /** Nome completo do órgão (ex.: "PREFEITURA MUNICIPAL DE ITAREMA"). */
  orgName: string;
  /** Forma curta usada em nome de arquivo (ex.: "ITAREMA-CE"). */
  orgShort: string;
  /** CNPJ formatado ou só dígitos. */
  cnpj: string;
  /** Endereço completo para o rodapé. */
  endereco: string;
  /** Identificador do processo (ex.: "DISP 11/2026" ou "PE 03/2026"). */
  processoNumero: string;
  /** Nome do responsável pela pesquisa de preços (assinatura). */
  responsavel: string;
  /** Cargo/função do responsável. */
  cargo: string;
}

const KEY = "petrus_org_metadata_v1";
const EVENT = "petrus:org-metadata-changed";

export const DEFAULT_ORG: OrgMetadata = {
  orgName: "",
  orgShort: "",
  cnpj: "",
  endereco: "",
  processoNumero: "",
  responsavel: "",
  cargo: "Responsável pela Pesquisa de Preços",
};

export function getOrgMetadata(): OrgMetadata {
  if (typeof window === "undefined") return DEFAULT_ORG;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_ORG;
    const parsed = JSON.parse(raw) as Partial<OrgMetadata>;
    return { ...DEFAULT_ORG, ...parsed };
  } catch {
    return DEFAULT_ORG;
  }
}

export function setOrgMetadata(meta: OrgMetadata): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(meta));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: meta }));
  } catch {
    /* quota / private mode — ignora */
  }
}

export function onOrgMetadataChange(cb: (m: OrgMetadata) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => cb(getOrgMetadata());
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}

function slug(s: string, max = 40): string {
  return s
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, max);
}

function onlyDigits(s: string): string {
  return (s || "").replace(/\D/g, "");
}

/**
 * Compõe o nome do arquivo no padrão profissional:
 *   "PROPOSTA DE PRECOS - <ORG_SHORT> - CNPJ <NNNN> - PROC <NUMERO> - <TIPO>.pdf"
 * Fallback se a metadata estiver vazia: usa o sufixo padrão.
 */
export function buildReportFilename(opts: {
  meta?: OrgMetadata;
  tipo: "ITEM" | "PROCESSO" | "CESTA";
  fallback: string;
  /** Sufixo adicional, ex.: descrição do item ou nº do processo de origem. */
  suffix?: string;
}): string {
  const meta = opts.meta ?? getOrgMetadata();
  const parts: string[] = ["PROPOSTA DE PRECOS"];

  const orgShort = (meta.orgShort || meta.orgName || "").trim();
  if (orgShort) parts.push(slug(orgShort, 50));

  const cnpjDigits = onlyDigits(meta.cnpj);
  if (cnpjDigits.length >= 8) parts.push(`CNPJ ${cnpjDigits}`);

  const proc = (meta.processoNumero || "").trim();
  if (proc) parts.push(`PROC ${slug(proc, 24)}`);

  parts.push(opts.tipo);
  if (opts.suffix) parts.push(slug(opts.suffix, 30));

  // Se não houver nenhum dado do órgão, mantém o fallback original.
  if (parts.length <= 2) return opts.fallback;

  return `${parts.join(" - ")}.pdf`;
}

/** Formata CNPJ para exibição (NN.NNN.NNN/NNNN-NN). */
export function formatCnpj(cnpj: string): string {
  const d = onlyDigits(cnpj).padStart(14, "0").slice(-14);
  if (d === "00000000000000") return "";
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}