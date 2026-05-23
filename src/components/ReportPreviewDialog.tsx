/**
 * Modal de prévia + seleção de anexos para download dos relatórios em PDF.
 *
 * Fluxo:
 *  - Recebe um ReportPlan (já construído pelo caller).
 *  - Renderiza base PDF como blob URL no iframe.
 *  - Permite marcar/desmarcar anexos por grupo + categoria.
 *  - Re-renderiza a prévia (debounce) quando seleção muda — para refletir
 *    a página final "Fontes consultadas".
 *  - Botão "Baixar PDF" chama finalizeReportPdf (mescla anexos selecionados).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  FileText,
  Download,
  Loader2,
  FileSignature,
  FileBadge,
  FileCheck2,
  FileQuestion,
  CheckSquare,
  Square,
  AlertTriangle,
  Building2,
  ChevronDown,
  ChevronUp,
  Save,
} from "lucide-react";
import {
  finalizeReportPdf,
  downloadBlob,
  type ReportPlan,
  type ReportAttachment,
  type AttachmentCategory,
} from "@/lib/export-report-pdf";
import {
  getOrgMetadata,
  setOrgMetadata,
  type OrgMetadata,
} from "@/lib/report-org";

interface Props {
  plan: ReportPlan | null;
  onClose: () => void;
}

const CATEGORY_META: Record<
  AttachmentCategory,
  { label: string; tone: string; Icon: typeof FileText }
> = {
  contrato: {
    label: "Contrato",
    tone: "bg-success/15 text-success border-success/30",
    Icon: FileCheck2,
  },
  ata: {
    label: "Ata de Reg. de Preços",
    tone: "bg-accent/15 text-accent border-accent/30",
    Icon: FileSignature,
  },
  edital: {
    label: "Edital",
    tone: "bg-muted text-muted-foreground border-border",
    Icon: FileBadge,
  },
  outro: {
    label: "Outro",
    tone: "bg-muted text-muted-foreground border-border",
    Icon: FileQuestion,
  },
};

function humanSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function OrgField({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
      />
    </label>
  );
}

export function ReportPreviewDialog({ plan, onClose }: Props) {
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(
    () => new Set(plan?.attachments.filter((a) => a.recommended).map((a) => a.url)),
  );
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewSize, setPreviewSize] = useState<number>(0);
  const [rendering, setRendering] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ loaded: number; total: number; current?: string } | null>(
    null,
  );
  const [orgOpen, setOrgOpen] = useState(false);
  const [orgDraft, setOrgDraft] = useState<OrgMetadata>(() => getOrgMetadata());
  const [orgVersion, setOrgVersion] = useState(0); // dispara re-render da prévia
  const [filenameTick, setFilenameTick] = useState(0);
  const lastBlobRef = useRef<string | null>(null);

  // Reset selection when plan changes
  useEffect(() => {
    if (!plan) return;
    setSelectedUrls(new Set(plan.attachments.filter((a) => a.recommended).map((a) => a.url)));
  }, [plan]);

  // Render preview (debounced)
  useEffect(() => {
    if (!plan) return;
    let canceled = false;
    const t = setTimeout(async () => {
      setRendering(true);
      try {
        const bytes = await plan.renderBase(selectedUrls);
        if (canceled) return;
        const blob = new Blob([bytes as BlobPart], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current);
        lastBlobRef.current = url;
        setPreviewUrl(url);
        setPreviewSize(bytes.byteLength);
      } catch (e) {
        console.error("preview render error", e);
      } finally {
        if (!canceled) setRendering(false);
      }
    }, 200);
    return () => {
      canceled = true;
      clearTimeout(t);
    };
  }, [plan, selectedUrls, orgVersion]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (lastBlobRef.current) URL.revokeObjectURL(lastBlobRef.current);
    };
  }, []);

  // Esc / lock scroll
  useEffect(() => {
    if (!plan) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && !downloading && onClose();
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [plan, onClose, downloading]);

  const grouped = useMemo(() => {
    if (!plan) return [] as Array<{ grupo: string; items: ReportAttachment[] }>;
    const m = new Map<string, ReportAttachment[]>();
    for (const a of plan.attachments) {
      const arr = m.get(a.grupo) ?? [];
      arr.push(a);
      m.set(a.grupo, arr);
    }
    // Ordena: Contrato > Ata > Processo (edital) > outros
    const order = (g: string) =>
      g.startsWith("Contrato") ? 0 : g.startsWith("Ata") ? 1 : g === "Processo" ? 2 : 3;
    return Array.from(m.entries())
      .map(([grupo, items]) => ({ grupo, items }))
      .sort((a, b) => order(a.grupo) - order(b.grupo) || a.grupo.localeCompare(b.grupo));
  }, [plan]);

  if (!plan) return null;

  const toggle = (url: string) =>
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });

  const toggleGroup = (items: ReportAttachment[], on: boolean) =>
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      for (const it of items) {
        if (on) next.add(it.url);
        else next.delete(it.url);
      }
      return next;
    });

  const selectAll = () =>
    setSelectedUrls(new Set(plan.attachments.map((a) => a.url)));
  const selectNone = () => setSelectedUrls(new Set());
  const selectRecommended = () =>
    setSelectedUrls(new Set(plan.attachments.filter((a) => a.recommended).map((a) => a.url)));

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setProgress({ loaded: 0, total: selectedUrls.size });
    try {
      const blob = await finalizeReportPdf(plan, selectedUrls, (p) => setProgress(p));
      const name = plan.getFilename?.() ?? plan.filename;
      downloadBlob(blob, name);
    } catch (e) {
      alert("Falha ao gerar PDF: " + (e as Error).message);
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  const selectedCount = selectedUrls.size;
  const totalCount = plan.attachments.length;
  const displayFilename = plan.getFilename?.() ?? plan.filename;
  void filenameTick; // forçar leitura para typecheck após save

  const saveOrg = () => {
    setOrgMetadata(orgDraft);
    setOrgVersion((v) => v + 1);
    setFilenameTick((v) => v + 1);
  };

  const orgFilled =
    !!(orgDraft.orgName || orgDraft.orgShort) &&
    !!orgDraft.cnpj &&
    !!orgDraft.processoNumero;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => !downloading && onClose()}
      />
      <div className="relative w-full h-full sm:h-[92vh] sm:max-w-7xl bg-card border border-border sm:rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-5 py-3 border-b border-border bg-card flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-8 w-8 rounded-md bg-primary/10 text-primary inline-flex items-center justify-center shrink-0">
              <FileText className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate">Prévia do relatório</div>
              <div className="text-[11px] text-muted-foreground truncate font-mono">
                {displayFilename}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={downloading}
            aria-label="Fechar"
            className="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-secondary disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_360px]">
          {/* Iframe preview */}
          <div className="relative bg-secondary/40 border-r border-border min-h-0">
            {rendering && (
              <div className="absolute top-3 right-3 z-10 inline-flex items-center gap-2 rounded-md bg-card border border-border px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm">
                <Loader2 className="h-3 w-3 animate-spin" /> Atualizando prévia…
              </div>
            )}
            {previewUrl ? (
              <iframe
                title="Prévia do relatório"
                src={previewUrl}
                className="w-full h-full bg-white"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Gerando prévia…
              </div>
            )}
          </div>

          {/* Sidebar de anexos */}
          <aside className="flex flex-col min-h-0 bg-card">
            {/* Identificação do órgão / processo */}
            <div className="border-b border-border shrink-0">
              <button
                onClick={() => setOrgOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 px-4 py-2.5 hover:bg-secondary/40 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="text-xs font-semibold uppercase tracking-wider">
                    Identificação do órgão
                  </span>
                  {!orgFilled && (
                    <span className="text-[9px] uppercase tracking-wider bg-warning/15 text-warning rounded px-1.5 py-0.5">
                      preencher
                    </span>
                  )}
                  {orgFilled && (
                    <span className="text-[9px] uppercase tracking-wider bg-success/15 text-success rounded px-1.5 py-0.5">
                      ok
                    </span>
                  )}
                </div>
                {orgOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {orgOpen && (
                <div className="px-4 pb-3 space-y-2">
                  <OrgField
                    label="Órgão / Razão social"
                    placeholder="Ex.: PREFEITURA MUNICIPAL DE ITAREMA"
                    value={orgDraft.orgName}
                    onChange={(v) => setOrgDraft((d) => ({ ...d, orgName: v }))}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <OrgField
                      label="Sigla / curta"
                      placeholder="ITAREMA-CE"
                      value={orgDraft.orgShort}
                      onChange={(v) => setOrgDraft((d) => ({ ...d, orgShort: v }))}
                    />
                    <OrgField
                      label="CNPJ"
                      placeholder="00.000.000/0000-00"
                      value={orgDraft.cnpj}
                      onChange={(v) => setOrgDraft((d) => ({ ...d, cnpj: v }))}
                    />
                  </div>
                  <OrgField
                    label="Endereço (rodapé)"
                    placeholder="Praça ..., Centro, Cidade-UF, CEP ..."
                    value={orgDraft.endereco}
                    onChange={(v) => setOrgDraft((d) => ({ ...d, endereco: v }))}
                  />
                  <OrgField
                    label="Nº do processo"
                    placeholder="Ex.: DISP 11/2026"
                    value={orgDraft.processoNumero}
                    onChange={(v) => setOrgDraft((d) => ({ ...d, processoNumero: v }))}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <OrgField
                      label="Responsável"
                      placeholder="Nome completo"
                      value={orgDraft.responsavel}
                      onChange={(v) => setOrgDraft((d) => ({ ...d, responsavel: v }))}
                    />
                    <OrgField
                      label="Cargo"
                      placeholder="Pregoeiro(a)"
                      value={orgDraft.cargo}
                      onChange={(v) => setOrgDraft((d) => ({ ...d, cargo: v }))}
                    />
                  </div>
                  <button
                    onClick={saveOrg}
                    className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-primary/10 text-primary border border-primary/30 px-3 py-1.5 text-xs font-semibold hover:bg-primary/15"
                  >
                    <Save className="h-3 w-3" />
                    Salvar e atualizar prévia
                  </button>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Os dados ficam salvos neste navegador e são reaproveitados em todos os
                    próximos relatórios.
                  </p>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-b border-border shrink-0">
              <div className="flex items-center justify-between mb-1">
                <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Anexos do relatório
                </div>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {selectedCount}/{totalCount} selecionados
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Anexos marcados serão <span className="font-medium text-foreground">mesclados ao PDF</span> e
                listados na página final de fontes.
              </p>
              <div className="mt-2 flex items-center gap-1 flex-wrap">
                <button
                  onClick={selectRecommended}
                  className="text-[10px] uppercase tracking-wider rounded-md border border-border bg-card px-2 py-1 hover:bg-secondary"
                  title="Apenas Atas e Contratos (recomendado p/ relatórios juridicamente eficientes)"
                >
                  Recomendados
                </button>
                <button
                  onClick={selectAll}
                  className="text-[10px] uppercase tracking-wider rounded-md border border-border bg-card px-2 py-1 hover:bg-secondary"
                >
                  Marcar todos
                </button>
                <button
                  onClick={selectNone}
                  className="text-[10px] uppercase tracking-wider rounded-md border border-border bg-card px-2 py-1 hover:bg-secondary"
                >
                  Desmarcar todos
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {grouped.length === 0 && (
                <div className="text-xs text-muted-foreground py-6 text-center border border-dashed border-border rounded-lg">
                  Sem anexos oficiais disponíveis para este processo.
                </div>
              )}
              {grouped.map(({ grupo, items }) => {
                const allOn = items.every((it) => selectedUrls.has(it.url));
                const anyOn = items.some((it) => selectedUrls.has(it.url));
                return (
                  <section key={grupo} className="rounded-lg border border-border overflow-hidden">
                    <header className="flex items-center justify-between gap-2 px-3 py-2 bg-secondary/40">
                      <div className="text-xs font-semibold truncate">{grupo}</div>
                      <button
                        onClick={() => toggleGroup(items, !allOn)}
                        className="text-[10px] uppercase tracking-wider rounded-md border border-border bg-card px-1.5 py-0.5 hover:bg-card/80"
                      >
                        {allOn ? "Desmarcar grupo" : anyOn ? "Marcar todos" : "Marcar todos"}
                      </button>
                    </header>
                    <ul className="divide-y divide-border/60">
                      {items.map((a) => {
                        const on = selectedUrls.has(a.url);
                        const meta = CATEGORY_META[a.category];
                        const Icon = meta.Icon;
                        return (
                          <li key={a.id}>
                            <button
                              onClick={() => toggle(a.url)}
                              className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors ${
                                on ? "bg-primary/5 hover:bg-primary/10" : "hover:bg-secondary/60"
                              }`}
                            >
                              <div className="mt-0.5 shrink-0 text-primary">
                                {on ? (
                                  <CheckSquare className="h-4 w-4" />
                                ) : (
                                  <Square className="h-4 w-4 text-muted-foreground" />
                                )}
                              </div>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5 mb-0.5">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider ${meta.tone}`}
                                  >
                                    <Icon className="h-2.5 w-2.5" />
                                    {meta.label}
                                  </span>
                                  {a.recommended && (
                                    <span className="inline-flex items-center rounded bg-gold/15 text-gold px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                                      ★ recomendado
                                    </span>
                                  )}
                                </div>
                                <div className="text-[12px] font-medium leading-snug line-clamp-2">
                                  {a.titulo}
                                </div>
                                <div className="text-[10px] text-muted-foreground truncate mt-0.5">
                                  {a.tipo}
                                </div>
                              </div>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })}

              {grouped.length > 0 && (
                <div className="text-[11px] text-muted-foreground rounded-md border border-border/60 bg-secondary/30 p-2.5 flex gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-gold shrink-0 mt-0.5" />
                  <span>
                    O edital costuma ser extenso. Atas e contratos já comprovam o valor homologado
                    com menos páginas — por isso ficam marcados por padrão.
                  </span>
                </div>
              )}
            </div>

            {/* Footer: ação principal */}
            <div className="border-t border-border px-4 py-3 bg-secondary/30 shrink-0 space-y-2">
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Prévia: ~{humanSize(previewSize)} (sem anexos baixados)</span>
              </div>
              {downloading && progress && (
                <div className="text-[11px] text-muted-foreground">
                  Baixando anexos {progress.loaded}/{progress.total}
                  {progress.current ? ` · ${progress.current.slice(0, 36)}` : ""}
                  <div className="mt-1 h-1 rounded bg-border overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{
                        width: `${progress.total ? (progress.loaded / progress.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
              )}
              <button
                onClick={handleDownload}
                disabled={downloading || rendering}
                className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-60 transition-smooth"
              >
                {downloading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Gerando PDF final…
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    Baixar PDF ({selectedCount} {selectedCount === 1 ? "anexo" : "anexos"})
                  </>
                )}
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}