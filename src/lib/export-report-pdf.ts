/**
 * Gerador de relatórios técnicos (PDF) — Lei 14.133/2021 e IN SEGES/ME 65/2021.
 *
 * Arquitetura:
 *  1. buildXxxReport(input)  -> ReportPlan   (síncrono, fast)
 *     - calcula candidatos a anexo (edital/atas/contratos) com flag recommended
 *     - expõe renderBase(selectedUrls) que devolve o PDF base como Uint8Array
 *  2. finalizeReportPdf(plan, selectedUrls) -> Blob
 *     - chama renderBase(selectedUrls) (inclui página final de fontes)
 *     - baixa PDFs do PNCP e mescla com pdf-lib
 *
 * Fluxo no UI:
 *  - Dialog de prévia mostra renderBase(allRecommended) num iframe
 *  - Usuário marca/desmarca anexos; ao baixar, finalize é chamado
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";
import { PDFDocument } from "pdf-lib";
import type { PriceResult } from "./types";
import type {
  ProcessDossier,
  ProcessDossierItem,
  ProcessDossierAta,
  ProcessDossierContrato,
} from "./report.functions";
import { fetchPncpDocument } from "./report.functions";

// ---------------------- constants & utils ----------------------

const MARGIN = 40;
const COLOR_TITLE: [number, number, number] = [15, 23, 42];
const COLOR_MUTED: [number, number, number] = [110, 110, 110];
const COLOR_ACCENT: [number, number, number] = [30, 64, 175];
const COLOR_RULE: [number, number, number] = [220, 220, 220];

function brl(v?: number | null) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}
function num(v?: number | null) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(v);
}
function fmtDate(s?: string | null) {
  if (!s) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toLocaleDateString("pt-BR");
  return s;
}
function fmtCnpj(c?: string | null) {
  if (!c) return "—";
  const d = c.replace(/\D/g, "").padStart(14, "0").slice(-14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}
function slug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

interface RenderCtx {
  doc: jsPDF;
  pageW: number;
  pageH: number;
  y: number;
}

function ensureSpace(ctx: RenderCtx, needed: number) {
  if (ctx.y + needed > ctx.pageH - MARGIN - 24) {
    ctx.doc.addPage();
    ctx.y = MARGIN;
  }
}

function setText(
  doc: jsPDF,
  size: number,
  weight: "normal" | "bold" = "normal",
  color: [number, number, number] = [0, 0, 0],
) {
  // jsPDF's built-in helvetica/times BOLD variants have a known bug that
  // inserts visible spacing after accented Latin chars (Ó, É, Í, Ç…) when
  // text mixes ASCII + diacritics — common in pt-BR titles. Workaround:
  // always use the normal weight and synthesize bold by re-drawing with
  // a 0.3pt x-offset (patched into doc.text in installBoldShim()).
  doc.setFont("helvetica", "normal");
  (doc as unknown as { __synthBold?: boolean }).__synthBold = weight === "bold";
  doc.setFontSize(size);
  doc.setTextColor(...color);
}

/**
 * Monkey-patch a jsPDF instance once so that doc.text() automatically draws
 * a second pass shifted by ~0.3pt whenever setText() requested bold.
 * This sidesteps the jsPDF accent-spacing bug while preserving every call site.
 */
function installBoldShim(doc: jsPDF) {
  const flagged = doc as unknown as { __boldShimInstalled?: boolean; __synthBold?: boolean };
  if (flagged.__boldShimInstalled) return;
  flagged.__boldShimInstalled = true;
  const orig = doc.text.bind(doc);
  (doc as unknown as { text: typeof doc.text }).text = ((
    ...args: Parameters<typeof doc.text>
  ) => {
    const r = orig(...args);
    if (flagged.__synthBold) {
      // 2nd pass shifted right by 0.3pt for a "semibold" stroke
      const [text, x, y, ...rest] = args as [
        string | string[],
        number,
        number,
        ...unknown[],
      ];
      if (typeof x === "number" && typeof y === "number") {
        orig(text, x + 0.3, y, ...(rest as []));
      }
    }
    return r;
  }) as typeof doc.text;
}

// ---------------------- desenho de blocos ----------------------

