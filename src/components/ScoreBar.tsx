interface Props {
  label: string;
  value: number; // 0..1
  tone?: "primary" | "accent" | "gold" | "success";
}

export function ScoreBar({ label, value, tone = "primary" }: Props) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const bar =
    tone === "accent"
      ? "bg-accent"
      : tone === "gold"
        ? "bg-gold"
        : tone === "success"
          ? "bg-success"
          : "bg-primary";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{pct}%</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
        <div className={`h-full ${bar} transition-smooth`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}