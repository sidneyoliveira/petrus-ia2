/**
 * Telemetria client-side de buscas (Petrus IA).
 *
 * Mantém um buffer em memória das últimas buscas concluídas para diagnóstico
 * rápido (avg duration, cache hit rate, timeout rate). Fire-and-forget —
 * nunca bloqueia ou derruba a UI. O log do servidor (source_runs) continua
 * sendo a fonte canônica; este aqui é só para dashboards/dev tools.
 */

export interface SearchMetric {
  query: string;
  tema?: string;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  resultCount: number;
  sourceCount: number;
  cacheHit: boolean;
  timeoutOccurred: boolean;
  error?: string;
}

const MAX_BUFFER = 200;
const buffer: SearchMetric[] = [];

export function recordSearchMetric(m: SearchMetric): void {
  buffer.push(m);
  if (buffer.length > MAX_BUFFER) buffer.shift();

  if (typeof window !== "undefined") {
    type Tracker = { track?: (event: string, data: unknown) => void };
    const w = window as unknown as { __PETRUS_TELEMETRY__?: Tracker };
    try {
      w.__PETRUS_TELEMETRY__?.track?.("search_completed", m);
    } catch {
      /* noop */
    }
  }

  if (typeof console !== "undefined" && m.error) {
    console.warn("[telemetry] busca com erro:", m);
  }
}

export function getSearchMetricsSnapshot() {
  const now = Date.now();
  const last24h = buffer.filter((m) => now - m.startedAt < 24 * 60 * 60 * 1000);
  const n = last24h.length;
  if (n === 0) {
    return {
      total: 0,
      avgDurationMs: 0,
      cacheHitRate: 0,
      timeoutRate: 0,
      errorRate: 0,
      totalResults: 0,
    };
  }
  return {
    total: n,
    avgDurationMs: Math.round(last24h.reduce((s, m) => s + m.durationMs, 0) / n),
    cacheHitRate: last24h.filter((m) => m.cacheHit).length / n,
    timeoutRate: last24h.filter((m) => m.timeoutOccurred).length / n,
    errorRate: last24h.filter((m) => m.error).length / n,
    totalResults: last24h.reduce((s, m) => s + m.resultCount, 0),
  };
}

export function clearSearchMetrics(): void {
  buffer.length = 0;
}