function drawHeader(ctx: RenderCtx, subtitle: string) {
  const { doc, pageW } = ctx;
  setText(doc, 14, "bold", COLOR_TITLE);
  doc.text("RELATÓRIO TÉCNICO DE PESQUISA DE PREÇOS", MARGIN, 50);
  setText(doc, 8, "normal", COLOR_MUTED);
  doc.text(
    "Lei nº 14.133/2021 (art. 23) · IN SEGES/ME nº 65/2021 (art. 5º)",
    MARGIN,
    64,
  );
  setText(doc, 10, "bold", COLOR_ACCENT);
  doc.text(subtitle, MARGIN, 82);
  doc.setDrawColor(...COLOR_RULE);
  doc.setLineWidth(0.6);
  doc.line(MARGIN, 90, pageW - MARGIN, 90);
  ctx.y = 104;
}

function drawSectionTitle(ctx: RenderCtx, label: string) {
  ensureSpace(ctx, 26);
  setText(ctx.doc, 9, "bold", COLOR_MUTED);
  ctx.doc.text(label.toUpperCase(), MARGIN, ctx.y);
  ctx.doc.setDrawColor(...COLOR_RULE);
  ctx.doc.line(MARGIN, ctx.y + 4, ctx.pageW - MARGIN, ctx.y + 4);
  ctx.y += 14;
}

function drawKeyValueGrid(
  ctx: RenderCtx,
  pairs: Array<[string, string | undefined]>,
  cols = 2,
) {
  const { doc, pageW } = ctx;
  const colW = (pageW - MARGIN * 2) / cols;
  const rowH = 26;
  let i = 0;
  while (i < pairs.length) {
    ensureSpace(ctx, rowH);
    for (let c = 0; c < cols && i < pairs.length; c++, i++) {
      const [label, raw] = pairs[i];
      const value = raw && raw.trim().length > 0 ? raw : "—";
      const x = MARGIN + c * colW;
      setText(doc, 7, "normal", COLOR_MUTED);
      doc.text(label.toUpperCase(), x, ctx.y);
      setText(doc, 10, "normal", [0, 0, 0]);
      const wrapped = doc.splitTextToSize(value, colW - 12);
      doc.text(wrapped.slice(0, 2), x, ctx.y + 12);
    }
    ctx.y += rowH;
  }
  ctx.y += 4;
}

function drawParagraph(ctx: RenderCtx, label: string, text?: string | null) {
  const value = text && text.trim().length > 0 ? text.trim() : "—";
  setText(ctx.doc, 7, "normal", COLOR_MUTED);
  ensureSpace(ctx, 14);
  ctx.doc.text(label.toUpperCase(), MARGIN, ctx.y);
  ctx.y += 10;
  setText(ctx.doc, 10, "normal", [0, 0, 0]);
  const wrapped = ctx.doc.splitTextToSize(value, ctx.pageW - MARGIN * 2);
  for (const line of wrapped) {
    ensureSpace(ctx, 14);
    ctx.doc.text(line, MARGIN, ctx.y);
    ctx.y += 13;
  }
  ctx.y += 6;
}

