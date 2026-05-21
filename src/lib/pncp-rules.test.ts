import { describe, it, expect } from "vitest";
import {
  classifyValorTipo,
  safeUnitValue,
  requiresItemFetch,
  parseNumeroControlePncpCompra,
} from "./pncp-rules";

describe("classifyValorTipo", () => {
  it("marca homologado quando há valor_unitario_homologado positivo", () => {
    expect(classifyValorTipo({ valor_unitario_homologado: 2.5 })).toBe("unitario_homologado");
  });

  it("marca estimado quando só há valor_unitario_estimado", () => {
    expect(classifyValorTipo({ valor_unitario_estimado: 1.99 })).toBe("unitario_estimado");
  });

  it("marca global quando só há valor_global ou valorTotalEstimado", () => {
    expect(classifyValorTipo({ valor_global: 391319.28 })).toBe("global");
    expect(classifyValorTipo({ valorTotalEstimado: 50000 })).toBe("global");
  });

  it("ignora zero e negativos (são lixo do PNCP)", () => {
    expect(classifyValorTipo({ valor_unitario_homologado: 0 })).toBe("desconhecido");
    expect(classifyValorTipo({ valor_global: -1 })).toBe("desconhecido");
  });

  it("prioridade: homologado > estimado > global", () => {
    expect(
      classifyValorTipo({
        valor_unitario_homologado: 10,
        valor_unitario_estimado: 8,
        valor_global: 1000,
      }),
    ).toBe("unitario_homologado");
  });
});

describe("safeUnitValue — REGRA INVIOLÁVEL: nunca exibir valor de lote como unitário", () => {
  it("entrega o homologado unitário diretamente", () => {
    const out = safeUnitValue({ valor_unitario_homologado: 2.11, quantidade: 1800 });
    expect(out.valor).toBe(2.11);
    expect(out.valorTotal).toBe(3798);
    expect(out.valorTipo).toBe("unitario_homologado");
  });

  it("BUG ANTIGO: NÃO devolve valor_global no campo unitário sem quantidade", () => {
    const out = safeUnitValue({ valor_global: 391319.28 });
    expect(out.valor).toBeNull();
    expect(out.valorTotal).toBe(391319.28);
    expect(out.valorTipo).toBe("global");
  });

  it("BUG ANTIGO: NÃO devolve valorTotalEstimado como unitário", () => {
    const out = safeUnitValue({ valorTotalEstimado: 250000 });
    expect(out.valor).toBeNull();
    expect(out.valorTotal).toBe(250000);
    expect(out.valorTipo).toBe("global");
  });

  it("DERIVA unitário quando há quantidade conhecida + valor global (multifuncional)", () => {
    // Cenário real: 792 SRV × R$ 494,09 = R$ 391.319,28
    const out = safeUnitValue({ valor_global: 391319.28, quantidade: 792 });
    expect(out.valor).toBeCloseTo(494.09, 2);
    expect(out.valorTotal).toBe(391319.28);
    expect(out.valorTipo).toBe("unitario_estimado");
  });

  it("NÃO deriva quando quantidade é zero ou ausente", () => {
    expect(safeUnitValue({ valor_global: 1000, quantidade: 0 }).valor).toBeNull();
    expect(safeUnitValue({ valor_global: 1000 }).valor).toBeNull();
  });

  it("retorna valor unitário + total = qty × unit quando ambos existem", () => {
    const out = safeUnitValue({ valor_unitario_estimado: 28, quantidade: 8993 });
    expect(out.valor).toBe(28);
    expect(out.valorTotal).toBe(8993 * 28);
    expect(out.valorTipo).toBe("unitario_estimado");
  });

  it("desconhecido quando não há valor algum", () => {
    const out = safeUnitValue({});
    expect(out.valor).toBeNull();
    expect(out.valorTotal).toBeNull();
    expect(out.valorTipo).toBe("desconhecido");
  });
});

