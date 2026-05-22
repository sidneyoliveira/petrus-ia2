import { createFileRoute } from "@tanstack/react-router";
import { harvestTick } from "@/lib/harvest.server";

export const Route = createFileRoute("/api/public/hooks/harvest-tick")({
  server: {
    handlers: {
      POST: async () => {
        try {
          const result = await harvestTick(2, 12);
          return Response.json({ ok: true, ...result });
        } catch (e) {
          return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
        }
      },
      GET: async () => {
        // health check
        return Response.json({ ok: true, alive: true });
      },
    },
  },
});