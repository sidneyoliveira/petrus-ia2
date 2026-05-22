/**
 * Cliente Inngest do projeto. O envio de eventos passa pelo
 * connector-gateway da Lovable; o serve endpoint (src/routes/api/public/inngest.ts)
 * usa este mesmo `inngest` para registrar as funções.
 */
import { Inngest, EventSchemas } from "inngest";

type Events = {
  "crawler/backfill.start": {
    data: { days: number; startDate?: string };
  };
  "crawler/discover.window": {
    data: {
      /** Formato YYYYMMDD. */
      dataInicial: string;
      dataFinal: string;
      modalidade: number;
    };
  };
  "crawler/extract.compra": {
    data: {
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
    };
  };
};

export const inngest = new Inngest({
  id: "petrus-ia",
  schemas: new EventSchemas().fromRecord<Events>(),
});

/**
 * Envia evento via gateway Lovable. Usado pelas server routes (HTTP) —
 * Inngest functions disparam outros eventos via `step.sendEvent`.
 */
export async function sendInngestEvent<K extends keyof Events>(
  name: K,
  data: Events[K]["data"],
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