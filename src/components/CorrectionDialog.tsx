import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { submitCorrection } from "@/lib/corrections.functions";
import type { PriceResult } from "@/lib/types";

type Field =
  | "valor"
  | "valor_total"
  | "quantidade"
  | "unidade"
  | "titulo"
  | "descricao"
  | "fornecedor"
  | "orgao"
  | "uf"
  | "data"
  | "outro";

const FIELD_LABELS: Record<Field, string> = {
  valor: "Valor unitário",
  valor_total: "Valor total",
  quantidade: "Quantidade",
  unidade: "Unidade de medida",
  titulo: "Título / objeto",
  descricao: "Descrição",
  fornecedor: "Fornecedor",
  orgao: "Órgão",
  uf: "UF",
  data: "Data",
  outro: "Outro campo",
};

function beforeValueFor(item: PriceResult, f: Field): string {
  switch (f) {
    case "valor": return item.valor != null ? String(item.valor) : "";
    case "valor_total": return item.valorTotal != null ? String(item.valorTotal) : "";
    case "quantidade": return item.quantidade != null ? String(item.quantidade) : "";
    case "unidade": return item.unidade ?? "";
    case "titulo": return item.objetoEstruturado || item.titulo || "";
    case "descricao": return item.descricao ?? "";
    case "fornecedor": return item.fornecedor ?? "";
    case "orgao": return item.orgao ?? "";
    case "uf": return item.uf ?? "";
    case "data": return item.data ?? "";
    default: return "";
  }
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: PriceResult;
  query: string;
}

export function CorrectionDialog({ open, onOpenChange, item, query }: Props) {
  const submit = useServerFn(submitCorrection);
  const [field, setField] = useState<Field>("valor");
  const [valueAfter, setValueAfter] = useState("");
  const [userNote, setUserNote] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "err" | "ok"; text: string } | null>(null);

  const valueBefore = beforeValueFor(item, field);

  async function handleSubmit() {
    if (!valueAfter.trim()) {
      setMsg({ kind: "err", text: "Informe o valor correto." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await submit({
        data: {
          itemId: item.id.length === 36 ? item.id : undefined,
          query,
          sourceUrl: item.url,
          field,
          valueBefore: valueBefore || undefined,
          valueAfter: valueAfter.trim(),
          sourceExcerpt: excerpt.trim() || item.sourceExcerpt || undefined,
          userNote: userNote.trim() || undefined,
        },
      });
      if (res.ok) {
        setMsg({ kind: "ok", text: "Correção registrada. Obrigado!" });
        setValueAfter("");
        setUserNote("");
        setExcerpt("");
        setTimeout(() => onOpenChange(false), 1200);
      } else {
        setMsg({ kind: "err", text: res.error || "Falha ao registrar correção." });
      }
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Corrigir extração</DialogTitle>
          <DialogDescription>
            Ensine a IA: aponte o campo que saiu errado e o valor correto. Vamos usar isso como
            exemplo nas próximas extrações da mesma fonte.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Campo</Label>
            <Select value={field} onValueChange={(v) => setField(v as Field)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(FIELD_LABELS) as Field[]).map((f) => (
                  <SelectItem key={f} value={f}>{FIELD_LABELS[f]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Valor atual (errado)</Label>
            <Input value={valueBefore} disabled placeholder="—" />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="valueAfter">Valor correto *</Label>
            <Input
              id="valueAfter"
              value={valueAfter}
              onChange={(e) => setValueAfter(e.target.value)}
              placeholder="Ex: 12,50  ou  Caixa c/ 100un"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="excerpt">Trecho-fonte onde está o valor (opcional)</Label>
            <Textarea
              id="excerpt"
              value={excerpt}
              onChange={(e) => setExcerpt(e.target.value)}
              placeholder={item.sourceExcerpt ? "Deixe vazio para reusar o trecho atual" : "Cole o trecho do PDF/HTML"}
              rows={3}
              maxLength={4000}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="note">Observação (opcional)</Label>
            <Textarea
              id="note"
              value={userNote}
              onChange={(e) => setUserNote(e.target.value)}
              placeholder="Ex: nesta fonte o valor unitário fica na coluna 4 da tabela."
              rows={2}
              maxLength={2000}
            />
          </div>
        </div>

        <DialogFooter>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-secondary"
            disabled={busy}
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={busy}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Enviando…" : "Registrar correção"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}