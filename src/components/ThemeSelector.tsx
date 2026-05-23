import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Tag, Check, X, Pencil, Trash2, Loader2 } from "lucide-react";
import {
  listThemes,
  createTheme,
  updateTheme,
  deleteTheme,
} from "@/lib/themes.functions";
import { useAuth } from "@/lib/auth";

const ACTIVE_THEME_KEY = "petrus.activeTheme";

export interface Theme {
  id: string;
  name: string;
  color: string;
  icon?: string | null;
}

const PALETTE = [
  "#10b981", // emerald
  "#3b82f6", // blue
  "#f59e0b", // amber
  "#ef4444", // red
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#14b8a6", // teal
  "#64748b", // slate
];

export function getActiveThemeId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ACTIVE_THEME_KEY);
  } catch {
    return null;
  }
}

export function setActiveThemeId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) localStorage.setItem(ACTIVE_THEME_KEY, id);
    else localStorage.removeItem(ACTIVE_THEME_KEY);
    window.dispatchEvent(new CustomEvent("petrus:theme:changed"));
  } catch {
    /* ignore */
  }
}

/**
 * Selector compacto de tema. Persiste seleção em localStorage e dispara evento
 * `petrus:theme:changed` para outros componentes se sincronizarem.
 */
export function ThemeSelector({
  value,
  onChange,
  allowAll = true,
  compact = false,
}: {
  value: string | null;
  onChange: (themeId: string | null) => void;
  allowAll?: boolean;
  compact?: boolean;
}) {
  const auth = useAuth();
  const qc = useQueryClient();
  const callList = useServerFn(listThemes);
  const callCreate = useServerFn(createTheme);
  const callUpdate = useServerFn(updateTheme);
  const callDelete = useServerFn(deleteTheme);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftColor, setDraftColor] = useState(PALETTE[0]);
  const [editId, setEditId] = useState<string | null>(null);

  const themesQ = useQuery({
    queryKey: ["themes"],
    queryFn: () => callList(),
    enabled: auth.isAuthenticated,
  });

  const createM = useMutation({
    mutationFn: (input: { name: string; color: string }) =>
      callCreate({ data: input }),
    onSuccess: (row) => {
      qc.invalidateQueries({ queryKey: ["themes"] });
      setDraftName("");
      setDraftColor(PALETTE[0]);
      setEditing(false);
      if (row?.id) onChange(row.id);
    },
  });

  const updateM = useMutation({
    mutationFn: (input: { id: string; name: string; color: string }) =>
      callUpdate({ data: input }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["themes"] });
      setEditId(null);
    },
  });

  const deleteM = useMutation({
    mutationFn: (id: string) => callDelete({ data: { id } }),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["themes"] });
      if (value === id) onChange(null);
    },
  });

  const themes = themesQ.data?.themes ?? [];
  const activeTheme = themes.find((t) => t.id === value) ?? null;

  if (!auth.isAuthenticated) return null;

  return (
    <div
      className={`rounded-xl border border-border bg-card ${compact ? "p-2" : "p-3"}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 pr-2 border-r border-border/60">
          <Tag className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
            Tema
          </span>
        </div>

        {allowAll && (
          <ThemeChip
            label="Todos"
            color="var(--muted-foreground)"
            active={value === null}
            onClick={() => onChange(null)}
          />
        )}

        {themes.map((t) =>
          editId === t.id ? (
            <InlineEdit
              key={t.id}
              initialName={t.name}
              initialColor={t.color}
              pending={updateM.isPending}
              onSave={(name, color) =>
                updateM.mutate({ id: t.id, name, color })
              }
              onCancel={() => setEditId(null)}
            />
          ) : (
            <div key={t.id} className="group relative">
              <ThemeChip
                label={t.name}
                color={t.color}
                active={value === t.id}
                onClick={() => onChange(t.id)}
              />
              <div className="absolute -top-1 -right-1 hidden group-hover:flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditId(t.id);
                  }}
                  className="h-4 w-4 rounded-full bg-card border border-border shadow-sm flex items-center justify-center hover:bg-secondary"
                  title="Renomear"
                >
                  <Pencil className="h-2.5 w-2.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Excluir tema "${t.name}"?`)) deleteM.mutate(t.id);
                  }}
                  className="h-4 w-4 rounded-full bg-card border border-border shadow-sm flex items-center justify-center hover:bg-destructive/10 hover:text-destructive"
                  title="Excluir"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </div>
            </div>
          ),
        )}

        {editing ? (
          <InlineEdit
            initialName={draftName}
            initialColor={draftColor}
            pending={createM.isPending}
            onSave={(name, color) => createM.mutate({ name, color })}
            onCancel={() => {
              setEditing(false);
              setDraftName("");
            }}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground transition-smooth"
          >
            <Plus className="h-3 w-3" /> Novo tema
          </button>
        )}

        {activeTheme && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            Filtrando por <strong style={{ color: activeTheme.color }}>{activeTheme.name}</strong>
          </span>
        )}
      </div>
    </div>
  );
}

function ThemeChip({
  label,
  color,
  active,
  onClick,
}: {
  label: string;
  color: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium border transition-smooth ${
        active
          ? "border-foreground/30 bg-secondary text-foreground shadow-sm"
          : "border-border bg-card text-muted-foreground hover:bg-secondary/60"
      }`}
      style={active ? { boxShadow: `inset 0 0 0 1px ${color}40` } : undefined}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
      {active && <Check className="h-3 w-3" />}
    </button>
  );
}

function InlineEdit({
  initialName,
  initialColor,
  pending,
  onSave,
  onCancel,
}: {
  initialName: string;
  initialColor: string;
  pending: boolean;
  onSave: (name: string, color: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim().length > 0) onSave(name.trim(), color);
      }}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-1 shadow-sm"
    >
      <div className="flex items-center gap-0.5">
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setColor(c)}
            className={`h-3.5 w-3.5 rounded-full transition-smooth ${
              c === color ? "ring-2 ring-offset-1 ring-offset-background ring-foreground/50" : ""
            }`}
            style={{ backgroundColor: c }}
            title={c}
          />
        ))}
      </div>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nome do tema"
        maxLength={60}
        className="w-32 bg-transparent text-[11px] outline-none placeholder:text-muted-foreground/60"
      />
      <button
        type="submit"
        disabled={pending || name.trim().length === 0}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-50"
        title="Salvar"
      >
        {pending ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Check className="h-3 w-3" />
        )}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-secondary text-muted-foreground hover:text-foreground"
        title="Cancelar"
      >
        <X className="h-3 w-3" />
      </button>
      {/* placeholder for future icon picker */}
      <Trash2 className="hidden" />
    </form>
  );
}