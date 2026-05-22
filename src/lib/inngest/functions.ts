/**
 * Funções Inngest do crawler PNCP. Pipeline em 2 hops (já que cada compra
 * pagina seus itens internamente):
 *
 *   1) discoverWindow → para cada janela (data + modalidade), pagina
 *      /v1/contratacoes/publicacao e enfileira N eventos extract.compra.
 *   2) extractCompra → para a compra, pagina /itens, resolve cada item
 *      (homologado) em paralelo e faz upsert no Golden Schema.
 *
 * Backfill: backfillStart fanout para 180 janelas (1 por dia) × N modalidades,
 * com concorrência baixa para não estourar o PNCP.
 */
import { inngest } from "./client";
import {
  discoverComprasByWindow,
  fetchCompraItens,
  fetchItemResultado,
  RELEVANT_MODALIDADES,
  type PncpCompraRef,
} from "../crawler/pncp-client.server";
import { normalizePncpItem, upsertCrawledItems } from "../crawler/golden-schema";

function fmtYYYYMMDD(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ---------- 1) Backfill: fan-out de janelas ----------

export const backfillStart = inngest.createFunction(
  { id: "crawler-backfill-start" },
  { event: "crawler/backfill.start" },
  async ({ event, step }) => {
    const days = Math.min(Math.max(Number(event.data.days) || 30, 1), 365);
    const start = event.data.startDate ? new Date(event.data.startDate) : new Date();

    // Cria um array de eventos: para cada dia, para cada modalidade.
    const events: { name: "crawler/discover.window"; data: { dataInicial: string; dataFinal: string; modalidade: number } }[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() - i);
      const ymd = fmtYYYYMMDD(d);
      for (const mod of RELEVANT_MODALIDADES) {
        events.push({
          name: "crawler/discover.window",
          data: { dataInicial: ymd, dataFinal: ymd, modalidade: mod },
        });
      }
    }

    // sendEvent em lotes de 100 (limite confortável do gateway).
    for (let i = 0; i < events.length; i += 100) {
      const chunk = events.slice(i, i + 100);
      await step.sendEvent(`fanout-${i}`, chunk);
    }
    return { dispatched: events.length, days, modalidades: RELEVANT_MODALIDADES.length };
  },
);

// ---------- 2) Discovery: 1 janela × 1 modalidade → enfileira compras ----------

export const discoverWindow = inngest.createFunction(
  {
    id: "crawler-discover-window",
    // Concorrência baixa para respeitar o PNCP.
    concurrency: { limit: 2 },
    retries: 3,
  },
  [
    { event: "crawler/discover.window" },
    // Cron horário: cobre as últimas 24h em todas modalidades.
    { cron: "0 */2 * * *" },
  ],
  async ({ event, step }) => {
    // Modo cron: sem event.data → varre últimas 24h em todas modalidades.
    if (!event.data?.dataInicial) {
      const now = new Date();
      const yest = new Date(now);
      yest.setUTCDate(yest.getUTCDate() - 1);
      const ymd = fmtYYYYMMDD(yest);
      const fanout = RELEVANT_MODALIDADES.map((m) => ({
        name: "crawler/discover.window" as const,
        data: { dataInicial: ymd, dataFinal: ymd, modalidade: m },
      }));
      await step.sendEvent("cron-fanout", fanout);
      return { mode: "cron-fanout", dispatched: fanout.length };
    }

    const { dataInicial, dataFinal, modalidade } = event.data;
    const compras = await step.run("discover", () =>
      discoverComprasByWindow(dataInicial, dataFinal, modalidade),
    );
    if (compras.length === 0) return { compras: 0 };

    // Fan-out: 1 evento extract.compra por compra.
    const events = compras.map((c) => ({
      name: "crawler/extract.compra" as const,
      data: {
        cnpj: c.cnpj,
        ano: c.ano,
        sequencial: c.sequencial,
        orgao: c.orgao,
        unidade: c.unidade,
        municipio: c.municipio,
        uf: c.uf,
        modalidade: c.modalidade,
        dataPublicacao: c.dataPublicacao,
        objetoCompra: c.objetoCompra,
        url: c.url,
      },
    }));
    for (let i = 0; i < events.length; i += 100) {
      await step.sendEvent(`extract-batch-${i}`, events.slice(i, i + 100));
    }
    return { compras: compras.length, dispatched: events.length };
  },
);

// ---------- 3) Extract: 1 compra → itens + resultados → upsert ----------

export const extractCompra = inngest.createFunction(
  {
    id: "crawler-extract-compra",
    concurrency: { limit: 4 },
    retries: 2,
  },
  { event: "crawler/extract.compra" },
  async ({ event, step }) => {
    const compra: PncpCompraRef = event.data;

    const itens = await step.run("fetch-itens", () =>
      fetchCompraItens(compra.cnpj, compra.ano, compra.sequencial),
    );
    if (itens.length === 0) return { itens: 0, persisted: 0 };

    // Resolve resultados em paralelo (concorrência 6 dentro da step).
    const resultados = await step.run("resolve-itens", async () => {
      const out: { item: typeof itens[number]; resultado: Awaited<ReturnType<typeof fetchItemResultado>> | null }[] = [];
      const CONC = 6;
      for (let i = 0; i < itens.length; i += CONC) {
        const chunk = itens.slice(i, i + CONC);
        const settled = await Promise.allSettled(
          chunk.map((it) =>
            typeof it.numeroItem === "number"
              ? fetchItemResultado(compra.cnpj, compra.ano, compra.sequencial, it.numeroItem)
              : Promise.resolve(null),
          ),
        );
        chunk.forEach((it, idx) => {
          const s = settled[idx];
          out.push({ item: it, resultado: s.status === "fulfilled" ? s.value : null });
        });
      }
      return out;
    });

    const rows = resultados
      .map(({ item, resultado }) => normalizePncpItem(compra, item, resultado))
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const { persisted, error } = await step.run("upsert", () => upsertCrawledItems(rows));
    if (error) throw new Error(`upsert failed: ${error}`);
    return { itens: itens.length, persisted };
  },
);

export const allFunctions = [backfillStart, discoverWindow, extractCompra];