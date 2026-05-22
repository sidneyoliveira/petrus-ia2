import type { PriceResult } from "./types";

function brl(v?: number | null) {
  if (typeof v !== "number") return "";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function exportCSV(results: PriceResult[], query: string) {
  const headers = [
    "Título", "Descrição", "Unidade", "Quantidade",
    "Valor Unitário", "Valor Total", "Tipo de Valor",
    "Qtd × Unit = Total", "Qualidade da Extração",
    "Fornecedor", "CNPJ", "Órgão",
    "Município", "UF", "Data", "Modalidade", "Situação", "Origem",
    "Homologado", "Score Final", "URL",
  ];
  const esc = (s: unknown) => {
    const str = String(s ?? "").replace(/"/g, '""');
    return `"${str}"`;
  };
  const rows = results.map((r) =>
    [
      r.titulo, r.descricao,
      (r.unidade ?? "").toUpperCase(),
      typeof r.quantidade === "number" ? r.quantidade : "",
      brl(r.valor),
      brl(r.valorTotal),
      r.valorTipo ?? "",
      r.mathStatus ?? "",
      r.extractionQuality ?? "",
      r.fornecedor ?? "", r.cnpj ?? "",
      r.orgao ?? "", r.municipio ?? "", r.uf ?? "", r.data ?? "",
      r.modalidade ?? "", r.situacao ?? "", r.origem, r.homologado ? "Sim" : "Não",
      Math.round(r.scoreFinal * 100) + "%", r.url ?? "",
    ].map(esc).join(";"),
  );
  const meta = [
    `# Petrus IA — Pesquisa de Preços`,
    `# Termo;${esc(query)}`,
    `# Gerado em;${esc(new Date().toLocaleString("pt-BR"))}`,
    `# Total de itens;${results.length}`,
    "",
  ].join("\n");
  const csv = "\ufeff" + meta + [headers.join(";"), ...rows].join("\n");
  download(`cotacao_${slug(query)}.csv`, csv, "text/csv");
}

export function exportTXT(results: PriceResult[], query: string) {
  const lines: string[] = [];
  lines.push("RELATÓRIO DE PESQUISA DE PREÇOS");
  lines.push("Lei nº 14.133/2021 — Art. 23");
  lines.push(`Termo pesquisado: ${query}`);
  lines.push(`Data: ${new Date().toLocaleString("pt-BR")}`);
  lines.push(`Total de itens: ${results.length}`);
  lines.push("=".repeat(72));
  results.forEach((r, i) => {
    lines.push("");
    lines.push(`${(i + 1).toString().padStart(3, "0")}. ${r.titulo}`);
    lines.push(`     Valor: ${brl(r.valor)}   |   Compatibilidade: ${Math.round(r.scoreFinal * 100)}%`);
    if (r.orgao) lines.push(`     Órgão: ${r.orgao}`);
    if (r.cnpj) lines.push(`     CNPJ: ${r.cnpj}`);
    if (r.municipio || r.uf) lines.push(`     Local: ${[r.municipio, r.uf].filter(Boolean).join(" / ")}`);
    if (r.data) lines.push(`     Data: ${r.data}`);
    if (r.modalidade) lines.push(`     Modalidade: ${r.modalidade}`);
    lines.push(`     Origem: ${r.origem}${r.homologado ? " (homologado)" : ""}`);
    if (r.url) lines.push(`     Fonte: ${r.url}`);
  });
  download(`cotacao_${slug(query)}.txt`, lines.join("\n"), "text/plain");
}

export function exportJSON(results: PriceResult[], query: string) {
  download(
    `cotacao_${slug(query)}.json`,
    JSON.stringify({ query, geradoEm: new Date().toISOString(), total: results.length, results }, null, 2),
    "application/json",
  );
}

function slug(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}