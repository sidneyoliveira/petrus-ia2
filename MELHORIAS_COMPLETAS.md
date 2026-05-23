# 🎯 Petrus IA 2 — Plano Completo de Melhorias e Modernização

**Data:** 23 de maio de 2026  
**Versão:** 1.0  
**Status:** Recomendações prioritárias para sistema em produção  

---

## 📊 Sumário Executivo

O sistema **Petrus IA** possui uma arquitetura excelente com pipeline de 8 estágios, deduplicação eficiente e validação matemática sólida. Contudo, há gaps visuais e técnicos que impedem uma experiência **"premium"**:

- **PDF gerador:** 1.235 linhas imperativas, inconsistências de formatação, bugs com acentuação
- **UI/UX:** Falta padronização visual, indicadores não são claros, responsividade precisa refinamento
- **Cestas:** Cálculos de variação não estão expostos, recalculos reativos melhoram UX
- **Performance:** Cache SWR e Cloudflare Workers precisam monitoramento de timeout
- **Acessibilidade:** Falta contexto visual para usuários de leitores de tela

Este documento apresenta **diagnóstico técnico**, **prioridades de implementação** e **passo a passo** para cada melhoria.

---

## 📍 1. REFATORAÇÃO VISUAL DO PDF ("Nota Técnica")

### 1.1 Problema Identificado: Inconsistência de Formatação

**Status Atual:**
- jsPDF + jspdf-autotable geram PDFs "funcionais" mas sem apelo visual
- Valores misturando padrões decimais: R$ 53,00 vs R$ 17.00
- Bug de acentuação em negrito (offset errático)

**Impacto Negativo:**
- Órgãos públicos rejeitam PDFs "amadores"
- Inconsistência reduz confiança no cálculo

---

### 1.2 Solução 1: Centralizar Formatação Monetária

**Arquivo:** `src/lib/export-report-pdf.ts` (já existe função `brl()`)

**Status Atual (linhas 53-56):**
```typescript
function brl(v?: number | null) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}
```

✅ **Já está correto!** A função usa `Intl.NumberFormat` com locale pt-BR.

**Ação Necessária:** Garantir que TODAS as renderizações de valores no PDF passem por `brl()`, nunca por template strings direto.

**Busca e Replace:**
```bash
# Procurar no PDF por construções como:
# "${r.valor}" ou `R$ ${...}` ou
# Valores formatados manualmente antes da chamada a jsPDF

# Padrão correto:
valor: brl(item.valor)
valorTotal: brl(item.valorTotal)
```

**Passo a Passo:**
1. Abra `src/lib/export-report-pdf.ts`
2. Localize todas as chamadas a `doc.text()`, `doc.cell()`, `autoTable()`
3. Identifique campos de valor (linhas ~150-300)
4. Certifique-se que TODOS usam `brl(valor)` antes de ir para o doc

**Teste:**
```typescript
// Teste unitário simples
import { brl, num } from "@/lib/export-report-pdf";

test("formatação de valores é consistente", () => {
  expect(brl(53)).toBe("R$ 53,00");
  expect(brl(17)).toBe("R$ 17,00");
  expect(num(1500.5)).toBe("1.500,5");
});
```

---

### 1.3 Solução 2: Eliminar Bug de Acentuação com Fontes TTF

**Problema Atual:**
- jsPDF insere espaçamento errático após acentos em negrito
- Solução atual é "monkey-patch" de offset (frágil)

**Solução Definitiva:**

**Arquivo a Criar:** `src/lib/pdf-fonts.ts`

```typescript
/**
 * Carregador de fontes TrueType para jsPDF.
 * Elimina bugs de acentuação e melhora apelo visual.
 */

import jsPDF from "jspdf";

// Font: Roboto (ou Inter/Poppins) — baixar .ttf do Google Fonts
// URL: https://fonts.google.com/download?family=Roboto

export async function loadCustomFonts(doc: jsPDF) {
  // Nota: Em produção, servir fontes TTF de CDN ou assets
  // Para MVP, usar Web Safe Fonts via @font-face do PDF
  
  // jsPDF suporta muito bem Times, Courier, Helvetica nativas
  // mas para melhor controle, use Verdana ou Arial que vêm com PDF
  
  // Se quiser fonte customizada:
  // 1. Converter TTF para base64
  // 2. Adicionar via doc.addFileToVFS()
  // 3. Usar em doc.setFont()
  
  doc.setFont("Helvetica", "normal"); // Fallback seguro
}

export function setupPdfStyles(doc: jsPDF) {
  // Cores corporativas
  doc.setTextColor(15, 23, 42); // slate-900
  doc.setFontSize(11);
  
  // Evita bug de acentuação: usar itálico ou regular, não negrito com acentos
  // Se precisar destaque, usar cor + tamanho em vez de peso de font
}
```

**Passo a Passo de Implementação:**

