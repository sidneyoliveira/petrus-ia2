# Plano: Petrus IA → paridade M2A (Enterprise)

Vou quebrar em **6 rodadas curtas**, cada uma entregável e testável. Hoje implemento a **Rodada A (schema + tríade matemática)**, que destrava todas as outras.

---

## Estado atual (o que já existe)

- `quote_items` já tem: `titulo`, `descricao`, `valor`, `valor_total`, `valor_tipo`, `quantidade`, `unidade`, `fornecedor`, `cnpj`, `orgao`, `uf`, `data`, `url`, `source_excerpt`, `embedding` (pgvector), `valor_inferido*` (self-healing).
- Self-healing (Gemini 3 Flash) já infere unitário a partir do `source_excerpt`.
- pgvector + `match_quote_items` RPC prontos para RAG.
- Enriquecimento de CNPJ via BrasilAPI cacheado.
- Frontend hoje é lista de cards (`ResultCard`) + modal, sem tabela facetada.

## O que falta para virar M2A

Schema relacional rígido, **validação matemática defensiva**, **filtros facetados**, **dashboard tabular**, **cesta de cotação** e **RLHF de correção de extração**.

---

## Rodadas

### 🔴 Rodada A — Schema rígido + Matemática Defensiva *(esta rodada)*

**Migração SQL** em `quote_items`:
- `objeto_estruturado text` (título canônico curto do item, separado de `descricao` técnica)
- `valor_total_calculado numeric` (qtd × unitário)
- `math_status text` — `ok` | `divergente` | `incompleto` | `single_value`
- `math_delta_pct numeric` (|total − calc| / total)
- `extraction_quality text` — `tríade_ok` | `sem_qtd` | `sem_unitário` | `só_global` | `lixo`
- índice em `(math_status, extraction_quality)` para o dashboard filtrar

**Lógica `src/lib/extract/triad.ts`** (puro, testável):
- `classifyTriad({quantidade, valor, valor_total})` → retorna `extraction_quality` + `math_status` + `delta_pct`.
- Regras:
  - Se `qtd && unit && total` e |qtd·unit − total|/total ≤ 0.02 → `tríade_ok` + `ok`.
  - Se divergir > 2% → `divergente` (não descarta, marca pra healer reprocessar).
  - Se só tem `valor_total` sem qtd → `só_global` (sinal de "valor global da licitação", baixa confiança).
  - Sem nenhum sinal numérico → `lixo` (filtrado por padrão do dashboard).
- Testes unitários em `src/lib/extract/triad.test.ts`.

**Wire no `search.functions.ts`**: ao persistir resultado novo em `quote_items`, rodar `classifyTriad` e gravar os campos. Resultados retornados ao frontend ganham `mathStatus` e `extractionQuality` em `PriceResult`.

**Healer rodada 2 estendido**: passa a reprocessar itens com `math_status='divergente'` (não só `valor IS NULL`).

### Rodada B — Dashboard facetado (tabela M2A-style)
- Nova rota `/dashboard` com `<Table>` shadcn: colunas Item, Unidade, Qtd, Unitário, Total, Órgão/UF, Data, Fornecedor, ✅ Matemática.
- Sidebar de filtros: UF, faixa de valor unitário, origem, **só tríade_ok**, data, modalidade.
- Cada linha expande (`Collapsible`) mostrando `descricao` + `source_excerpt` + botão "Ver Fonte com Destaque" (já existe).
- Badge colorido por `math_status` (verde/âmbar/vermelho).

### Rodada C — Cesta de cotação ("Adicionar à Minha Cotação")
- Tabela `quote_baskets` + `basket_items` (RLS por sessão anônima via `basket_token` em localStorage).
- Botão `+ Selecionar` em cada linha.
- Página `/cotacao` lista itens da cesta, calcula mediana/média/min/max por item, exporta CSV/PDF (reusa `src/lib/export.ts`).

### Rodada D — RLHF "❌ Corrigir Extração"
- Botão no card abre dialog: "Onde estava o valor unitário?" (textarea/seletor de span).
- Tabela `extraction_corrections (item_id, field, before, after, source_domain, source_url, user_note, created_at, embedding)`.
- Próxima busca: antes de chamar o healer/extractor, faz `match_corrections(query_embedding, domain)` e injeta as 3 correções mais similares no prompt como few-shot ("nesta fonte, valor unitário fica na coluna 4").

### Rodada E — Reverse engineering de portais (M2A, BLL, PCP)
- `src/lib/sources/m2a.ts`, `bll.ts`, `pcp.ts`: chamam o endpoint JSON real (descoberto via Network tab) em vez de raspar HTML.
- Cada source devolve já no schema rígido → entra direto em `quote_items` com `extraction_quality='tríade_ok'`.

### Rodada F — Filtro FPM (porte de município)
- Tabela `municipios_fpm` (seed do IBGE/STN).
- Filtro "comparar só com municípios de FPM similar" no dashboard.

---

## Detalhes técnicos da Rodada A

```text
src/
├── lib/
│   ├── extract/
│   │   ├── triad.ts          # classifyTriad() puro
│   │   └── triad.test.ts     # vitest
│   ├── search.functions.ts   # +classifyTriad ao persistir
│   ├── heal/value-healer.server.ts  # +query math_status='divergente'
│   └── types.ts              # PriceResult += mathStatus, extractionQuality, objetoEstruturado
└── components/ResultCard.tsx # badge math_status
```

Migração:
```sql
ALTER TABLE quote_items
  ADD COLUMN objeto_estruturado text,
  ADD COLUMN valor_total_calculado numeric,
  ADD COLUMN math_status text,
  ADD COLUMN math_delta_pct numeric,
  ADD COLUMN extraction_quality text;
CREATE INDEX quote_items_quality_idx
  ON quote_items (extraction_quality, math_status);
```

Sem mudanças destrutivas em colunas existentes — só aditivo, seguro pra dados já gravados (ficam `NULL` e são preenchidos no próximo backfill/busca).

---

## Confirma?

Sigo com a **Rodada A** agora (migração + `triad.ts` + wire + badge no card). As rodadas B–F ficam pra mensagens seguintes, uma por vez, pra você poder testar a cada passo.
