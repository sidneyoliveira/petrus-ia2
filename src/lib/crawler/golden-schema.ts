/**
 * Golden Schema: normaliza um item PNCP (com seu resultado homologado, se
 * houver) para o formato unificado de `quote_items`. Esse é o "tb_item_licitacao_unificado"
 * do blueprint — tudo o que o crawler escreve passa por aqui.
 */
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { Json } from "@/integrations/supabase/types";
import type { PncpCompraRef, PncpItemRaw, PncpResultadoRaw } from "./pncp-client.server";

const asJson = <T,>(v: T): Json => v as unknown as Json;

function normalizeText(s: string | undefined | null): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fingerprint estável por item PNCP. Mesma compra + mesmo numeroItem =
 * mesma linha. Re-crawls em datas diferentes atualizam (não duplicam).
 */
export function pncpItemFingerprint(
  compra: PncpCompraRef,
  numeroItem: number,
): string {
  return `pncp|${compra.cnpj}|${compra.ano}|${compra.sequencial}|${numeroItem}`;
}

export interface NormalizedQuoteRow {
  fingerprint: string;
  query_norm: string;
  titulo: string;
  descricao: string;
  objeto_estruturado: string;
  unidade: string | null;
  quantidade: number | null;
  valor: number | null;
  valor_total: number | null;
  valor_tipo: string;
  fornecedor: string | null;
  cnpj: string | null;
  orgao: string | null;
  municipio: string | null;
  uf: string | null;
  data: string | null;
  modalidade: string | null;
  homologado: boolean;
  origem: string;
  url: string | null;
  documento: string;
  payload: Json;
  source_payload_raw: Json;
  source_excerpt: string;
  discovered_via: string;
}

export function normalizePncpItem(
  compra: PncpCompraRef,
  item: PncpItemRaw,
  resultado: PncpResultadoRaw | null,
): NormalizedQuoteRow | null {
  const numeroItem = item.numeroItem;
  if (typeof numeroItem !== "number") return null;

  const descricao = (item.descricao || "").trim();
  if (!descricao) return null;

  // Preferir homologado; cair pra estimado.
  const valorUnit =
    (resultado?.valorUnitarioHomologado as number | undefined) ??
    item.valorUnitarioHomologado ??
    item.valorUnitarioEstimado ??
    null;
  const valorTotal =
    (resultado?.valorTotalHomologado as number | undefined) ??
    item.valorTotalHomologado ??
    item.valorTotal ??
    null;
  const quantidade =
    (resultado?.quantidadeHomologada as number | undefined) ?? item.quantidade ?? null;

  const homologado = !!(resultado?.valorUnitarioHomologado || item.valorUnitarioHomologado);
  const valorTipo = homologado ? "unitario_homologado" : "unitario_estimado";

  const titulo = descricao.slice(0, 200);
  const queryNorm = normalizeText(`${titulo} ${compra.objetoCompra ?? ""}`).slice(0, 500);

  const fingerprint = pncpItemFingerprint(compra, numeroItem);
  const data =
    compra.dataPublicacao && /^\d{4}-\d{2}-\d{2}/.test(compra.dataPublicacao)
      ? compra.dataPublicacao.slice(0, 10)
      : null;

  const fornecedor = resultado?.nomeRazaoSocialFornecedor?.trim() || null;

  const payload = {
    id: fingerprint,
    titulo,
    descricao,
    valor: valorUnit,
    valorTotal,
    valorTipo,
    quantidade,
    unidade: item.unidadeMedida ?? null,
    fornecedor,
    cnpj: resultado?.niFornecedor ?? null,
    orgao: compra.orgao ?? null,
    municipio: compra.municipio ?? null,
    uf: compra.uf ?? null,
    data,
    modalidade: compra.modalidade ?? null,
    homologado,
    origem: "PNCP (crawler)",
    url: compra.url ?? null,
    numeroItem,
    ncm: item.ncmNbsCodigo ?? null,
    // scores placeholder — busca FTS ranqueia por ts_rank, não por estes campos
    scoreTextual: 1,
    scoreSemantico: 1,
    scoreJuridico: 1,
    scoreGeografico: 1,
    scoreTecnico: 1,
    scoreFinal: 1,
  };

  return {
    fingerprint,
    query_norm: queryNorm || titulo.toLowerCase().slice(0, 500),
    titulo: titulo.slice(0, 500),
    descricao: descricao.slice(0, 3000),
    objeto_estruturado: titulo.slice(0, 240),
    unidade: item.unidadeMedida ?? null,
    quantidade,
    valor: valorUnit,
    valor_total: valorTotal,
    valor_tipo: valorTipo,
    fornecedor,
    cnpj: resultado?.niFornecedor ?? null,
    orgao: compra.orgao ?? null,
    municipio: compra.municipio ?? null,
    uf: compra.uf ?? null,
    data,
    modalidade: compra.modalidade ?? null,
    homologado,
    origem: "PNCP (crawler)",
    url: compra.url ?? null,
    documento: "edital",
    payload: asJson(payload),
    source_payload_raw: asJson({
      cnpj: compra.cnpj,
      ano: compra.ano,
      sequencial: compra.sequencial,
      numeroItem,
    }),
    source_excerpt: descricao.slice(0, 1000),
    discovered_via: "crawler",
  };
}

/** Upsert idempotente em quote_items via fingerprint. */
export async function upsertCrawledItems(rows: NormalizedQuoteRow[]): Promise<{ persisted: number; error?: string }> {
  if (rows.length === 0) return { persisted: 0 };
  let persisted = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabaseAdmin
      .from("quote_items")
      .upsert(chunk, { onConflict: "fingerprint" });
    if (error) {
      return { persisted, error: error.message };
    }
    persisted += chunk.length;
  }
  return { persisted };
}