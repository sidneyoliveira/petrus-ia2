import { describe, it, expect } from "vitest";
import { classifyTriad } from "./triad";

describe("classifyTriad", () => {
  it("tríade completa fechando bate como ok", () => {
    const r = classifyTriad({ quantidade: 500, valor: 42, valor_total: 21000 });
    expect(r.math_status).toBe("ok");
    expect(r.extraction_quality).toBe("tríade_ok");
    expect(r.valor_total_calculado).toBe(21000);
  });

  it("tríade com arredondamento dentro de 2% é ok", () => {
    const r = classifyTriad({ quantidade: 3, valor: 33.33, valor_total: 100 });
    expect(r.math_status).toBe("ok");
    expect(r.math_delta_pct).toBeLessThan(0.02);
  });

  it("tríade divergente > 2% marca divergente", () => {
    const r = classifyTriad({ quantidade: 10, valor: 100, valor_total: 5000 });
    expect(r.math_status).toBe("divergente");
    expect(r.extraction_quality).toBe("tríade_ok");
    expect(r.math_delta_pct).toBeCloseTo(0.8, 2);
  });

  it("qtd + unitário sem total deriva o total", () => {
    const r = classifyTriad({ quantidade: 4, valor: 25 });
    expect(r.math_status).toBe("ok");
    expect(r.valor_total_calculado).toBe(100);
  });

  it("só valor_total → só_global (valor global do processo)", () => {
    const r = classifyTriad({ valor_total: 5_000_000 });
    expect(r.extraction_quality).toBe("só_global");
    expect(r.math_status).toBe("single_value");
  });

  it("qtd + total sem unitário → sem_unitário (healer reprocessa)", () => {
    const r = classifyTriad({ quantidade: 500, valor_total: 21000 });
    expect(r.extraction_quality).toBe("sem_unitário");
    expect(r.math_status).toBe("incompleto");
  });

  it("nada preenchido → lixo", () => {
    const r = classifyTriad({});
    expect(r.extraction_quality).toBe("lixo");
  });

  it("só unitário (catálogo) → sem_qtd / single_value", () => {
    const r = classifyTriad({ valor: 99.9 });
    expect(r.extraction_quality).toBe("sem_qtd");
    expect(r.math_status).toBe("single_value");
  });

  it("valores zero/negativos são tratados como ausentes", () => {
    const r = classifyTriad({ quantidade: 0, valor: -5, valor_total: 100 });
    expect(r.extraction_quality).toBe("só_global");
  });
});