1. **Identificar Todos os Negrito + Acentos:**
```bash
grep -n "setFont.*bold" src/lib/export-report-pdf.ts
grep -n "\\[ãáàâäéèêëíìîïóòôõöúùûü\\]" src/lib/export-report-pdf.ts
```

2. **Substituir Padrão:**
   - ❌ Antes: `doc.setFont("Helvetica", "bold"); doc.text("Órgão X");`
   - ✅ Depois: `doc.setFont("Helvetica", "normal"); doc.setTextColor(30, 64, 175); doc.setFontSize(12); doc.text("Órgão X");`

3. **Testar Renderização:**
   - Gerar PDF com nome contendo "São Paulo", "Brasília", "Açúcar"
   - Verificar se acentos aparecem sem espaçamento

---

### 1.4 Solução 3: Modernizar Design da Tabela

**Problema:**
- AutoTable com cores "âmbar" chapadas não é amigável para impressão PB

**Arquivo:** `src/lib/export-report-pdf.ts` (~linha 200+)

**Ação:**

```typescript
// ANTES (linhas ~250):
autoTable(doc, {
  body: items.map(item => [item.titulo, brl(item.valor)]),
  // ... mais config
  didDrawPage: (data) => {
    // Colorir linhas selecionadas em âmbar (#ca8a04)
  }
});

// DEPOIS (modernizado):
autoTable(doc, {
  body: items.map((item, i) => [
    item.titulo,
    brl(item.valor),
    item.quantidade,
    item.unidade
  ]),
  styles: {
    font: "Helvetica",
    fontSize: 9,
    cellPadding: 4, // aumentar de ~2 para dar "respiro"
    halign: "left",
    valign: "middle",
    lineColor: [220, 220, 220], // cinza suave
    lineWidth: 0.2,
    textColor: [40, 40, 40]
  },
  alternateRowStyles: {
    fillColor: [243, 244, 246], // cinza MUITO suave (#F3F4F6)
    textColor: [40, 40, 40]
  },
  headStyles: {
    fillColor: [30, 64, 175], // azul corporativo
    textColor: [255, 255, 255],
    fontStyle: "normal", // sem negrito + acentos
    fontSize: 10,
    halign: "center"
  },
  columnStyles: {
    0: { halign: "left" },   // Título
    1: { halign: "right", cellWidth: 35 },   // Valor
    2: { halign: "center", cellWidth: 20 },  // Qtd
    3: { halign: "center", cellWidth: 20 }   // Un.
  }
});

// Remover cores fortes; PDF PB fica ilegível com negrito-acentos
// Usar ÍCONE no lugar de cor: ✓ para selecionado
```

**Passo a Passo:**

1. Abra `src/lib/export-report-pdf.ts` linha ~200
2. Localize todas as chamadas a `autoTable()`
3. Aumente `cellPadding` de 2 para 4
4. Mude `alternateRowStyles.fillColor` para `[243, 244, 246]`
5. Remova cores "âmbar" (`#ca8a04`)
6. Teste impressão em PB

**Teste:**
```bash
npm run build
# Gerar PDF teste, imprimir em PB, validar legibilidade
```

---

### 1.5 Solução 4: Arquitetura Futura (Roadmap)

**Opção A: React PDF Renderer (3–6 meses)**
```bash
npm install @react-pdf/renderer
```

Permite criar PDFs como componentes React:
```tsx
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

const MyPDF = () => (
  <Document>
    <Page>
      <View style={styles.container}>
        <Text>Nota Técnica</Text>
      </View>
    </Page>
  </Document>
);

export default MyPDF;
```

**Benefício:** Reutilizar componentes, estilo via StyleSheet (similar Tailwind)  
**Desafio:** Suporte limitado a fonte; performance para PDFs grandes

**Opção B: Puppeteer + HTML/Tailwind (Recomendado para 2026)**
- Manter HTML estilizado com Tailwind na memória
- Usar Puppeteer no backend para converter HTML → PDF
- Deploy em Cloudflare Workers (suporta Puppeteer via `puppeteer-core`)

```bash
npm install puppeteer-core @sparticuz/chromium
```

```typescript
// Exemplo backend (Inngest ou API route)
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

export async function generatePdfViaHeadless(htmlString: string) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: "new",
  });
  
  const page = await browser.newPage();
  await page.setContent(htmlString, { waitUntil: "networkidle0" });
  const pdf = await page.pdf({ format: "A4" });
  
  await browser.close();
  return pdf;
}
```

**Benefício:**
- PDF idêntico ao navegador (100% fidelidade visual)
- Tailwind v4 funciona nativamente
- Suporte completo a acentos, imagens, gráficos

**Quando:** Q3–Q4 2026

---

## 🎨 2. PADRONIZAÇÃO DE UI/UX (Frontend)

### 2.1 Cards vs. Listas vs. Tabelas

