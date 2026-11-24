import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import {
  rpcContract,
  type InboxMessage,
  type ReplyInput,
} from "../contract";
import {
  optimisticResolveInboxItem,
  useInboxStore,
} from "../lib/inbox-store";
import {
  WAIT_WARNING_AFTER_MS,
  formatAgo,
  lead,
  previewUrl,
  tagOf,
} from "../lib/inbox-questions";
import {
  readStoredSelection,
  writeStoredSelection,
  type InboxSelection,
} from "../lib/inbox-storage";
import { cn } from "../lib/utils";
import { AnswerCard } from "./inbox-answer-card";
import { BotBadge } from "./inbox-bot-badge";
import { Button } from "./ui/button";

const AMBER = "text-amber-700 dark:text-amber-300";

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-border/80 bg-muted/60 px-1 font-mono text-[10px] leading-none text-muted-foreground">
      {children}
    </kbd>
  );
}

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function selectMessage(
  messages: readonly InboxMessage[],
  selection: InboxSelection,
): InboxMessage | undefined {
  if (!messages.length) return undefined;
  if (!selection) return messages[0];
  return (
    messages.find((m) => m.id === selection.id) ??
    messages.find(
      (m) =>
        m.createdAt > selection.at ||
        (m.createdAt === selection.at && m.id > selection.id),
    ) ??
    messages[messages.length - 1]
  );
}

