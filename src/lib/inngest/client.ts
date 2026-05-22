/**
 * Cliente Inngest do projeto. O envio de eventos passa pelo
 * connector-gateway da Lovable; o serve endpoint (src/routes/api/public/inngest.ts)
 * usa este mesmo `inngest` para registrar as funções.
 */
import { Inngest } from "inngest";

export interface BackfillStartData { days: number; startDate?: string }
export interface DiscoverWindowData {
  /** Formato YYYYMMDD. */
  dataInicial: string;
  dataFinal: string;
  modalidade: number;
}
export interface ExtractCompraData {
  cnpj: string;
  ano: string;
  sequencial: string;
  orgao?: string;
  unidade?: string;
  municipio?: string;
  uf?: string;
  modalidade?: string;
  dataPublicacao?: string;
  objetoCompra?: string;
  url?: string;
}

export type EventName =
  | "crawler/backfill.start"
  | "crawler/discover.window"
  | "crawler/extract.compra"
  | "crawler/m2a.discover";

export const inngest = new Inngest({ id: "petrus-ia" });

/**
 * Envia evento via gateway Lovable. Usado pelas server routes (HTTP) —
 * Inngest functions disparam outros eventos via `step.sendEvent`.
 */
export async function sendInngestEvent(
  name: EventName,
  data: Record<string, unknown>,
): Promise<void> {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const INNGEST_API_KEY = process.env.INNGEST_API_KEY;
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");
  if (!INNGEST_API_KEY) throw new Error("INNGEST_API_KEY not configured");
  const res = await fetch("https://connector-gateway.lovable.dev/inngest/e/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": INNGEST_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, data }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Inngest send failed [${res.status}]: ${body.slice(0, 300)}`);
  }
}