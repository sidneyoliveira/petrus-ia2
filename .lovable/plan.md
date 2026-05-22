# Plano — Continuação + Ambição

## Parte A — Fechar o que ficou pendente das fases anteriores

### A1. Rotas de autenticação (re-criar agora que `routeTree.gen.ts` regenera no build)
- `src/routes/login.tsx` — formulário Email/Senha + botão Google (via broker `lovable.auth.signInWithOAuth("google")`). Redireciona para `/` após sucesso.
- `src/routes/auth/callback.tsx` — trata callback OAuth, redireciona para `/`.
- `src/routes/_authenticated.tsx` — layout pathless, `beforeLoad` chama `supabase.auth.getUser()`; se não logado, `redirect({ to: "/login" })`. Renderiza `<Outlet />`.
- `src/routes/_authenticated/cestas.tsx` — lista cestas salvas, abrir, deletar, renomear (usa `baskets.functions.ts` já criado).
- `SiteHeader`: menu de usuário (avatar + nome do `useAuth`) com "Minhas cestas" / "Sair"; botão "Entrar" se deslogado.
- `__root.tsx`: `AuthProvider` + listener `onAuthStateChange` → `router.invalidate()` + `queryClient.invalidateQueries()`.
- Chamar `supabase--configure_social_auth` com `providers: ["google"]`.

### A2. UI compacta + cesta na nuvem em `/cotacao`
- `ResultsTable`: remover colunas matemáticas (`mathStatus`, `extractionQuality`, `valorTotalCalculado`, `delta`). Manter: Item, Órgão, UF, Data, Unid, Qtd, Unitário, Total, Fonte, Ações (ícones c/ tooltip).
- `ResultCard`: esconder bloco "Validação matemática" e badges de extração.
- `/cotacao`: botões "Salvar na nuvem" / "Carregar da nuvem" (visíveis só se logado).

### A3. Stream real de log por fonte (Fase 4)
- Refatorar `src/lib/search.functions.ts`: extrair `runSearch(query, filters, { onProgress })` para `src/lib/search-core.server.ts`.
- Novo server route `src/routes/api/public/search-stream.ts` (NDJSON) emitindo `source_start`, `source_done`, `final`.
- `/buscar`: novo hook `useStreamingSearch` consumindo `ReadableStream`. Fallback para `useQuery` antigo se stream falhar.
- `LiveSearchLog` mostra nomes reais conforme chegam (PNCP, Transparência, Firecrawl, etc).

### A4. Prioridade valor contratado (Fase 5)
- `src/lib/contract-resolver.server.ts`: detecta link de ata/contrato no `source_payload_raw`, faz `firecrawl.scrape` em markdown, extrai valor unitário homologado com `google/gemini-2.5-flash` (Lovable AI). Persiste em `quote_items.valor_contratado` + `valor_contratado_fonte` + `contract_fetch_status`.
- ServerFn `resolveContractValue(itemId)` fire-and-forget após cada busca (top N por relevância, ~5 itens).
- `PriceResult` em UI: exibe `valor_contratado ?? valor_homologado ?? valor_estimado` + badge da fonte.

## Parte B — AMBIÇÃO (nova rodada)

### B1. Salvar TODOS os itens da contratação (não só o match)
- Quando o adapter (PNCP, etc) busca uma contratação que tem N itens, hoje só persistimos o item que casou com a query. Mudar para:
  - Em `src/lib/persistence.server.ts` (novo): função `persistContractationItems(items[])` que faz upsert por `fingerprint` (hash de `documento + numero_item`) em `quote_items` com `query_norm` = query do item dentro daquela contratação.
  - Adapters PNCP e Transparência ganham passo extra: depois de pegar o item alvo, listam todos os itens daquela contratação (endpoint `/compras/{id}/itens`) e enfileiram persistência.
- Coluna nova em `quote_items`: `discovered_via` ('search' | 'harvest' | 'sibling') para distinguir origem.

### B2. Busca DB-first + ranking por similaridade
- Refatorar `runSearch`: ANTES de bater fontes externas, faz `SELECT` em `quote_items` filtrando por:
  - `query_norm ILIKE '%caneta%'` (match textual rápido)
  - + se tiver embedding: similaridade vetorial top-50 (`embedding <=> query_embedding`)
