/**
 * Carregador de fontes TrueType (Inter) para jsPDF.
 *
 * Substitui o "bold shim" (monkey-patch que desenhava 2 passadas com offset
 * para simular negrito) por bold REAL via TTF embutida — eliminando o bug
 * de espaçamento errático após caracteres acentuados (Ó, É, Ç, Ã…).
 *
 * Uso:
 *   const doc = new jsPDF(...);
 *   await ensurePdfFonts(doc);
 *   doc.setFont("Inter", "bold");
 */
import type jsPDF from "jspdf";
import interRegularUrl from "@/assets/fonts/Inter-Regular.ttf?url";
import interSemiBoldUrl from "@/assets/fonts/Inter-SemiBold.ttf?url";

let cache: { regular: string; bold: string } | null = null;
let inflight: Promise<{ regular: string; bold: string }> | null = null;

async function fetchAsBase64(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Falha ao carregar fonte: ${url}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Conversão chunked — evita stack overflow em arquivos grandes (~300KB)
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(bin);
}

async function loadAll() {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    const [regular, bold] = await Promise.all([
      fetchAsBase64(interRegularUrl),
      fetchAsBase64(interSemiBoldUrl),
    ]);
    cache = { regular, bold };
    return cache;
  })();
  return inflight;
}

/**
 * Registra a família "Inter" (normal + bold) no documento jsPDF e a define
 * como fonte ativa. Cacheia os base64 entre chamadas.
 */
export async function ensurePdfFonts(doc: jsPDF): Promise<void> {
  try {
    const { regular, bold } = await loadAll();
    // addFileToVFS aceita o mesmo arquivo várias vezes sem custo significativo
    doc.addFileToVFS("Inter-Regular.ttf", regular);
    doc.addFont("Inter-Regular.ttf", "Inter", "normal");
    doc.addFileToVFS("Inter-SemiBold.ttf", bold);
    doc.addFont("Inter-SemiBold.ttf", "Inter", "bold");
    doc.setFont("Inter", "normal");
  } catch (err) {
    // Fallback silencioso para Helvetica nativo se algo falhar
    console.warn("[pdf-fonts] falha ao registrar Inter, usando Helvetica", err);
    doc.setFont("helvetica", "normal");
  }
}