async function drawProcessoCard(
  ctx: RenderCtx,
  d: ProcessDossier | null,
  fallback: { origem: string; url?: string },
) {
  const { doc, pageW } = ctx;
  const boxX = MARGIN;
  const boxW = pageW - MARGIN * 2;
  const url = d?.urlCanonica || fallback.url;

  const objeto = (d?.objetoCompra || "").trim();
  const objetoLines = objeto
    ? doc.splitTextToSize(objeto, boxW - 28).slice(0, 6)
    : [];
  const baseH = 130;
  const boxH = baseH + (objetoLines.length > 0 ? 18 + objetoLines.length * 11 : 0);
  ensureSpace(ctx, boxH + 16);
  const boxY = ctx.y;

  doc.setDrawColor(...COLOR_RULE);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(boxX, boxY, boxW, boxH, 6, 6, "FD");

  let qrSize = 90;
  if (url) {
    try {
      const dataUrl = await QRCode.toDataURL(url, {
        margin: 0,
        width: 256,
        errorCorrectionLevel: "M",
      });
      doc.addImage(
        dataUrl,
        "PNG",
        boxX + boxW - qrSize - 14,
        boxY + 14,
        qrSize,
        qrSize,
      );
      setText(doc, 6.5, "normal", COLOR_MUTED);
      doc.text("Escaneie para abrir a fonte", boxX + boxW - qrSize - 14, boxY + qrSize + 22, {
        maxWidth: qrSize,
      });
    } catch {
      qrSize = 0;
    }
  } else {
    qrSize = 0;
  }

  const leftX = boxX + 14;
  const leftMaxW = boxW - 28 - (qrSize ? qrSize + 16 : 0);
  let y = boxY + 22;

  setText(doc, 7, "bold", COLOR_ACCENT);
  doc.text("PROCESSO LICITATÓRIO", leftX, y);
  y += 12;
  setText(doc, 12, "bold", COLOR_TITLE);
  const orgaoLines = doc.splitTextToSize(
    (d?.orgao || fallback.origem || "—").trim(),
    leftMaxW,
  );
  doc.text(orgaoLines.slice(0, 2), leftX, y);
  y += Math.min(orgaoLines.length, 2) * 13 + 4;

  const pairs: Array<[string, string]> = [];
  if (d?.sequencial && d?.ano) pairs.push(["Nº / Ano", `${d.sequencial}/${d.ano}`]);
  if (d?.modalidade) pairs.push(["Modalidade", d.modalidade]);
  if (d?.situacao) pairs.push(["Situação", d.situacao]);
  const mun = [d?.municipio, d?.uf].filter(Boolean).join(" / ");
  if (mun) pairs.push(["Local", mun]);
  if (d?.dataPublicacao) pairs.push(["Publicação", fmtDate(d.dataPublicacao)]);
  if (d?.cnpj) pairs.push(["CNPJ do órgão", fmtCnpj(d.cnpj)]);

  const colW = leftMaxW / 2;
  for (let i = 0; i < pairs.length; i += 2) {
    for (let c = 0; c < 2 && i + c < pairs.length; c++) {
      const [label, value] = pairs[i + c];
      const x = leftX + c * colW;
      setText(doc, 6.5, "normal", COLOR_MUTED);
      doc.text(label.toUpperCase(), x, y);
      setText(doc, 9, "normal", [0, 0, 0]);
      const lines = doc.splitTextToSize(value, colW - 6);
      doc.text(lines.slice(0, 1), x, y + 10);
    }
    y += 22;
  }

  if (url) {
    setText(doc, 7, "normal", COLOR_ACCENT);
    const urlLines = doc.splitTextToSize(url, leftMaxW);
    doc.text(urlLines.slice(0, 2), leftX, boxY + baseH - 14);
    doc.link(leftX, boxY + baseH - 24, leftMaxW, 20, { url });
  }

  if (objetoLines.length > 0) {
    const oy = boxY + baseH + 4;
    setText(doc, 6.5, "bold", COLOR_MUTED);
    doc.text("OBJETO DA CONTRATAÇÃO", leftX, oy);
    setText(doc, 9, "normal", [0, 0, 0]);
    doc.text(objetoLines, leftX, oy + 12);
  }

  ctx.y = boxY + boxH + 16;
}

function drawFooter(doc: jsPDF, pageW: number, pageH: number) {
  const total = (doc as unknown as { internal: { getNumberOfPages: () => number } })
    .internal.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    doc.setPage(p);
    setText(doc, 7, "normal", COLOR_MUTED);
    doc.text(
      "Documento gerado automaticamente por Petrus IA · Lei 14.133/2021",
      MARGIN,
      pageH - 18,
    );
    doc.text(`Página ${p} de ${total}`, pageW - MARGIN, pageH - 18, {
      align: "right",
    });
  }
}

function drawFundamentacao(ctx: RenderCtx) {
  drawSectionTitle(ctx, "Fundamentação legal");
  setText(ctx.doc, 9, "normal", [0, 0, 0]);
  const text =
    "A presente pesquisa observa o art. 23, §1º, da Lei nº 14.133/2021, " +
    "que prevê a preferência por preços praticados em contratações similares " +
    "celebradas por outros entes da Administração Pública e disponíveis no " +
    "Portal Nacional de Contratações Públicas (PNCP), nos termos do inciso I. " +
    "Os dados aqui apresentados refletem informações públicas obtidas " +
    "diretamente da fonte oficial identificada, sendo verificáveis pelo link " +
    "canônico e pelo QR Code disponibilizados neste relatório.";
  const wrapped = ctx.doc.splitTextToSize(text, ctx.pageW - MARGIN * 2);
  for (const line of wrapped) {
    ensureSpace(ctx, 14);
    ctx.doc.text(line, MARGIN, ctx.y);
    ctx.y += 13;
  }
  ctx.y += 4;
}

function drawValores(ctx: RenderCtx, d: ProcessDossier) {
  if (
    typeof d.valorTotalEstimado !== "number" &&
    typeof d.valorTotalHomologado !== "number"
  )
    return;
  drawSectionTitle(ctx, "Valores do processo");
  drawKeyValueGrid(
    ctx,
    [
      ["Valor total estimado", brl(d.valorTotalEstimado)],
      ["Valor total homologado", brl(d.valorTotalHomologado)],
    ],
    2,
  );
}

