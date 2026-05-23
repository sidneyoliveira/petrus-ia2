/**
 * Constantes de variantes de botão (Petrus IA).
 *
 * Regras:
 * - primary    → única ação principal por seção (ex.: "Gerar relatório")
 * - secondary  → ações de fluxo (ex.: "Adicionar à cesta")
 * - destructive→ delete/remover/excluir
 * - outline    → ação neutra, alternativa ao secondary
 * - ghost      → links e ações terciárias
 *
 * Use junto com classes de tamanho/espaçamento do componente:
 *   <button className={`px-3 py-1.5 text-xs font-medium rounded-md transition-smooth ${buttonVariants.primary}`}>
 */
export const buttonVariants = {
  primary:
    "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50",
  secondary:
    "border border-border bg-card hover:bg-secondary text-foreground",
  destructive:
    "bg-destructive text-destructive-foreground hover:opacity-90 disabled:opacity-50",
  outline:
    "border border-border bg-transparent hover:bg-secondary text-foreground",
  ghost:
    "text-muted-foreground hover:bg-secondary hover:text-foreground",
  accent:
    "bg-accent text-accent-foreground hover:opacity-90 disabled:opacity-50",
} as const;

export type ButtonVariant = keyof typeof buttonVariants;

/** Tamanhos padrão (combine com a variante). */
export const buttonSizes = {
  xs: "px-2 py-1 text-[11px] rounded-md",
  sm: "px-3 py-1.5 text-xs rounded-md",
  md: "px-4 py-2 text-sm rounded-md",
  lg: "px-5 py-2.5 text-sm rounded-lg",
} as const;

export type ButtonSize = keyof typeof buttonSizes;

/** Helper para compor classes: btn("primary", "sm") */
export function btn(variant: ButtonVariant = "primary", size: ButtonSize = "sm") {
  return `inline-flex items-center justify-center gap-1.5 font-medium transition-smooth ${buttonSizes[size]} ${buttonVariants[variant]}`;
}