import { Link } from "@tanstack/react-router";
import { Scale, Search } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle";

export function SiteHeader() {
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
          <Link to="/buscar" className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth" activeProps={{ className: "text-foreground" }}>Pesquisar</Link>
          <Link to="/sobre" className="px-3 py-1.5 rounded-md hover:text-foreground transition-smooth" activeProps={{ className: "text-foreground" }}>Sobre</Link>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            to="/buscar"
            className="hidden sm:inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-smooth hover:opacity-90"
          >
            <Search className="h-3.5 w-3.5" />
            Nova pesquisa
          </Link>
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}