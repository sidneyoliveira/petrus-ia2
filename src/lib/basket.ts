import { useEffect, useState, useCallback } from "react";
import type { PriceResult } from "./types";

const KEY = "petrus.basket.v1";
const ACTIVE_ID_KEY = "petrus.basket.activeId";

export interface BasketItem {
  item: PriceResult;
  /** Quantidade que o usuário quer cotar para esta linha (independente da quantidade original). */
  quantidade: number;
  /** Query/contexto em que o item foi adicionado (pra agrupar/exibir). */
  query?: string;
  addedAt: string;
}

function read(): BasketItem[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function write(items: BasketItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    window.dispatchEvent(new CustomEvent("petrus:basket:changed"));
  } catch {
    /* quota or private mode — ignore */
  }
}

export function getActiveBasketId(): string | null {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(ACTIVE_ID_KEY); } catch { return null; }
}
export function setActiveBasketId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (id) localStorage.setItem(ACTIVE_ID_KEY, id);
    else localStorage.removeItem(ACTIVE_ID_KEY);
    window.dispatchEvent(new CustomEvent("petrus:basket:changed"));
  } catch { /* ignore */ }
}

/** Substitui o conteúdo local da cesta (usado quando carrega da nuvem). */
export function replaceBasketItems(items: BasketItem[]) {
  write(items);
}

export function useBasket() {
  const [items, setItems] = useState<BasketItem[]>(() => read());

  useEffect(() => {
    const sync = () => setItems(read());
    window.addEventListener("petrus:basket:changed", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("petrus:basket:changed", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const add = useCallback((item: PriceResult, query?: string) => {
    const next = read();
    if (next.some((b) => b.item.id === item.id)) return;
    next.push({
      item,
      quantidade: typeof item.quantidade === "number" && item.quantidade > 0 ? item.quantidade : 1,
      query,
      addedAt: new Date().toISOString(),
    });
    write(next);
    setItems(next);
  }, []);

  const remove = useCallback((id: string) => {
    const next = read().filter((b) => b.item.id !== id);
    write(next);
    setItems(next);
  }, []);

  const toggle = useCallback((item: PriceResult, query?: string) => {
    const current = read();
    if (current.some((b) => b.item.id === item.id)) {
      const next = current.filter((b) => b.item.id !== item.id);
      write(next);
      setItems(next);
    } else {
      const next = [
        ...current,
        {
          item,
          quantidade: typeof item.quantidade === "number" && item.quantidade > 0 ? item.quantidade : 1,
          query,
          addedAt: new Date().toISOString(),
        },
      ];
      write(next);
      setItems(next);
    }
  }, []);

  const setQuantidade = useCallback((id: string, q: number) => {
    const next = read().map((b) =>
      b.item.id === id ? { ...b, quantidade: Math.max(0, q) } : b,
    );
    write(next);
    setItems(next);
  }, []);

  const clear = useCallback(() => {
    write([]);
    setItems([]);
  }, []);

  const ids = new Set(items.map((b) => b.item.id));

  return { items, ids, add, remove, toggle, setQuantidade, clear };
}