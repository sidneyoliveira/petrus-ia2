export interface PriceResult {
  id: string;
  titulo: string;
  descricao: string;
  unidade?: string;
  valor?: number | null;
  valorTotal?: number | null;
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

export interface SearchResponse {
  results: PriceResult[];
  total: number;
  pagina: number;
  pageSize: number;
  query: string;
  tookMs: number;
}