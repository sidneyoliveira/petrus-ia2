import { Award, Building2, Calendar, MapPin, Tag, ExternalLink, Bookmark, ThumbsUp, ThumbsDown, AlertTriangle, CheckCircle2, AlertCircle, HelpCircle, Database, FileText, FolderDown, Loader2 } from "lucide-react";
import type { PriceResult } from "@/lib/types";
import { useServerFn } from "@tanstack/react-start";
import { submitFeedback } from "@/lib/feedback.functions";
import { buildProcessDossier } from "@/lib/report.functions";
import { exportItemReportPdf, exportProcessReportPdf } from "@/lib/export-report-pdf";
import { useState } from "react";

function brl(v?: number | null) {
  if (typeof v !== "number") return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}
function valorBadge(t?: PriceResult["valorTipo"]) {
  switch (t) {
    case "unitario_homologado": return { label: "unit. homologado", tone: "bg-success/15 text-success" };
    case "unitario_estimado":   return { label: "unit. estimado",   tone: "bg-primary/10 text-primary" };
    case "global":              return { label: "TOTAL do processo", tone: "bg-destructive/15 text-destructive" };
    default:                    return { label: "valor s/ contexto", tone: "bg-muted text-muted-foreground" };
  }
}
function mathBadge(s?: PriceResult["mathStatus"], q?: PriceResult["extractionQuality"]) {
  if (!s && !q) return null;
  if (s === "ok" && q === "tríade_ok") {
    return { label: "matemática ✓", tone: "bg-success/15 text-success", Icon: CheckCircle2, title: "Qtd × Unitário = Total fecha" };
  }
  if (s === "divergente") {
    return { label: "matemática divergente", tone: "bg-destructive/15 text-destructive", Icon: AlertCircle, title: "Qtd × Unitário ≠ Total (>2%) — IA vai reprocessar" };
  }
  if (q === "só_global") {
    return { label: "só valor global", tone: "bg-destructive/15 text-destructive", Icon: AlertTriangle, title: "Sem qtd nem unitário — provavelmente valor total do processo" };
  }
  if (q === "sem_unitário" || q === "sem_qtd") {
    return { label: "tríade incompleta", tone: "bg-muted text-muted-foreground", Icon: HelpCircle, title: "Faltam dados pra fechar a matemática" };
  }
  return null;
}
function fmtDate(d?: string) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d.slice(0, 10);
  return new Intl.DateTimeFormat("pt-BR").format(dt);
}
function fmtCNPJ(c?: string) {
  if (!c) return "";
  const d = c.replace(/\D/g, "").padStart(14, "0").slice(-14);
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

interface Props {
  item: PriceResult;
  onOpen: (item: PriceResult) => void;
  onSave?: (item: PriceResult) => void;
  saved?: boolean;
  query?: string;
}

export function ResultCard({ item, onOpen, onSave, saved, query }: Props) {
  const sendFeedback = useServerFn(submitFeedback);
  const fetchDossier = useServerFn(buildProcessDossier);
  const [feedback, setFeedback] = useState<"accept" | "reject" | null>(null);
  const [sending, setSending] = useState(false);
  const [reportLoading, setReportLoading] = useState<"item" | "process" | null>(null);

  const handleReport = async (mode: "item" | "process") => {
    if (reportLoading) return;
    setReportLoading(mode);
    try {
      const dossier = await fetchDossier({
        data: {
          origem: item.origem,
          url: item.url,
          fallback: {
            orgao: item.orgao,
            modalidade: item.modalidade,
            municipio: item.municipio,
            uf: item.uf,
            dataPublicacao: item.data,
            objetoCompra: item.descricao,
          },
        },
      });
      if (mode === "item") {
        await exportItemReportPdf(item, dossier);
      } else {
        await exportProcessReportPdf(dossier);
      }
    } catch (e) {
      alert("Falha ao gerar relatório: " + (e as Error).message);
    } finally {
      setReportLoading(null);
    }
  };

  const handleFeedback = async (action: "accept" | "reject") => {
    if (feedback || sending) return;
    setSending(true);
    setFeedback(action);
    try {
      await sendFeedback({
        data: {
          query: query || item.titulo,
          itemId: item.id,
          source: item.origem,
          action,
          snapshot: {
            titulo: item.titulo,
            valor: item.valor,
            orgao: item.orgao,
          },
        },
      });
    } catch (e) {
      console.warn("feedback err", e);
      setFeedback(null);
    } finally {
      setSending(false);
    }
  };
  return (
    <article className="group relative rounded-xl border border-border bg-card hover:border-accent/40 hover:bg-card/80 transition-colors overflow-hidden">
      <div className="flex flex-col md:flex-row md:items-stretch">
        {/* Bloco principal: título + metadados */}
        <div className="flex-1 min-w-0 p-4 md:p-5">
          <div className="flex items-start justify-between gap-3 mb-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                {item.origem}
              </span>
              {item.fromLocalDb && (
                <span title="Resultado recuperado do banco de dados do sistema enquanto a busca ao vivo atualiza as fontes" className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground">
                  <Database className="h-3 w-3" /> Banco do sistema
                </span>
              )}
              {item.documento && item.documento !== "outro" && (
                <span className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-secondary-foreground">
                  {item.documento}
                </span>
              )}
              {item.homologado && (
                <span className="inline-flex items-center gap-1 rounded-md bg-gold/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gold">
                  <Award className="h-3 w-3" /> Homologado
                </span>
              )}
              {(() => {
                const m = mathBadge(item.mathStatus, item.extractionQuality);
                if (!m) return null;
                const { Icon } = m;
                return (
                  <span
                    title={m.title}
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${m.tone}`}
                  >
                    <Icon className="h-3 w-3" /> {m.label}
                  </span>
                );
              })()}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onSave?.(item); }}
              aria-label="Salvar"
              className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border ${
                saved ? "bg-accent text-accent-foreground" : "bg-background hover:bg-secondary"
              }`}
            >
              <Bookmark className="h-3.5 w-3.5" fill={saved ? "currentColor" : "none"} />
            </button>
          </div>

          <button onClick={() => onOpen(item)} className="text-left w-full">
            <h3 className="font-semibold text-base leading-snug text-balance line-clamp-2 group-hover:text-primary">
              {item.titulo}
            </h3>
          </button>
          {item.subtitulo && (
            <div className="mt-1 text-[11px] uppercase tracking-wider text-muted-foreground truncate" title={item.subtitulo}>
              {item.subtitulo}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {item.orgao && (
              <span className="inline-flex items-center gap-1.5 min-w-0 max-w-[28rem]">
                <Building2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate" title={item.orgao}>{item.orgao}</span>
              </span>
            )}
            {(item.municipio || item.uf) && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 shrink-0" />
                <span>{[item.municipio, item.uf].filter(Boolean).join(" / ")}</span>
              </span>
            )}
            {item.data && (
              <span className="inline-flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5 shrink-0" />
                <span>{fmtDate(item.data)}</span>
              </span>
            )}
            {item.modalidade && (
              <span className="inline-flex items-center gap-1.5">
                <Tag className="h-3.5 w-3.5 shrink-0" />
                <span>{item.modalidade}</span>
              </span>
            )}
            {item.unidade && (
              <span className="text-muted-foreground">Un.: <span className="text-foreground">{item.unidade}</span></span>
            )}
            {item.cnpj && (
              <span className="font-mono text-[11px]">CNPJ {fmtCNPJ(item.cnpj)}</span>
            )}
          </div>
        </div>

        {/* Bloco lateral: valor + compatibilidade + scores compactos */}
        <div className="border-t md:border-t-0 md:border-l border-border/60 bg-secondary/20 md:w-[240px] shrink-0 p-4 md:p-5 flex flex-col justify-center gap-3">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                Valor
                {item.valorTipo === "global" && (
                  <AlertTriangle className="h-3 w-3 text-destructive" />
                )}
              </div>
              <div className={`text-xl font-semibold tabular-nums ${item.valorTipo === "global" ? "text-muted-foreground line-through decoration-destructive/60" : ""}`}>
                {brl(item.valor)}
              </div>
              <div className={`mt-0.5 inline-flex rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${valorBadge(item.valorTipo).tone}`}>
                {valorBadge(item.valorTipo).label}
              </div>
              {typeof item.quantidade === "number" && (
                <div className="text-[10px] text-muted-foreground mt-0.5 tabular-nums">
                  Qtd: {item.quantidade}{item.unidade ? ` ${item.unidade}` : ""}
                </div>
              )}
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Compat.</div>
              <div className="text-xl font-bold text-accent tabular-nums">{Math.round(item.scoreFinal * 100)}%</div>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 md:px-5 py-2.5 border-t border-border/60 bg-card flex items-center justify-between">
        <button onClick={() => onOpen(item)} className="text-xs font-medium text-primary hover:underline">
          Ver detalhes
        </button>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => handleReport("item")}
            disabled={reportLoading !== null}
            title="Gerar PDF jurídico só deste item (com espelho do edital)"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] hover:bg-secondary disabled:opacity-60"
          >
            {reportLoading === "item" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileText className="h-3 w-3" />}
            PDF do item
          </button>
          <button
            onClick={() => handleReport("process")}
            disabled={reportLoading !== null}
            title="Gerar PDF jurídico do processo inteiro (todos os itens + documentos oficiais)"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] hover:bg-secondary disabled:opacity-60"
          >
            {reportLoading === "process" ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderDown className="h-3 w-3" />}
            PDF do processo
          </button>
          <button
            onClick={() => handleFeedback("accept")}
            disabled={!!feedback || sending}
            title="Marcar como útil — ajuda a IA a aprender"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-border disabled:opacity-60 ${
              feedback === "accept" ? "bg-success/15 text-success border-success/40" : "hover:bg-secondary"
            }`}
          >
            <ThumbsUp className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => handleFeedback("reject")}
            disabled={!!feedback || sending}
            title="Não compatível — IA aprende a descartar"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-border disabled:opacity-60 ${
              feedback === "reject" ? "bg-destructive/15 text-destructive border-destructive/40" : "hover:bg-secondary"
            }`}
          >
            <ThumbsDown className="h-3.5 w-3.5" />
          </button>
          {item.url && (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              Fonte <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </article>
  );
}