**Regra de Ouro:**

| Componente | Uso | Quando |
|-----------|-----|--------|
| **Tabela** | Comparação densa de dados | Busca de resultados, cotação rápida |
| **Card** | Visualização de item único | Cestas, temas, visualização acessível |
| **Lista** | Sequência com ações | Histórico, breadcrumbs |

**Arquivo Afetado:** `src/routes/buscar.tsx` e `src/routes/cotacao.tsx`

**Status Atual:**
- ✅ Buscar: Usa Cards + Tabela (toggle funciona)
- ✅ Cotação: Usa Tabela para listagem
- ⚠️ Cestas: Muito espaço em branco, sem Card visual

**Implementação: Melhorar Página `/cestas`**

**Arquivo:** `src/routes/_authenticated/cestas.tsx`

```tsx
// ANTES (layout linear):
<div className="grid gap-4">
  {baskets.map(basket => (
    <div key={basket.id} className="p-4 border rounded">
      <div>{basket.name}</div>
      <button>Carregar</button>
      <button>Deletar</button>
    </div>
  ))}
</div>

// DEPOIS (Cards com tema visual):
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {baskets.map(basket => {
    const theme = themes.find(t => t.id === basket.themeId);
    const itemCount = basket.items?.length ?? 0;
    const estimatedTotal = basket.items?.reduce((sum, item) => 
      sum + ((item.valor ?? 0) * (item.quantidade ?? 1)), 0) ?? 0;
    
    return (
      <div
        key={basket.id}
        className="group rounded-lg border border-border bg-card p-4 hover:shadow-lg transition-all cursor-pointer"
        onClick={() => loadBasket(basket.id)}
      >
        {/* Header com tema */}
        <div className="flex items-start justify-between mb-3">
          <div className="flex items-center gap-2">
            {theme?.icon && <span className="text-2xl">{theme.icon}</span>}
            <div>
              <h3 className="font-semibold text-sm truncate">{basket.name}</h3>
              <p className="text-xs text-muted-foreground">
                {new Date(basket.createdAt).toLocaleDateString("pt-BR")}
              </p>
            </div>
          </div>
          <div
            className="w-8 h-8 rounded-lg opacity-60 group-hover:opacity-100 transition-opacity"
            style={{
              backgroundColor: theme?.color ?? "#94a3b8",
            }}
          />
        </div>
        
        {/* Stats */}
        <div className="space-y-2 mb-4 pb-4 border-b border-border/40">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Itens</span>
            <span className="font-semibold">{itemCount}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Valor estimado</span>
            <span className="font-semibold text-accent">
              {brl(estimatedTotal)}
            </span>
          </div>
          
          {/* Progress bar */}
          <div className="mt-3">
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-primary to-accent transition-all"
                style={{
                  width: `${Math.min(100, (itemCount / 20) * 100)}%`
                }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">
              {itemCount} / 20 itens (meta)
            </p>
          </div>
        </div>
        
        {/* Ações */}
        <div className="flex gap-2">
          <button
            onClick={(e) => {
              e.stopPropagation();
              loadBasket(basket.id);
            }}
            className="flex-1 rounded-md bg-primary/10 text-primary text-xs font-medium py-1.5 hover:bg-primary/20 transition-colors"
          >
            Carregar
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              deleteBasket(basket.id);
            }}
            className="px-2 rounded-md border border-destructive/30 text-destructive text-xs hover:bg-destructive/10 transition-colors"
            title="Deletar"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    );
  })}
</div>
```

**Passo a Passo:**

1. Abra `src/routes/_authenticated/cestas.tsx`
2. Localize a seção de renderização de cestas (linha ~100+)
3. Substitua o layout por Grid com Cards
4. Adicione barra de progresso visual
5. Integre cor/ícone de tema
6. Teste responsividade (mobile: 1 coluna, tablet: 2, desktop: 3)

---

### 2.2 Espaçamento e Margens Consistentes

**Arquivo:** `src/styles.css` ou `tailwind.config.js`

**Status Atual:**
- Tailwind v4 está configurado
- Mas faltam constantes de espaçamento

**Implementação:**

```css
/* src/styles.css */

@layer components {
  /* Container padrão */
  .container-page {
    @apply mx-auto w-full max-w-7xl px-4 sm:px-6 py-8;
  }
  
  /* Card padrão */
  .card-base {
    @apply rounded-lg border border-border bg-card p-6 shadow-sm;
  }
  
  /* Card compacto (para listas) */
  .card-compact {
    @apply rounded-md border border-border bg-card/50 p-4;
  }
  
  /* Gap padrão entre items */
  .gap-standard {
    @apply gap-4;
  }
  
  /* Espaço vertical entre seções */
  .space-section {
    @apply space-y-6;
  }
}

/* Breakpoints customizados */
@custom-media --sm (width >= 640px);
@custom-media --md (width >= 768px);
@custom-media --lg (width >= 1024px);
```