function drawItensTable(
  ctx: RenderCtx,
  itens: ProcessDossierItem[],
  highlightNumeros?: Set<number>,
) {
  ensureSpace(ctx, 40);
  autoTable(ctx.doc, {
    startY: ctx.y,
    margin: { left: MARGIN, right: MARGIN },
    head: [[
      "#",
      "Descrição",
      "Un.",
      "Qtd",
      "V. unit. estimado",
      "V. unit. homologado",
      "Fornecedor",
    ]],
    body: itens.map((it) => [
      String(it.numeroItem),
      it.descricao || "—",
      (it.unidade || "—").toUpperCase(),
      num(it.quantidade),
      brl(it.valorUnitarioEstimado),
      brl(it.valorUnitarioHomologado),
      it.fornecedor || "—",
    ]),
    styles: {
      fontSize: 8,
      cellPadding: 4,
      valign: "top",
      overflow: "linebreak",
      textColor: 20,
    },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 8, fontStyle: "normal" },
    bodyStyles: { fillColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 22, halign: "right" },
      1: { cellWidth: "auto" },
      2: { cellWidth: 28, halign: "center" },
      3: { cellWidth: 50, halign: "right" },
      4: { cellWidth: 75, halign: "right" },
      5: { cellWidth: 80, halign: "right" },
      6: { cellWidth: 100 },
    },
    didParseCell: (data) => {
      if (
        highlightNumeros &&
        data.section === "body" &&
        highlightNumeros.has(Number((data.row.raw as string[])[0]))
      ) {
        // Não usar fontStyle "bold" aqui — jsPDF tem bug de espaçamento
        // após chars acentuados em helvetica/times bold. Destacamos só
        // pela cor de fundo + texto mais escuro.
        data.cell.styles.fillColor = [254, 243, 199];
        data.cell.styles.textColor = [30, 41, 59];
      }
    },
  });
  // @ts-expect-error lastAutoTable é injetado pelo plugin
  ctx.y = (ctx.doc.lastAutoTable?.finalY ?? ctx.y) + 12;
}

function drawContratosResumo(ctx: RenderCtx, contratos: ProcessDossierContrato[]) {
  if (!contratos || contratos.length === 0) return;
  drawSectionTitle(ctx, `Contratos firmados (${contratos.length})`);
  for (const c of contratos) {
    ensureSpace(ctx, 36);
    setText(ctx.doc, 9, "bold", [0, 0, 0]);
    ctx.doc.text(
      `Contrato ${c.numeroContrato ?? "—"}${c.fornecedor ? ` · ${c.fornecedor}` : ""}`,
      MARGIN,
      ctx.y,
    );
    ctx.y += 12;
    setText(ctx.doc, 8, "normal", COLOR_MUTED);
    const parts = [
      c.cnpjFornecedor ? `CNPJ ${fmtCnpj(c.cnpjFornecedor)}` : null,
      typeof c.valorInicial === "number" ? `Valor ${brl(c.valorInicial)}` : null,
      c.vigenciaInicio || c.vigenciaFim
        ? `Vigência ${fmtDate(c.vigenciaInicio)} a ${fmtDate(c.vigenciaFim)}`
        : null,
    ]
      .filter(Boolean)
      .join("  ·  ");
    if (parts) {
      ctx.doc.text(parts, MARGIN, ctx.y);
      ctx.y += 12;
    }
    ctx.y += 4;
  }
}

// ---------------------- ReportAttachment ----------------------

export type AttachmentCategory = "edital" | "ata" | "contrato" | "outro";

export interface ReportAttachment {
  /** estável — chave para seleção */
  id: string;
  titulo: string;
  tipo: string;
  url: string;
  category: AttachmentCategory;
  /** marcado por padrão na UI */
  recommended: boolean;
  /** rótulo agrupador, ex.: "Processo", "Ata 1/2026", "Contrato 17/2026" */
  grupo: string;
}

function categorize(tipo: string, titulo: string): AttachmentCategory {
  const t = `${tipo} ${titulo}`.toLowerCase();
  if (/contrato/.test(t)) return "contrato";
  if (/\bata\b|registro de pre/.test(t)) return "ata";
  if (/edital|termo de refer|anexo/.test(t)) return "edital";
  return "outro";
}

function pickRelevantAtas(
  atas: ProcessDossierAta[],
  itemDescricao?: string,
): Set<string> {
  // devolve numeros de ata "relevantes" (que contêm o item buscado)
  const out = new Set<string>();
  if (!atas || atas.length === 0 || !itemDescricao || itemDescricao.length < 6) return out;
  const needle = itemDescricao.toLowerCase().slice(0, 60);
  for (const a of atas) {
    if (a.itens.some((it) => it.descricao.toLowerCase().includes(needle))) {
      out.add(String(a.numeroAta ?? ""));
    }
  }
  return out;
}

