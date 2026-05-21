import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

export interface CotacaoRow {
  titulo: string;
  unidade: string | null;
  quantidade: number;
  unitario: number | null;
  subtotal: number | null;
  fornecedor: string | null;
  cnpj: string | null;
  orgao: string | null;
  uf: string | null;
  data: string | null;
  origem: string;
  url: string | null;
}

export interface CotacaoPdfInput {
  rows: CotacaoRow[];
  totalGeral: number;
  media: number;
  mediana: number;
}

function brl(v: number | null | undefined): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  // dd/mm/aaaa
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  return s;
}

/**
 * Gera a Nota Técnica de Preços em PDF a partir dos itens da cesta.
 * Formato A4 paisagem para acomodar fornecedor/órgão/CNPJ na mesma linha.
 */
export function exportCotacaoPdf(input: CotacaoPdfInput): void {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 36;

  // Cabeçalho
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text("Nota Técnica de Pesquisa de Preços", margin, 48);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(110);
  doc.text(
    "Cotação gerada via CotaçãoIA — Lei 14.133/2021, IN SEGES/ME 65/2021",
    margin,
    62,
  );
  const emitido = new Date().toLocaleString("pt-BR");
  doc.text(`Emitido em ${emitido}`, pageWidth - margin, 62, { align: "right" });

  // Sumário
  doc.setTextColor(0);
  doc.setFontSize(10);
  const sumY = 86;
  const stats: Array<[string, string]> = [
    ["Itens", String(input.rows.length)],
    ["Total geral", brl(input.totalGeral)],
    ["Média unitária", brl(input.media)],
    ["Mediana unitária", brl(input.mediana)],
  ];
  const statW = (pageWidth - margin * 2) / stats.length;
  stats.forEach(([label, val], i) => {
    const x = margin + i * statW;
    doc.setDrawColor(220);
    doc.roundedRect(x, sumY, statW - 8, 36, 4, 4);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(110);
    doc.text(label.toUpperCase(), x + 8, sumY + 12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(0);
    doc.text(val, x + 8, sumY + 28);
  });

  // Tabela
  autoTable(doc, {
    startY: sumY + 52,
    margin: { left: margin, right: margin },
    head: [[
      "#",
      "Item",
      "Un.",
      "Qtd",
      "Unitário",
      "Subtotal",
      "Fornecedor / CNPJ",
      "Órgão / UF",
      "Data",
      "Origem",
    ]],
    body: input.rows.map((r, i) => [
      String(i + 1),
      r.titulo,
      (r.unidade || "—").toUpperCase(),
      String(r.quantidade),
      brl(r.unitario),
      brl(r.subtotal),
      [r.fornecedor || "—", r.cnpj || ""].filter(Boolean).join("\n"),
      [r.orgao || "—", r.uf || ""].filter(Boolean).join(" · "),
      fmtDate(r.data),
      r.origem,
    ]),
    foot: [[
      "", "", "", "", { content: "Total geral", styles: { halign: "right", fontStyle: "bold" } },
      { content: brl(input.totalGeral), styles: { halign: "right", fontStyle: "bold" } },
      "", "", "", "",
    ]],
    styles: { fontSize: 8, cellPadding: 4, valign: "top", overflow: "linebreak" },
    headStyles: { fillColor: [30, 41, 59], textColor: 255, fontSize: 8 },
    footStyles: { fillColor: [241, 245, 249], textColor: 0 },
    columnStyles: {
      0: { cellWidth: 22, halign: "right" },
      1: { cellWidth: 200 },
      2: { cellWidth: 28, halign: "center" },
      3: { cellWidth: 36, halign: "right" },
      4: { cellWidth: 64, halign: "right" },
      5: { cellWidth: 70, halign: "right" },
      6: { cellWidth: 140 },
      7: { cellWidth: 130 },
      8: { cellWidth: 56, halign: "center" },
      9: { cellWidth: 70 },
    },
    didDrawPage: () => {
      // Rodapé com número de página + fontes
      const total = (doc as unknown as { internal: { getNumberOfPages: () => number } })
        .internal.getNumberOfPages();
      const current = (doc as unknown as { internal: { getCurrentPageInfo: () => { pageNumber: number } } })
        .internal.getCurrentPageInfo().pageNumber;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(
        `Página ${current} de ${total}`,
        pageWidth - margin,
        pageHeight - 18,
        { align: "right" },
      );
    },
  });

  // Anexo: lista de fontes (URLs)
  const sources = input.rows
    .map((r, i) => ({ i: i + 1, url: r.url }))
    .filter((s): s is { i: number; url: string } => Boolean(s.url));

  if (sources.length > 0) {
    doc.addPage();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text("Fontes consultadas", margin, 48);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    let y = 70;
    for (const s of sources) {
      if (y > pageHeight - margin) {
        doc.addPage();
        y = 48;
      }
      const line = `[${s.i}] ${s.url}`;
      const wrapped = doc.splitTextToSize(line, pageWidth - margin * 2);
      doc.text(wrapped, margin, y);
      y += wrapped.length * 11 + 4;
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  doc.save(`nota-tecnica-precos-${date}.pdf`);
}