- Resultados do DB entram no topo se forem `query_norm` exato; abaixo se forem similares.
- TTL: itens > 90 dias entram com badge "histórico" e peso menor no ranking.
- Marca `cached: true` no `PriceResult` quando vier do DB.

### B3. Painel admin + harvester em background
- Tabela nova `harvest_queries` (id, term, status, last_run_at, total_found, enabled, priority, created_by user_id).
- Tabela nova `harvest_runs` (id, query_id, started_at, finished_at, items_persisted, error).
- RLS: `has_role(uid, 'admin')` lê/escreve; ninguém mais.
- Tabela `user_roles` + enum `app_role` + função `has_role` (padrão Lovable).
- Server route `src/routes/api/public/hooks/harvest-tick.ts`: chamado por `pg_cron` a cada 15min. Pega top 3 queries `enabled=true` ordenadas por `last_run_at` ASC, roda `runSearch` em modo `harvest` (sem filtros restritivos, persiste todos itens), grava em `harvest_runs`.
- pg_cron job via `supabase--insert`.
- `src/routes/_authenticated/admin.tsx` (gated por `has_role`):
  - CRUD de `harvest_queries` (adicionar "caneta azul", "papel A4 75g", "notebook i5"…).
  - Lista `harvest_runs` recentes com status.
  - Botão "Rodar agora" (chama hook manualmente).
  - Toggle enabled/disabled, prioridade.

### B4. Anti-redundância
- Antes de persistir item, checa `fingerprint` único — se já existe e `updated_at < 7 dias`, pula.
- Harvester nunca re-busca a mesma query antes de 24h (cláusula `last_run_at`).

## Escopo técnico — arquivos

```
Migrations:
  - user_roles + app_role + has_role()
  - harvest_queries, harvest_runs (RLS admin-only)
  - quote_items: discovered_via column
  - índice GIN em quote_items.query_norm (busca textual)

src/lib/:
  - persistence.server.ts (novo — upsert por fingerprint)
  - search-core.server.ts (novo — runSearch com onProgress + db-first)
  - contract-resolver.server.ts (novo)
  - harvest.server.ts (novo — orquestra tick)
  - admin.functions.ts (novo — CRUD harvest_queries, role check)

src/routes/:
  - login.tsx, auth/callback.tsx
  - _authenticated.tsx (layout)
  - _authenticated/cestas.tsx
  - _authenticated/admin.tsx
  - api/public/search-stream.ts
  - api/public/hooks/harvest-tick.ts

UI:
  - SiteHeader (menu user + link admin se role=admin)
  - ResultsTable (compacta, ícones)
  - ResultCard (sem matemática)
  - LiveSearchLog (real)
  - /cotacao (cloud sync)
```

## Riscos

- **Crédito Firecrawl/Lovable AI**: harvester roda contínuo. Limite por tick (3 queries × ~10 itens) + dedup por fingerprint mitigam.
- **Stream NDJSON**: fallback para serverFn não-streaming já planejado.
- **routeTree.gen.ts**: rotas serão regeneradas pelo plugin Vite no próximo build — sem intervenção manual.
- **Embedding na busca DB-first**: requer função RPC `match_quote_items(query_embedding, threshold, count)`. Vou criar.

## Sugestão de ordem (faseado, mas tudo na mesma rodada)

1. Migrations (roles, harvest_*, discovered_via, índice, RPC).
2. Auth UI (login, callback, _authenticated, header).
3. UI compacta + cesta nuvem.
4. persistence.server + busca DB-first + persistir todos itens da contratação.
5. Stream NDJSON + LiveSearchLog real.
6. Contract resolver (Fase 5).
7. Admin panel + harvest hook + pg_cron.

Vou pedir aprovação UMA vez para a migration de roles+harvest e seguir reto. As funcionalidades vão sendo entregues progressivamente — se algo quebrar no meio, paramos com checkpoint estável (auth + UI compacta já funcionando).

## Confirma?

Posso seguir com tudo isso numa rodada longa? Se preferir entregar em duas levas (1–3 agora, 4–7 depois), me diga.