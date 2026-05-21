/**
 * Regras puras de classificação de valores do PNCP.
 *
 * Pertinente a duas garantias:
 *   1. Nunca exibir o "valor global" (preço do lote/processo inteiro)
 *      no campo de valor unitário — isso confundia o operador.
 *   2. Sinalizar quando uma linha só traz valor global, exigindo
 *      chamar /pncp-api/v1/.../compras/.../itens para obter o unitário.
 *
 * Este arquivo NÃO importa nada do runtime — é 100% puro e testável.
 */

export type ValorTipo =
  | "unitario_homologado"
  | "unitario_estimado"
  | "global"
  | "desconhecido";

export interface RawValores {
  valor_unitario_homologado?: number | null;
  valor_unitario_estimado?: number | null;
  valor_unitario?: number | null;
  valor_homologado?: number | null;
  valor_estimado?: number | null;
  valor_global?: number | null;
  valorTotalEstimado?: number | null;
  valor_total_item?: number | null;
  quantidade?: number | null;
}

const isPos = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Classifica a natureza do valor presente na linha bruta.
 * Prioridade: homologado unitário > estimado unitário > global > desconhecido.
 */
export function classifyValorTipo(r: RawValores): ValorTipo {
  if (isPos(r.valor_unitario_homologado)) return "unitario_homologado";
  if (isPos(r.valor_unitario_estimado) || isPos(r.valor_unitario))
    return "unitario_estimado";
  if (isPos(r.valor_homologado) || isPos(r.valor_estimado))
    return "unitario_estimado";
  if (isPos(r.valor_global) || isPos(r.valorTotalEstimado)) return "global";
  return "desconhecido";
}

/**
 * Retorna o valor UNITÁRIO seguro.
 *
 * REGRA INVIOLÁVEL: se a linha só tem valor global (lote/processo inteiro),
 * o unitário é `null`. Nunca devolver valor_global aqui — só em valorTotal.
 * O frontend mostra "valor unitário não informado" e o operador pode abrir
 * a fonte ou aguardar o enriquecimento /itens.
 *
 * Se houver quantidade > 0 conhecida E só valor global, podemos DERIVAR
 * o unitário como global/quantidade — mas marcamos como "unitario_estimado"
 * apenas se a quantidade for inteira plausível (>=1). Caso contrário, null.
 */
export function safeUnitValue(r: RawValores): {
  valor: number | null;
  valorTotal: number | null;
  valorTipo: ValorTipo;
} {
  if (isPos(r.valor_unitario_homologado))
    return {
      valor: r.valor_unitario_homologado!,
      valorTotal:
        (isPos(r.valor_total_item) && r.valor_total_item!) ||
        (isPos(r.quantidade) ? r.quantidade! * r.valor_unitario_homologado! : r.valor_unitario_homologado!),
      valorTipo: "unitario_homologado",
    };
  if (isPos(r.valor_unitario_estimado))
    return {
      valor: r.valor_unitario_estimado!,
      valorTotal:
        (isPos(r.valor_total_item) && r.valor_total_item!) ||
        (isPos(r.quantidade) ? r.quantidade! * r.valor_unitario_estimado! : r.valor_unitario_estimado!),
      valorTipo: "unitario_estimado",
    };
  if (isPos(r.valor_unitario))
    return {
      valor: r.valor_unitario!,
      valorTotal:
        (isPos(r.valor_total_item) && r.valor_total_item!) ||
        (isPos(r.quantidade) ? r.quantidade! * r.valor_unitario! : r.valor_unitario!),
      valorTipo: "unitario_estimado",
    };
  if (isPos(r.valor_homologado))
    return { valor: r.valor_homologado!, valorTotal: r.valor_homologado!, valorTipo: "unitario_estimado" };
  if (isPos(r.valor_estimado))
    return { valor: r.valor_estimado!, valorTotal: r.valor_estimado!, valorTipo: "unitario_estimado" };

  // Apenas global disponível
  const totalGlobal =
    (isPos(r.valor_global) && r.valor_global!) ||
    (isPos(r.valorTotalEstimado) && r.valorTotalEstimado!) ||
    null;

  if (totalGlobal && isPos(r.quantidade) && r.quantidade! >= 1) {
    // Deriva unitário a partir do global/quantidade — só quando quantidade
    // é claramente conhecida. Marca como estimado derivado.
    const derived = totalGlobal / r.quantidade!;
    if (Number.isFinite(derived) && derived > 0)
      return {
        valor: Math.round(derived * 100) / 100,
        valorTotal: totalGlobal,
        valorTipo: "unitario_estimado",
      };
  }

  return { valor: null, valorTotal: totalGlobal, valorTipo: totalGlobal ? "global" : "desconhecido" };
}

/**
 * True quando precisamos OBRIGATORIAMENTE buscar /itens no PNCP.
 * - Só veio valor global (sem unitário) E não conseguimos derivar.
 * - Ou veio sem valor algum mas existe o número de controle PNCP.
 */
export function requiresItemFetch(input: {
  raw: RawValores;
  numero_controle_pncp?: string | null;
}): boolean {
  const t = classifyValorTipo(input.raw);
  if (t === "unitario_homologado" || t === "unitario_estimado") return false;
  // Global puro OU desconhecido com referência PNCP → precisa enriquecer.
  return Boolean(input.numero_controle_pncp) || t === "global";
}

/**
 * Regex do `numeroControlePNCPCompra`: 14 dígitos (CNPJ) "-1-" SEQ "/" ANO.
 * Extraído como pura para permitir testar formatos válidos/inválidos.
 */
export function parseNumeroControlePncpCompra(
  value?: unknown,
): { cnpj: string; ano: string; sequencial: string } | null {
  const s = String(value ?? "").trim();
  const m = s.match(/(\d{14})-1-0*(\d+)\/(\d{4})/);
  if (!m) return null;
  return { cnpj: m[1], sequencial: String(Number(m[2])), ano: m[3] };
}