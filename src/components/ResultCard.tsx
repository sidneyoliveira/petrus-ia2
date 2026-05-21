import { Award, Building2, Calendar, MapPin, Tag, ExternalLink, Bookmark } from "lucide-react";
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
}

export function ResultCard({ item, onOpen, onSave, saved }: Props) {
  return (
    <article className="group relative rounded-xl border border-border bg-card shadow-card transition-smooth hover:-translate-y-0.5 hover:shadow-elegant overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
              {item.origem}
            </span>
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
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSave?.(item);
            }}
            aria-label="Salvar"
            className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-border transition-smooth ${
              saved ? "bg-accent text-accent-foreground" : "bg-background hover:bg-secondary"
            }`}
          >
            <Bookmark className="h-3.5 w-3.5" fill={saved ? "currentColor" : "none"} />
          </button>
        </div>

        <button onClick={() => onOpen(item)} className="text-left w-full">
          <h3 className="font-semibold leading-snug text-balance line-clamp-2 group-hover:text-primary transition-smooth">
            {item.titulo}
          </h3>
        </button>
        <p className="mt-1.5 text-sm text-muted-foreground line-clamp-2 leading-relaxed">
          {item.descricao}
        </p>

        <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          {item.orgao && (
            <div className="flex items-center gap-1.5 min-w-0">
              <Building2 className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" title={item.orgao}>{item.orgao}</span>
            </div>
          )}
          {(item.municipio || item.uf) && (
            <div className="flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{[item.municipio, item.uf].filter(Boolean).join(" / ")}</span>
            </div>
          )}
          {item.data && (
            <div className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 shrink-0" />
              <span>{fmtDate(item.data)}</span>
            </div>
          )}
          {item.modalidade && (
            <div className="flex items-center gap-1.5">
              <Tag className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{item.modalidade}</span>
            </div>
          )}
        </div>

        {item.cnpj && (
          <div className="mt-2 text-[11px] text-muted-foreground font-mono">
            CNPJ {fmtCNPJ(item.cnpj)}
          </div>
        )}

        <div className="mt-4 flex items-end justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Valor</div>
            <div className="text-lg font-semibold tabular-nums">{brl(item.valor)}</div>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Compatibilidade</div>
            <div className="text-lg font-bold text-accent tabular-nums">
              {Math.round(item.scoreFinal * 100)}%
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 pt-3 border-t border-border/60">
          <ScoreBar label="Semântico" value={item.scoreSemantico} tone="accent" />
          <ScoreBar label="Jurídico" value={item.scoreJuridico} tone="primary" />
          <ScoreBar label="Textual" value={item.scoreTextual} tone="primary" />
          <ScoreBar label="Técnico" value={item.scoreTecnico} tone="success" />
        </div>
      </div>

      <div className="px-5 py-3 border-t border-border/60 bg-secondary/30 flex items-center justify-between">
        <button onClick={() => onOpen(item)} className="text-xs font-medium text-primary hover:underline">
          Ver detalhes completos
        </button>
        {item.url && (
          <a
            href={item.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-smooth"
          >
            Fonte <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </article>
  );
}