**Aplicar em componentes:**

```tsx
// ANTES
<div className="mx-auto w-full max-w-7xl px-4 sm:px-6 py-8 space-y-6">
  <div className="rounded-lg border border-border bg-card p-6">
    ...
  </div>
</div>

// DEPOIS
<div className="container-page space-section">
  <div className="card-base">
    ...
  </div>
</div>
```

---

### 2.3 Padronização de Botões (shadcn/ui)

**Regra:**

```tsx
// Primary — apenas ação principal
<button className="bg-primary text-primary-foreground">
  Gerar Relatório Geral
</button>

// Secondary/Outline — fluxo
<button className="border border-border bg-card hover:bg-secondary">
  Adicionar à Cesta
</button>

// Destructive — DELETE/REMOVER
<button className="bg-destructive text-destructive-foreground">
  Excluir Outlier
</button>

// Ghost — links, secundário
<button className="hover:bg-secondary text-muted-foreground">
  Ver Fonte Original
</button>
```

**Criar Constants:**

**Arquivo:** `src/lib/button-variants.ts`

```typescript
export const buttonVariants = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  secondary: "border border-border bg-card hover:bg-secondary",
  destructive: "bg-destructive text-destructive-foreground hover:opacity-90",
  ghost: "text-muted-foreground hover:bg-secondary",
  outline: "border border-border hover:bg-secondary",
} as const;
```

**Aplicar:**

```tsx
import { buttonVariants } from "@/lib/button-variants";

// Usar no componente
<button className={`px-3 py-1.5 text-xs font-medium rounded-md transition-smooth ${buttonVariants.primary}`}>
  Ação Principal
</button>
```

---

## 💰 3. TRATAMENTO DE CESTAS (Cálculos e IN 65/2021)

### 3.1 Coeficiente de Variação (CV)

**Problema:**
- IN SEGES 65/2021 exige CV ≤ 25% para "cesta homogênea"
- Sistema calcula Média, Mediana, Desvio mas não expõe CV

**Implementação:**

**Arquivo:** `src/lib/basket-stats.ts` (criar)

```typescript
/**
 * Cálculos estatísticos de cesta segundo IN SEGES 65/2021
 */

export interface BasketStats {
  n: number;
  media: number;
  mediana: number;
  desvio: number;
  coeficienteVariacao: number;
  min: number;
  max: number;
  outliers: string[]; // IDs dos itens outliers removidos
  homogeneo: boolean; // CV <= 25%
  recomendacao: string;
}

export function calculateBasketStats(
  items: Array<{ id: string; valor: number }>,
  outlierThreshold = 1.5 // IQR multiplicador
): BasketStats {
  if (items.length === 0) {
    return {
      n: 0,
      media: 0,
      mediana: 0,
      desvio: 0,
      coeficienteVariacao: 0,
      min: 0,
      max: 0,
      outliers: [],
      homogeneo: true,
      recomendacao: "Cesta vazia",
    };
  }

  // 1. Remover outliers via IQR
  const valores = items.map(i => i.valor).sort((a, b) => a - b);
  const q1 = percentile(valores, 0.25);
  const q3 = percentile(valores, 0.75);
  const iqr = q3 - q1;
  const lim_inf = q1 - outlierThreshold * iqr;
  const lim_sup = q3 + outlierThreshold * iqr;

  const outlierIds = items
    .filter(i => i.valor < lim_inf || i.valor > lim_sup)
    .map(i => i.id);

  const clean = items.filter(i => !outlierIds.includes(i.id));
  const cleanValores = clean.map(i => i.valor);

  // 2. Média e Mediana
  const media = cleanValores.reduce((a, b) => a + b, 0) / cleanValores.length;
  const mediana = cleanValores[Math.floor(cleanValores.length / 2)];

  // 3. Desvio Padrão
  const variancia =
    cleanValores.reduce((s, v) => s + Math.pow(v - media, 2), 0) /
    cleanValores.length;
  const desvio = Math.sqrt(variancia);

  // 4. Coeficiente de Variação
  const cv = media !== 0 ? (desvio / media) * 100 : 0;

  // 5. Recomendação
  let recomendacao = "";
  if (cv <= 15) {
    recomendacao = "Cesta muito homogênea ✓";
  } else if (cv <= 25) {
    recomendacao = "Cesta homogênea ✓";
  } else {
    recomendacao = "⚠️ Cesta heterogênea. Considere remover discrepâncias.";
  }

  return {
    n: cleanValores.length,
    media,
    mediana,
    desvio: Number(desvio.toFixed(2)),
    coeficienteVariacao: Number(cv.toFixed(1)),
    min: cleanValores[0],
    max: cleanValores[cleanValores.length - 1],
    outliers: outlierIds,
    homogeneo: cv <= 25,
    recomendacao,
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  const weight = idx - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}
```