/**
 * Constrói a lista de anexos candidatos para um dossier.
 * recommended: por padrão Ata + Contrato; Edital só fica recomendado em relatórios
 * de processo inteiro (não na visão de item, pra evitar PDFs gigantes).
 */
function gatherAttachments(
  dossier: ProcessDossier | null,
  opts: { mode: "item" | "process" | "basket"; itemDescricao?: string },
): ReportAttachment[] {
  if (!dossier) return [];
  const atasRelevantes = pickRelevantAtas(dossier.atas, opts.itemDescricao);
  const wantEdital = opts.mode === "process"; // só processo completo recomenda edital
  const out: ReportAttachment[] = [];

  // arquivos do processo (geralmente edital + termo de referência)
  for (const a of dossier.arquivos) {
    const cat = categorize(a.tipo, a.titulo);
    out.push({
      id: `proc:${a.url}`,
      titulo: a.titulo,
      tipo: a.tipo,
      url: a.url,
      category: cat,
      grupo: "Processo",
      recommended: cat === "edital" ? wantEdital : true,
    });
  }

  // atas
  for (const ata of dossier.atas) {
    const grupo = `Ata ${ata.numeroAta ?? ""}`.trim();
    const isRelevant =
      opts.mode !== "item" || atasRelevantes.size === 0
        ? true
        : atasRelevantes.has(String(ata.numeroAta ?? ""));
    for (const a of ata.arquivos) {
      out.push({
        id: `ata:${ata.numeroAta}:${a.url}`,
        titulo: a.titulo,
        tipo: a.tipo,
        url: a.url,
        category: "ata",
        grupo,
        recommended: isRelevant,
      });
    }
  }

  // contratos
  for (const c of dossier.contratos || []) {
    const grupo = `Contrato ${c.numeroContrato ?? ""}`.trim();
    for (const a of c.arquivos) {
      out.push({
        id: `contrato:${c.numeroContrato}:${a.url}`,
        titulo: a.titulo,
        tipo: a.tipo,
        url: a.url,
        category: "contrato",
        grupo,
        recommended: true,
      });
    }
  }

  // dedupe por url
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)));
}

// ---------------------- ReportPlan ----------------------

export interface ReportPlan {
  filename: string;
  /** Lista plana de anexos candidatos (preview reflete `recommended` por padrão). */
  attachments: ReportAttachment[];
  /** Renderiza o PDF base (sem anexos externos) já com página final de "Fontes consultadas". */
  renderBase: (selectedUrls: Set<string>) => Promise<Uint8Array>;
}

/** Página final de fontes consultadas — lista compacta clicável dos anexos selecionados. */
function drawFontesPage(
  ctx: RenderCtx,
  selected: ReportAttachment[],
  dossierUrl?: string,
) {
  ctx.doc.addPage();
  ctx.y = MARGIN;
  drawHeader(ctx, "Fontes consultadas");
  setText(ctx.doc, 9, "normal", [0, 0, 0]);
  drawParagraph(
    ctx,
    "Verificabilidade",
    "Todos os documentos abaixo foram obtidos da fonte oficial (PNCP). " +
      "Os anexos marcados pelo usuário também foram mesclados ao final deste PDF " +
      "e podem ser conferidos diretamente nos links a seguir.",
  );

  if (dossierUrl) {
    drawSectionTitle(ctx, "Fonte canônica do processo");
    setText(ctx.doc, 8, "normal", COLOR_ACCENT);
    const lines = ctx.doc.splitTextToSize(dossierUrl, ctx.pageW - MARGIN * 2);
    ensureSpace(ctx, lines.length * 11 + 6);
    ctx.doc.text(lines, MARGIN, ctx.y);
    ctx.doc.link(MARGIN, ctx.y - 8, ctx.pageW - MARGIN * 2, lines.length * 11 + 4, {
      url: dossierUrl,
    });
    ctx.y += lines.length * 11 + 8;
  }

  if (selected.length === 0) {
    drawSectionTitle(ctx, "Documentos anexados");
    setText(ctx.doc, 9, "normal", COLOR_MUTED);
    ensureSpace(ctx, 14);
    ctx.doc.text("Nenhum anexo selecionado.", MARGIN, ctx.y);
    return;
  }

  // agrupa por grupo
  const grupos = new Map<string, ReportAttachment[]>();
  for (const a of selected) {
    const arr = grupos.get(a.grupo) ?? [];
    arr.push(a);
    grupos.set(a.grupo, arr);
  }

  drawSectionTitle(ctx, `Documentos anexados (${selected.length})`);
  for (const [grupo, arr] of grupos) {
    ensureSpace(ctx, 18);
    setText(ctx.doc, 9, "bold", COLOR_TITLE);
    ctx.doc.text(grupo, MARGIN, ctx.y);
    ctx.y += 12;
    for (const a of arr) {
      ensureSpace(ctx, 26);
      setText(ctx.doc, 8, "bold", [0, 0, 0]);
      const titleLines = ctx.doc.splitTextToSize(
        `• ${a.titulo}`,
        ctx.pageW - MARGIN * 2 - 8,
      );
      ctx.doc.text(titleLines.slice(0, 2), MARGIN + 8, ctx.y);
      ctx.y += titleLines.length * 10;
      setText(ctx.doc, 7, "normal", COLOR_MUTED);
      ctx.doc.text(`Tipo: ${a.tipo}`, MARGIN + 16, ctx.y);
      ctx.y += 9;
      setText(ctx.doc, 7, "normal", COLOR_ACCENT);
      const urlLines = ctx.doc.splitTextToSize(a.url, ctx.pageW - MARGIN * 2 - 16);
      ctx.doc.text(urlLines.slice(0, 2), MARGIN + 16, ctx.y);
      ctx.doc.link(MARGIN + 16, ctx.y - 8, ctx.pageW - MARGIN * 2 - 16, urlLines.length * 10, {
        url: a.url,
      });
      ctx.y += urlLines.length * 9 + 6;
    }
    ctx.y += 4;
  }
}

