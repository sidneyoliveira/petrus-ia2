import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const Input = z.object({
  url: z.string().url().max(2000),
  hintQuery: z.string().max(200).optional(),
});

export interface ExtractedItem {
  numero_item: number | null;
  descricao_limpa: string;
  unidade: string | null;
  quantidade: number | null;
  valor_unitario: number | null;
  valor_total: number | null;
  marca_modelo: string | null;
  /** Resultado da validação Qtd × V.Un ≈ V.Total */
  validacao_matematica: "ok" | "divergente" | "indisponivel";
  /** Aderência à hintQuery (0..1), se fornecida */
  aderencia_query?: number;
}

export interface ExtractResponse {
  ok: boolean;
  metadata_processo: {
    orgao: string | null;
    tipo_documento: string | null;
    objeto_geral: string | null;
    fornecedor_vencedor: string | null;
  };
  itens_extraidos: ExtractedItem[];
  relatorio_confiabilidade: {
    itens_encontrados: number;
    avisos: string;
  };
  paginas?: number;
  caracteres?: number;
  truncated?: boolean;
  sourceUrl?: string;
  error?: string;
}

const SYSTEM_PROMPT = `Você é um Arquiteto de IA Sênior e Analista de Dados Licitatórios especializado em compras públicas brasileiras (PNCP, Compras.gov.br, TCEs, Portais de Transparência).

Seu objetivo é extrair ITENS REAIS E GRANULARES de documentos de compras, ignorando resumos, cabeçalhos e descrições genéricas de processo.

REGRAS DE EXTRAÇÃO:
1. REJEIÇÃO DE CABEÇALHOS: textos que começam com "Aquisição de...", "Contratação de empresa para...", "Registro de preços visando..." são OBJETO do processo, NÃO itens. Descarte-os.
2. ANATOMIA DO ITEM: itens reais vivem em tabelas (Termo de Referência, Anexo I, Planilha de Custos, Nota de Empenho).
3. ATRIBUTOS OBRIGATÓRIOS: número/lote, descrição específica, unidade (UN/CX/KG/PCT/SERV), quantidade, valor unitário e/ou total.
4. VALIDAÇÃO MATEMÁTICA: V.Total ≈ Quantidade × V.Unitário. Se não bater, corrija ou descarte.
5. Um item deve ser algo que cabe numa prateleira ou um serviço delimitado — NÃO o título do edital mascarado.

Responda APENAS um JSON estrito no formato:
{
  "metadata_processo": { "orgao": string|null, "tipo_documento": string|null, "objeto_geral": string|null, "fornecedor_vencedor": string|null },
  "itens_extraidos": [ { "numero_item": number|null, "descricao_limpa": string, "unidade": string|null, "quantidade": number|null, "valor_unitario": number|null, "valor_total": number|null, "marca_modelo": string|null } ],
  "relatorio_confiabilidade": { "itens_encontrados": number, "avisos": string }
}
Sem texto fora do JSON. Sem markdown. Sem cercas de código.`;

function parseNumberBR(v: unknown): number | null {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v !== "string") return null;
  const s = v.replace(/[^\d.,-]/g, "").replace(/\.(?=\d{3}(?:[.,]|$))/g, "").replace(",", ".");
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function validateMath(it: { quantidade: number | null; valor_unitario: number | null; valor_total: number | null }): ExtractedItem["validacao_matematica"] {
  const { quantidade: q, valor_unitario: u, valor_total: t } = it;
  if (typeof q !== "number" || typeof u !== "number") return "indisponivel";
  const calc = q * u;
  if (typeof t !== "number") return "indisponivel";
  if (t === 0 || calc === 0) return calc === t ? "ok" : "divergente";
  const diff = Math.abs(calc - t) / Math.max(Math.abs(t), Math.abs(calc));
  return diff <= 0.02 ? "ok" : "divergente";
}

function aderenciaQuery(desc: string, q: string): number {
  if (!q) return 0;
  const toks = q
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (toks.length === 0) return 0;
  const d = desc
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  const hits = toks.filter((t) => d.includes(t)).length;
  return hits / toks.length;
}

