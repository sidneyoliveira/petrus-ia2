## Objetivo

Hoje `searchPrices` aguarda **todas** as fontes terminarem antes de devolver qualquer item (5min para 1000 itens = tela em branco). Vamos transformar a busca em um stream: cada fonte que termina **empurra** seus itens para o navegador, que vai re-rankeando e mostrando em tempo real. O resultado final (com cache e telemetria) continua igual ao de hoje.

## Arquitetura

```text
Navegador (/buscar)
   │  POST /api/public/search/stream  (body = filtros)
   ▼
TSS server route (SSE: text/event-stream)
   │
   ├─ dispara cada tarefa do pipeline em paralelo
   │     (PNCP × 3 páginas, M2A, Portal CP, Firecrawl, mining, etc.)
   │
   ├─ a cada Promise que resolve:
   │     1) anexa os RawItem ao buffer global
   │     2) roda enrich+rank+dedup INCREMENTAL no buffer
   │     3) emite `event: snapshot` com top-N resultados atuais
   │     4) emite `event: source` com {name, status, count}
   │
   └─ quando todas resolvem:
         - persiste cache (igual hoje)
         - emite `event: done` com payload final + tookMs + sources
         - fecha o stream
```

## Mudanças por arquivo

**1. `src/lib/search/pipeline.server.ts`** (refactor mínimo)
- Expor um helper novo `rankPartial(raw, data, apiKey, catalog)` que recebe o array bruto acumulado e devolve `PriceResult[]` rankeado — basicamente o que hoje vive em `searchPrices` entre as linhas 213–366, extraído para uma função pura. Sem mudar comportamento.
- Expor `buildTaskList(data, catalog, apiKey)` que devolve `Array<{ name: string; run: () => Promise<RawItem[]> }>` — a mesma lista de `tasks` que hoje vive inline, agora nomeada por fonte.

**2. `src/routes/api/public/search/stream.ts`** (novo)
- TSS server route POST que aceita o `FilterSchema`.
- Lê cache primeiro: se HIT e não-`forceRefresh`, manda um único `event: done` com o cache e fecha (mantém latência zero da UX cacheada).
- Caso contrário, abre `ReadableStream`, chama `buildTaskList`, escuta cada `task.run()` com `Promise.allSettled` mas via loop assíncrono — para cada resolução: acumula raw, chama `rankPartial`, emite `snapshot` + `source`. No final emite `done` e grava cache.
- Auth: opcional — a rota fica em `/api/public/*` para não exigir bearer; validação Zod no body. (mesmo nível de exposição do serverFn atual, que também é callable sem login).

**3. `src/lib/search-stream.ts`** (novo, client-only)
- Hook `useSearchStream(filters, enabled)` que retorna `{ items, sources, done, error, tookMs }`.
- Internamente: `fetch('/api/public/search/stream', { method: 'POST', body: JSON.stringify(filters) })`, lê o `response.body` com `getReader()`, parseia eventos SSE, atualiza estado React via `useState` + `useReducer`.
- Aborta com `AbortController` quando filtros mudam ou o componente desmonta.

**4. `src/routes/buscar.tsx`** (substituição cirúrgica)
- Remove o `useQuery({ queryFn: () => callSearch(...) })` da busca principal.
- Mantém `searchDbItems` (DB-first) intocado.
- Plugin `useSearchStream` no lugar; `data.results` agora vem do estado do hook.
- `isFetching` vira `!done && items.length === 0`; passamos a mostrar um indicador "buscando em N fontes · X itens encontrados…" no topo enquanto `!done`.

**5. `src/lib/search.functions.ts`** (mantido)
- O serverFn `searchPrices` continua existindo para compatibilidade (export PDF, rota `/cotacao`, refresh em background do cache). Internamente passa a usar os helpers extraídos em #1, sem mudança de contrato.

## Detalhes técnicos

- **Cloudflare Workers + SSE**: `ReadableStream` é nativo e suportado. Headers obrigatórios: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Não usar compressão.
- **Backpressure**: emitir snapshot só a cada 500ms (debounce) ou quando uma fonte nova chega — evita inundar a UI quando várias fontes resolvem juntas.
- **Re-ranking incremental**: `rankPartial` é O(n log n) no tamanho atual do buffer (~poucos milhares no pior caso). Roda a cada source completion (~10-15 vezes por busca). Custo desprezível.
- **Cache**: gravado apenas no `done`, igual hoje. Snapshots intermediários **não** vão para o cache.
- **Erros por fonte**: continuam silenciados (igual hoje); o painel de telemetria mostra falha.
- **Erro fatal do stream**: emite `event: error` e fecha. Frontend mostra toast.

## Fora do escopo

- Manter `searchPrices` como serverFn (não vamos quebrar `/cotacao` nem o refresh em background).
- Nada muda nas fontes/pipelines individuais — só na orquestração.
- Sem mudanças visuais além do indicador de progresso "X fontes · Y itens".