// ---------------------- builders ----------------------

export function buildItemReport(
  item: PriceResult,
  dossier: ProcessDossier | null,
): ReportPlan {
  const itemDescricao = item.objetoEstruturado || item.titulo;
  const attachments = gatherAttachments(dossier, { mode: "item", itemDescricao });
  const filename = `relatorio-item-${slug(itemDescricao)}.pdf`;

  return {
    filename,
    attachments,
    renderBase: async (selectedUrls) => {
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      installBoldShim(doc);
      const ctx: RenderCtx = {
        doc,
        pageW: doc.internal.pageSize.getWidth(),
        pageH: doc.internal.pageSize.getHeight(),
        y: 0,
      };

      drawHeader(ctx, "Relatório de item — pesquisa de preço unitário");
      await drawProcessoCard(ctx, dossier, {
        origem: dossier?.origem || item.origem,
        url: dossier?.urlCanonica || item.url,
      });

      drawSectionTitle(ctx, "Item pesquisado");
      drawParagraph(ctx, "Descrição do item", itemDescricao);
      drawKeyValueGrid(
        ctx,
        [
          ["Unidade", item.unidade?.toUpperCase()],
          [
            "Quantidade contratada",
            typeof item.quantidade === "number" ? num(item.quantidade) : undefined,
          ],
          ["Valor unitário", brl(item.valor)],
          ["Valor total do item", brl(item.valorTotal)],
          ["Fornecedor", item.fornecedor],
          ["CNPJ do fornecedor", item.cnpj ? fmtCnpj(item.cnpj) : undefined],
          [
            "Procedência do valor",
            item.valorTipo === "unitario_homologado"
              ? "Unitário homologado"
              : item.valorTipo === "unitario_estimado"
                ? "Unitário estimado"
                : item.valorTipo === "global"
                  ? "Valor TOTAL do processo (não unitário)"
                  : "Sem contexto",
          ],
          ["Homologação", item.homologado ? "Sim — item homologado" : "Não confirmada"],
        ],
        2,
      );

      if (dossier) {
        drawValores(ctx, dossier);
        drawContratosResumo(ctx, dossier.contratos);
        if (dossier.itens.length > 0) {
          drawSectionTitle(
            ctx,
            `Demais itens do mesmo processo (${dossier.itens.length})`,
          );
          const highlight = new Set<number>();
          const desc = itemDescricao.toLowerCase().slice(0, 40);
          for (const it of dossier.itens) {
            if (it.descricao.toLowerCase().includes(desc) && desc.length >= 10) {
              highlight.add(it.numeroItem);
            }
          }
          drawItensTable(ctx, dossier.itens, highlight);
        }
      }

      drawFundamentacao(ctx);

      // Página final: fontes (somente selecionados)
      const selected = attachments.filter((a) => selectedUrls.has(a.url));
      drawFontesPage(ctx, selected, dossier?.urlCanonica);

      drawFooter(doc, ctx.pageW, ctx.pageH);
      return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    },
  };
}

