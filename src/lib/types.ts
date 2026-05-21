export interface PriceResult {
  id: string;
  titulo: string;
  subtitulo?: string;
  descricao: string;
  unidade?: string;
  quantidade?: number | null;
  valor?: number | null;
  valorTotal?: number | null;
  /**
   * Procedência do `valor` exibido:
   * - "unitario_homologado": valor unitário homologado do item (ideal)
   * - "unitario_estimado": valor unitário estimado do item
   * - "global": valor TOTAL do processo (não unitário — pouco confiável p/ cotação)
   * - "desconhecido": campo de valor sem contexto claro
   */
  valorTipo?: "unitario_homologado" | "unitario_estimado" | "global" | "desconhecido";
  fornecedor?: string;
  cnpj?: string;
  orgao?: string;
  municipio?: string;
  uf?: string;
  data?: string;
  modalidade?: string;
  situacao?: string;
  numero?: string;
  ano?: string;
  origem: string;
  documento?: "edital" | "ata" | "contrato" | "outro";
  url?: string;
  /**
   * Trecho-fonte (até ~1000 chars) usado para destacar o conteúdo no documento
   * original quando o usuário clica em "Ver Fonte com Destaque". Em geral espelha
   * `descricao`, mas pode ser refinado por pipelines posteriores.
   */
  sourceExcerpt?: string;
  homologado: boolean;
  scoreTextual: number;
  scoreSemantico: number;
  scoreJuridico: number;
  scoreGeografico: number;
  scoreTecnico: number;
  scoreFinal: number;
  /**
   * Título canônico curto do item (separado da `descricao` técnica).
   * Quando ausente, a UI cai para `titulo`.
   */
  objetoEstruturado?: string;
  /** Resultado da validação aritmética Qtd × Unitário = Total. */
  mathStatus?: "ok" | "divergente" | "incompleto" | "single_value";
  /** Classificação da extração: tríade_ok / sem_qtd / sem_unitário / só_global / lixo. */
  extractionQuality?:
    | "tríade_ok"
    | "sem_qtd"
    | "sem_unitário"
    | "só_global"
    | "lixo";
  /** Total recalculado (qtd × unitário) — pode diferir de valorTotal. */
  valorTotalCalculado?: number | null;
  /** Divergência relativa |total - calc|/total (0..1). */
  mathDeltaPct?: number | null;
}

export interface SearchFilters {
  query: string;
  uf?: string;
  modalidade?: string;
  apenasHomologados?: boolean;
  ultimosMeses?: number;
  valorMin?: number;
  valorMax?: number;
  pagina?: number;
}

export type SearchMode = "semantic" | "exact" | "all_keywords";

export interface SearchSourceStatus {
  name: string;
  domain?: string;
  total: number;
}

export interface SearchResponse {
  results: PriceResult[];
  total: number;
  pagina: number;
  pageSize: number;
  query: string;
  tookMs: number;
  sources?: SearchSourceStatus[];
  /** True quando o resultado veio do cache em vez da varredura ao vivo. */
  fromCache?: boolean;
  /** ISO timestamp de quando o cache foi gerado. */
  cachedAt?: string;
  /** True quando o cache existe mas já está fora da janela de frescor. */
  stale?: boolean;
}