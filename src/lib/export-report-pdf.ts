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
import type { PriceResult } from "./types";
import type { ProcessDossier, ProcessDossierItem } from "./report.functions";

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
  setText(doc, 8, "normal", COLOR_MUTED);
  doc.text(
    `Emitido em ${new Date().toLocaleString("pt-BR")}`,
    pageW - MARGIN,
    64,
    { align: "right" },
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

async function drawCanonicalSource(
  ctx: RenderCtx,
  origem: string,
  url?: string,
) {
  ensureSpace(ctx, 120);
  const { doc, pageW } = ctx;
  const boxX = MARGIN;
  const boxY = ctx.y;
  const boxW = pageW - MARGIN * 2;
  const boxH = 110;
  doc.setDrawColor(...COLOR_RULE);
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(boxX, boxY, boxW, boxH, 6, 6, "FD");

  // QR code à direita
  let qrSize = 84;
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
        boxX + boxW - qrSize - 13,
        boxY + 13,
        qrSize,
        qrSize,
      );
    } catch {
      qrSize = 0;
    }
  } else {
    qrSize = 0;
  }

  // Texto à esquerda
  setText(doc, 8, "bold", COLOR_ACCENT);
  doc.text("FONTE OFICIAL CONSULTADA", boxX + 14, boxY + 22);
  setText(doc, 12, "bold", COLOR_TITLE);
  doc.text(origem.toUpperCase(), boxX + 14, boxY + 40);
  setText(doc, 8, "normal", COLOR_MUTED);
  doc.text("URL canônica para verificação por auditoria:", boxX + 14, boxY + 58);
  setText(doc, 9, "normal", COLOR_ACCENT);
  const maxUrlW = boxW - 28 - (qrSize ? qrSize + 16 : 0);
  const urlLines = doc.splitTextToSize(url || "—", maxUrlW);
  doc.text(urlLines.slice(0, 3), boxX + 14, boxY + 72);
  if (url) {
    // Faz a área do link clicável
    doc.link(boxX + 14, boxY + 62, maxUrlW, 30, { url });
  }
  setText(doc, 7, "normal", COLOR_MUTED);
  doc.text(
    "Escaneie o QR Code para acessar a página original.",
    boxX + 14,
    boxY + boxH - 12,
  );

  ctx.y += boxH + 16;
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
    drawSectionTitle(ctx, "Documentos oficiais da fonte");
    setText(ctx.doc, 9, "normal", COLOR_MUTED);
    ensureSpace(ctx, 14);
    ctx.doc.text(
      "Nenhum documento publicado pela fonte até o momento da emissão.",
      MARGIN,
      ctx.y,
    );
    ctx.y += 18;
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

function drawProcessoEspelho(ctx: RenderCtx, d: ProcessDossier) {
  drawSectionTitle(ctx, "Espelho do edital");
  drawKeyValueGrid(
    ctx,
    [
      ["Órgão", d.orgao],
      ["CNPJ do órgão", d.cnpj ? fmtCnpj(d.cnpj) : undefined],
      ["Modalidade", d.modalidade],
      ["Situação", d.situacao],
      [
        "Nº/Ano da contratação",
        d.sequencial && d.ano ? `${d.sequencial}/${d.ano}` : undefined,
      ],
      ["Nº de controle PNCP", d.numeroControlePNCP],
      ["Município / UF", [d.municipio, d.uf].filter(Boolean).join(" / ")],
      ["Data de publicação", fmtDate(d.dataPublicacao)],
      ["Valor total estimado", brl(d.valorTotalEstimado)],
      ["Valor total homologado", brl(d.valorTotalHomologado)],
    ],
    2,
  );
  drawParagraph(ctx, "Objeto da contratação", d.objetoCompra);
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
  await drawCanonicalSource(ctx, dossier.origem, dossier.urlCanonica);
  drawProcessoEspelho(ctx, dossier);

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
  } else {
    drawSectionTitle(ctx, "Itens do processo");
    setText(ctx.doc, 9, "normal", COLOR_MUTED);
    ensureSpace(ctx, 14);
    ctx.doc.text(
      "Itens estruturados não disponíveis na API da fonte. Consulte os documentos oficiais abaixo.",
      MARGIN,
      ctx.y,
    );
    ctx.y += 18;
  }

  drawArquivos(ctx, dossier.arquivos);
  drawWarnings(ctx, dossier.warnings);
  drawFundamentacao(ctx);
  drawFooter(doc, ctx.pageW, ctx.pageH);

  const orgaoSlug = slug(dossier.orgao || "processo");
  const fname = `relatorio-processo-${orgaoSlug}-${dossier.ano ?? ""}-${dossier.sequencial ?? ""}.pdf`;
  doc.save(fname);
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
  await drawCanonicalSource(
    ctx,
    dossier?.origem || item.origem,
    dossier?.urlCanonica || item.url,
  );

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

  // Espelho do processo
  if (dossier) {
    drawProcessoEspelho(ctx, dossier);

    // Tabela com TODOS os itens do processo (destacando este)
    if (dossier.itens.length > 0) {
      drawSectionTitle(
        ctx,
        `Demais itens do mesmo processo (${dossier.itens.length})`,
      );
      // Tenta casar pelo número do item; se não dá, casa por descrição parcial
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
    drawWarnings(ctx, dossier.warnings);
  } else {
    drawWarnings(ctx, [
      "Não foi possível buscar dados estruturados da fonte ao vivo. O relatório usa apenas as informações já extraídas no momento da pesquisa.",
    ]);
  }

  drawFundamentacao(ctx);
  drawFooter(doc, ctx.pageW, ctx.pageH);

  const fname = `relatorio-item-${slug(item.objetoEstruturado || item.titulo)}.pdf`;
  doc.save(fname);
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