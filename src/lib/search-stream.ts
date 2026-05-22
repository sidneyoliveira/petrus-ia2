/**
 * Hook client-side que consome o stream SSE de /api/public/search/stream.
 * Emite parciais conforme cada fonte responde — sem esperar a busca acabar.
 */
import { useEffect, useRef, useState } from "react";
import type { PriceResult, SearchResponse, SearchSourceStatus } from "./types";

export interface StreamSource {
  name: string;
  status: "running" | "ok" | "empty" | "error";
  count: number;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
}

export interface SearchStreamState {
  items: PriceResult[];
  sources: StreamSource[];
  inflight: StreamSource[];
  log: { ts: number; kind: string; text: string }[];
  totalSources: number;
  doneSources: number;
  phase?: string;
  done: boolean;
  fromCache: boolean;
  error: Error | null;
  tookMs: number;
  final?: SearchResponse;
  finalSources?: SearchSourceStatus[];
}

const INITIAL: SearchStreamState = {
  items: [],
  sources: [],
  inflight: [],
  log: [],
  totalSources: 0,
  doneSources: 0,
  done: false,
  fromCache: false,
  error: null,
  tookMs: 0,
};

export interface SearchStreamInput {
  query: string;
  tema?: string;
  mode?: "semantic" | "exact" | "all_keywords";
  keywords?: string[];
  forceRefresh?: boolean;
  pagina?: number;
}

/**
 * Parse incremental de Server-Sent Events. Acumula bytes em buffer e
 * separa eventos por `\n\n`.
 */
function* parseSSE(buffer: string): Generator<{ event: string; data: string }> {
  const blocks = buffer.split("\n\n");
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data) yield { event, data };
  }
}

export function useSearchStream(
  input: SearchStreamInput | null,
  key: string,
): SearchStreamState & { refetch: () => void } {
  const [state, setState] = useState<SearchStreamState>(INITIAL);
  const [tick, setTick] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!input || !input.query || input.query.trim().length < 2) {
      setState(INITIAL);
      return;
    }
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const started = Date.now();
    setState({ ...INITIAL });

    (async () => {
      try {
        const res = await fetch("/api/public/search/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`stream falhou: ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // processa apenas blocos completos (separados por \n\n)
          const lastBoundary = buf.lastIndexOf("\n\n");
          if (lastBoundary === -1) continue;
          const complete = buf.slice(0, lastBoundary + 2);
          buf = buf.slice(lastBoundary + 2);

          for (const evt of parseSSE(complete)) {
            let payload: unknown;
            try {
              payload = JSON.parse(evt.data);
            } catch {
              continue;
            }
            const p = payload as Record<string, unknown>;
            if (evt.event === "start") {
              const total = Number(p.totalSources) || 0;
              console.groupCollapsed(`%c[busca] iniciando — ${total} fontes`, "color:#888");
              console.log("variantes:", p.variants);
              console.groupEnd();
              setState((s) => ({
                ...s,
                totalSources: total,
                log: [...s.log, { ts: Date.now(), kind: "start", text: `varredura iniciada (${total} fontes)` }],
              }));
            } else if (evt.event === "source:start") {
              const name = String(p.name ?? "?");
              console.log(`%c[busca] → consultando ${name}`, "color:#3b82f6");
              setState((s) => ({
                ...s,
                inflight: [
                  ...s.inflight,
                  { name, status: "running", count: 0, startedAt: Date.now() },
                ],
                log: [...s.log, { ts: Date.now(), kind: "start", text: `→ ${name}` }],
              }));
            } else if (evt.event === "source") {
              const src: StreamSource = {
                name: String(p.name ?? "?"),
                status: (p.status as StreamSource["status"]) ?? "ok",
                count: Number(p.count) || 0,
                error: typeof p.error === "string" ? p.error : undefined,
                finishedAt: Date.now(),
              };
              const emoji = src.status === "ok" ? "✓" : src.status === "empty" ? "∅" : "✗";
              const color = src.status === "ok" ? "#10b981" : src.status === "empty" ? "#6b7280" : "#ef4444";
              console.log(
                `%c[busca] ${emoji} ${src.name} — ${src.status === "error" ? src.error ?? "erro" : `${src.count} itens`}`,
                `color:${color}`,
              );
              setState((s) => ({
                ...s,
                sources: [...s.sources, src],
                inflight: s.inflight.filter((x) => x.name !== src.name),
                log: [
                  ...s.log,
                  {
                    ts: Date.now(),
                    kind: src.status,
                    text: `${emoji} ${src.name} — ${src.status === "error" ? src.error ?? "erro" : `${src.count} itens`}`,
                  },
                ],
                doneSources: Number(p.done) || s.doneSources + 1,
                totalSources: Number(p.total) || s.totalSources,
              }));
            } else if (evt.event === "snapshot") {
              const items = (p.items ?? []) as PriceResult[];
              setState((s) => ({
                ...s,
                items,
                tookMs: Date.now() - started,
              }));
            } else if (evt.event === "phase") {
              const name = String(p.name ?? "");
              console.log(`%c[busca] ⏳ ${name}`, "color:#f59e0b");
              setState((s) => ({
                ...s,
                phase: name,
                log: [...s.log, { ts: Date.now(), kind: "phase", text: `⏳ ${name}` }],
              }));
            } else if (evt.event === "done") {
              const final = payload as SearchResponse;
              console.log(
                `%c[busca] ✓ concluída em ${final.tookMs ?? Date.now() - started}ms — ${final.results.length} itens${final.fromCache ? " (cache)" : ""}`,
                "color:#10b981;font-weight:bold",
              );
              setState((s) => ({
                ...s,
                items: final.results,
                done: true,
                fromCache: !!final.fromCache,
                tookMs: final.tookMs ?? Date.now() - started,
                phase: undefined,
                inflight: [],
                final,
                finalSources: final.sources,
              }));
            } else if (evt.event === "error") {
              console.error("[busca] erro fatal:", p.message);
              setState((s) => ({
                ...s,
                error: new Error(String(p.message ?? "erro desconhecido")),
                done: true,
                inflight: [],
              }));
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setState((s) => ({ ...s, error: err as Error, done: true }));
      }
    })();

    return () => {
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  return {
    ...state,
    refetch: () => setTick((t) => t + 1),
  };
}