## Motor de Indexação PNCP/Compras-gov com Inngest + FTS

### Pré-requisito (bloqueante)
**Conectar Inngest** em Connectors antes de eu começar. Sem isso, a fila não roda. Depois de conectar, eu sigo o plano abaixo sem novas perguntas.

---

### Arquitetura alvo

```text
┌─ Inngest Cron (hourly) ────────────┐
│   discover.window  (1 dia/exec)    │  → enfileira N eventos
└────────────────┬───────────────────┘
                 ▼
┌─ extract.compra (paralelo, conc=4) ┐
│   pagina /v1/.../itens             │  → enfileira 1 evento por item
└────────────────┬───────────────────┘
                 ▼
┌─ resolve.item (paralelo, conc=8) ──┐
│   GET /itens/{n}/resultados        │
│   normaliza → upsert quote_items   │
│   marca homologado + fornecedor    │
└────────────────────────────────────┘
```

Cada step é durável: erro de uma compra não derruba a janela; Inngest retenta sozinho com backoff.

### Camadas

**1. Discovery por data (não por keyword)**
- Novo `src/lib/crawler/pncp-discovery.server.ts`: pagina `GET /v1/contratacoes/publicacao?dataInicial=&dataFinal=&codigoModalidadeContratacao=...` cobrindo modalidades relevantes (pregão eletrônico, dispensa, concorrência).
- Novo `src/lib/crawler/compras-gov-discovery.server.ts`: reusa `compras-gov.server.ts` já existente, mas agora chamado pelo worker por janela de data, não por keyword.

**2. Extraction + Adjudication**
- `src/lib/crawler/pncp-extract.server.ts`: dado `(cnpj, ano, seq)`, busca itens (reusa `fetchPncpItens` que já respeita `totalPaginas`) e para cada item enfileira `resolve.item`.
- `src/lib/crawler/pncp-resolve.server.ts`: chama `/itens/{n}/resultados` (reusa `fetchPncpItemResultado`), normaliza para o Golden Schema e faz upsert em `quote_items` com `discovered_via='crawler'`, `homologado=true` quando há `valorUnitarioHomologado`.

**3. Inngest functions**
- `src/lib/inngest/client.ts`: client + helper `sendEvent` via gateway Lovable.
- `src/lib/inngest/functions.ts`: define `discoverWindow`, `extractCompra`, `resolveItem` com concorrência, retry, dead-letter.
- `src/routes/api/public/inngest.ts`: serve endpoint (`POST/GET/PUT`) usando `inngest/edge` — Inngest precisa desse URL para sync e invocação.
- Cron Inngest: `discover.window` roda a cada 1h, processando dataInicial/dataFinal de 1 dia (janela deslizante). Backfill inicial de 180 dias: 1 evento manual disparando 180 janelas (Inngest paraleliza com conc=2 para não estourar PNCP).

**4. Full-Text Search (PostgreSQL TSVector)**
- Migration:
  - Adiciona coluna `tsv tsvector` em `quote_items`.
  - Trigger `BEFORE INSERT/UPDATE` que computa `to_tsvector('portuguese', unaccent(coalesce(titulo,'') || ' ' || coalesce(descricao,'') || ' ' || coalesce(objeto_estruturado,'')))`.
  - Índice GIN em `tsv`.
  - Extensão `unaccent` (se não estiver).
  - Backfill da coluna para linhas existentes.
- Nova função SQL `search_quote_items_fts(query text, limit int)` que retorna ordenado por `ts_rank_cd`.
- Refator `searchDbItems` (`src/lib/db-search.functions.ts`): usa `.rpc('search_quote_items_fts', ...)` em vez de `ILIKE`.

**5. Wire no /buscar (DB-first)**
- Em `src/routes/buscar.tsx`: dispara `searchDbItems` em paralelo com a busca remota; mostra resultados do banco no topo imediatamente com badge "do banco" e mergeia quando a remota termina (dedupe por `fingerprint`).

**6. Admin: trigger backfill manual**
- Novo endpoint `/api/public/hooks/crawler-backfill` (com header `apikey` anon) que dispara o evento Inngest `backfill.start` com `days: 180`. UI no `/admin` com botão "Rodar backfill 180 dias".

### Arquivos

**Criar (8):**
- `src/lib/inngest/client.ts`
- `src/lib/inngest/functions.ts`
- `src/lib/crawler/pncp-discovery.server.ts`
- `src/lib/crawler/pncp-extract.server.ts`
- `src/lib/crawler/pncp-resolve.server.ts`
- `src/lib/crawler/golden-schema.ts` (normalizer + upsert helper)
- `src/routes/api/public/inngest.ts`
- `src/routes/api/public/hooks/crawler-backfill.ts`

**Editar (3):**
- `src/lib/db-search.functions.ts` → usar `rpc` FTS
- `src/routes/buscar.tsx` → wire DB-first com merge
- `src/routes/admin.tsx` → botão backfill + tabela `harvest_runs` mostrando jobs Inngest

**Migration (1):**
- `unaccent` extension + `tsv` column + trigger + GIN index + backfill + `search_quote_items_fts` RPC

### O que NÃO mudo
- O `harvestTick` antigo (cron pg) continua funcionando para os termos manuais que o admin cadastrou — não removo, só deixo de ser o motor principal.
- `fetchPncpItens` / `fetchPncpItemResultado` / `pncpFetchJson` continuam — só passam a ser chamados pelos workers Inngest.
- A busca remota live (`searchPrices`) continua existindo para quando o termo for muito novo e ainda não estiver no índice.

### Riscos / cuidados
- **PNCP rate limit**: backfill de 180 dias = ~180 × N modalidades × M páginas. Vou começar conc=2 e watch `429`. Se travar, reduzo para 1 e aumento backoff.
- **Custo Inngest**: tier free aguenta esse volume tranquilo (eventos são baratos; runs custam só onde há código).
- **Volume `quote_items`**: 180 dias pode trazer 100k-500k linhas. RLS pública de leitura continua OK; GIN index segura.

### Próximo passo
1. Você conecta Inngest em Connectors.
2. Eu rodo a migration FTS (separada, primeiro), depois crio os arquivos do crawler + Inngest, depois wire DB-first no /buscar, depois botão de backfill no admin.

Confirma que conectou Inngest pra eu começar?
