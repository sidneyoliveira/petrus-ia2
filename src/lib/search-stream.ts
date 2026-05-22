/**
 * Hook client-side que consome o stream SSE de /api/public/search/stream.
 * Emite parciais conforme cada fonte responde — sem esperar a busca acabar.
 */
import { useEffect, useRef, useState } from "react";
import type { PriceResult, SearchResponse, SearchSourceStatus } from "./types";

export interface StreamSource {
  name: string;
  status: "ok" | "empty" | "error";
  count: number;
  error?: string;
}

export interface SearchStreamState {
  items: PriceResult[];
  sources: StreamSource[];
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
              setState((s) => ({ ...s, totalSources: Number(p.totalSources) || 0 }));
            } else if (evt.event === "source") {
              const src: StreamSource = {
                name: String(p.name ?? "?"),
                status: (p.status as StreamSource["status"]) ?? "ok",
                count: Number(p.count) || 0,
                error: typeof p.error === "string" ? p.error : undefined,
              };
              setState((s) => ({
                ...s,
                sources: [...s.sources, src],
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
              setState((s) => ({ ...s, phase: String(p.name ?? "") }));
            } else if (evt.event === "done") {
              const final = payload as SearchResponse;
              setState((s) => ({
                ...s,
                items: final.results,
                done: true,
                fromCache: !!final.fromCache,
                tookMs: final.tookMs ?? Date.now() - started,
                phase: undefined,
                final,
                finalSources: final.sources,
              }));
            } else if (evt.event === "error") {
              setState((s) => ({
                ...s,
                error: new Error(String(p.message ?? "erro desconhecido")),
                done: true,
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