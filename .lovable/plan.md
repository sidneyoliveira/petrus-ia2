## Escopo
Cinco frentes, cada uma com risco diferente. Vou executar nesta ordem, commitando entre fases para você poder reverter qualquer uma sem perder o resto.

---

### Fase 1 — Autenticação + perfis (baixo risco)
- Migration: tabela `profiles` (user_id FK auth.users, display_name, avatar_url, email) com RLS "dono lê/edita o seu", trigger `handle_new_user` populando no signup.
- Configurar social auth: Google via `configure_social_auth` (+ email/senha mantido).
- Rotas novas: `/login`, `/auth/callback` (broker Lovable), `/_authenticated` layout guard.
- `SiteHeader`: botão "Entrar" → menu com avatar quando logado, "Sair".
- `__root.tsx`: `onAuthStateChange` → `router.invalidate()` + `queryClient.invalidateQueries()`.
- **Não exige login pra usar /buscar** — login só é necessário pra salvar cesta no servidor.

### Fase 2 — Cesta no banco (baixo risco)
- Migration: tabela `baskets` (id, user_id, name, items jsonb, created_at, updated_at) com RLS "dono CRUD".
- ServerFn `saveBasket`, `listBaskets`, `loadBasket`, `deleteBasket` com `requireSupabaseAuth`.
- `useBasket` mantém localStorage como cache, mas ganha `syncToCloud()` / `loadFromCloud(id)`.
- Nova página `/_authenticated/cestas`: lista cestas salvas, abrir/renomear/excluir.
- Em `/cotacao`: botão "Salvar cesta na nuvem" (se logado) + "Carregar cesta".

### Fase 3 — UI compacta (baixo risco)
- `ResultsTable`: remover colunas `mathStatus`, `extractionQuality`, `valorTotalCalculado`, `delta`; manter só Item, Órgão, UF, Data, Unit, Qtd, Unitário, Total, Fonte, Ações.
- Ações vira `<TooltipProvider>` com ícones: `<Eye/>` (ver), `<ShoppingBasket/>` (cesta), `<Flag/>` (corrigir), `<ExternalLink/>` (fonte).
- `ResultCard`: idem — esconde bloco "Validação matemática" e badges de extração.
- `PriceResult` type: campos matemáticos ficam (backend continua calculando para o healer), só somem da UI.

### Fase 4 — Log real por fonte (médio risco)
- Novo server route `src/routes/api/search-stream.ts` que streama NDJSON:
  - `{"event":"source_start","name":"PNCP"}`
  - `{"event":"source_done","name":"PNCP","count":42,"ms":1230}`
  - `{"event":"final","results":[...],"total":...}`
- Refatorar `search.functions.ts` extraindo `runSearch(query, {onProgress})` — server-fn atual vira wrapper sem callback (preserva contrato existente), route nova usa o callback.
- `/buscar`: substitui `useQuery(getSearch)` por um hook customizado `useStreamingSearch` que consome o NDJSON via `fetch` + `ReadableStream`. Fallback pra server-fn se o stream falhar.
- `LiveSearchLog` passa a mostrar nomes reais conforme chegam: "✓ PNCP (42 itens, 1.2s)", "⏳ Transparência Itarema…".

### Fase 5 — Prioridade valor contratado (alto risco, escopo limitado)
**Não mexer no fluxo atual de extração.** Adicionar camada nova:
- Migration: colunas `quote_items.valor_contratado` (numeric), `valor_contratado_fonte` (text — 'ata'|'contrato'|'homologacao'|null), `contract_fetch_status` ('pending'|'ok'|'fail'|'na').
- Novo `src/lib/contract-resolver.server.ts`: dado um `quote_item` com URL do PNCP/portal, tenta:
  1. Detectar links de ata/contrato/termo no payload bruto (já temos `source_payload_raw`).
  2. Buscar a página/PDF via Firecrawl scrape (`formats: ['markdown']`).
  3. Extrair valor unitário homologado via Lovable AI (`google/gemini-2.5-flash`) com prompt focado: "retorne valor unitário contratado ou null".
- ServerFn `resolveContractValue(itemId)` chamado sob demanda + um job em backfill via página `/admin`.
- No PriceResult exibido: `valor` passa a ser `valor_contratado ?? valor_homologado ?? valor_estimado`, com badge mostrando a fonte ("Contratado" / "Homologado" / "Estimado").
- Sem fila/cron — primeiro acesso a um item dispara `resolveContractValue` em background (fire-and-forget) e atualiza no DB pra próximas consultas.

---

### Migrations resumidas
```sql
-- Fase 1
create table profiles (user_id uuid primary key references auth.users on delete cascade, ...);
-- Fase 2
create table baskets (id uuid pk, user_id uuid not null, name text, items jsonb, ...);
-- Fase 5
alter table quote_items add column valor_contratado numeric,
  add column valor_contratado_fonte text,
  add column contract_fetch_status text default 'pending';
```

### Riscos / observações
- **Fase 4** é a mais arriscada: TanStack server routes streamam bem em Workers, mas SSR/preload precisa de cuidado. Vou manter o `useQuery` antigo como fallback.
- **Fase 5** consome créditos do Firecrawl e do Lovable AI — vou limitar a 1 chamada/item, com cache permanente em `quote_items`.
- "Cotação de fornecedor da internet" (e-commerce) você pediu pra **não** implementar agora — confirmado, fora de escopo.
- Você está em `/cotacao` agora; depois da Fase 3 essa página fica mais limpa também.

Confirma a ordem e que posso seguir tudo numa rodada longa? Se preferir, posso parar após a Fase 3 pra você validar antes de eu encostar no streaming e no resolver de contratos.