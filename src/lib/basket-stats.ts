/**
 * Cálculos estatísticos de cesta segundo a IN SEGES nº 65/2021.
 *
 * - Remove outliers via IQR (Tukey, multiplicador 1,5 por padrão).
 * - Calcula média, mediana, desvio padrão e Coeficiente de Variação (CV).
 * - Considera a cesta homogênea quando CV ≤ 25 %.
 */

export interface BasketStatsInput {
  id: string;
  valor: number;
}

export interface BasketStats {
  n: number;
  nBruto: number;
  media: number;
  mediana: number;
  desvio: number;
  /** Coeficiente de variação em pontos percentuais (ex.: 18,4 = 18,4 %). */
  coeficienteVariacao: number;
  min: number;
  max: number;
  outliers: string[];
  homogeneo: boolean;
  recomendacao: string;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

const EMPTY: BasketStats = {
  n: 0,
  nBruto: 0,
  media: 0,
  mediana: 0,
  desvio: 0,
  coeficienteVariacao: 0,
  min: 0,
  max: 0,
  outliers: [],
  homogeneo: true,
  recomendacao: "Cesta vazia",
};

export function calculateBasketStats(
  items: BasketStatsInput[],
  iqrMultiplier = 1.5,
): BasketStats {
  const valid = items.filter(
    (i) => typeof i.valor === "number" && Number.isFinite(i.valor) && i.valor > 0,
  );
  if (valid.length === 0) return EMPTY;

  const sorted = [...valid].sort((a, b) => a.valor - b.valor);
  const values = sorted.map((s) => s.valor);

  // Outliers via IQR — só vale a pena com n ≥ 4.
  let outliers: string[] = [];
  let clean = sorted;
  if (values.length >= 4) {
    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);
    const iqr = q3 - q1;
    const lo = q1 - iqrMultiplier * iqr;
    const hi = q3 + iqrMultiplier * iqr;
    outliers = sorted.filter((s) => s.valor < lo || s.valor > hi).map((s) => s.id);
    clean = sorted.filter((s) => s.valor >= lo && s.valor <= hi);
  }

  const cleanValues = clean.map((s) => s.valor);
  const n = cleanValues.length;
  const media = cleanValues.reduce((a, b) => a + b, 0) / n;
  const mediana =
    n % 2 === 0
      ? (cleanValues[n / 2 - 1] + cleanValues[n / 2]) / 2
      : cleanValues[(n - 1) / 2];
  const variancia =
    cleanValues.reduce((s, v) => s + (v - media) ** 2, 0) / n;
  const desvio = Math.sqrt(variancia);
  const cv = media !== 0 ? (desvio / media) * 100 : 0;

  let recomendacao: string;
  if (n < 3) {
    recomendacao = "Adicione mais cotações (mínimo recomendado: 3 fontes).";
  } else if (cv <= 15) {
    recomendacao = "Cesta muito homogênea — preços alinhados.";
  } else if (cv <= 25) {
    recomendacao = "Cesta homogênea — dentro do CV ≤ 25 % (IN 65/2021).";
  } else {
    recomendacao =
      "Cesta heterogênea (CV > 25 %). Reavalie outliers ou justifique a dispersão.";
  }

  return {
    n,
    nBruto: valid.length,
    media,
    mediana,
    desvio: Number(desvio.toFixed(2)),
    coeficienteVariacao: Number(cv.toFixed(1)),
    min: cleanValues[0],
    max: cleanValues[n - 1],
    outliers,
    homogeneo: cv <= 25 && n >= 3,
    recomendacao,
  };
}