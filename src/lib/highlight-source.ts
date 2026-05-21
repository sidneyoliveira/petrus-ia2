/**
 * Constrói uma URL que abre o documento original e destaca o trecho-fonte.
 * - PDFs: usa o parâmetro `#search="..."` reconhecido por Chrome PDF viewer,
 *   Adobe Reader e pdf.js, mantendo `#page=` se vier do payload.
 * - HTML/qualquer outra coisa: usa Text Fragment (`#:~:text=...`) — suportado
 *   por Chrome, Edge, Safari 16.1+ e variantes.
 *
 * Mantém o snippet curto (4–12 palavras) para maximizar matches exatos.
 */
export function buildHighlightUrl(url: string, excerpt?: string | null): string {
  if (!url) return url;
  const snippet = pickSnippet(excerpt ?? "");
  if (!snippet) return url;

  const isPdf = /\.pdf(\?|$)/i.test(url) || /\/pdf\//i.test(url);
  if (isPdf) {
    // Preserva fragment existente (ex.: #page=3) e adiciona search.
    const hasHash = url.includes("#");
    const sep = hasHash ? "&" : "#";
    return `${url}${sep}search=${encodeURIComponent(`"${snippet}"`)}`;
  }

  // Text Fragment — só funciona como ÚNICO fragment, então sobrepõe qualquer hash.
  const base = url.split("#")[0];
  return `${base}#:~:text=${encodeURIComponent(snippet)}`;
}

function pickSnippet(text: string): string {
  const clean = text
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  if (!clean) return "";
  // Pega a primeira frase "densa": ignora cabeçalhos curtos tipo "OBJETO:".
  const sentences = clean.split(/(?<=[.!?])\s+/);
  const target = sentences.find((s) => s.length >= 25) ?? clean;
  const words = target.split(" ").filter(Boolean);
  const slice = words.slice(0, Math.min(12, Math.max(4, words.length))).join(" ");
  // Browsers limitam ~256 chars no fragmento útil.
  return slice.slice(0, 180);
}