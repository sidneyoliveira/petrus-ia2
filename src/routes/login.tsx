import { createFileRoute, redirect, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { SiteHeader } from "@/components/SiteHeader";
import { SiteFooter } from "@/components/SiteFooter";
import { useAuth } from "@/lib/auth";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  head: () => ({
    meta: [
      { title: "Entrar · Petrus IA" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
});

function LoginPage() {
  const auth = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  if (auth.isAuthenticated) {
    throw redirect({ to: "/cotacao" });
  }

  async function withGoogle() {
    setErr(null);
    setLoading(true);
    try {
      const r = await lovable.auth.signInWithOAuth("google", {
        redirect_uri: window.location.origin,
      });
      if (r.error) setErr(r.error.message ?? "Falha no login Google");
    } finally {
      setLoading(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setMsg(null);
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = "/cotacao";
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: `${window.location.origin}/` },
        });
        if (error) throw error;
        setMsg("Conta criada. Verifique seu e-mail para confirmar e depois entre.");
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <SiteHeader />
      <main className="flex-1 mx-auto w-full max-w-sm px-4 sm:px-6 py-12">
        <div className="rounded-xl border border-border bg-card p-6 shadow-card">
          <h1 className="text-lg font-semibold tracking-tight">
            {mode === "signin" ? "Entrar" : "Criar conta"}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Salve cestas na nuvem e acesse de qualquer lugar.
          </p>

          <button
            type="button"
            onClick={withGoogle}
            disabled={loading}
            className="mt-5 w-full inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
              <path fill="#4285F4" d="M22 12.2c0-.74-.07-1.45-.2-2.13H12v4.03h5.6c-.24 1.3-.97 2.4-2.07 3.14v2.61h3.35C20.84 18.07 22 15.4 22 12.2z"/>
              <path fill="#34A853" d="M12 22c2.8 0 5.14-.93 6.85-2.52l-3.35-2.6c-.93.62-2.12.99-3.5.99-2.69 0-4.97-1.82-5.79-4.27H2.74v2.68C4.45 19.74 7.97 22 12 22z"/>
              <path fill="#FBBC05" d="M6.21 13.6a6.01 6.01 0 010-3.82V7.1H2.74a10 10 0 000 9.8l3.47-2.7z"/>
              <path fill="#EA4335" d="M12 5.92c1.52 0 2.88.52 3.95 1.55l2.96-2.96C17.13 2.92 14.8 2 12 2 7.97 2 4.45 4.26 2.74 7.1l3.47 2.68C7.03 7.74 9.31 5.92 12 5.92z"/>
            </svg>
            Continuar com Google
          </button>

          <div className="my-4 flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <span className="h-px flex-1 bg-border" /> ou e-mail <span className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={onSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium">E-mail</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs font-medium">Senha</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete={mode === "signin" ? "current-password" : "new-password"}
                className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
            {err && <p className="text-xs text-destructive">{err}</p>}
            {msg && <p className="text-xs text-success">{msg}</p>}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {loading ? "..." : mode === "signin" ? "Entrar" : "Criar conta"}
            </button>
          </form>

          <button
            type="button"
            onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setErr(null); setMsg(null); }}
            className="mt-4 w-full text-center text-xs text-muted-foreground hover:text-foreground"
          >
            {mode === "signin" ? "Não tem conta? Criar uma" : "Já tem conta? Entrar"}
          </button>

          <div className="mt-6 text-center text-[11px] text-muted-foreground">
            <Link to="/" className="hover:text-foreground">← Voltar ao início</Link>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}