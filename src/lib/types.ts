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
  origem: "PNCP" | "Compras.gov.br" | "Transparência" | "Outro";
  documento?: "edital" | "ata" | "contrato" | "outro";
  url?: string;
  homologado: boolean;
  scoreTextual: number;
  scoreSemantico: number;
  scoreJuridico: number;
  scoreGeografico: number;
  scoreTecnico: number;
  scoreFinal: number;
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

export interface SearchResponse {
  results: PriceResult[];
  total: number;
  pagina: number;
  pageSize: number;
  query: string;
  tookMs: number;
}