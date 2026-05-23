# Relatórios PDF por item / por processo (Lei 14.133)

## Decisões técnicas importantes

**Screenshot da página do edital.** O runtime é Cloudflare Workers — `puppeteer`/`playwright`/`sharp` não rodam. Em vez de tentar abrir um navegador headless, vou gerar um **"Espelho do Edital"** dentro do PDF: uma página renderizada com a marca PNCP/portal de origem, contendo todos os dados oficiais (órgão, CNPJ, modalidade, número, data, objeto completo, situação) **buscados ao vivo na API JSON do PNCP** (`/api/consulta/v1/contratacoes/publicacao` + `/itens` + `/arquivos`). Isso é juridicamente mais defensável que um print: o conteúdo é o oficial, com URL canônica e QR Code apontando para o original. Em rodapé: "Este espelho reproduz os dados oficiais da fonte indicada — consulte o link/QR Code para o original."

Se você realmente precisar do print visual, isso requer um serviço externo (ex: ScreenshotAPI, Browserless) pago e fora do escopo do Workers. Posso adicionar depois como segundo passo se confirmar.

**Fontes que não são PNCP** (TCE-CE, M2A, Transparência) não têm API de detalhe estruturada. Para esses, o "Espelho" usa apenas os dados que já foram extraídos (`PriceResult`) + link canônico.

## Entregáveis

### 1. Server function `buildProcessDossier` (`src/lib/report.functions.ts`)
Entrada: `{ origem, url, cnpj?, ano?, sequencial? }`. Saída (DTO serializável):
- `processo`: órgão, CNPJ, modalidade, número, ano, data publicação, data abertura, objeto completo, situação, valor estimado total
- `itens[]`: todos os itens do processo (do PNCP `/itens`) com qtd, unidade, valor estimado e homologado, fornecedor (se houver `/resultados`)
- `arquivos[]`: lista de documentos oficiais (edital, ata, homologação, contrato) — endpoint `/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos`, com URL pública pra cada um
- `urlCanonica`: link pra página pública do edital no PNCP

### 2. Geradores PDF (`src/lib/export-report-pdf.ts`)
Duas funções públicas:

- `exportItemReportPdf(item, dossier?)` — relatório de **1 item** específico
- `exportProcessReportPdf(dossier, items)` — relatório de **todos os itens do processo**

Layout (A4 retrato, margens 40pt, quebra automática):

```text
┌────────────────────────────────────────────────┐
│ RELATÓRIO TÉCNICO DE PESQUISA DE PREÇOS        │
│ Lei 14.133/2021 · IN SEGES/ME 65/2021          │
│ Emitido em DD/MM/AAAA HH:MM                    │
├────────────────────────────────────────────────┤
│ ESPELHO DO EDITAL — FONTE: PNCP                │
│ Órgão · CNPJ · Modalidade · Nº · Ano           │
│ Data publicação · Situação                     │
│ Objeto: [texto completo, wrapping]             │
│ URL: https://pncp.gov.br/...    [QR Code]      │
├────────────────────────────────────────────────┤
│ ITENS                                           │
│ Tabela: #, descrição, un., qtd, v. unit.       │
│ estimado, v. unit. homologado, fornecedor      │
│ — autoTable com quebra de página automática    │
├────────────────────────────────────────────────┤
│ DOCUMENTOS OFICIAIS DA FONTE                   │
│ • Edital — link                                │
│ • Ata de realização — link                     │
│ • Termo de homologação — link                  │
│ • Contrato — link                              │
├────────────────────────────────────────────────┤
│ FUNDAMENTAÇÃO LEGAL                            │
│ Texto curto: art. 23 §1º incisos I-V da Lei    │
│ 14.133/2021 — preferência por preços de        │
│ contratações similares de outros entes         │
│ públicos no PNCP (inciso I).                   │
├────────────────────────────────────────────────┤
│ Rodapé: paginação · gerado por Petrus IA       │
└────────────────────────────────────────────────┘
```

Para o **QR Code** vou adicionar `qrcode` (10KB, pure JS, roda em browser).

### 3. UI

- **`ResultCard`**: novo menu compacto com dois itens — "Relatório deste item (PDF)" e "Relatório do processo completo (PDF)". Mostra spinner enquanto busca o dossier.
- **`ResultModal`**: mesmos dois botões, mais proeminentes.
- **`cotacao.tsx`** (cesta): substituo o PDF atual pelo novo gerador, agora com seção "Espelho do edital" por item agrupado por processo + lista de documentos oficiais por processo.

### 4. Arquivos novos / alterados

- novo: `src/lib/report.functions.ts` (server fn `buildProcessDossier`)
- novo: `src/lib/export-report-pdf.ts`
- alterado: `src/components/ResultCard.tsx`, `src/components/ResultModal.tsx`, `src/routes/cotacao.tsx`
- novo dep: `qrcode` + `@types/qrcode`

### 5. QA

Após gerar, vou disparar uma exportação de teste contra um PNCP real, converter o PDF pra imagem com `pdftoppm` e inspecionar margens, quebras e dados. Itero até passar.

## Posso seguir?

Confirme dois pontos:

1. **Espelho do edital com dados oficiais (sem print real)** — OK ou você quer mesmo um print visual via serviço pago?
2. **Cesta**: substituir o PDF atual pelo novo formato enriquecido, ou manter o atual e adicionar um botão extra "Relatório completo"?
