import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

const Schema = z.object({
  url: z.string().url().max(2000),
});

export const Route = createFileRoute("/api/ocr")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "JSON inválido" }, { status: 400 });
        }
        const parsed = Schema.safeParse(body);
        if (!parsed.success) {
          return Response.json({ error: "Parâmetros inválidos" }, { status: 400 });
        }
        const target = parsed.data.url;
        // Trava de domínio: apenas fontes oficiais conhecidas
        try {
          const u = new URL(target);
          const host = u.hostname.toLowerCase();
          const allowed = [
            "pncp.gov.br",
            "compras.gov.br",
            "portaldatransparencia.gov.br",
            "gov.br",
          ];
          if (!allowed.some((d) => host === d || host.endsWith(`.${d}`))) {
            return Response.json(
              { error: "Domínio não permitido para OCR" },
              { status: 403 },
            );
          }
        } catch {
          return Response.json({ error: "URL inválida" }, { status: 400 });
        }

        // Resolve a URL final do PDF. Se o link for HTML (página do PNCP),
        // tenta extrair um link de PDF do conteúdo. Se for PDF direto, baixa.
        async function resolvePdfBytes(initial: string): Promise<{ buf: ArrayBuffer; url: string } | { error: string; status: number }> {
          try {
            const res = await fetch(initial, { headers: { "User-Agent": "CotacaoIA/1.0", Accept: "application/pdf, text/html;q=0.5, */*;q=0.1" } });
            if (!res.ok) return { error: `Falha ao baixar (HTTP ${res.status})`, status: 502 };
            const ct = (res.headers.get("content-type") || "").toLowerCase();
            const isPdf = ct.includes("pdf") || initial.toLowerCase().endsWith(".pdf");
            if (isPdf) {
              const buf = await res.arrayBuffer();
              if (buf.byteLength > 15 * 1024 * 1024) return { error: "PDF maior que 15MB", status: 413 };
              return { buf, url: initial };
            }
            // É HTML — tenta extrair link para PDF
            const html = await res.text();
            const matches = Array.from(html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)).map((m) => m[1]);
            if (matches.length === 0) {
              return { error: "Este link é uma página HTML e não contém PDF anexo. Abra a fonte original para baixar o arquivo manualmente.", status: 415 };
            }
            const abs = new URL(matches[0], initial).toString();
            const r2 = await fetch(abs, { headers: { "User-Agent": "CotacaoIA/1.0", Accept: "application/pdf" } });
            if (!r2.ok) return { error: `Falha ao baixar PDF anexo (HTTP ${r2.status})`, status: 502 };
            const buf = await r2.arrayBuffer();
            if (buf.byteLength > 15 * 1024 * 1024) return { error: "PDF maior que 15MB", status: 413 };
            return { buf, url: abs };
          } catch (e) {
            return { error: `Erro de rede: ${(e as Error).message}`, status: 502 };
          }
        }

        const got = await resolvePdfBytes(target);
        if ("error" in got) return Response.json({ error: got.error }, { status: got.status });
        const pdfBuffer = got.buf;

        try {
          const { extractText, getDocumentProxy } = await import("unpdf");
          const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
          const { totalPages, text } = await extractText(pdf, { mergePages: true });
          const full = Array.isArray(text) ? text.join("\n\n") : String(text || "");
          return Response.json({
            ok: true,
            pages: totalPages,
            chars: full.length,
            sourceUrl: got.url,
            text: full.slice(0, 60000),
            truncated: full.length > 60000,
          });
        } catch (e) {
          console.error("OCR/parse error", e);
          return Response.json(
            { error: `Não foi possível processar o PDF: ${(e as Error).message}` },
            { status: 500 },
          );
        }
      },
    },
  },
});