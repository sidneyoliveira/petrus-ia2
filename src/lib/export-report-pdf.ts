/**
 * Gerador de relatórios técnicos (PDF) para uso em processos de cotação
 * conforme Lei 14.133/2021 e IN SEGES/ME 65/2021.
 *
 * Dois formatos:
 *  - exportItemReportPdf:    1 item específico + espelho do processo de origem
 *  - exportProcessReportPdf: todos os itens do processo (preferência legal
 *                            do art. 23 §1º I — PNCP)
 *
 * Layout A4 retrato, margens 40pt, quebra de página automática via autoTable.
 * QR Code embutido apontando para a URL canônica da fonte (defensável
 * juridicamente: o auditor pode validar o vínculo entre o PDF e a fonte
 * oficial).
 */
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import QRCode from "qrcode";
import { PDFDocument } from "pdf-lib";
import type { PriceResult } from "./types";
import type { ProcessDossier, ProcessDossierItem, ProcessDossierAta } from "./report.functions";
import { fetchPncpDocument } from "./report.functions";

// ---------------------- helpers ----------------------

const MARGIN = 40;
const COLOR_TITLE: [number, number, number] = [15, 23, 42];
const COLOR_MUTED: [number, number, number] = [110, 110, 110];
const COLOR_ACCENT: [number, number, number] = [30, 64, 175];
const COLOR_RULE: [number, number, number] = [220, 220, 220];

function brl(v?: number | null) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(v);
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
  if (ctx.y + needed > ctx.pageH - MARGIN - 24 /* footer */) {
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
  doc.setFont("helvetica", weight);
  doc.setFontSize(size);
  doc.setTextColor(...color);
}

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
  // Subtítulo (tipo do relatório)
  setText(doc, 10, "bold", COLOR_ACCENT);
  doc.text(subtitle, MARGIN, 82);
  // régua
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

/**
 * Card principal: dados do processo + QR Code da fonte oficial.
 * Substitui o antigo "Espelho do edital" + "Fonte oficial" em um único bloco.
 */
async function drawProcessoCard(
  ctx: RenderCtx,
  d: ProcessDossier | null,
  fallback: { origem: string; url?: string },
) {
  const { doc, pageW } = ctx;
  const boxX = MARGIN;
  const boxW = pageW - MARGIN * 2;
  const url = d?.urlCanonica || fallback.url;

  // Pré-calcula objeto (full width abaixo) pra dimensionar o card
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

  // QR (direita)
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

  // Coluna esquerda: dados do processo
  const leftX = boxX + 14;
  const leftMaxW = boxW - 28 - (qrSize ? qrSize + 16 : 0);
  let y = boxY + 22;

  // Cabeçalho do card: órgão + nº/ano
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

  // Grid de 2 colunas com dados-chave
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

  // URL canônica (linha clicável discreta)
  if (url) {
    setText(doc, 7, "normal", COLOR_ACCENT);
    const urlLines = doc.splitTextToSize(url, leftMaxW);
    doc.text(urlLines.slice(0, 2), leftX, boxY + baseH - 14);
    doc.link(leftX, boxY + baseH - 24, leftMaxW, 20, { url });
  }

  // Objeto (full width abaixo)
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

function drawArquivos(ctx: RenderCtx, arquivos: ProcessDossier["arquivos"]) {
  if (!arquivos || arquivos.length === 0) {
    return;
  }
  drawSectionTitle(ctx, "Documentos oficiais da fonte");
  for (const a of arquivos) {
    ensureSpace(ctx, 22);
    setText(ctx.doc, 9, "bold", [0, 0, 0]);
    ctx.doc.text(`• ${a.titulo}`, MARGIN, ctx.y);
    setText(ctx.doc, 8, "normal", COLOR_MUTED);
    ctx.doc.text(
      [a.tipo, a.data ? fmtDate(a.data) : null].filter(Boolean).join(" · "),
      MARGIN + 12,
      ctx.y + 11,
    );
    // link clicável
    const urlLines = ctx.doc.splitTextToSize(a.url, ctx.pageW - MARGIN * 2 - 12);
    setText(ctx.doc, 8, "normal", COLOR_ACCENT);
    ctx.doc.text(urlLines.slice(0, 1), MARGIN + 12, ctx.y + 22);
    ctx.doc.link(MARGIN + 12, ctx.y + 14, ctx.pageW - MARGIN * 2 - 12, 12, {
      url: a.url,
    });
    ctx.y += 30;
  }
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
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 8 },
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
        data.cell.styles.fillColor = [254, 243, 199]; // amber-100
        data.cell.styles.fontStyle = "bold";
      }
    },
  });
  // @ts-expect-error lastAutoTable é injetado pelo plugin
  ctx.y = (ctx.doc.lastAutoTable?.finalY ?? ctx.y) + 12;
}