export const extractItemsFromDocument = createServerFn({ method: "POST" })
  .inputValidator((i: unknown) => Input.parse(i))
  .handler(async ({ data }): Promise<ExtractResponse> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      return {
        ok: false,
        metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
        itens_extraidos: [],
        relatorio_confiabilidade: { itens_encontrados: 0, avisos: "LOVABLE_API_KEY não configurada." },
        error: "AI key missing",
      };
    }

    // 1) OCR/extração de texto via rota interna /api/ocr (mesmo host)
    let pdfText = "";
    let pages: number | undefined;
    let chars: number | undefined;
    let truncated: boolean | undefined;
    let sourceUrl: string | undefined;
    try {
      // Em server, fazemos a chamada direta ao mesmo handler via fetch absoluto
      // não está disponível — então duplicamos o fluxo de download+parse aqui.
      const u = new URL(data.url);
      const host = u.hostname.toLowerCase();
      const allowed = ["pncp.gov.br", "compras.gov.br", "portaldatransparencia.gov.br", "gov.br"];
      if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) {
        return {
          ok: false,
          metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
          itens_extraidos: [],
          relatorio_confiabilidade: { itens_encontrados: 0, avisos: "Domínio não permitido." },
          error: "domain not allowed",
        };
      }

      async function getPdfBytes(initial: string): Promise<ArrayBuffer> {
        const r = await fetch(initial, { headers: { "User-Agent": "CotacaoIA/1.0", Accept: "application/pdf, text/html;q=0.5" } });
        if (!r.ok) throw new Error(`download HTTP ${r.status}`);
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("pdf") || initial.toLowerCase().endsWith(".pdf")) {
          return await r.arrayBuffer();
        }
        const html = await r.text();
        const m = Array.from(html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)).map((x) => x[1]);
        if (m.length === 0) throw new Error("Página HTML sem PDF anexo");
        const abs = new URL(m[0], initial).toString();
        sourceUrl = abs;
        const r2 = await fetch(abs, { headers: { "User-Agent": "CotacaoIA/1.0", Accept: "application/pdf" } });
        if (!r2.ok) throw new Error(`download anexo HTTP ${r2.status}`);
        return await r2.arrayBuffer();
      }

      const buf = await getPdfBytes(data.url);
      if (!sourceUrl) sourceUrl = data.url;
      if (buf.byteLength > 15 * 1024 * 1024) throw new Error("PDF > 15MB");
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { totalPages, text } = await extractText(pdf, { mergePages: true });
      const full = Array.isArray(text) ? text.join("\n\n") : String(text || "");
      pages = totalPages;
      chars = full.length;
      // Para itens, focamos nas seções com mais densidade tabular.
      // Heurística: pega janelas ao redor de palavras-chave de tabela.
      const MAX = 120_000;
      truncated = full.length > MAX;
      if (!truncated) {
        pdfText = full;
      } else {
        // Janelas em torno de "ITEM", "DESCRIÇÃO", "QUANTIDADE", "VALOR UNIT", "VALOR TOTAL"
        const re = /\b(item|descric[aã]o|especifica[cç][aã]o|quantidade|qtd|valor\s+unit|valor\s+total|unidade|und|pre[cç]o|anexo\s+i|termo\s+de\s+refer[eê]ncia)\b/gi;
        const windows: string[] = [];
        let m: RegExpExecArray | null;
        const W = 4000;
        let lastEnd = -W;
        while ((m = re.exec(full)) !== null) {
          const s = Math.max(0, m.index - W / 2);
          if (s < lastEnd) continue;
          const e = Math.min(full.length, m.index + W / 2);
          windows.push(full.slice(s, e));
          lastEnd = e;
          if (windows.join("\n---\n").length > MAX) break;
        }
        pdfText = windows.length > 0 ? windows.join("\n---\n").slice(0, MAX) : full.slice(0, MAX);
      }
    } catch (e) {
      return {
        ok: false,
        metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
        itens_extraidos: [],
        relatorio_confiabilidade: { itens_encontrados: 0, avisos: `OCR falhou: ${(e as Error).message}` },
        error: (e as Error).message,
      };
    }

    if (!pdfText || pdfText.length < 200) {
      return {
        ok: false,
        metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
        itens_extraidos: [],
        relatorio_confiabilidade: { itens_encontrados: 0, avisos: "Texto insuficiente após OCR (PDF pode ser imagem escaneada)." },
        paginas: pages,
        caracteres: chars,
        truncated,
        sourceUrl,
      };
    }

    // 2) Extração estruturada via Gemini 2.5 Pro (melhor para tabelas e raciocínio longo)
    const userMsg = `Texto do documento (pode estar truncado em janelas relevantes):\n\n${pdfText}\n\n${data.hintQuery ? `O usuário está cotando especificamente: "${data.hintQuery}". Priorize itens que combinem com esse termo, mas extraia TODOS os itens reais encontrados.` : ""}`;

    let aiContent = "";
    try {
      const r = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        return {
          ok: false,
          metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
          itens_extraidos: [],
          relatorio_confiabilidade: { itens_encontrados: 0, avisos: `IA falhou (HTTP ${r.status}): ${t.slice(0, 200)}` },
          error: `ai http ${r.status}`,
          paginas: pages,
          caracteres: chars,
          truncated,
          sourceUrl,
        };
      }
      const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      aiContent = j.choices?.[0]?.message?.content ?? "";
    } catch (e) {
      return {
        ok: false,
        metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
        itens_extraidos: [],
        relatorio_confiabilidade: { itens_encontrados: 0, avisos: `Erro de rede com IA: ${(e as Error).message}` },
        error: (e as Error).message,
        paginas: pages,
        caracteres: chars,
        truncated,
        sourceUrl,
      };
    }

    // 3) Parse + validação
    let parsed: {
      metadata_processo?: ExtractResponse["metadata_processo"];
      itens_extraidos?: Array<Record<string, unknown>>;
      relatorio_confiabilidade?: { itens_encontrados?: number; avisos?: string };
    } = {};
    try {
      const m = aiContent.match(/\{[\s\S]*\}$/) ?? aiContent.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : aiContent);
    } catch {
      return {
        ok: false,
        metadata_processo: { orgao: null, tipo_documento: null, objeto_geral: null, fornecedor_vencedor: null },
        itens_extraidos: [],
        relatorio_confiabilidade: { itens_encontrados: 0, avisos: "IA retornou JSON inválido." },
        error: "invalid json",
        paginas: pages,
        caracteres: chars,
        truncated,
        sourceUrl,
      };
    }

    const rawItens = Array.isArray(parsed.itens_extraidos) ? parsed.itens_extraidos : [];
    const itens: ExtractedItem[] = rawItens.map((it) => {
      const desc = String((it.descricao_limpa ?? it.descricao ?? "") as string).trim();
      const quantidade = parseNumberBR(it.quantidade);
      const valor_unitario = parseNumberBR(it.valor_unitario);
      const valor_total = parseNumberBR(it.valor_total);
      const validacao = validateMath({ quantidade, valor_unitario, valor_total });
      const out: ExtractedItem = {
        numero_item: typeof it.numero_item === "number" ? (it.numero_item as number) : parseNumberBR(it.numero_item),
        descricao_limpa: desc.slice(0, 500),
        unidade: it.unidade ? String(it.unidade).slice(0, 20) : null,
        quantidade,
        valor_unitario,
        valor_total,
        marca_modelo: it.marca_modelo ? String(it.marca_modelo).slice(0, 120) : null,
        validacao_matematica: validacao,
      };
      if (data.hintQuery) out.aderencia_query = aderenciaQuery(desc, data.hintQuery);
      return out;
    });

    // Filtra "itens" que claramente são objetos do processo
    const filtered = itens.filter((it) => {
      if (!it.descricao_limpa || it.descricao_limpa.length < 4) return false;
      const d = it.descricao_limpa.toLowerCase();
      if (/^aquisi[cç][aã]o\s+de\b/.test(d) && !it.valor_unitario) return false;
      if (/^contrata[cç][aã]o\s+de\b/.test(d) && !it.valor_unitario) return false;
      if (/^registro\s+de\s+pre[cç]os\b/.test(d) && !it.valor_unitario) return false;
      return true;
    });

    // Ordena: query-match -> validação ok -> tem unitário -> ordem original
    filtered.sort((a, b) => {
      const ad = a.aderencia_query ?? 0;
      const bd = b.aderencia_query ?? 0;
      if (ad !== bd) return bd - ad;
      const av = a.validacao_matematica === "ok" ? 1 : 0;
      const bv = b.validacao_matematica === "ok" ? 1 : 0;
      if (av !== bv) return bv - av;
      const au = typeof a.valor_unitario === "number" ? 1 : 0;
      const bu = typeof b.valor_unitario === "number" ? 1 : 0;
      return bu - au;
    });

    const avisos: string[] = [];
    const divergentes = filtered.filter((i) => i.validacao_matematica === "divergente").length;
    const semPreco = filtered.filter((i) => i.valor_unitario == null).length;
    if (divergentes > 0) avisos.push(`${divergentes} itens com matemática divergente (Qtd × V.Un ≠ V.Total).`);
    if (semPreco > 0) avisos.push(`${semPreco} itens sem valor unitário extraível.`);
    if (truncated) avisos.push("Texto do PDF truncado; focado em janelas com palavras-chave de tabela.");
    const aiAviso = parsed.relatorio_confiabilidade?.avisos;
    if (aiAviso) avisos.push(String(aiAviso));

    return {
      ok: true,
      metadata_processo: {
        orgao: parsed.metadata_processo?.orgao ?? null,
        tipo_documento: parsed.metadata_processo?.tipo_documento ?? null,
        objeto_geral: parsed.metadata_processo?.objeto_geral ?? null,
        fornecedor_vencedor: parsed.metadata_processo?.fornecedor_vencedor ?? null,
      },
      itens_extraidos: filtered,
      relatorio_confiabilidade: {
        itens_encontrados: filtered.length,
        avisos: avisos.join(" "),
      },
      paginas: pages,
      caracteres: chars,
      truncated,
      sourceUrl,
    };
  });