**Integração na Tela `/cotacao`:**

**Arquivo:** `src/routes/cotacao.tsx` (~linha 100)

```tsx
import { calculateBasketStats } from "@/lib/basket-stats";

function CotacaoPage() {
  const { items } = useBasket();
  
  // Recalcular stats quando itens mudam
  const stats = useMemo(() => {
    if (items.length === 0) return null;
    
    const values = items
      .filter(i => i.valor && typeof i.valor === "number")
      .map(i => ({ id: i.id, valor: i.valor! }));
    
    return calculateBasketStats(values);
  }, [items]);

  return (
    <div>
      {/* ... header ... */}
      
      {/* Card de Stats */}
      {stats && (
        <div className={`rounded-lg border p-4 mb-6 ${
          stats.homogeneo 
            ? "bg-success/5 border-success/30" 
            : "bg-destructive/5 border-destructive/30"
        }`}>
          <div className="flex items-start gap-4">
            <div className="flex-1 grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Itens</span>
                <div className="font-semibold text-lg">{stats.n}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Média</span>
                <div className="font-semibold text-lg text-accent">
                  {brl(stats.media)}
                </div>
              </div>
              <div>
                <span className="text-muted-foreground">Mediana</span>
                <div className="font-semibold text-lg">{brl(stats.mediana)}</div>
              </div>
              <div>
                <span className="text-muted-foreground">Desvio</span>
                <div className="font-semibold text-lg">{brl(stats.desvio)}</div>
              </div>
              <div>
                <span className="text-muted-foreground">CV</span>
                <div className={`font-semibold text-lg ${
                  stats.coeficienteVariacao <= 25
                    ? "text-success"
                    : "text-destructive"
                }`}>
                  {stats.coeficienteVariacao.toFixed(1)}%
                </div>
              </div>
            </div>
          </div>
          
          {/* Recomendação */}
          <div className="mt-4 pt-4 border-t border-border/40">
            <p className={`text-sm font-medium ${
              stats.homogeneo
                ? "text-success"
                : "text-destructive"
            }`}>
              {stats.recomendacao}
            </p>
            {stats.outliers.length > 0 && (
              <p className="text-xs text-muted-foreground mt-2">
                {stats.outliers.length} outlier(s) removido(s) do cálculo.
              </p>
            )}
          </div>
        </div>
      )}
      
      {/* ... tabela de itens ... */}
    </div>
  );
}
```

**Passo a Passo:**

1. Crie `src/lib/basket-stats.ts` com código acima
2. Importe em `src/routes/cotacao.tsx`
3. Render Card de stats acima da tabela
4. Ajuste cores de sucesso/erro
5. Teste com cesta de 5+ itens
6. Valide cálculos em planilha Excel

---

### 3.2 Recalcular Reativo (useMemo)

**Problema:**
- Quando usuário exclui outlier manualmente, a tela não atualiza stats em tempo real

**Solução:**

```tsx
// ANTES
function removeItem(id: string) {
  basket.remove(id);
  // Sem recalcular stats — precisa refresh
}

// DEPOIS
const stats = useMemo(() => {
  // Recalcula automaticamente quando `items` muda
  if (items.length === 0) return null;
  const values = items
    .filter(i => typeof i.valor === "number")
    .map(i => ({ id: i.id, valor: i.valor! }));
  return calculateBasketStats(values);
}, [items]); // Dependência: items

function removeItem(id: string) {
  basket.remove(id);
  // React chama useMemo automaticamente → stats atualiza → UI re-renderiza
}
```

**Teste:**
1. Adicione 5 itens com preços: 100, 105, 110, 115, 1000
2. Veja CV > 25%
3. Clique em remover o item de 1000
4. Confirme que stats atualiza sem refresh

---

### 3.3 Value-Healer Validation Visual

**Problema:**
- Se `math_status` = "warn" ou "error", o item é renderizado mas sem destaque visual claro

**Arquivo:** `src/components/ResultsTable.tsx` (linha ~200)

```tsx
// ANTES
{item.mathStatus === "divergente" && (
  <Badge className="bg-destructive/15 text-destructive">
    Matemática divergente
  </Badge>
)}

// DEPOIS
export function MathStatusIndicator({
  status,
  delta,
}: {
  status?: string;
  delta?: number | null;
}) {
  if (status === "ok") {
    return (
      <div className="inline-flex items-center gap-1 rounded-md bg-success/10 text-success text-xs px-2 py-1">
        <CheckCircle2 className="h-3 w-3" />
        Matemática OK
      </div>
    );
  }
  if (status === "divergente") {
    const pct = delta ? (delta * 100).toFixed(1) : "?";
    return (
      <div className="inline-flex items-center gap-1 rounded-md bg-destructive/10 text-destructive text-xs px-2 py-1 border border-destructive/30">
        <AlertCircle className="h-3 w-3" />
        ⚠️ {pct}% divergência
      </div>
    );
  }
  return null;
}

// Usar na tabela:
<TableCell>
  <MathStatusIndicator
    status={item.mathStatus}
    delta={item.mathDeltaPct}
  />
</TableCell>
```

