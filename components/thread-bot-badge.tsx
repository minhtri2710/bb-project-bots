import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ExperimentalThreadInfoProps,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract, ThreadBotInfo } from "../contract";
import { BotIcon } from "./bot-icon";

const CHANGED = "project-bots-changed";

function useThreadBotInfo(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [info, setInfo] = useState<ThreadBotInfo | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const current = ++seq.current;
    return rpc
      .call("thread_bot_info", { threadId })
      .then((result) => {
        if (current === seq.current) setInfo(result);
      })
      .catch(() => {});
  }, [rpc, threadId]);

  useEffect(() => {
    setInfo(null);
    void refresh();
    return () => {
      seq.current++;
    };
  }, [refresh]);

  const connection = useRealtimeConnectionState();
  const prev = useRef(connection);
  useEffect(() => {
    if (connection === "connected" && prev.current !== "connected") void refresh();
    prev.current = connection;
  }, [connection, refresh]);

  useRealtime(CHANGED, () => {
    void refresh();
  });

  return info;
}

export function ThreadBotHeaderBadge({ threadId }: PluginThreadHeaderActionProps) {
  const info = useThreadBotInfo(threadId);
  if (!info?.bot) return null;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs text-foreground"
      title={`${info.bot.name} (${info.bot.kind === "unaffiliated" ? "Unaffiliated coordinator" : "Project bot"})\n${info.bot.filePath}`}
    >
      <BotIcon avatar={info.bot.avatar} size={15} />
      <span className="max-w-[140px] truncate font-medium">{info.bot.name}</span>
      {info.bot.kind === "unaffiliated" ? (
        <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">coord</span>
      ) : null}
    </span>
  );
}

export function ThreadBotInfoSection({ threadId }: ExperimentalThreadInfoProps) {
  const info = useThreadBotInfo(threadId);
  const [expanded, setExpanded] = useState(false);
  if (!info?.bot) return null;
  return (
    <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <BotIcon avatar={info.bot.avatar} size={20} />
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground">{info.bot.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              {info.bot.kind === "unaffiliated" ? "Unaffiliated coordinator" : "Project bot"} · {info.bot.id}
            </div>
          </div>
        </div>
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide prompt" : "Show prompt"}
        </button>
      </div>
      <div className="font-mono text-[10px] text-muted-foreground truncate" title={info.bot.filePath}>
        {info.bot.filePath}
      </div>
      {info.tools.length ? (
        <div className="flex flex-wrap gap-1">
          {info.tools.map((tool) => (
            <span key={tool} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {tool}
            </span>
          ))}
        </div>
      ) : null}
      {expanded ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-2 font-mono text-[10px] text-foreground border border-border/60">
          {info.instructions}
        </pre>
      ) : null}
    </div>
  );
}