export function buildProcessReport(
  dossier: ProcessDossier,
  opts: { highlightItem?: number } = {},
): ReportPlan {
  const attachments = gatherAttachments(dossier, { mode: "process" });
  const orgaoSlug = slug(dossier.orgao || "processo");
  const filename = `relatorio-processo-${orgaoSlug}-${dossier.ano ?? ""}-${dossier.sequencial ?? ""}.pdf`;

  return {
    filename,
    attachments,
    renderBase: async (selectedUrls) => {
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      installBoldShim(doc);
      const ctx: RenderCtx = {
        doc,
        pageW: doc.internal.pageSize.getWidth(),
        pageH: doc.internal.pageSize.getHeight(),
        y: 0,
      };

      drawHeader(ctx, "Relatório consolidado do processo");
      await drawProcessoCard(ctx, dossier, {
        origem: dossier.origem,
        url: dossier.urlCanonica,
      });
      drawValores(ctx, dossier);
      drawContratosResumo(ctx, dossier.contratos);

      if (dossier.itens.length > 0) {
        drawSectionTitle(ctx, `Itens do processo (${dossier.itens.length})`);
        const highlight =
          opts.highlightItem !== undefined ? new Set([opts.highlightItem]) : undefined;
        drawItensTable(ctx, dossier.itens, highlight);
      }

      drawFundamentacao(ctx);

      const selected = attachments.filter((a) => selectedUrls.has(a.url));
      drawFontesPage(ctx, selected, dossier.urlCanonica);

      drawFooter(doc, ctx.pageW, ctx.pageH);
      return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    },
  };
}

export interface BasketReportRow {
  item: PriceResult;
  quantidadeCotada: number;
  dossier: ProcessDossier | null;
}

export function buildBasketReport(
  rows: BasketReportRow[],
  totals: { totalGeral: number; media: number; mediana: number },
): ReportPlan {
  // Anexos: união por processo (modo basket — recommend tudo exceto edital)
  const all: ReportAttachment[] = [];
  const seenProc = new Set<string>();
  for (const r of rows) {
    if (!r.dossier) continue;
    const k =
      r.dossier.urlCanonica ||
      `${r.dossier.cnpj}-${r.dossier.ano}-${r.dossier.sequencial}`;
    if (seenProc.has(k)) continue;
    seenProc.add(k);
    all.push(
      ...gatherAttachments(r.dossier, {
        mode: "basket",
        itemDescricao: r.item.objetoEstruturado || r.item.titulo,
      }),
    );
  }
  // dedupe por url
  const seen = new Set<string>();
  const attachments = all.filter((a) =>
    seen.has(a.url) ? false : (seen.add(a.url), true),
  );
  // Em cesta, edital também fica desmarcado por padrão (volume!)
  for (const a of attachments) {
    if (a.category === "edital") a.recommended = false;
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `cesta-cotacao-${date}.pdf`;

  return {
    filename,
    attachments,
    renderBase: async (selectedUrls) => {
      const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      installBoldShim(doc);
      const ctx: RenderCtx = {
        doc,
        pageW: doc.internal.pageSize.getWidth(),
        pageH: doc.internal.pageSize.getHeight(),
        y: 0,
      };

      drawHeader(ctx, "Cesta de cotação — Nota Técnica de pesquisa de preços");

      drawSectionTitle(ctx, "Resumo da cesta");
      drawKeyValueGrid(
        ctx,
        [
          ["Itens cotados", String(rows.length)],
          ["Total geral", brl(totals.totalGeral)],
          ["Média unitária", brl(totals.media)],
          ["Mediana unitária", brl(totals.mediana)],
        ],
        4,
      );

      drawSectionTitle(ctx, "Itens consolidados");
      ensureSpace(ctx, 40);
      autoTable(doc, {
        startY: ctx.y,
        margin: { left: MARGIN, right: MARGIN },
        head: [["#", "Item", "Un.", "Qtd", "Unitário", "Subtotal", "Fonte"]],
        body: rows.map((r, i) => {
          const unit = typeof r.item.valor === "number" ? r.item.valor : null;
          const sub = unit !== null ? unit * r.quantidadeCotada : null;
          return [
            String(i + 1),
            r.item.objetoEstruturado || r.item.titulo,
            (r.item.unidade || "—").toUpperCase(),
            String(r.quantidadeCotada),
            brl(unit),
            brl(sub),
            [r.item.origem, r.item.orgao].filter(Boolean).join(" · "),
          ];
        }),
        foot: [[
          "",
          "",
          "",
          "",
          { content: "Total geral", styles: { halign: "right", fontStyle: "bold" } },
          { content: brl(totals.totalGeral), styles: { halign: "right", fontStyle: "bold" } },
          "",
        ]],
        styles: {
          fontSize: 8,
          cellPadding: 4,
          valign: "top",
          overflow: "linebreak",
          textColor: 20,
        },
        headStyles: { fillColor: [30, 41, 59], textColor: 255, fontStyle: "normal" },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          0: { cellWidth: 22, halign: "right" },
          1: { cellWidth: "auto" },
          2: { cellWidth: 28, halign: "center" },
          3: { cellWidth: 40, halign: "right" },
          4: { cellWidth: 70, halign: "right" },
          5: { cellWidth: 75, halign: "right" },
          6: { cellWidth: 110 },
        },
      });
      // @ts-expect-error lastAutoTable
      ctx.y = (doc.lastAutoTable?.finalY ?? ctx.y) + 16;

      // Espelho de cada processo distinto
      const seenP = new Set<string>();
      for (const r of rows) {
        const d = r.dossier;
        if (!d) continue;
        const key = d.urlCanonica || `${d.cnpj}-${d.ano}-${d.sequencial}`;
        if (seenP.has(key)) continue;
        seenP.add(key);

        doc.addPage();
        ctx.y = MARGIN;
        drawHeader(ctx, "Espelho do processo");
        await drawProcessoCard(ctx, d, { origem: d.origem, url: d.urlCanonica });
        drawValores(ctx, d);
        drawContratosResumo(ctx, d.contratos);
        if (d.itens.length > 0) {
          drawSectionTitle(ctx, `Itens do processo (${d.itens.length})`);
          const highlight = new Set<number>();
          const desc = (r.item.objetoEstruturado || r.item.titulo || "")
            .toLowerCase()
            .slice(0, 40);
          for (const it of d.itens) {
            if (it.descricao.toLowerCase().includes(desc) && desc.length >= 10) {
              highlight.add(it.numeroItem);
            }
          }
          drawItensTable(ctx, d.itens, highlight);
        }
      }

      doc.addPage();
      ctx.y = MARGIN;
      drawHeader(ctx, "Encerramento");
      drawFundamentacao(ctx);

      const selected = attachments.filter((a) => selectedUrls.has(a.url));
      drawFontesPage(ctx, selected, undefined);

      drawFooter(doc, ctx.pageW, ctx.pageH);
      return new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
    },
  };
}

