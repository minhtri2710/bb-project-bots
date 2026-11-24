import { useMemo } from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { InboxMessage, ReplyInput } from "../contract";
import { formatAgo, lead, previewUrl, WAIT_WARNING_AFTER_MS } from "../lib/inbox-questions";
import { cn } from "../lib/utils";
import { AnswerCard } from "./inbox-answer-card";
import { BotBadge } from "./inbox-bot-badge";
import { Button } from "./ui/button";

export function MessageCard({
  message,
  keys = false,
  now = Date.now(),
  onAnswer,
  onDismiss,
}: {
  message: InboxMessage;
  keys?: boolean;
  now?: number;
  onAnswer: (reply: ReplyInput) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const { title, body } = useMemo(() => lead(message.text), [message.text]);
  const preview = useMemo(() => previewUrl(message.text), [message.text]);
  const isOpen = message.state === "open";
  const isStale = isOpen && now - message.createdAt > WAIT_WARNING_AFTER_MS;

  return (
    <div
      data-inbox-message={message.id}
      className={cn(
        "my-2 overflow-hidden rounded-lg border bg-card/80 text-card-foreground shadow-xs",
        isOpen
          ? "border-amber-500/40 dark:border-amber-400/35"
          : "border-border/70",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 bg-muted/25 px-3 py-1.5 text-[11px]">
        <Icon
          name="Inbox"
          className={cn(
            "size-3.5 shrink-0",
            isOpen
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
          )}
        />
        <BotBadge bot={message.bot} fallback={message.threadTitle} />
        <span className="font-mono text-[10.5px] text-muted-foreground">
          #{message.id}
        </span>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px]",
            isOpen
              ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
              : message.state === "answered"
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-muted text-muted-foreground",
          )}
        >
          {isOpen
            ? "Waiting for decision"
            : message.state === "answered"
              ? "Answered"
              : "Dismissed"}
        </span>
        <time
          className={cn(
            "font-mono text-[10.5px] tabular-nums",
            isStale
              ? "text-amber-700 dark:text-amber-300"
              : "text-muted-foreground",
          )}
          dateTime={new Date(message.createdAt).toISOString()}
          title={new Date(message.createdAt).toLocaleString()}
        >
          {formatAgo(message.createdAt, now)}
        </time>
      </div>

      <div className="px-3.5 py-2.5">
        {title && (
          <div className="text-[14px] leading-snug font-semibold text-foreground">
            {title}
          </div>
        )}
        {body && (
          <div className="mt-1 text-[13px] leading-relaxed text-foreground/90">
            <Markdown content={body} />
          </div>
        )}
        {preview && (
          <div className="mt-2">
            <Button type="button" size="sm" variant="outline" asChild>
              <a href={preview} target="_blank" rel="noreferrer">
                <Icon name="ExternalLink" className="size-3.5" />
                Open preview
              </a>
            </Button>
          </div>
        )}
      </div>

      {isOpen ? (
        <AnswerCard
          message={message}
          keys={keys}
          onAnswer={onAnswer}
          onDismiss={onDismiss}
        />
      ) : message.state === "answered" && message.answerText ? (
        <div className="border-t border-border/60 bg-muted/20 px-3.5 py-2 text-xs text-muted-foreground">
          <div className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Your answer
          </div>
          <div className="whitespace-pre-wrap text-foreground/85">
            {message.answerText}
          </div>
        </div>
      ) : (
        <div className="border-t border-border/60 bg-muted/20 px-3.5 py-2 font-mono text-[11px] text-muted-foreground">
          Dismissed without an answer
        </div>
      )}
    </div>
  );
}