function drawWarnings(ctx: RenderCtx, warnings: string[]) {
  if (!warnings.length) return;
  drawSectionTitle(ctx, "Observações");
  setText(ctx.doc, 8, "normal", COLOR_MUTED);
  for (const w of warnings) {
    ensureSpace(ctx, 14);
    const lines = ctx.doc.splitTextToSize(`• ${w}`, ctx.pageW - MARGIN * 2);
    for (const l of lines) {
      ensureSpace(ctx, 12);
      ctx.doc.text(l, MARGIN, ctx.y);
      ctx.y += 11;
    }
  }
  ctx.y += 4;
}

// ---------------------- API pública ----------------------

/**
 * Decide quais atas anexar com base na descrição do item.
 * Se nada bate, devolve TODAS as atas (best-effort).
 */
function pickRelevantAtas(
  atas: ProcessDossierAta[],
  itemDescricao?: string,
): ProcessDossierAta[] {
  if (!atas || atas.length === 0) return [];
  if (!itemDescricao || itemDescricao.length < 6) return atas;
  const needle = itemDescricao.toLowerCase().slice(0, 60);
  const filtered = atas.filter((a) =>
    a.itens.some((it) => it.descricao.toLowerCase().includes(needle)),
  );
  return filtered.length > 0 ? filtered : atas;
}

/**
 * Anexa PDFs externos (edital + atas selecionadas) ao final do doc jsPDF,
 * gerando um único PDF mesclado via pdf-lib. Adiciona uma página separadora
 * antes de cada documento embutido.
 */