// ---------------------- finalize: baixar PDFs + mesclar ----------------------

export interface FinalizeProgress {
  loaded: number;
  total: number;
  current?: string;
}

export async function finalizeReportPdf(
  plan: ReportPlan,
  selectedUrls: Set<string>,
  onProgress?: (p: FinalizeProgress) => void,
): Promise<Blob> {
  const baseBytes = await plan.renderBase(selectedUrls);
  const selected = plan.attachments.filter((a) => selectedUrls.has(a.url));

  if (selected.length === 0) {
    return new Blob([baseBytes as BlobPart], { type: "application/pdf" });
  }

  onProgress?.({ loaded: 0, total: selected.length });

  // Baixa em paralelo (limitando concorrência leve)
  const downloads: Array<{ meta: ReportAttachment; bytes: Uint8Array | null }> = [];
  let done = 0;
  await Promise.all(
    selected.map(async (meta) => {
      try {
        const r = await fetchPncpDocument({ data: { url: meta.url } });
        if (!r.ok) {
          downloads.push({ meta, bytes: null });
        } else {
          const bin = atob(r.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const isPdf =
            /pdf/i.test(r.contentType) ||
            (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);
          downloads.push({ meta, bytes: isPdf ? bytes : null });
        }
      } catch {
        downloads.push({ meta, bytes: null });
      } finally {
        done += 1;
        onProgress?.({ loaded: done, total: selected.length, current: meta.titulo });
      }
    }),
  );

  // Mescla
  try {
    const merged = await PDFDocument.load(baseBytes);
    for (const d of downloads) {
      if (!d.bytes) continue;
      try {
        const ext = await PDFDocument.load(d.bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(ext, ext.getPageIndices());
        for (const p of pages) merged.addPage(p);
      } catch {
        // documento corrompido — ignora
      }
    }
    const out = await merged.save();
    return new Blob([out as BlobPart], { type: "application/pdf" });
  } catch {
    return new Blob([baseBytes as BlobPart], { type: "application/pdf" });
  }
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}