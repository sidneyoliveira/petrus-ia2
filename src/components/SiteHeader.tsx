import { Link } from "@tanstack/react-router";
import { Scale, Search, ShoppingBasket, LogIn, LogOut, User as UserIcon } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";
import { useBasket } from "@/lib/basket";
import { useAuth } from "@/lib/auth";

export function SiteHeader() {
  const { items } = useBasket();
  const auth = useAuth();
  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/60 glass">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 group">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-accent-gradient shadow-elegant">
            <Scale className="h-4 w-4 text-accent-foreground" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight">CotaçãoIA</div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
              Lei 14.133 · Art. 23
            </div>
          </div>
        </Link>
        <nav className="hidden md:flex items-center gap-1 text-sm text-muted-foreground">
          <Link to="/" className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth" activeProps={{ className: "text-foreground" }}>Início</Link>
          <Link to="/buscar" search={{ q: "" }} className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth" activeProps={{ className: "text-foreground" }}>Pesquisar</Link>
          <Link to="/cotacao" className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth inline-flex items-center gap-1.5" activeProps={{ className: "text-foreground" }}>
            <ShoppingBasket className="h-3.5 w-3.5" />
            Cotação
            {items.length > 0 && (
              <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full bg-accent text-accent-foreground text-[10px] font-semibold tabular-nums">
                {items.length}
              </span>
            )}
          </Link>
          {auth.isAuthenticated && (
            <Link to="/cestas" className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth" activeProps={{ className: "text-foreground" }}>Cestas</Link>
          )}
          <Link to="/sobre" className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth" activeProps={{ className: "text-foreground" }}>Sobre</Link>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            to="/buscar"
            search={{ q: "" }}
            className="hidden sm:inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-smooth hover:opacity-90"
          >
            <Search className="h-3.5 w-3.5" />
            Nova pesquisa
          </Link>
          {auth.isAuthenticated ? (
            <div className="flex items-center gap-1">
              <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-muted-foreground px-2 max-w-[180px] truncate">
                <UserIcon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{auth.user?.email}</span>
              </span>
              <button
                type="button"
                onClick={() => auth.signOut()}
                title="Sair"
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-accent transition-smooth"
              >
                <LogOut className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Sair</span>
              </button>
            </div>
          ) : (
            <Link
              to="/login"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs hover:bg-accent transition-smooth"
              title="Entrar"
            >
              <LogIn className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Entrar</span>
            </Link>
          )}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}