describe("requiresItemFetch — quando o pipeline DEVE chamar /itens do PNCP", () => {
  it("FALSE quando já temos unitário homologado", () => {
    expect(
      requiresItemFetch({
        raw: { valor_unitario_homologado: 5 },
        numero_controle_pncp: "00394684000153-1-000021/2026",
      }),
    ).toBe(false);
  });

  it("TRUE quando só temos valor global do processo (lote)", () => {
    expect(
      requiresItemFetch({
        raw: { valor_global: 391319.28 },
        numero_controle_pncp: "00394684000153-1-000021/2026",
      }),
    ).toBe(true);
  });

  it("TRUE quando só há valorTotalEstimado (resultado da busca PNCP)", () => {
    expect(
      requiresItemFetch({
        raw: { valorTotalEstimado: 250000 },
        numero_controle_pncp: "00394684000153-1-000021/2026",
      }),
    ).toBe(true);
  });

  it("TRUE quando não há valor algum mas existe numero_controle_pncp", () => {
    expect(
      requiresItemFetch({
        raw: {},
        numero_controle_pncp: "00394684000153-1-000021/2026",
      }),
    ).toBe(true);
  });

  it("FALSE quando não há valor nem numero_controle_pncp (resultado externo)", () => {
    expect(requiresItemFetch({ raw: {} })).toBe(false);
  });
});

describe("parseNumeroControlePncpCompra", () => {
  it("extrai CNPJ, sequencial e ano do formato canônico", () => {
    const out = parseNumeroControlePncpCompra("00394684000153-1-000021/2026");
    expect(out).toEqual({ cnpj: "00394684000153", sequencial: "21", ano: "2026" });
  });

  it("aceita sequencial sem zeros à esquerda", () => {
    expect(parseNumeroControlePncpCompra("63025530000104-1-63/2026")).toEqual({
      cnpj: "63025530000104",
      sequencial: "63",
      ano: "2026",
    });
  });

  it("retorna null em strings inválidas", () => {
    expect(parseNumeroControlePncpCompra("")).toBeNull();
    expect(parseNumeroControlePncpCompra("foo")).toBeNull();
    expect(parseNumeroControlePncpCompra("123-1-1/2026")).toBeNull(); // CNPJ curto
    expect(parseNumeroControlePncpCompra(null)).toBeNull();
    expect(parseNumeroControlePncpCompra(undefined)).toBeNull();
  });
});

describe("contrato de saída para o frontend — não regredir a UX do lote", () => {
  // Estes casos espelham resultados reais que vimos no PNCP e blindam contra
  // o bug "preço unitário gigante igual ao valor do lote inteiro".
  const casos: Array<{
    nome: string;
    raw: Parameters<typeof safeUnitValue>[0];
    esperaUnit: number | null;
    esperaTipo: ReturnType<typeof classifyValorTipo>;
  }> = [
    {
      nome: "Multifuncional (locação) — só global + qtd",
      raw: { valor_global: 391319.28, quantidade: 792 },
      esperaUnit: 494.09,
      esperaTipo: "global", // classify ainda diz global no raw
    },
    {
      nome: "Caneta esferográfica — homologado unitário",
      raw: { valor_unitario_homologado: 2.11, quantidade: 1800 },
      esperaUnit: 2.11,
      esperaTipo: "unitario_homologado",
    },
    {
      nome: "Ata sem unitário, só global e sem quantidade — NÃO mostrar lote",
      raw: { valor_global: 1_200_000 },
      esperaUnit: null,
      esperaTipo: "global",
    },
  ];

  for (const c of casos) {
    it(c.nome, () => {
      const out = safeUnitValue(c.raw);
      if (c.esperaUnit === null) expect(out.valor).toBeNull();
      else expect(out.valor).toBeCloseTo(c.esperaUnit, 2);
      expect(classifyValorTipo(c.raw)).toBe(c.esperaTipo);
    });
  }
});