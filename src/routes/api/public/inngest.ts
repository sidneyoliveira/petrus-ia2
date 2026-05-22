/**
 * Serve endpoint do Inngest. O dashboard do Inngest faz POST aqui pra
 * registrar/executar as funções definidas em src/lib/inngest/functions.ts.
 * Verificação de assinatura usa INNGEST_SIGNING_KEY (env).
 */
import { createFileRoute } from "@tanstack/react-router";
import { serve } from "inngest/edge";
import { inngest } from "@/lib/inngest/client";
import { allFunctions } from "@/lib/inngest/functions";

const handler = serve({ client: inngest, functions: allFunctions });

export const Route = createFileRoute("/api/public/inngest")({
  server: {
    handlers: {
      GET: async ({ request }) => handler(request),
      POST: async ({ request }) => handler(request),
      PUT: async ({ request }) => handler(request),
    },
  },
});