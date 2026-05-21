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

        let pdfBuffer: ArrayBuffer;
        try {
          const res = await fetch(target, {
            headers: { "User-Agent": "CotacaoIA/1.0" },
          });
          if (!res.ok) {
            return Response.json(
              { error: `Falha ao baixar PDF (HTTP ${res.status})` },
              { status: 502 },
            );
          }
          const ct = res.headers.get("content-type") || "";
          if (!ct.includes("pdf") && !target.toLowerCase().endsWith(".pdf")) {
            return Response.json(
              { error: "O recurso não é um PDF" },
              { status: 415 },
            );
          }
          pdfBuffer = await res.arrayBuffer();
          if (pdfBuffer.byteLength > 15 * 1024 * 1024) {
            return Response.json(
              { error: "PDF maior que 15MB" },
              { status: 413 },
            );
          }
        } catch (e) {
          return Response.json(
            { error: `Erro de rede: ${(e as Error).message}` },
            { status: 502 },
          );
        }

        try {
          const { extractText, getDocumentProxy } = await import("unpdf");
          const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
          const { totalPages, text } = await extractText(pdf, { mergePages: true });
          const full = Array.isArray(text) ? text.join("\n\n") : String(text || "");
          return Response.json({
            ok: true,
            pages: totalPages,
            chars: full.length,
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