import type { BotSummary } from "../contract";
import { cn } from "../lib/utils";

export function BotBadge({
  bot,
  fallback,
  className,
}: {
  bot: BotSummary | null;
  fallback?: string | null;
  className?: string;
}) {
  if (bot) {
    return (
      <span
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-foreground",
          className,
        )}
        title={bot.role ? `${bot.name} — ${bot.role}` : bot.name}
      >
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: bot.color ?? "var(--primary)" }}
        />
        <span className="truncate">{bot.name}</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 font-mono text-[11px] text-muted-foreground",
        className,
      )}
    >
      <span className="truncate">{fallback || "Thread"}</span>
    </span>
  );
}
