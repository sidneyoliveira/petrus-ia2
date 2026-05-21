import { X, ExternalLink, Award, FileSearch, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PriceResult } from "@/lib/types";
import { ScoreBar } from "./ScoreBar";

function brl(v?: number | null) {
  if (typeof v !== "number") return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}
function fmtDate(d?: string) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d.slice(0, 10);
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(dt);
}

interface Props {
  item: PriceResult | null;
  onClose: () => void;
}

export function ResultModal({ item, onClose }: Props) {
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [ocrError, setOcrError] = useState<string | null>(null);
  const [ocrMeta, setOcrMeta] = useState<{ pages?: number; chars?: number; truncated?: boolean } | null>(null);

  useEffect(() => {
    if (!item) return;
    setOcrText(null);
    setOcrError(null);
    setOcrMeta(null);
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [item, onClose]);

  if (!item) return null;

  const runOcr = async () => {
    if (!item.url) return;
    setOcrLoading(true);
    setOcrError(null);
    setOcrText(null);
    try {
      const res = await fetch("/api/ocr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: item.url }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setOcrError(data.error || `Falha (HTTP ${res.status})`);
      } else {
        setOcrText(data.text);
        setOcrMeta({ pages: data.pages, chars: data.chars, truncated: data.truncated });
      }
    } catch (e) {
      setOcrError((e as Error).message);
    } finally {
      setOcrLoading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/60" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full sm:max-w-6xl max-h-[94vh] overflow-hidden rounded-t-2xl sm:rounded-2xl bg-card border border-border shadow-lg flex flex-col"
      >
        {/* Header compacto */}
        <div className="bg-card border-b border-border/60 px-5 py-3 flex items-start justify-between gap-3 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 mb-1">
              <span className="inline-flex items-center rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                {item.origem}
              </span>
              {item.documento && item.documento !== "outro" && (
                <span className="inline-flex items-center rounded-md bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground">
                  {item.documento}
                </span>
              )}
              {item.homologado && (
                <span className="inline-flex items-center gap-1 rounded-md bg-gold/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gold">
                  <Award className="h-3 w-3" /> Homologado
                </span>
              )}
            </div>
            <h2 className="text-sm sm:text-base font-semibold leading-snug line-clamp-2" title={item.titulo}>
              {item.titulo}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Fechar"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-secondary transition-smooth shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Conteúdo principal — 2 colunas em desktop, ocupa o resto da altura */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="grid lg:grid-cols-[1fr_300px] gap-5">
            <div className="space-y-4 min-w-0">
              {/* Stats em linha */}
              <section className="grid grid-cols-3 gap-3 rounded-xl border border-border bg-secondary/30 p-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Valor</div>
                  <div className="text-lg font-bold tabular-nums">{brl(item.valor)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Data</div>
                  <div className="text-sm font-medium">{fmtDate(item.data)}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Compat.</div>
                  <div className="text-lg font-bold text-accent tabular-nums">{Math.round(item.scoreFinal * 100)}%</div>
                </div>
              </section>

              {/* Descrição tabulada */}
              <section>
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Descrição</div>
                <p className="text-sm leading-relaxed max-h-32 overflow-auto pr-1">{item.descricao}</p>
              </section>

              {/* Campos tabulados em grid 4 col — sem scroll vertical */}
              <section className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2.5">
                <Field label="Órgão" value={item.orgao} />
                <Field label="CNPJ" value={item.cnpj} mono />
                <Field label="Unidade" value={item.unidade} />
                <Field label="Modalidade" value={item.modalidade} />
                <Field label="Situação" value={item.situacao} />
                <Field label="Município / UF" value={[item.municipio, item.uf].filter(Boolean).join(" / ")} />
                <Field label="Número" value={item.numero} />
                <Field label="Ano" value={item.ano} />
              </section>

              {/* Ações */}
              {item.url && (
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-smooth hover:opacity-90"
                  >
                    Abrir fonte original <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <button
                    onClick={runOcr}
                    disabled={ocrLoading}
                    className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3.5 py-1.5 text-xs font-medium hover:bg-secondary transition-smooth disabled:opacity-60"
                  >
                    {ocrLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSearch className="h-3.5 w-3.5" />}
                    Extrair texto do PDF
                  </button>
                </div>
              )}

              {(ocrText || ocrError || ocrLoading) && (
                <section className="rounded-xl border border-border bg-secondary/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      OCR / Extração de PDF
                    </div>
                    {ocrMeta && (
                      <div className="text-[11px] text-muted-foreground tabular-nums">
                        {ocrMeta.pages} págs · {ocrMeta.chars?.toLocaleString("pt-BR")} car.
                        {ocrMeta.truncated ? " · truncado" : ""}
                      </div>
                    )}
                  </div>
                  {ocrError && <div className="text-sm text-destructive">{ocrError}</div>}
                  {ocrLoading && !ocrText && (
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" /> Analisando documento…
                    </div>
                  )}
                  {ocrText && (
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs leading-relaxed font-mono text-foreground/90">
                      {ocrText}
                    </pre>
                  )}
                </section>
              )}
            </div>

            {/* Sidebar de scores — único bloco com scrolling vertical, evita scroll da página */}
            <aside className="space-y-3 lg:border-l lg:border-border/60 lg:pl-5">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground">Scores de compatibilidade</div>
              <div className="space-y-2.5 rounded-xl border border-border bg-secondary/30 p-3">
                <ScoreBar label="Semântico (IA)" value={item.scoreSemantico} tone="accent" />
                <ScoreBar label="Textual" value={item.scoreTextual} />
                <ScoreBar label="Jurídico" value={item.scoreJuridico} />
                <ScoreBar label="Técnico" value={item.scoreTecnico} tone="success" />
                <ScoreBar label="Geográfico" value={item.scoreGeografico} tone="gold" />
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-sm truncate ${mono ? "font-mono text-xs" : ""}`} title={value || undefined}>
        {value || "—"}
      </div>
    </div>
  );
}