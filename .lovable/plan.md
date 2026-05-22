# Plano: fechar as 5 frentes pendentes

Vou dividir em **2 levas** para controlar consumo de créditos (Firecrawl + Lovable AI são os mais caros).

---

## Leva 1 — barata, alto impacto (agora)

### 1. DB-first no `/buscar` (zero créditos externos)
- Em `buscar.tsx`, antes do `useQuery` da busca remota, disparar `searchDbItems({ query })` em paralelo.
- Mostrar resultados do banco imediatamente no topo com badge **"do banco"**. Quando a busca remota termina, mesclar (dedupe por `id`/`fingerprint`), mantendo os do banco que casam exato no topo.
- Custo: 0 créditos externos. Resposta percebida muito mais rápida.

### 2. Persistir itens-irmãos da contratação
- Em `search.functions.ts` (PNCP e Compras.gov), quando a API já retorna a lista de itens da contratação no mesmo payload, fazer `upsert` em `quote_items` de TODOS os itens (não só os que casaram), com `discovered_via='sibling'` e `query_norm` derivado do título de cada irmão.
- Sem chamadas extras a APIs externas — reaproveita o payload que já veio. Custo: 0 créditos.
- Onde os endpoints PNCP/Transparência **não** trazem irmãos no mesmo response, deixar um TODO e seguir.

### 3. UI compacta + cesta na nuvem + rota `/cestas`
- Recriar `src/routes/_authenticated.tsx` (layout gate) e `src/routes/_authenticated/cestas.tsx` usando `baskets.functions.ts` (já existe).
- Em `/cotacao`: botões **"Salvar na nuvem"** / **"Carregar da nuvem"** que chamam `saveBasket`/`loadBasket`+`replaceBasketItems`.
- Esconder colunas matemáticas redundantes no `ResultsTable` (`mathStatus`, `extractionQuality`, `valorTotalCalculado`, `delta`).

---

## Leva 2 — cara, fazer depois (sob confirmação)

### 4. Stream NDJSON real
- Refator de `search.functions.ts` → `search-core.server.ts` com callback `onProgress(stage, source, count)`.
- Nova rota `src/routes/api/search-stream.ts` que faz `ReadableStream` em NDJSON.
- Hook `useStreamingSearch` no cliente substitui o log simulado por eventos reais (`source.start`, `source.done`, `merge`, `done`).
- Custo: 0 créditos diretos, mas refator grande e arriscado (regressão na busca atual).

### 5. Resolver de valor contratado
- `contract-resolver.server.ts`: para itens PNCP com `homologado=true` e sem `valor_contratado`, chamar Firecrawl no `url` da ata + `google/gemini-2.5-flash-lite` (modelo mais barato) com schema JSON pequeno (`{ valor_homologado, fornecedor }`).
- Rodar **on-demand** (botão "buscar valor contratado") em vez de automático, pra controlar custo.
- Persistir em `valor_contratado`, `valor_contratado_fonte`, `contract_fetch_status`.

---

## Ordem de execução agora (Leva 1)
1. Wire `searchDbItems` no `/buscar` com merge no topo
2. Persistir irmãos no `search.functions.ts` (PNCP + Compras.gov adapters)
3. Rotas auth (`_authenticated.tsx`, `_authenticated/cestas.tsx`)
4. Botões salvar/carregar nuvem no `/cotacao`
5. Esconder colunas redundantes do `ResultsTable`

Total estimado: ~6-8 arquivos editados, 2 criados, 0 migrations, **zero créditos de Firecrawl/Lovable AI**.

Pergunto: **toco a Leva 1 inteira agora e deixo Leva 2 (stream + contract resolver) pra próxima rodada**, certo? Ou prefere que eu também já faça o stream real (item 4) que não custa créditos mas é refator grande?