function ZeroState({
  resolvedToday,
  now,
  onOpenThread,
}: {
  resolvedToday: readonly InboxMessage[];
  now: number;
  onOpenThread: (threadId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-border/70 bg-muted/40 text-muted-foreground">
        <Icon name="Inbox" className="size-5" />
      </div>
      <h2 className="mt-4 text-base font-semibold text-foreground">
        Nothing waits on you
      </h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        Unanswered questions from your bots and threads will appear here, oldest
        first.
      </p>

      {resolvedToday.length > 0 && (
        <div className="mt-8 w-full max-w-md rounded-lg border border-border/70 bg-card/50 text-left">
          <div className="border-b border-border/60 px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
            Resolved today · {resolvedToday.length}
          </div>
          <div className="divide-y divide-border/50">
            {resolvedToday.slice(0, 12).map((msg) => {
              const { title } = lead(msg.text);
              return (
                <button
                  key={msg.id}
                  type="button"
                  onClick={() => onOpenThread(msg.threadId)}
                  className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-xs transition-colors hover:bg-accent/40"
                >
                  <BotBadge
                    bot={msg.bot}
                    fallback={msg.threadTitle ?? msg.threadId}
                    className="max-w-[38%]"
                  />
                  <span className="min-w-0 flex-1 truncate text-foreground/85">
                    {title || `Message #${msg.id}`}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {msg.state === "answered" ? "answered" : "dismissed"} ·{" "}
                    {formatAgo(msg.resolvedAt ?? msg.createdAt, now)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function InboxPage({ subPath }: PluginNavPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const now = useNow(60_000);
  const { open, resolvedToday, hydrated, error, refresh } = useInboxStore();

  const [selection, setSelectionState] = useState<InboxSelection>(() =>
    readStoredSelection(),
  );
  const [queueOpen, setQueueOpen] = useState(false);
  const queueRef = useRef<HTMLDivElement | null>(null);

  const setSelection = useCallback((next: InboxSelection) => {
    setSelectionState(next);
    writeStoredSelection(next);
  }, []);

  // Support deep link /plugins/inbox/inbox/<messageId>
  useEffect(() => {
    if (!subPath) return;
    const id = Number(decodeURIComponent(subPath.split("/")[0] ?? ""));
    if (Number.isSafeInteger(id) && id > 0) {
      setSelection({ id, at: 0, open: true });
    }
  }, [subPath, setSelection]);

  const current = useMemo(
    () => selectMessage(open, selection),
    [open, selection],
  );
  const currentIndex = useMemo(
    () => (current ? open.findIndex((m) => m.id === current.id) : -1),
    [open, current],
  );

  // Advance persisted selection when current item leaves the list
  useEffect(() => {
    if (!selection || !hydrated) return;
    const exact = open.find((m) => m.id === selection.id);
    if (exact) {
      if (exact.createdAt !== selection.at) {
        setSelection({ ...selection, at: exact.createdAt });
      }
      return;
    }
    if (selection.at === 0) return;
    const next = selectMessage(open, selection);
    if (next) {
      setSelection({ id: next.id, at: next.createdAt, open: true });
    } else {
      setSelection(null);
    }
  }, [open, selection, hydrated, setSelection]);

  // Close queue popover on outside click
  useEffect(() => {
    if (!queueOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        queueRef.current &&
        event.target instanceof Node &&
        !queueRef.current.contains(event.target)
      ) {
        setQueueOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [queueOpen]);

  const handleSelect = useCallback(
    (msg: InboxMessage) => {
      setSelection({ id: msg.id, at: msg.createdAt, open: true });
      setQueueOpen(false);
    },
    [setSelection],
  );

  const handleStep = useCallback(
    (delta: number) => {
      if (!open.length || currentIndex < 0) return;
      const next = open[Math.max(0, Math.min(open.length - 1, currentIndex + delta))];
      if (next) handleSelect(next);
    },
    [currentIndex, handleSelect, open],
  );

  const handleOpenThread = useCallback(
    (threadId: string) => {
      navigate.toThread(threadId);
    },
    [navigate],
  );

  // Fast keyboard triage: j/k step through queue, Shift+O opens thread, Esc closes queue popover
  useEffect(() => {
    if (!open.length) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        (target instanceof Element &&
          target.closest('input, textarea, select, [contenteditable="true"]')) ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      if (event.key === "Escape" && queueOpen) {
        event.preventDefault();
        setQueueOpen(false);
        return;
      }
      if (!current) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        handleStep(event.key === "j" ? 1 : -1);
      } else if (event.key === "O") {
        event.preventDefault();
        handleOpenThread(current.threadId);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current, handleOpenThread, handleStep, open.length, queueOpen]);

  const handleAnswer = useCallback(
    async (messageId: number, reply: ReplyInput) => {
      optimisticResolveInboxItem(messageId, "answered");
      try {
        await rpc.call("answer_message", { messageId, ...reply });
      } finally {
        void refresh();
      }
    },
    [refresh, rpc],
  );

  const handleDismiss = useCallback(
    async (messageId: number) => {
      optimisticResolveInboxItem(messageId, "dismissed");
      try {
        await rpc.call("dismiss_message", { messageId });
      } finally {
        void refresh();
      }
    },
    [refresh, rpc],
  );

  if (!hydrated && open.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading Inbox…
      </div>
    );
  }

  if (error && open.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  if (open.length === 0 || !current) {
    return (
      <ZeroState
        resolvedToday={resolvedToday}
        now={now}
        onOpenThread={handleOpenThread}
      />
    );
  }

  const { title, body } = lead(current.text);
  const preview = previewUrl(current.text);
  const tag = tagOf(current);
  const stale = now - current.createdAt > WAIT_WARNING_AFTER_MS;

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-inbox-item={current.id}
    >
      {/* Compact top queue/switcher bar */}
      <div
        ref={queueRef}
        className="relative flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5"
      >
        {/* Prev / Counter / Next */}
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Previous item (k)"
            title="Previous (k)"
            disabled={currentIndex <= 0}
            onClick={() => handleStep(-1)}
            className="inline-flex size-6 items-center justify-center rounded border border-border/60 bg-background/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-35"
          >
            <Icon name="ChevronLeft" className="size-3.5" />
          </button>
          <span className="min-w-[3.25rem] text-center font-mono text-[11px] tabular-nums text-muted-foreground">
            <span className={cn("font-semibold", AMBER)}>{currentIndex + 1}</span>
            {" / "}
            {open.length}
          </span>
          <button
            type="button"
            aria-label="Next item (j)"
            title="Next (j)"
            disabled={currentIndex >= open.length - 1}
            onClick={() => handleStep(1)}
            className="inline-flex size-6 items-center justify-center rounded border border-border/60 bg-background/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-35"
          >
            <Icon name="ChevronRight" className="size-3.5" />
          </button>
        </div>

        {/* Compact scrollable queue pills */}
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Waiting inbox items"
        >
          {open.map((msg, idx) => {
            const isSelected = msg.id === current.id;
            const itemTitle = lead(msg.text).title || `#${msg.id}`;
            const itemStale = now - msg.createdAt > WAIT_WARNING_AFTER_MS;
            return (
              <button
                key={msg.id}
                type="button"
                role="tab"
                aria-selected={isSelected}
                data-inbox-row={msg.id}
                onClick={(event) => {
                  event.currentTarget.blur();
                  handleSelect(msg);
                }}
                className={cn(
                  "inline-flex max-w-[14rem] shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isSelected
                    ? "border-primary/40 bg-accent font-medium text-foreground"
                    : "border-transparent bg-transparent text-muted-foreground hover:border-border/60 hover:bg-accent/40 hover:text-foreground",
                )}
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 shrink-0 rounded-full"
                  style={{
                    backgroundColor: msg.bot?.color ?? "var(--primary)",
                  }}
                />
                <span className="truncate">
                  {msg.bot?.name ? `${msg.bot.name}: ` : ""}
                  {itemTitle}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-[10px] tabular-nums",
                    itemStale ? AMBER : "text-muted-foreground/75",
                  )}
                >
                  {formatAgo(msg.createdAt, now)}
                </span>
                <span className="sr-only">
                  ({idx + 1} of {open.length})
                </span>
              </button>
            );
          })}
        </div>

        {/* Expandable queue popover trigger + subtle key hints */}
        <div className="flex shrink-0 items-center gap-2">
          {open.length > 1 && (
            <button
              type="button"
              aria-expanded={queueOpen}
              aria-label="Show full queue"
              onClick={() => setQueueOpen((v) => !v)}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded border px-2 font-mono text-[10.5px] transition-colors",
                queueOpen
                  ? "border-primary/40 bg-accent text-foreground"
                  : "border-border/60 bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span>Queue</span>
              <Icon
                name={queueOpen ? "ChevronUp" : "ChevronDown"}
                className="size-3"
              />
            </button>
          )}
          <div className="hidden items-center gap-2 font-mono text-[10px] text-muted-foreground/80 lg:flex">
            <span className="flex items-center gap-0.5">
              <Kbd>j</Kbd>
              <Kbd>k</Kbd>
            </span>
            <span className="flex items-center gap-0.5">
              <Kbd>⇧↵</Kbd> send
            </span>
            <span className="flex items-center gap-0.5">
              <Kbd>⇧O</Kbd> thread
            </span>
          </div>
        </div>

        {/* Expandable queue dropdown */}
        {queueOpen && open.length > 1 && (
          <div className="absolute top-full right-3 left-3 z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-border bg-popover p-1.5 shadow-lg md:left-auto md:w-96">
            <div className="flex items-center justify-between px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              <span>
                Waiting on you · <span className={AMBER}>{open.length}</span>
              </span>
              <span className="normal-case">oldest first</span>
            </div>
            <div className="space-y-0.5">
              {open.map((msg) => {
                const isSelected = msg.id === current.id;
                const rowTitle = lead(msg.text).title || `Message #${msg.id}`;
                const gistText = msg.query?.[0]?.text;
                const more = Math.max(0, (msg.query?.length ?? 0) - 1);
                const rowStale = now - msg.createdAt > WAIT_WARNING_AFTER_MS;
                return (
                  <button
                    key={msg.id}
                    type="button"
                    onClick={() => handleSelect(msg)}
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent/50",
                      isSelected && "bg-accent/70",
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <BotBadge
                        bot={msg.bot}
                        fallback={msg.threadTitle ?? msg.projectName ?? msg.threadId}
                        className="max-w-[60%]"
                      />
                      <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        <span className="rounded border border-border/70 px-1 font-mono text-[9.5px] leading-4 text-muted-foreground">
                          {tagOf(msg)}
                        </span>
                        <time
                          className={cn(
                            "font-mono text-[10.5px] tabular-nums",
                            rowStale ? AMBER : "text-muted-foreground",
                          )}
                        >
                          {formatAgo(msg.createdAt, now)}
                        </time>
                      </span>
                    </span>
                    <span className="truncate text-xs font-medium text-foreground">
                      {rowTitle}
                    </span>
                    {gistText && (
                      <span className="truncate text-[11px] text-muted-foreground">
                        {gistText}
                        {more > 0 && (
                          <span className="font-mono text-[10px]"> +{more}</span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Main full-bleed stage: active message + decision card */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-5 pt-5 pb-12">
          <header className="flex min-w-0 flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <BotBadge
              bot={current.bot}
              fallback={current.threadTitle ?? current.threadId}
            />
            {current.bot && current.threadTitle && (
              <>
                <span>·</span>
                <span className="truncate font-sans text-xs text-muted-foreground">
                  {current.threadTitle}
                </span>
              </>
            )}
            <span className="shrink-0 rounded border border-border/70 px-1 font-mono text-[10px] leading-4 text-muted-foreground">
              {tag}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-2">
              <span className="flex items-center gap-1">
                waited
                <time
                  className={cn(
                    "shrink-0 font-mono text-[11px] tabular-nums",
                    stale && AMBER,
                  )}
                  dateTime={new Date(current.createdAt).toISOString()}
                  title={`Asked ${new Date(current.createdAt).toLocaleString()}`}
                >
                  {formatAgo(current.createdAt, now)}
                </time>
              </span>
              <button
                type="button"
                aria-label="Open thread (Shift+O)"
                title="Open thread (⇧O)"
                onClick={() => handleOpenThread(current.threadId)}
                className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Icon name="MessageSquare" className="size-3.5" />
              </button>
            </span>
          </header>

          <h2 className="mt-3 text-[18px] leading-7 font-semibold tracking-[-0.01em] text-foreground">
            {title || `Message #${current.id}`}
          </h2>

          {body && (
            <div className="mt-1.5 text-[14px] leading-6 text-foreground/90">
              <Markdown content={body} />
            </div>
          )}

          {preview && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" asChild>
                <a href={preview} target="_blank" rel="noreferrer">
                  <Icon name="ExternalLink" className="size-3.5" />
                  Open preview
                </a>
              </Button>
            </div>
          )}

          <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-card/60">
            <AnswerCard
              key={current.id}
              message={current}
              keys={true}
              className="border-t-0"
              onAnswer={(reply) => handleAnswer(current.id, reply)}
              onDismiss={() => handleDismiss(current.id)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