async function mergeWithExternalPdfs(
  jsPdfDoc: jsPDF,
  attachments: Array<{ titulo: string; tipo: string; url: string }>,
  filename: string,
) {
  // Sem anexos? Apenas salva.
  if (attachments.length === 0) {
    jsPdfDoc.save(filename);
    return;
  }

  // Baixa todos em paralelo (com limite leve via Promise.all — atas/editais são poucos)
  const fetched = await Promise.all(
    attachments.map(async (a) => {
      try {
        const r = await fetchPncpDocument({ data: { url: a.url } });
        return { meta: a, doc: r };
      } catch (e) {
        return {
          meta: a,
          doc: { ok: false, base64: "", contentType: "", size: 0, error: String(e) },
        };
      }
    }),
  );

  // Para cada anexo bem-sucedido que seja PDF, adiciona uma página separadora antes
  const pageW = jsPdfDoc.internal.pageSize.getWidth();
  const pageH = jsPdfDoc.internal.pageSize.getHeight();

  // Constrói lista final (com separadores) — descarta não-PDF
  const validPdfs: Array<{ meta: (typeof fetched)[number]["meta"]; bytes: Uint8Array }> = [];
  for (const f of fetched) {
    if (!f.doc.ok) continue;
    const isPdf =
      /pdf/i.test(f.doc.contentType) ||
      atob(f.doc.base64.slice(0, 8)).startsWith("%PDF");
    if (!isPdf) continue;
    const bin = atob(f.doc.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    validPdfs.push({ meta: f.meta, bytes });
  }

  // Se nenhum PDF foi baixado, ainda registra um aviso no doc principal
  if (validPdfs.length === 0) {
    jsPdfDoc.addPage();
    const ctx: RenderCtx = { doc: jsPdfDoc, pageW, pageH, y: 0 };
    drawHeader(ctx, "Documentos oficiais não anexados");
    setText(jsPdfDoc, 9, "normal", COLOR_MUTED);
    ctx.y = 120;
    jsPdfDoc.text(
      "Os documentos da fonte não puderam ser baixados no momento da emissão.",
      MARGIN,
      ctx.y,
    );
    jsPdfDoc.save(filename);
    return;
  }

  // Páginas separadoras + lista de anexos
  for (const v of validPdfs) {
    jsPdfDoc.addPage();
    const ctx: RenderCtx = { doc: jsPdfDoc, pageW, pageH, y: 0 };
    drawHeader(ctx, "Anexo — documento oficial integrado");
    setText(jsPdfDoc, 7, "bold", COLOR_ACCENT);
    jsPdfDoc.text(v.meta.tipo.toUpperCase(), MARGIN, 130);
    setText(jsPdfDoc, 14, "bold", COLOR_TITLE);
    const t = jsPdfDoc.splitTextToSize(v.meta.titulo, pageW - MARGIN * 2);
    jsPdfDoc.text(t.slice(0, 4), MARGIN, 150);
    setText(jsPdfDoc, 8, "normal", COLOR_MUTED);
    jsPdfDoc.text(
      "Documento original abaixo, mesclado a este relatório a partir da fonte PNCP.",
      MARGIN,
      220,
    );
    setText(jsPdfDoc, 7, "normal", COLOR_ACCENT);
    const urlLines = jsPdfDoc.splitTextToSize(v.meta.url, pageW - MARGIN * 2);
    jsPdfDoc.text(urlLines.slice(0, 3), MARGIN, 240);
    jsPdfDoc.link(MARGIN, 232, pageW - MARGIN * 2, 24, { url: v.meta.url });
  }

  // Aplica numeração / rodapé considerando que ainda virão páginas mescladas depois
  drawFooter(jsPdfDoc, pageW, pageH);

  // Converte o jsPDF para bytes
  const mainBytes = new Uint8Array(jsPdfDoc.output("arraybuffer") as ArrayBuffer);

  // Mescla com pdf-lib
  try {
    const merged = await PDFDocument.load(mainBytes);
    for (const v of validPdfs) {
      try {
        const ext = await PDFDocument.load(v.bytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(ext, ext.getPageIndices());
        for (const p of pages) merged.addPage(p);
      } catch {
        // documento corrompido — ignora
      }
    }
    const out = await merged.save();
    const blob = new Blob([out as BlobPart], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  } catch {
    // fallback: salva só o principal
    jsPdfDoc.save(filename);
  }
}

/** Reúne arquivos do processo + arquivos das atas selecionadas. */
function collectAttachments(
  dossier: ProcessDossier | null,
  itemDescricao?: string,
): Array<{ titulo: string; tipo: string; url: string }> {
  if (!dossier) return [];
  const out: Array<{ titulo: string; tipo: string; url: string }> = [];
  for (const a of dossier.arquivos) out.push(a);
  const relevantAtas = pickRelevantAtas(dossier.atas, itemDescricao);
  for (const ata of relevantAtas) {
    for (const a of ata.arquivos) {
      out.push({
        titulo: `Ata ${ata.numeroAta ?? ""} — ${a.titulo}`.trim(),
        tipo: a.tipo,
        url: a.url,
      });
    }
  }
  // dedupe por URL
  const seen = new Set<string>();
  return out.filter((a) => {
    if (seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });
}

export async function exportProcessReportPdf(
  dossier: ProcessDossier,
  opts: { highlightItem?: number } = {},
): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const ctx: RenderCtx = {
    doc,
    pageW: doc.internal.pageSize.getWidth(),
    pageH: doc.internal.pageSize.getHeight(),
    y: 0,
  };

  drawHeader(ctx, "Relatório consolidado do processo");
  await drawProcessoCard(ctx, dossier, { origem: dossier.origem, url: dossier.urlCanonica });
  drawValores(ctx, dossier);

  if (dossier.itens.length > 0) {
    drawSectionTitle(
      ctx,
      `Itens do processo (${dossier.itens.length})`,
    );
    const highlight =
      opts.highlightItem !== undefined
        ? new Set([opts.highlightItem])
        : undefined;
    drawItensTable(ctx, dossier.itens, highlight);
  }

  drawArquivos(ctx, dossier.arquivos);
  drawFundamentacao(ctx);

  const orgaoSlug = slug(dossier.orgao || "processo");
  const fname = `relatorio-processo-${orgaoSlug}-${dossier.ano ?? ""}-${dossier.sequencial ?? ""}.pdf`;
  const attachments = collectAttachments(dossier);
  await mergeWithExternalPdfs(doc, attachments, fname);
}

export async function exportItemReportPdf(
  item: PriceResult,
  dossier: ProcessDossier | null,
): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
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

  // Bloco do item específico
  drawSectionTitle(ctx, "Item pesquisado");
  drawParagraph(ctx, "Descrição do item", item.objetoEstruturado || item.titulo);
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
      [
        "Homologação",
        item.homologado ? "Sim — item homologado" : "Não confirmada",
      ],
    ],
    2,
  );

  if (dossier) {
    drawValores(ctx, dossier);

    // Tabela com TODOS os itens do processo (destacando este)
    if (dossier.itens.length > 0) {
      drawSectionTitle(
        ctx,
        `Demais itens do mesmo processo (${dossier.itens.length})`,
      );
      const highlight = new Set<number>();
      const desc = (item.objetoEstruturado || item.titulo || "")
        .toLowerCase()
        .slice(0, 40);
      for (const it of dossier.itens) {
        if (it.descricao.toLowerCase().includes(desc) && desc.length >= 10) {
          highlight.add(it.numeroItem);
        }
      }
      drawItensTable(ctx, dossier.itens, highlight);
    }
    drawArquivos(ctx, dossier.arquivos);
  }

  drawFundamentacao(ctx);

  const fname = `relatorio-item-${slug(item.objetoEstruturado || item.titulo)}.pdf`;
  const attachments = collectAttachments(dossier, item.objetoEstruturado || item.titulo);
  await mergeWithExternalPdfs(doc, attachments, fname);
}

