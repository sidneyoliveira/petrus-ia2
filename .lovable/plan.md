## Objetivo

Buscar a mesma cotação em **várias fontes públicas simultaneamente** (PNCP, TCEs estaduais, scraping/dorking via Firecrawl), normalizar tudo no mesmo schema `PriceResult`, persistir em `quote_items` e devolver ao usuário com lastro (URL da fonte + trecho original).

## Arquitetura (equivalência Django → stack atual)

```text
                 src/routes/buscar.tsx (React)
                            │
                            ▼  useServerFn
              src/lib/search.functions.ts (RPC)
                            │
            ┌───────────────┼─────────────────────────┐
            ▼               ▼                         ▼
   pncp.source.ts    tce.source.ts              dorking.source.ts
   (API oficial)     (TCE-CE/SP/MG via API)     (Firecrawl /search)
            │               │                         │
            └───────┬───────┴────────────┬────────────┘
                    ▼                    ▼
            normalize() → PriceResult     enrich.ts
                    │              (BrasilAPI/ReceitaWS p/ CNPJ)
                    ▼
            quote_items (cache + lastro)
```

Cada fonte é um módulo isolado com a mesma interface:

```ts
export interface PriceSource {
  id: "pncp" | "tce-ce" | "tce-sp" | "tce-mg" | "dork-pdf" | "dork-html";
  search(q: NormalizedQuery, signal: AbortSignal): Promise<PriceResult[]>;
}
```

O agregador faz `Promise.allSettled` com timeout por fonte (15s) e retorna o que chegou + status por fonte (já temos `SearchSourceStatus`).

## Entregáveis desta rodada

### 1. Estrutura de pastas
```text
src/lib/sources/
  index.ts              # registry + agregador com Promise.allSettled
  pncp.source.ts        # já existe parcialmente em search.functions.ts → extrair
  tce-ce.source.ts      # API LCO do TCE-CE
  tce-sp.source.ts      # API aberta do TCE-SP
  tce-mg.source.ts      # API aberta do TCE-MG
  dorking.source.ts     # Firecrawl /v2/search com queries dork
  enrich/
    cnpj.ts             # BrasilAPI + fallback ReceitaWS
    cnae.ts             # bate CNAE × item (peso no scoreFinal)
```

### 2. Schema do banco (nova migração)
- Adicionar coluna `source_payload_raw jsonb` em `quote_items` (lastro bruto pra auditoria futura).
- Adicionar `source_excerpt text` (trecho original onde o valor foi extraído — base do "Ver Fonte Original").
- Nova tabela `source_runs` (telemetria por fonte por busca: `source_id`, `search_id`, `status`, `count`, `took_ms`, `error`) — alimenta o painel de saúde das fontes.
- Nova tabela `cnpj_cache` (TTL 30 dias): `cnpj`, `razao`, `cnae`, `ativo`, `fetched_at` — evita martelar BrasilAPI.

### 3. Conector Firecrawl
Conectar via `standard_connectors--connect` com `connector_id: "firecrawl"` (não está conectado ainda — vou disparar o picker). Vai prover `FIRECRAWL_API_KEY` no `process.env` para o `dorking.source.ts`.

### 4. Queries de dorking (exemplos que vão pro Firecrawl)
- `filetype:pdf "ata de registro de preços" "{termo}" "valor unitário" site:gov.br`
- `filetype:pdf "termo de homologação" "{termo}" "R$" site:gov.br`
- `"{termo}" "menor preço" "homologado" site:tce.{uf}.gov.br`

Limit 10 resultados por dork, com `scrapeOptions.formats=['markdown']` pra já vir o conteúdo extraível.

### 5. Cache-first + revalidação em background
- `search.functions.ts` consulta `quote_searches` por `(query_norm, filters_hash)`.
- Se `fresh_until > now()` → retorna do cache imediatamente (`fromCache: true`).
- Se `stale` → retorna cache **e** dispara fan-out novo em background via rota `/api/public/hooks/revalidate-search` (chamada via `fetch` no próprio handler, sem aguardar).
- Se não existe → fan-out síncrono e persiste.

### 6. Agregador resiliente
```ts
const results = await Promise.allSettled(
  sources.map(s => withTimeout(s.search(q, signal), 15_000))
);
// telemetria por fonte vai pra source_runs, payload pra quote_items
```
Fonte que falhar **não derruba a busca** — só aparece com `status: "error"` no `sources[]`.

### 7. Validação defensiva (mantém o pncp-rules.ts existente)
Toda fonte passa pelo mesmo pipeline:
1. `normalize()` para `PriceResult`
2. `pncp-rules.detectValorTipo()` — se vier "global" sem unitário → marca pra re-extração (Self-Healing fica pra rodada 2, mas o marcador já é gravado).
3. `enrichCNPJ()` se tiver CNPJ → joga `cnpj_cache`.

## Fora de escopo desta rodada (próximas etapas)

- Self-Healing loop com Lovable AI (rodada 2)
- pgvector + RAG de feedback (rodada 3)
- Botão "Ver Fonte Original" com highlight visual no PDF (rodada 4) — mas **já gravo `source_excerpt`** pra rodada 4 só precisar renderizar
- Scraping de agregadores privados (M2A, BLL, LicitaNet) — depende de avaliar se Firecrawl supera o bloqueio

## Riscos conhecidos

- **APIs de TCE são instáveis e variam por estado.** Vou começar só com TCE-CE (mais documentado) e deixar TCE-SP/MG como stub que retorna `[]` até validar manualmente o endpoint. Não quero inventar URLs.
- **Firecrawl consome créditos.** Cada dork = 1 search + N scrapes. Vou limitar a 2 dorks × 10 resultados = ~20 créditos por busca não-cacheada. Cache de 24h reduz drasticamente.
- **Cloudflare Worker tem timeout.** Fan-out paralelo com timeout 15s por fonte e cap total de 25s.

## Detalhes técnicos

- Server functions: `createServerFn` (não Edge Functions Supabase — esta stack é TanStack Start em Worker).
- Validação de input: Zod (já em uso).
- Tipos compartilhados: `PriceResult` em `src/lib/types.ts` já cobre tudo.
- Logs: `console.log` estruturado por fonte → visível em `server-function-logs`.
- Sem rate-limiting custom (não é primitivo do backend ainda) — confio em Firecrawl + cache do DB.

## Plano de execução

1. Conectar Firecrawl (picker interativo)
2. Migração do schema (`source_runs`, `cnpj_cache`, colunas novas)
3. Refatorar `search.functions.ts` para usar o registry `src/lib/sources/`
4. Implementar `pncp.source.ts` (extrair do existente, sem mudar lógica)
5. Implementar `tce-ce.source.ts`
6. Implementar `dorking.source.ts` (Firecrawl)
7. Implementar `enrich/cnpj.ts` (BrasilAPI)
8. Wire-up no agregador + telemetria em `source_runs`
9. Smoke-test via `invoke-server-function` em produção