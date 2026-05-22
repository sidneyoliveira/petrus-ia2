/**
 * Funções Inngest do crawler PNCP.
 *  1) backfillStart → fan-out de N janelas (1 por dia × modalidade)
 *  2) discoverWindow → pagina /v1/contratacoes/publicacao e enfileira compras
 *  3) extractCompra → pagina itens da compra, resolve resultados, upsert
 */
import { inngest } from "./client";
import {
  discoverComprasByWindow,
  fetchCompraItens,
  fetchItemResultado,
  RELEVANT_MODALIDADES,
  type PncpCompraRef,
  type PncpItemRaw,
  type PncpResultadoRaw,
} from "../crawler/pncp-client.server";
import { normalizePncpItem, upsertCrawledItems } from "../crawler/golden-schema";

function fmtYYYYMMDD(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export const backfillStart = inngest.createFunction(
  {
    id: "crawler-backfill-start",
    triggers: [{ event: "crawler/backfill.start" }],
  },
  async ({ event, step }) => {
    const data = (event.data ?? {}) as { days?: number; startDate?: string };
    const days = Math.min(Math.max(Number(data.days) || 30, 1), 365);
    const start = data.startDate ? new Date(data.startDate) : new Date();
    const events: { name: "crawler/discover.window"; data: { dataInicial: string; dataFinal: string; modalidade: number } }[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() - i);
      const ymd = fmtYYYYMMDD(d);
      for (const mod of RELEVANT_MODALIDADES) {
        events.push({ name: "crawler/discover.window", data: { dataInicial: ymd, dataFinal: ymd, modalidade: mod } });
      }
    }
    // Trava de custo: limite hard de 2000 janelas para não estourar o free tier do Inngest (50k execuções/mês).
    const MAX_WINDOWS = 2000;
    const capped = events.slice(0, MAX_WINDOWS);
    for (let i = 0; i < capped.length; i += 100) {
      await step.sendEvent(`fanout-${i}`, capped.slice(i, i + 100));
    }
    return { dispatched: capped.length, requested: events.length, days, capped: capped.length < events.length };
  },
);

export const discoverWindow = inngest.createFunction(
  {
    id: "crawler-discover-window",
    concurrency: { limit: 2 },
    retries: 3,
    triggers: [
      { event: "crawler/discover.window" },
      { cron: "0 */6 * * *" },
    ],
  },
  async ({ event, step }) => {
    const ev = (event.data ?? {}) as Partial<{ dataInicial: string; dataFinal: string; modalidade: number }>;
    if (!ev.dataInicial) {
      const yest = new Date();
      yest.setUTCDate(yest.getUTCDate() - 1);
      const ymd = fmtYYYYMMDD(yest);
      const fanout = RELEVANT_MODALIDADES.map((m) => ({
        name: "crawler/discover.window" as const,
        data: { dataInicial: ymd, dataFinal: ymd, modalidade: m },
      }));
      await step.sendEvent("cron-fanout", fanout);
      return { mode: "cron", dispatched: fanout.length };
    }
    const { dataInicial, dataFinal, modalidade } = ev as { dataInicial: string; dataFinal: string; modalidade: number };
    const compras = await step.run("discover", () =>
      discoverComprasByWindow(dataInicial, dataFinal, modalidade),
    );
    if (compras.length === 0) return { compras: 0 };
    const events = compras.map((c: PncpCompraRef) => ({
      name: "crawler/extract.compra" as const,
      data: {
        cnpj: c.cnpj, ano: c.ano, sequencial: c.sequencial,
        orgao: c.orgao, unidade: c.unidade, municipio: c.municipio,
        uf: c.uf, modalidade: c.modalidade, dataPublicacao: c.dataPublicacao,
        objetoCompra: c.objetoCompra, url: c.url,
      },
    }));
    for (let i = 0; i < events.length; i += 100) {
      await step.sendEvent(`extract-${i}`, events.slice(i, i + 100));
    }
    return { compras: compras.length };
  },
);

export const extractCompra = inngest.createFunction(
  {
    id: "crawler-extract-compra",
    concurrency: { limit: 4 },
    retries: 2,
    triggers: [{ event: "crawler/extract.compra" }],
  },
  async ({ event, step }) => {
    const compra = event.data as PncpCompraRef;
    const itens = await step.run("fetch-itens", () =>
      fetchCompraItens(compra.cnpj, compra.ano, compra.sequencial),
    );
    if (itens.length === 0) return { itens: 0, persisted: 0 };
    const resolved = await step.run("resolve", async () => {
      const out: { item: PncpItemRaw; resultado: PncpResultadoRaw | null }[] = [];
      const CONC = 6;
      for (let i = 0; i < itens.length; i += CONC) {
        const chunk = itens.slice(i, i + CONC);
        const settled = await Promise.allSettled(
          chunk.map((it: PncpItemRaw) =>
            typeof it.numeroItem === "number"
              ? fetchItemResultado(compra.cnpj, compra.ano, compra.sequencial, it.numeroItem)
              : Promise.resolve(null),
          ),
        );
        chunk.forEach((it: PncpItemRaw, idx: number) => {
          const s = settled[idx];
          out.push({ item: it, resultado: s.status === "fulfilled" ? s.value : null });
        });
      }
      return out;
    });
    const rows = resolved
      .map((x) => normalizePncpItem(compra, x.item, x.resultado))
      .filter((r): r is NonNullable<typeof r> => r !== null);
    const { persisted, error } = await step.run("upsert", () => upsertCrawledItems(rows));
    if (error) throw new Error(`upsert: ${error}`);
    return { itens: itens.length, persisted };
  },
);

export const allFunctions = [backfillStart, discoverWindow, extractCompra];