/**
 * Relatório completo da cesta de cotação: agrupa por processo,
 * inclui espelho + documentos oficiais + tabela consolidada.
 * Substitui o antigo exportCotacaoPdf na cesta.
 */
export interface BasketReportRow {
  item: PriceResult;
  quantidadeCotada: number;
  /** Dossier do processo dono deste item, quando disponível. */
  dossier: ProcessDossier | null;
}

export async function exportBasketReportPdf(
  rows: BasketReportRow[],
  totals: { totalGeral: number; media: number; mediana: number },
): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
  const ctx: RenderCtx = {
    doc,
    pageW: doc.internal.pageSize.getWidth(),
    pageH: doc.internal.pageSize.getHeight(),
    y: 0,
  };

  drawHeader(ctx, "Cesta de cotação — Nota Técnica de pesquisa de preços");

  // Resumo
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

  // Tabela consolidada
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
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
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

  // Para cada processo distinto, anexa espelho + documentos
  const seen = new Set<string>();
  for (const r of rows) {
    const d = r.dossier;
    if (!d) continue;
    const key = d.urlCanonica || `${d.cnpj}-${d.ano}-${d.sequencial}`;
    if (seen.has(key)) continue;
    seen.add(key);

    doc.addPage();
    ctx.y = MARGIN;
    drawHeader(ctx, `Espelho do processo — ${d.orgao ?? "—"}`);
    await drawCanonicalSource(ctx, d.origem, d.urlCanonica);
    drawProcessoEspelho(ctx, d);
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
    drawArquivos(ctx, d.arquivos);
    drawWarnings(ctx, d.warnings);
  }

  // Última página: fundamentação
  doc.addPage();
  ctx.y = MARGIN;
  drawHeader(ctx, "Encerramento");
  drawFundamentacao(ctx);
  drawFooter(doc, ctx.pageW, ctx.pageH);

  const date = new Date().toISOString().slice(0, 10);
  doc.save(`cesta-cotacao-${date}.pdf`);
}