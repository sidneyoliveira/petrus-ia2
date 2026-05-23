import { CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";

function brl(v?: number | null) {
  if (typeof v !== "number") return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
}

export interface MathStatusIndicatorProps {
  status?: "ok" | "divergente" | "incompleto" | "single_value";
  delta?: number | null;
  quantidade?: number | null;
  valor?: number | null;
  valorTotal?: number | null;
  compact?: boolean;
}

/**
 * Pequeno chip que mostra se a aritmética Qtd × Unitário = Total bate.
 * Tooltip explica o porquê quando há divergência.
 */
export function MathStatusIndicator({
  status,
  delta,
  quantidade,
  valor,
  valorTotal,
  compact,
}: MathStatusIndicatorProps) {
  if (!status) return null;

  if (status === "ok") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success"
        title="Quantidade × Unitário confere com o Total declarado."
      >
        <CheckCircle2 className="h-3 w-3" />
        {compact ? "OK" : "Matemática OK"}
      </span>
    );
  }

  if (status === "divergente") {
    const pct =
      typeof delta === "number" ? `${(delta * 100).toFixed(1)} %` : "—";
    const calc =
      typeof quantidade === "number" && typeof valor === "number"
        ? quantidade * valor
        : null;
    const tip =
      typeof quantidade === "number" && typeof valor === "number"
        ? `Qtd ${quantidade} × ${brl(valor)} = ${brl(calc)}, mas o Total declarado é ${brl(valorTotal)} (Δ ${pct}).`
        : `Aritmética divergente em ${pct}.`;
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
        title={tip}
      >
        <AlertTriangle className="h-3 w-3" />
        Δ {pct}
      </span>
    );
  }

  // incompleto / single_value
  const label = status === "single_value" ? "Só global" : "Sem qtd";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={
        status === "single_value"
          ? "Edital traz apenas o valor global do processo — sem unitário comparável."
          : "Extração incompleta: faltou quantidade ou unitário."
      }
    >
      <HelpCircle className="h-3 w-3" />
      {label}
    </span>
  );
}