**Ação na Célula:**
```tsx
// Adicionar contorno vermelho na célula de valor quando há erro
<TableCell
  className={
    item.mathStatus === "divergente"
      ? "border-2 border-destructive/40 bg-destructive/5"
      : ""
  }
>
  {brl(item.valor)}
</TableCell>
```

**Passo a Passo:**

1. Abra `src/components/ResultsTable.tsx`
2. Localize renderização de math_status (linha ~150+)
3. Crie função `MathStatusIndicator`
4. Adicione contorno visual nas células com erro
5. Teste com busca que retorna itens com `mathStatus !== "ok"`

---

## ⚡ 4. PERFORMANCE E ARQUITETURA

### 4.1 Cache SWR e TTL (Validação de Invalidação)

**Arquivo:** `src/lib/db-search.functions.ts`

**Status Atual:**
- TTL de 24h na tabela `quote_searches`
- Mas não há validação se revalidação falha

**Problema:**
```
Timestamp X: Busca "cadeira" OK, cached
Timestamp X+1h: Background revalidation começa
  → Se API cair, o cache é sobrescrito com NULL
  → Usuário vê 0 resultados (pior que resultado velho!)
```

**Solução:**

```typescript
// src/lib/cache-validation.ts
export async function revalidateSearchCache(
  queryId: string,
  searchKey: string,
  onError?: (error: Error) => void
) {
  try {
    // 1. Buscar do banco o cache atual
    const cached = await db.quote_searches.findUnique({
      where: { id: queryId },
    });

    if (!cached || cached.data_expires < new Date()) {
      // Cache expirou, refazer busca
      const fresh = await performNewSearch(searchKey);
      
      // 2. Atualizar banco com dados NOVOS
      await db.quote_searches.update({
        where: { id: queryId },
        data: {
          cached_results: fresh,
          status: "ok",
          data_expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    } else {
      // Cache ainda é válido, apenas refresh timestamp
      await db.quote_searches.update({
        where: { id: queryId },
        data: {
          last_accessed: new Date(),
        },
      });
    }
  } catch (error) {
    console.error(`[Cache] Revalidation failed for ${searchKey}:`, error);
    
    // ❌ NÃO sobrescrever cache com NULL/erro
    // ✅ Apenas registrar telemetria
    await db.source_runs.create({
      data: {
        query_id: queryId,
        source: "cache_revalidation",
        status: "error",
        error_message: (error as Error).message,
        timestamp: new Date(),
      },
    });

    if (onError) onError(error as Error);
    // Cache antigo continua disponível para usuários
  }
}
```

**Passo a Passo:**

1. Crie `src/lib/cache-validation.ts`
2. Implemente lógica acima
3. Adicione telemetria em `source_runs`
4. NÃO sobrescrever cache em caso de erro
5. Monitorar via logs do Cloudflare

---

### 4.2 Cloudflare Workers e Timeout

**Arquivo:** `src/api/search.ts` (rota SSE)

**Problema:**
- Free tier Cloudflare: 10s CPU timeout
- Promise.allSettled espera todas as APIs (PNCP, Compras.gov, TCEs)
- Se uma API travar, timeout mata todo o worker

**Status Atual:**
- Arquivo menciona `useSearchStream` com SSE ✅ bom!
- Mas sem timeout/abort handling

**Implementação:**

```typescript
// src/lib/search-stream.ts
export async function* searchWithTimeout(
  query: string,
  tema?: string,
  timeoutMs = 10000 // 10s para Cloudflare
) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const sources = [
      fetchFromPNCP(query, tema, controller.signal),
      fetchFromCompras(query, tema, controller.signal),
      fetchFromTCEs(query, tema, controller.signal),
    ];

    for await (const result of Promise.allSettled(sources)) {
      yield result;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.log("[Search] Timeout — entregando resultados parciais");
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeoutId);
  }
}
```

**React Hook:**

```typescript
// src/lib/search-stream.ts (existing)
export function useSearchStream(options?: SearchOptions, key?: string) {
  const [items, setItems] = useState<PriceResult[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!options) return;

    const abortController = new AbortController();

    (async () => {
      try {
        const response = await fetch("/api/search/stream", {
          method: "POST",
          body: JSON.stringify(options),
          signal: abortController.signal,
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        while (true) {
          const { done: isDone, value } = await reader.read();
          if (isDone) break;

          const text = new TextDecoder().decode(value);
          const lines = text.split("\n");

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const json = JSON.parse(line.slice(6));
                setItems((prev) => [...prev, json]);
              } catch {
                // Ignore parse errors
              }
            }
          }
        }

        setDone(true);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setError(err as Error);
        }
      }
    })();

    return () => abortController.abort();
  }, [options?.query, key]);

  return { items, error, done };
}
```

