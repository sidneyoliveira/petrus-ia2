/**
 * Tríade de Item — validação matemática defensiva (padrão M2A).
 *
 * Classifica cada item extraído em duas dimensões ortogonais:
 * - `extraction_quality`: o que o extractor conseguiu pescar do texto
 * - `math_status`: se a aritmética Qtd × Unitário = Total fecha
 *
 * Puro: sem I/O. Testável em vitest sem mocks.
 */

export type MathStatus = "ok" | "divergente" | "incompleto" | "single_value";
export type ExtractionQuality =
  | "tríade_ok"
  | "sem_qtd"
  | "sem_unitário"
  | "só_global"
  | "lixo";

export interface TriadInput {
  quantidade?: number | null;
  valor?: number | null; // unitário
  valor_total?: number | null;
}

export interface TriadResult {
  math_status: MathStatus;
  extraction_quality: ExtractionQuality;
  valor_total_calculado: number | null;
  math_delta_pct: number | null; // 0..1 (ex.: 0.05 = 5% de divergência)
}

const TOLERANCE = 0.02; // 2% de divergência aceitável (arredondamento de centavos)

function isPos(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

export function classifyTriad(input: TriadInput): TriadResult {
  const q = isPos(input.quantidade) ? input.quantidade : null;
  const u = isPos(input.valor) ? input.valor : null;
  const t = isPos(input.valor_total) ? input.valor_total : null;

  // Sem absolutamente nenhum dado financeiro → lixo
  if (q === null && u === null && t === null) {
    return {
      math_status: "incompleto",
      extraction_quality: "lixo",
      valor_total_calculado: null,
      math_delta_pct: null,
    };
  }

  // Tríade completa → valida matemática
  if (q !== null && u !== null && t !== null) {
    const calc = q * u;
    const delta = Math.abs(calc - t) / t;
    return {
      math_status: delta <= TOLERANCE ? "ok" : "divergente",
      extraction_quality: "tríade_ok",
      valor_total_calculado: calc,
      math_delta_pct: delta,
    };
  }

  // Qtd + unitário, total ausente → deriva o total, consideramos tríade_ok
  if (q !== null && u !== null && t === null) {
    return {
      math_status: "ok",
      extraction_quality: "tríade_ok",
      valor_total_calculado: q * u,
      math_delta_pct: null,
    };
  }

  // Qtd + total, sem unitário → healer pode preencher
  if (q !== null && u === null && t !== null) {
    return {
      math_status: "incompleto",
      extraction_quality: "sem_unitário",
      valor_total_calculado: null,
      math_delta_pct: null,
    };
  }

  // Unitário + total, sem qtd → derivável mas baixa confiança
  if (q === null && u !== null && t !== null) {
    return {
      math_status: "incompleto",
      extraction_quality: "sem_qtd",
      valor_total_calculado: null,
      math_delta_pct: null,
    };
  }

  // Só unitário (sem qtd, sem total) → tipicamente preço de catálogo
  if (u !== null && q === null && t === null) {
    return {
      math_status: "single_value",
      extraction_quality: "sem_qtd",
      valor_total_calculado: null,
      math_delta_pct: null,
    };
  }

  // Só total (sem qtd, sem unitário) → valor global do processo, perigoso
  if (t !== null && q === null && u === null) {
    return {
      math_status: "single_value",
      extraction_quality: "só_global",
      valor_total_calculado: null,
      math_delta_pct: null,
    };
  }

  // Só qtd → inútil sem valor
  return {
    math_status: "incompleto",
    extraction_quality: "lixo",
    valor_total_calculado: null,
    math_delta_pct: null,
  };
}