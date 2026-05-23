# Plano de Profissionalização do Sistema

Vou executar em 4 fases sequenciais. Cada fase termina com teste/validação antes de seguir.

## Fase 1 — Auditoria e correção dos mecanismos de busca
1. Mapear todas as fontes em `price_sources` + os fetchers no código.
2. Para cada fonte, rodar uma busca de teste real (termo: "notebook") e medir: status, tempo, nº de resultados, erros.
3. Identificar fontes quebradas (timeout, 404, layout mudou, seletor errado) e:
   - Corrigir o que for recuperável (ajustar endpoint, headers, parser).
   - Desabilitar (`enabled=false`) as que estão definitivamente fora do ar, com nota.
4. Otimizar o pipeline de palavras-chave:
   - Normalizador único (stopwords, sinônimos PT-BR, plural/singular).
   - Expansão automática (ex: "cadeira escritório" → "cadeira ergonômica", "cadeira giratória").
   - Boost por matches exatos e penalização por objetos genéricos ("registro de preços visando…").

## Fase 2 — Categorias / temas de busca
Permitir o usuário organizar suas pesquisas em **temas paralelos** (ex: "Notebooks 2026", "Cadeiras", "Material de limpeza").

- Nova tabela `search_themes` (id, user_id, name, color, icon, created_at).
- Coluna `theme_id` opcional em `baskets`.
- UI: seletor de tema no topo da página de cotação, com:
  - Criar/renomear/excluir tema.
  - Filtrar cestas pelo tema atual.
  - Cor identificadora por tema (chip).
- Cesta e relatório passam a herdar o tema (aparece no header do PDF).

## Fase 3 — Padronização visual e UX
- Auditar `src/styles.css`: garantir uso só de tokens semânticos (`--primary`, `--accent`, etc).
- Varrer componentes e substituir cores hardcoded (`bg-blue-500`, `text-white`) por tokens.
- Padronizar botões: 1 sistema de variantes (`default`, `outline`, `ghost`, `destructive`, `premium`) — remover variações ad-hoc.
- Espaçamento e tipografia consistentes (escala única).
- Estados (loading, empty, error) padronizados via componente `<StateView />`.

## Fase 4 — PDF e relatórios (revisão final)
- Testar geração de PDF de item, processo e cesta com dados reais.
- Validar margens (24mm), quebra de linha de textos longos, tabelas que não estouram.
- Otimizar prévia (carregamento mais rápido, indicador de progresso por anexo).
- Garantir que o tema escolhido aparece no cabeçalho do PDF.
- QA visual: renderizar páginas como imagem e inspecionar.

## Detalhes técnicos
- Buscas: instrumentar com `source_runs` (já existe) — adicionar dashboard admin simples mostrando taxa de sucesso por fonte últimos 7 dias.
- Temas: migração SQL + RLS por `user_id`.
- Cores: usar `oklch` no `styles.css`, sem hex em componentes.
- PDF: manter `pdf-lib` + `jspdf`, sem dependências novas.

## Ordem de entrega
1. Migração de banco (temas) — pede aprovação.
2. Auditoria de buscas (relatório do que está quebrado + correções).
3. UI de temas + padronização visual.
4. Revisão final do PDF + QA.

Confirma esse plano para eu começar pela Fase 1 (auditoria das buscas)?