**Passo a Passo:**

1. Abra `src/lib/search-stream.ts`
2. Adicione `AbortController` e `timeoutMs` param
3. Configure timeout = 8s (deixar margem antes do 10s do Cloudflare)
4. Teste com requisição lenta:
```bash
curl "http://localhost:5173/api/search/stream" \
  -d '{"query":"bolsa infantil"}' \
  --max-time 15 # mata depois de 15s
```
5. Confirmar que "Resultados parciais" aparecem após 8s

---

### 4.3 Monitoramento de Performance

**Arquivo:** `src/lib/telemetry.ts` (criar)

```typescript
/**
 * Coleta de métricas de performance para dashboard
 */

export interface SearchMetrics {
  queryId: string;
  query: string;
  tema?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  resultCount: number;
  sourceCount: number;
  cacheHit: boolean;
  error?: string;
  timeoutOccurred: boolean;
}

const metrics: SearchMetrics[] = [];

export function recordSearchMetric(data: SearchMetrics) {
  metrics.push(data);

  // Enviar para analytics (Sentry, Datadog, etc.)
  if (typeof window !== "undefined" && window.__TELEMETRY__) {
    window.__TELEMETRY__.track("search_completed", {
      ...data,
      durationMs: data.endTime ? data.endTime - data.startTime : 0,
    });
  }
}

export function getMetricsSnapshot() {
  const last24h = metrics.filter(
    (m) => Date.now() - m.startTime < 24 * 60 * 60 * 1000
  );

  return {
    totalSearches: last24h.length,
    avgDuration: last24h.reduce((s, m) => s + (m.durationMs ?? 0), 0) / last24h.length,
    cacheHitRate: last24h.filter((m) => m.cacheHit).length / last24h.length,
    timeoutRate: last24h.filter((m) => m.timeoutOccurred).length / last24h.length,
    totalResults: last24h.reduce((s, m) => s + m.resultCount, 0),
  };
}
```

**Integração:**

```tsx
// src/routes/buscar.tsx
import { recordSearchMetric } from "@/lib/telemetry";

const startTime = Date.now();

stream = useSearchStream(options, key);

useEffect(() => {
  if (stream.done) {
    recordSearchMetric({
      queryId: `search_${Date.now()}`,
      query: q,
      tema,
      startTime,
      endTime: Date.now(),
      resultCount: stream.items.length,
      sourceCount: stream.finalSources?.length ?? 0,
      cacheHit: stream.fromCache ?? false,
      timeoutOccurred: false, // ou true se AbortError
    });
  }
}, [stream.done]);
```

---

## 🔍 5. TESTES E VALIDAÇÃO

### 5.1 Teste de Mudança Rápida

**Cenário:** Apague "bolsa infantil" e digite "cadeira" repetidas vezes

**O que testar:**

1. **Abort de requisições:**
```typescript
// Cada nova busca deve abortar a anterior
// Verificar DevTools → Network que XHRs antigos ficam "canceled"
```

2. **Renderização:**
```tsx
// Ao mudar termo, limpar `items` antigo imediatamente
useEffect(() => {
  if (q !== previousQuery.current) {
    setItems([]; // Limpar antes de buscar
    previousQuery.current = q;
  }
}, [q]);
```

3. **Teste Manual:**
```bash
# Terminal 1: npm run dev
# Terminal 2: Abrir DevTools → Network
# Fazer 5 buscas rápidas (cadeira, mesa, armário, cama, estante)
# Confirmar que resultados NÃO ficam misturados
```

---

### 5.2 Teste de Responsividade

**Arquivo:** Nenhum — só testes manuais

**Mobile (375px — iPhone SE):**
- [ ] Tabela tem `overflow-x-auto` (scroll horizontal)
- [ ] Cards exibem em 1 coluna
- [ ] Botões de ação não ficam sobrepostos

```tsx
// No componente de tabela:
<div className="overflow-x-auto">
  <Table>...</Table>
</div>

// No grid de cards:
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {items.map(...)}
</div>
```

**Teste:**
```bash
# Chrome DevTools → F12 → Ctrl+Shift+M (toggle device toolbar)
# Arrastar para 375px, 768px, 1024px, 1440px
# Validar layout em cada breakpoint
```

---

### 5.3 Teste do Value-Healer

**Cenário:** Busque algo genérico ("papel", "lápis") que retorna itens com `mathStatus != "ok"`

**Validação:**

1. **Visual de Alerta:**
   - Célula de valor deve ter border vermelho
   - Badge "Matemática divergente" visível

2. **Tooltip:**
   - Passar mouse sobre a célula mostra: "Qtd × Unitário = R$ X, mas Total é R$ Y"

