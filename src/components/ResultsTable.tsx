import { useState, Fragment } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Highlighter,
  Bookmark,
  Wrench,
  Database,
} from "lucide-react";
import type { PriceResult } from "@/lib/types";
import { buildHighlightUrl } from "@/lib/highlight-source";
import { CorrectionDialog } from "@/components/CorrectionDialog";

function brl(v?: number | null) {
  if (typeof v !== "number") return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}
function fmtDate(d?: string) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d.slice(0, 10);
  return new Intl.DateTimeFormat("pt-BR").format(dt);
}
function fmtQty(q?: number | null) {
  if (typeof q !== "number") return "—";
  return new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 3 }).format(q);
}

interface Props {
  items: PriceResult[];
  onOpen: (item: PriceResult) => void;
  onSave?: (item: PriceResult) => void;
  savedIds?: Set<string>;
  onAddToBasket?: (item: PriceResult) => void;
  basketIds?: Set<string>;
  query?: string;
}

export function ResultsTable({
  items,
  onOpen,
  onSave,
  savedIds,
  onAddToBasket,
  basketIds,
  query = "",
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const correctingItem = items.find((i) => i.id === correctingId) ?? null;

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="bg-secondary/30 hover:bg-secondary/30">
              <TableHead className="w-8"></TableHead>
              <TableHead className="min-w-[280px]">Item</TableHead>
              <TableHead className="w-20">Un.</TableHead>
              <TableHead className="w-24 text-right">Qtd</TableHead>
              <TableHead className="w-32 text-right">Unitário</TableHead>
              <TableHead className="w-32 text-right">Total</TableHead>
              <TableHead className="min-w-[180px]">Órgão / UF</TableHead>
              <TableHead className="w-28">Data</TableHead>
              <TableHead className="min-w-[180px]">Fornecedor</TableHead>
              <TableHead className="w-20 text-right">Compat.</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => {
              const isOpen = expanded.has(item.id);
              const isSaved = savedIds?.has(item.id) ?? false;
              const inBasket = basketIds?.has(item.id) ?? false;
              const titulo = item.objetoEstruturado || item.titulo;
              const localLabel = [item.municipio, item.uf].filter(Boolean).join("/");
              const highlightUrl = item.url
                ? buildHighlightUrl(item.url, item.sourceExcerpt ?? item.descricao)
                : null;
              return (
                <Fragment key={item.id}>
                  <TableRow
                    className="cursor-pointer align-top"
                    onClick={() => toggle(item.id)}
                  >
                    <TableCell className="pt-3">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium">
                      <div className="line-clamp-2 leading-snug" title={titulo}>
                        {titulo}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[9px] uppercase font-medium">
                          {item.origem}
                        </Badge>
                        {item.fromLocalDb && (
                          <Badge variant="secondary" className="text-[9px] uppercase gap-1" title="Resultado recuperado do banco de dados do sistema">
                            <Database className="h-3 w-3" /> Banco
                          </Badge>
                        )}
                        {item.documento && item.documento !== "outro" && (
                          <Badge variant="secondary" className="text-[9px] uppercase">
                            {item.documento}
                          </Badge>
                        )}
                        {item.homologado && (
                          <Badge className="text-[9px] uppercase bg-gold/15 text-gold border-gold/30 hover:bg-gold/20">
                            Homologado
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="uppercase text-xs">{item.unidade || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {fmtQty(item.quantidade)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm font-medium">
                      {item.valorTipo === "global" ? (
                        <span className="text-muted-foreground line-through decoration-destructive/60">
                          {brl(item.valor)}
                        </span>
                      ) : (
                        brl(item.valor)
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-sm">
                      {brl(item.valorTotal ?? item.valorTotalCalculado)}
                    </TableCell>
                    <TableCell className="text-xs">
                      <div className="line-clamp-2" title={item.orgao}>
                        {item.orgao || "—"}
                      </div>
                      {localLabel && (
                        <div className="text-muted-foreground mt-0.5">{localLabel}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{fmtDate(item.data)}</TableCell>
                    <TableCell className="text-xs">
                      <div className="line-clamp-2" title={item.fornecedor}>
                        {item.fornecedor || "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="text-sm font-bold text-accent tabular-nums">
                        {Math.round(item.scoreFinal * 100)}%
                      </span>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {onSave && (
                        <button
                          onClick={() => onSave(item)}
                          aria-label="Salvar"
                          className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-border ${
                            isSaved ? "bg-accent text-accent-foreground" : "hover:bg-secondary"
                          }`}
                        >
                          <Bookmark className="h-3.5 w-3.5" fill={isSaved ? "currentColor" : "none"} />
                        </button>
                      )}
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableCell colSpan={11} className="p-5">
                        <div className="grid md:grid-cols-[1fr_auto] gap-4">
                          <div className="min-w-0">
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
                              Trecho-fonte
                            </div>
                            <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap break-words">
                              {item.sourceExcerpt || item.descricao || "Sem trecho disponível."}
                            </p>
                            {item.modalidade && (
                              <div className="mt-3 text-xs text-muted-foreground">
                                Modalidade: <span className="text-foreground">{item.modalidade}</span>
                              </div>
                            )}
                          </div>
                          <div className="flex md:flex-col flex-row gap-2 md:w-56 shrink-0">
                            <button
                              onClick={() => onOpen(item)}
                              className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90 transition-smooth"
                            >
                              Ver detalhes
                            </button>
                            {onAddToBasket && (
                              <button
                                onClick={() => onAddToBasket(item)}
                                className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition-smooth ${
                                  inBasket
                                    ? "border-accent bg-accent/15 text-accent"
                                    : "border-border bg-card hover:bg-secondary"
                                }`}
                              >
                                {inBasket ? "✓ Na cotação" : "Adicionar à cotação"}
                              </button>
                            )}
                            {item.url && (
                              <a
                                href={item.url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs hover:bg-secondary transition-smooth"
                              >
                                <ExternalLink className="h-3.5 w-3.5" /> Abrir fonte
                              </a>
                            )}
                            {highlightUrl && (
                              <a
                                href={highlightUrl}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex items-center justify-center gap-1.5 rounded-md border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-gold hover:bg-gold/20 transition-smooth"
                              >
                                <Highlighter className="h-3.5 w-3.5" /> Ver com destaque
                              </a>
                            )}
                            <button
                              onClick={() => setCorrectingId(item.id)}
                              className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground transition-smooth"
                              title="Ensinar a IA: aponte o erro de extração"
                            >
                              <Wrench className="h-3.5 w-3.5" /> Corrigir extração
                            </button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {correctingItem && (
        <CorrectionDialog
          open={!!correctingId}
          onOpenChange={(v) => !v && setCorrectingId(null)}
          item={correctingItem}
          query={query}
        />
      )}
    </div>
  );
}