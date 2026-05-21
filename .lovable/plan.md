## Objetivo

1. **Cache persistente** — toda busca grava no banco. Próxima busca igual (ou semelhante) devolve resultado em milissegundos enquanto, em segundo plano, refaz a varredura completa e atualiza o cache.
2. **Corrigir extração de itens** — a busca está mostrando o "objeto do contrato" (texto do processo inteiro) em vez dos itens granulares (descrição + UN + qtd + valor unitário + valor total), mesmo quando esses itens existem na API do PNCP ou na página da contratação.

---

## Parte 1 — Banco de dados de cache

### Migration nova (`supabase/migrations/...`)

Duas tabelas + um índice trigram para busca por similaridade.

**`quote_searches`** — uma linha por busca executada
- `id uuid pk`
- `query_norm text` (normalizado: minúsculo, sem acento, sem stop-words)
- `query_raw text`
- `filters jsonb` (uf, modalidade, valor min/max, etc.)
- `total int`, `took_ms int`
- `sources jsonb` (status por fonte)
- `computed_at timestamptz default now()`
- `fresh_until timestamptz` (computed_at + 24h por padrão)
- `unique (query_norm, filters)` para upsert

**`quote_items`** — uma linha por item de cotação encontrado, dedup global
- `id uuid pk`
- `fingerprint text unique` (hash de cnpj+ano+numero+numeroItem ou url+descricao+valor)
- `search_id uuid fk -> quote_searches.id`
- `query_norm text` (denormalizado p/ busca por palavra)
- `titulo text`, `descricao text`, `unidade text`, `quantidade numeric`
- `valor numeric`, `valor_total numeric`, `valor_tipo text`
- `fornecedor text`, `cnpj text`, `orgao text`, `municipio text`, `uf text`
- `data date`, `modalidade text`, `homologado bool`
- `origem text`, `url text`, `documento text`
- `score_final numeric`
- `payload jsonb` (PriceResult completo p/ rehidratar sem recalcular)
- `created_at timestamptz default now()`

**Índices**
- `gin (to_tsvector('portuguese', titulo || ' ' || descricao))` para busca textual rápida
- `gin (query_norm gin_trgm_ops)` para "consultas parecidas"
- `btree (search_id)`, `btree (cnpj, ano)` para refresh

**RLS**: leitura pública (`USING (true)`), insert/update apenas via service role (`supabaseAdmin`) — o usuário final nunca escreve direto.

### Fluxo no `searchPrices` (server fn)

```text
1. normaliza query → query_norm
2. SELECT do cache (quote_searches WHERE query_norm = $1 AND filters = $2)
   ├─ HIT FRESCO (fresh_until > now)  → devolve {fromCache: true, results, computedAt}
   ├─ HIT VELHO                       → devolve cache imediato + dispara refresh
   └─ MISS                            → faz busca completa, grava e devolve

3. Em paralelo (background, sem await na resposta):
   - executa pipeline atual (PNCP + Firecrawl + TCE-CE + mineAttachments)
   - upsert em quote_searches e quote_items
```

Para o "refresh em background com UI ao vivo": adicionar uma server fn nova `refreshSearch(query_norm)` que o front chama via `useMutation` logo após receber o cache; quando ela termina, o front invalida a query e mostra os resultados frescos.

### UI (`src/routes/buscar.tsx`)

- Mostrar badge "📦 Cache de Xmin atrás — buscando ao vivo…" enquanto o background roda.
- Quando o refresh termina, banner verde "✓ Resultados atualizados" e a lista re-renderiza.
- Card de resultado ganha um campo opcional `cachedAt`.

---

## Parte 2 — Correção da extração de itens

### Diagnóstico

O `enrichWithPNCPItems` já existe e expande processo→itens via `/pncp-api/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens`. Quando o usuário pesquisa, três coisas estão falhando:

1. **Resultados da busca PNCP (`/api/search/`) não trazem `orgao_cnpj`, `ano`, `numero` em todos os casos** — vêm em `numero_controle_pncp` (formato `CNPJ-1-SEQ/ANO`). O parser `parseNumeroControlePncpCompra` existe mas só é usado em contratos, não no item raw. Resultado: muitos PNCPs caem no `passthrough` e aparecem como "objeto do contrato".

2. **`item_url` do PNCP às vezes aponta para `/contratos/...`** — o código chama `resolvePncpCompraFromContract` mas o link da busca é `/editais/...` ou `/compras/...` na maioria dos casos. Quando aponta pra contrato e a API `/contratos/{ano}/{seq}` devolve outro `numeroControlePncpCompra`, a expansão funciona; quando não devolve, perdemos os itens.

3. **`isGranularItemResult` exige `unidade || quantidade || valorTotal || valorTipo unitario_*`** — itens minerados de PDF/HTML às vezes não têm `unidade` (só descrição + valor) e são descartados pela regra "se há granular, remove processos" da linha 1612.

### Fixes (em `src/lib/search.functions.ts`)

1. **Sempre derivar cnpj/ano/seq de `numero_controle_pncp`** quando os campos diretos faltarem:
```ts
// dentro de enrichWithPNCPItems, antes do parsed:
const fromControle = parseNumeroControlePncpCompra(r.numero_controle_pncp);
const cnpj = (r.orgao_cnpj ?? parsed?.cnpj ?? fromControle?.cnpj ?? "").replace(/\D/g, "");
const ano = r.ano ?? parsed?.ano ?? fromControle?.ano;
const seqRaw = r.numero_sequencial_compra_ata ?? r.numero_sequencial ?? r.numero ?? parsed?.sequencial ?? fromControle?.sequencial ?? "";
```

2. **Limite `enrichable` mais alto** (já é 120; passar a 200 + remover o `enrichable.length < limit` que cortava silenciosamente).

3. **Fallback de scrape**: se `fetchPncpItens` voltar vazio E temos `item_url`, faz scrape via Firecrawl da página `/app/...` e roda `extractItemsFromHtmlTables` + LLM ontológico que já existe. Isso resolve o caso "página tem itens visíveis mas API não devolve".

4. **Afrouxar `isGranularItemResult`** — aceitar quando `r.valor` existe e o título não é processo/objeto, mesmo sem unidade.

5. **Logar** (`console.info`) quantos foram enriquecidos vs. passthrough vs. fallback de scrape, para o usuário ver via `server-function-logs` se voltar a falhar.

---

## Entrega

1. Migration SQL (cache + RLS + índices + extensão pg_trgm).
2. Edit em `src/lib/search.functions.ts`:
   - Helpers `normalizeQuery`, `readCache`, `writeCache`.
   - Wrap do `searchPrices` para cache-first + background refresh.
   - Fixes 1–5 acima na extração de itens.
3. Edit em `src/routes/buscar.tsx`: badge de cache + banner de refresh + invalidação de query.
4. Edit em `src/lib/types.ts`: campos opcionais `fromCache`, `cachedAt`.

Sem mudanças em outras telas/funcionalidades. Sem mexer em arquivos auto-gerados.