3. **Ação Possível:**
   - Usuário pode clicar em botão "Revisar extração" que abre um modal

```tsx
<TableCell
  className={`relative ${
    item.mathStatus === "divergente"
      ? "border-2 border-destructive/40"
      : ""
  }`}
  title={
    item.mathStatus === "divergente"
      ? `Qtd ${item.quantidade} × Unitário ${brl(item.valor)} = ${brl(item.quantidade ? item.valor * item.quantidade : 0)}, mas Total declarado é ${brl(item.valorTotal)}`
      : undefined
  }
>
  {brl(item.valor)}
</TableCell>
```

---

## 📋 PLANO DE IMPLEMENTAÇÃO (Roadmap)

### **Fase 1: MVP (Semana 1–2) — Correções Críticas**

| Tarefa | Arquivo(s) | Tempo | Prioridade |
|--------|-----------|------|-----------|
| Centralizar formatação BRL | export-report-pdf.ts | 30min | 🔴 CRÍTICA |
| Remover bug de acentuação (negrito) | export-report-pdf.ts | 1h | 🔴 CRÍTICA |
| Tabela PDF com padding maior | export-report-pdf.ts | 30min | 🟡 ALTA |
| Card visual em Cestas | cestas.tsx | 2h | 🟡 ALTA |
| Stats com CV | basket-stats.ts, cotacao.tsx | 2h | 🟡 ALTA |
| MathStatusIndicator | ResultsTable.tsx | 1h | 🟡 ALTA |

**Subtotal Fase 1:** ~7h

---

### **Fase 2: UX Refinement (Semana 2–3)**

| Tarefa | Arquivo(s) | Tempo | Prioridade |
|--------|-----------|------|-----------|
| Constantes CSS (gap, padding) | styles.css, tailwind.config.js | 1h | 🟢 MÉDIA |
| Button variants | button-variants.ts | 30min | 🟢 MÉDIA |
| Melhorar ResponsIvidade (mobile) | buscar.tsx, cotacao.tsx | 2h | 🟢 MÉDIA |
| Indicador visual de itens em cesta | SiteHeader, ResultCard | 1h | 🟢 MÉDIA |

**Subtotal Fase 2:** ~4.5h

---

### **Fase 3: Performance (Semana 3–4)**

| Tarefa | Arquivo(s) | Tempo | Prioridade |
|--------|-----------|------|-----------|
| Cache validation com retry | cache-validation.ts | 1.5h | 🟡 ALTA |
| Timeout handling em SSE | search-stream.ts | 1h | 🟡 ALTA |
| Telemetria de perf | telemetry.ts | 1.5h | 🟢 MÉDIA |
| Monitorar Cloudflare timeouts | (infra) | 1h | 🟢 MÉDIA |

**Subtotal Fase 3:** ~5h

---

### **Fase 4: Roadmap Futuro (Q3–Q4 2026)**

- [ ] Migração para React PDF Renderer ou Puppeteer
- [ ] Melhorias de acessibilidade (WCAG 2.1 AA)
- [ ] Dashboard de analytics (Grafana/Datadog)
- [ ] Suporte a assinatura digital de PDFs
- [ ] Cache distribuído (Redis) para multi-worker Cloudflare

---

## ✅ CHECKLIST DE VALIDAÇÃO

### Antes de Merge

- [ ] Teste unitário de formatação (BRL, CV)
- [ ] PDF gerado sem erros de acentuação
- [ ] Cards de cesta renderizam em desktop/mobile
- [ ] Stats atualizam sem refresh ao remover item
- [ ] MathStatusIndicator visível e inteligível
- [ ] Busca rápida não mistura resultados
- [ ] Timeout em 8s retorna resultados parciais
- [ ] Sem console errors em browser

### Após Deploy em Produção

- [ ] Monitorar Sentry/Datadog por erros de PDF
- [ ] Coletar feedback de usuários sobre novo layout
- [ ] Validar tempo de busca médio < 5s
- [ ] Taxa de cache hit > 70%
- [ ] Taxa de timeout < 1%

---

## 📚 Referências

- **Lei 14.133/2021:** https://www.gov.br/compras/pt-br/
- **IN SEGES 65/2021:** Normatização de pesquisas de preços
- **jsPDF Docs:** https://github.com/parallax/jsPDF
- **React PDF:** https://react-pdf.org/
- **Cloudflare Workers:** https://workers.cloudflare.com/
- **Tailwind CSS v4:** https://tailwindcss.com/blog/tailwindcss-v4

---

## 📞 Contato e Suporte

Para dúvidas sobre implementação, abra issue em `ISSUES.md` com tag `[MELHORIA]`.

---

**Documento preparado por:** GitHub Copilot  
**Última atualização:** 23 de maio de 2026  
**Status:** ✅ Pronto para implementação
