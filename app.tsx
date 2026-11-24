import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  experimental_Icon as Icon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_useRpcKeyedQuery,
  experimental_useSidebarNavigation,
  experimental_useSidebarThreads,
  Markdown,
  ThreadTitle,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  type ExperimentalBadge,
  type ExperimentalMessageMetadataProps,
  type PluginMessageDirectiveProps,
  type PluginSidebarThread,
  type PluginThreadActionsInlineItem,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import {
  INBOX_REALTIME_CHANNEL,
  rpcContract,
  type BotRecordDto,
  type DreamConfigDto,
  type DreamStateSummaryDto,
  type InboxMessage,
  type PluginSettingsDto,
  type ReplyInput,
  type SpecialThreadDto,
} from "./contract";
import { BotEditorDialog, type BotEditorTarget } from "./components/bot-editor-dialog";
import { DreamSettingsDialog } from "./components/dream-settings-dialog";
import { InboxPage } from "./components/inbox-page";
import { MessageCard } from "./components/inbox-message-card";
import { SidebarBotIcon } from "./components/sidebar-bot-icon";
import { SidebarConversationStatus } from "./components/sidebar-conversation-status";
import { SpecialThreadDialog, type SpecialThreadDialogTarget } from "./components/special-thread-dialog";
import { SpecialThreadBadgeIcon } from "./components/special-thread-icon";
import { ThreadBotInfoSection } from "./components/thread-bot-badge";
import { useInboxStore } from "./lib/inbox-store";
import { mostRecentRootId, sortBotRoots } from "./lib/thread-order";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Button } from "./components/ui/button";
import { TooltipProvider } from "./components/ui/tooltip";
import { usePortalScopeProps } from "./lib/portal-scope";
import { threadActionTarget } from "./lib/thread-action-target";
import "./style.css";

const CHANGED = "project-bots-changed";

function isThreadBusy(thread: PluginSidebarThread): boolean {
  return !thread.isArchived && (thread.status === "active" || thread.status === "starting" || thread.hasPendingInteraction);
}

function useSidebarState() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    projectBots: BotRecordDto[];
    unaffiliatedBots: BotRecordDto[];
    hosts: Array<{ id: string; name: string; connected: boolean }>;
    personalProjectId: string;
    threadBindings: Array<{ threadId: string; botId: string }>;
    lastViewed: Array<{ botId: string; threadId: string }>;
    lastUsedAt: Array<{ botId: string; lastUsedAt: number }>;
    pinnedBotIds: string[];
    settledBotIds: string[];
    settledThreads: Array<{ threadId: string; settledAt: number }>;
    threadOrder: Array<{ botId: string; threadIds: string[] }>;
    specialThreads: SpecialThreadDto[];
    settings: PluginSettingsDto;
    dreamConfig: DreamConfigDto;
    dreamThreadId: string | null;
    dreamStates: DreamStateSummaryDto[];
    rootDir: string;
  }>({
    projectBots: [],
    unaffiliatedBots: [],
    hosts: [],
    personalProjectId: "",
    threadBindings: [],
    lastViewed: [],
    lastUsedAt: [],
    pinnedBotIds: [],
    settledBotIds: [],
    settledThreads: [],
    threadOrder: [],
    specialThreads: [],
    settings: { autoSettle: true, autoSettleAfterHours: 72 },
    dreamConfig: { enabled: false, providerId: "", model: "", intervalMinutes: 60 },
    dreamThreadId: null,
    dreamStates: [],
    rootDir: "",
  });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const refresh = useCallback(() => {
    const current = ++seq.current;
    return rpc
      .call("sidebar_state", null)
      .then((result) => {
        if (current !== seq.current) return;
        setState(result);
        setLoaded(true);
        setError(null);
      })
      .catch((cause) => {
        if (current !== seq.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [rpc]);

  useEffect(() => {
    void refresh();
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

  return { rpc, ...state, loaded, error, refresh };
}

function ThreadTreeItem({
  thread,
  childrenByParent,
  activeThreadId,
  activeAncestors,
  showHostPill = false,
  settled = false,
  special = null,
  canReorder = false,
  isFirst = false,
  isLast = false,
  dropEdge = null,
  onDragStartThread,
  onDragOverThread,
  onDropThread,
  onDragEndThread,
  onMoveThread,
  onPromoteSpecial,
  onDemoteSpecial,
  onToggleThreadSettle,
  onSelect,
  depth = 0,
}: {
  thread: PluginSidebarThread;
  childrenByParent: Map<string, PluginSidebarThread[]>;
  activeThreadId: string | null;
  activeAncestors: Set<string>;
  showHostPill?: boolean;
  settled?: boolean;
  special?: SpecialThreadDto | null;
  canReorder?: boolean;
  isFirst?: boolean;
  isLast?: boolean;
  dropEdge?: "before" | "after" | null;
  onDragStartThread?: (threadId: string) => void;
  onDragOverThread?: (threadId: string, edge: "before" | "after") => void;
  onDropThread?: (targetThreadId: string, edge: "before" | "after") => void;
  onDragEndThread?: () => void;
  onMoveThread?: (threadId: string, direction: "top" | "up" | "down") => void;
  onPromoteSpecial?: (thread: PluginSidebarThread) => void;
  onDemoteSpecial?: (threadId: string) => void;
  onToggleThreadSettle?: (threadId: string, currentlySettled: boolean) => void;
  onSelect: (threadId: string, split: boolean) => void;
  depth?: number;
}) {
  const children = childrenByParent.get(thread.id) ?? [];
  const [expanded, setExpanded] = useState(() => activeAncestors.has(thread.id));
  const isSelected = thread.id === activeThreadId;
  const busy = isThreadBusy(thread);

  useEffect(() => {
    if (activeAncestors.has(thread.id)) setExpanded(true);
  }, [activeAncestors, thread.id]);

  const inlineActions = useMemo<PluginThreadActionsInlineItem[]>(() => {
    const items: PluginThreadActionsInlineItem[] = [];
    if (depth === 0 && onPromoteSpecial) {
      items.push({
        key: "special-promote",
        group: "0_special",
        action: {
          label: special ? "Edit Special thread…" : "Promote to Special thread…",
          detail: special ? special.name : "Inject a standing skill into sibling threads",
          icon: "Sparkles",
          run: () => onPromoteSpecial(thread),
        },
      });
    }
    if (depth === 0 && special && onDemoteSpecial) {
      items.push({
        key: "special-demote",
        group: "0_special",
        action: {
          label: "Demote from Special thread",
          icon: "X",
          variant: "destructive",
          run: () => onDemoteSpecial(thread.id),
        },
      });
    }
    if (canReorder && onMoveThread) {
      if (!isFirst) {
        items.push({
          key: "reorder-top",
          group: "1_reorder",
          action: {
            label: "Move to top",
            icon: "ArrowUp",
            run: () => onMoveThread(thread.id, "top"),
          },
        });
        items.push({
          key: "reorder-up",
          group: "1_reorder",
          action: {
            label: "Move up",
            icon: "ChevronUp",
            run: () => onMoveThread(thread.id, "up"),
          },
        });
      }
      if (!isLast) {
        items.push({
          key: "reorder-down",
          group: "1_reorder",
          action: {
            label: "Move down",
            icon: "ChevronDown",
            run: () => onMoveThread(thread.id, "down"),
          },
        });
      }
    }
    return items;
  }, [
    canReorder,
    depth,
    isFirst,
    isLast,
    onDemoteSpecial,
    onMoveThread,
    onPromoteSpecial,
    special,
    thread,
  ]);

  return (
    <li className="relative">
      {dropEdge === "before" ? (
        <div className="pointer-events-none absolute inset-x-1 top-0 z-10 h-0.5 rounded-full bg-primary" />
      ) : null}
      <ThreadActionsContextMenu
        thread={threadActionTarget(thread)}
        inline={inlineActions.length > 0 ? inlineActions : undefined}
      >
        <div
          draggable={canReorder}
          onDragStart={(e) => {
            if (!canReorder || !onDragStartThread) return;
            e.dataTransfer.effectAllowed = "move";
            e.dataTransfer.setData("text/plain", thread.id);
            onDragStartThread(thread.id);
          }}
          onDragOver={(e) => {
            if (!canReorder || !onDragOverThread) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            const rect = e.currentTarget.getBoundingClientRect();
            const edge = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
            onDragOverThread(thread.id, edge);
          }}
          onDrop={(e) => {
            if (!canReorder || !onDropThread) return;
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            const edge = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
            onDropThread(thread.id, edge);
          }}
          onDragEnd={() => onDragEndThread?.()}
          className={`pb-thread-row group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-accent/50${
            settled ? " opacity-70 hover:opacity-100" : ""
          }${special ? " pb-special-thread-row" : ""}`}
          style={{
            paddingLeft: `${depth * 14 + 8}px`,
            ...(special
              ? {
                  backgroundColor: isSelected
                    ? undefined
                    : `${special.color ?? "#f59e0b"}10`,
                }
              : undefined),
          }}
          aria-current={isSelected ? "page" : undefined}
        >
          {children.length ? (
            <button
              type="button"
              aria-label={expanded ? "Collapse child conversations" : "Expand child conversations"}
              className="flex size-4 shrink-0 items-center justify-center rounded text-[10px] text-muted-foreground hover:bg-accent"
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
            >
              {expanded ? "▾" : "▸"}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <a
            href={`#thread-${thread.id}`}
            className="flex min-w-0 flex-1 items-center gap-1.5"
            onClick={(e) => {
              e.preventDefault();
              onSelect(thread.id, e.metaKey || e.ctrlKey);
            }}
          >
            {special ? (
              <SpecialThreadBadgeIcon icon={special.icon} color={special.color} size="sm" />
            ) : (
              <span className="flex size-4 shrink-0 items-center justify-center">
                <SidebarConversationStatus thread={thread} />
              </span>
            )}
            {showHostPill && thread.host?.name ? (
              <span
                className="shrink-0 rounded bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground"
                title={`Host: ${thread.host.name}`}
              >
                {thread.host.name}
              </span>
            ) : null}
            <span
              className={`min-w-0 flex-1 truncate text-[12px] ${
                special ? "font-semibold text-foreground" : "text-foreground"
              }`}
              title={special ? `${special.name} · Special thread` : undefined}
            >
              {special ? special.name : <ThreadTitle threadId={thread.id} />}
            </span>
            {special && (busy || thread.isUnread) ? (
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                <SidebarConversationStatus thread={thread} />
              </span>
            ) : null}
          </a>
          {onToggleThreadSettle && depth === 0 && !busy && !special ? (
            <button
              type="button"
              aria-label={settled ? "Wake conversation" : "Settle conversation"}
              title={settled ? "Wake conversation" : "Settle conversation"}
              className={`shrink-0 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground ${settled ? "opacity-80" : "hidden group-hover:inline-flex focus-visible:inline-flex"}`}
              onClick={(e) => {
                e.stopPropagation();
                onToggleThreadSettle(thread.id, settled);
              }}
            >
              {settled ? "↺" : "✓"}
            </button>
          ) : null}
        </div>
      </ThreadActionsContextMenu>
      {dropEdge === "after" ? (
        <div className="pointer-events-none absolute inset-x-1 bottom-0 z-10 h-0.5 rounded-full bg-primary" />
      ) : null}
      {children.length && expanded ? (
        <ul className="space-y-0.5">
          {children.map((child) => (
            <ThreadTreeItem
              key={child.id}
              thread={child}
              childrenByParent={childrenByParent}
              activeThreadId={activeThreadId}
              activeAncestors={activeAncestors}
              showHostPill={showHostPill}
              settled={settled}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function formatRelativeProjectPath(path: string | undefined): string | null {
  if (!path) return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  // Convert /home/<user>/... or /Users/<user>/... into ~/...
  const homeRelative = trimmed.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
  return homeRelative;
}

function BotGroupRow({
  bot,
  hostName,
  pinned,
  idleVariant = 0,
  threads,
  expanded,
  onToggleExpand,
  activeThreadId,
  activeAncestors,
  lastViewedThreadId,
  settledThreadMap,
  threadOrder,
  specialThreadMap,
  settings,
  onToggleThreadSettle,
  onReorderThreads,
  onPromoteSpecial,
  onDemoteSpecial,
  onOpenBot,
  onNewChat,
  onTogglePin,
  onDreamNow,
  onEditBot,
  onDeleteBot,
  onSelectThread,
}: {
  bot: BotRecordDto;
  hostName?: string | null;
  pinned: boolean;
  idleVariant?: number;
  threads: PluginSidebarThread[];
  expanded: boolean;
  onToggleExpand: () => void;
  activeThreadId: string | null;
  activeAncestors: Set<string>;
  lastViewedThreadId: string | null;
  settledThreadMap: Map<string, number>;
  threadOrder: readonly string[];
  specialThreadMap: Map<string, SpecialThreadDto>;
  settings: PluginSettingsDto;
  onToggleThreadSettle: (threadId: string, currentlySettled: boolean) => void;
  onReorderThreads: (botId: string, threadIds: string[]) => void;
  onPromoteSpecial: (thread: PluginSidebarThread) => void;
  onDemoteSpecial: (threadId: string) => void;
  onOpenBot: () => void;
  onNewChat: () => void;
  onTogglePin: () => void;
  onDreamNow: () => void;
  onEditBot: () => void;
  onDeleteBot?: () => void;
  onSelectThread: (threadId: string, split: boolean) => void;
}) {
  const portalScope = usePortalScopeProps();
  const [showSettledThreads, setShowSettledThreads] = useState(false);
  const [dragThreadId, setDragThreadId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ threadId: string; edge: "before" | "after" } | null>(null);
  const visibleThreads = useMemo(
    () => threads.filter((t) => !t.isArchived).sort((a, b) => b.updatedAt - a.updatedAt),
    [threads],
  );
  const threadIds = useMemo(() => new Set(visibleThreads.map((t) => t.id)), [visibleThreads]);
  const specialIdsForBot = useMemo(() => {
    const set = new Set<string>();
    for (const [tid, s] of specialThreadMap) {
      if (s.botId === bot.id) set.add(tid);
    }
    return set;
  }, [specialThreadMap, bot.id]);
  const roots = useMemo(() => {
    const rawRoots = visibleThreads.filter((t) => !t.parentThreadId || !threadIds.has(t.parentThreadId));
    return sortBotRoots(rawRoots, threadOrder, specialIdsForBot);
  }, [visibleThreads, threadIds, threadOrder, specialIdsForBot]);
  const childrenByParent = useMemo(() => {
    const map = new Map<string, PluginSidebarThread[]>();
    for (const t of visibleThreads) {
      if (!t.parentThreadId || !threadIds.has(t.parentThreadId)) continue;
      const list = map.get(t.parentThreadId) ?? [];
      list.push(t);
      map.set(t.parentThreadId, list);
    }
    return map;
  }, [visibleThreads, threadIds]);

  const { activeRoots, settledRoots } = useMemo(() => {
    const active: PluginSidebarThread[] = [];
    const settledList: PluginSidebarThread[] = [];
    const settleCutoff = Date.now() - settings.autoSettleAfterHours * 3_600_000;

    const collectSubtree = (root: PluginSidebarThread): PluginSidebarThread[] => {
      const result: PluginSidebarThread[] = [root];
      const queue: PluginSidebarThread[] = [root];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const child of childrenByParent.get(cur.id) ?? []) {
          result.push(child);
          queue.push(child);
        }
      }
      return result;
    };

    const latestActivityByRoot = new Map<string, number>();
    const subtreeByRoot = new Map<string, PluginSidebarThread[]>();
    for (const root of roots) {
      const subtree = collectSubtree(root);
      subtreeByRoot.set(root.id, subtree);
      latestActivityByRoot.set(
        root.id,
        subtree.reduce((max, t) => Math.max(max, t.updatedAt, t.latestAttentionAt), 0),
      );
    }
    const newestRootId = mostRecentRootId(
      roots,
      (root) => latestActivityByRoot.get(root.id) ?? root.updatedAt,
    );

    for (const root of roots) {
      const isMostRecent = root.id === newestRootId;
      const subtree = subtreeByRoot.get(root.id) ?? [root];
      const keepActive = subtree.some(
        (t) =>
          t.id === activeThreadId ||
          isThreadBusy(t) ||
          t.isPinned ||
          t.isUnread ||
          specialThreadMap.has(t.id),
      );
      if (keepActive) {
        active.push(root);
        continue;
      }
      const latestActivity = latestActivityByRoot.get(root.id) ?? 0;
      const manualSettledAt = settledThreadMap.get(root.id);
      if (manualSettledAt !== undefined && manualSettledAt >= latestActivity) {
        settledList.push(root);
        continue;
      }
      if (!isMostRecent && settings.autoSettle && latestActivity > 0 && latestActivity < settleCutoff) {
        settledList.push(root);
      } else {
        active.push(root);
      }
    }
    return { activeRoots: active, settledRoots: settledList };
  }, [roots, childrenByParent, activeThreadId, settledThreadMap, specialThreadMap, settings]);

  const handleMoveThread = useCallback(
    (threadId: string, direction: "top" | "up" | "down") => {
      const currentIds = activeRoots.map((t) => t.id);
      const idx = currentIds.indexOf(threadId);
      if (idx === -1) return;
      const nextIds = [...currentIds];
      const [item] = nextIds.splice(idx, 1);
      if (!item) return;
      if (direction === "top") nextIds.unshift(item);
      else if (direction === "up") nextIds.splice(Math.max(0, idx - 1), 0, item);
      else nextIds.splice(Math.min(nextIds.length, idx + 1), 0, item);
      onReorderThreads(bot.id, nextIds);
    },
    [activeRoots, bot.id, onReorderThreads],
  );

  const handleDropThread = useCallback(
    (targetThreadId: string, edge: "before" | "after") => {
      const sourceId = dragThreadId;
      setDragThreadId(null);
      setDropTarget(null);
      if (!sourceId || sourceId === targetThreadId) return;
      const currentIds = activeRoots.map((t) => t.id);
      const fromIdx = currentIds.indexOf(sourceId);
      const targetIdx = currentIds.indexOf(targetThreadId);
      if (fromIdx === -1 || targetIdx === -1) return;
      const nextIds = currentIds.filter((id) => id !== sourceId);
      const insertAt = nextIds.indexOf(targetThreadId) + (edge === "after" ? 1 : 0);
      nextIds.splice(insertAt, 0, sourceId);
      onReorderThreads(bot.id, nextIds);
    },
    [activeRoots, bot.id, dragThreadId, onReorderThreads],
  );

  const busy = visibleThreads.some(isThreadBusy);
  const waiting = visibleThreads.some((t) => !t.isArchived && t.hasPendingInteraction);
  const isCurrentBot = Boolean(activeThreadId && threadIds.has(activeThreadId));
  const spansMultipleHosts = useMemo(() => {
    const hosts = new Set<string>();
    for (const t of visibleThreads) {
      const key = t.host?.id || t.host?.name;
      if (key) hosts.add(key);
      if (hosts.size > 1) return true;
    }
    return false;
  }, [visibleThreads]);

  const relPath = formatRelativeProjectPath(bot.projectPath);
  const subtitle =
    bot.kind === "unaffiliated"
      ? bot.role || "Coordinator"
      : [relPath, hostName].filter(Boolean).join(" · ") || "Project Bot";

  return (
    <div className="mb-0.5">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            className="pb-row group flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent/50"
            aria-current={isCurrentBot && !expanded ? "page" : undefined}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={onOpenBot}
              onDoubleClick={(e) => {
                e.preventDefault();
                onToggleExpand();
              }}
              title={
                bot.kind === "project"
                  ? `${bot.name}\n${bot.projectPath ?? ""}\n${bot.filePath}`
                  : `${bot.name} (${bot.role || "Coordinator"})\n${bot.filePath}`
              }
            >
              <span className="relative flex size-7 shrink-0 items-center justify-center">
                <SidebarBotIcon
                  botId={bot.id}
                  avatar={bot.avatar}
                  threads={visibleThreads}
                  idleVariant={idleVariant}
                  selected={isCurrentBot}
                />
                {waiting ? (
                  <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border border-background bg-amber-500" />
                ) : busy ? (
                  <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border border-background bg-primary animate-pulse" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-xs font-medium text-foreground">
                  <span className="truncate">{bot.name}</span>
                  {pinned ? (
                    <span className="shrink-0 text-[9px] text-muted-foreground" aria-label="Pinned" title="Pinned">
                      📌
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">{subtitle}</span>
              </span>
            </button>

            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0"
              aria-label={`New conversation with ${bot.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onNewChat();
              }}
            >
              +
            </Button>

            <button
              type="button"
              aria-label={expanded ? `Collapse ${bot.name} conversations` : `Expand ${bot.name} conversations`}
              aria-expanded={expanded}
              className="flex h-6 min-w-[26px] shrink-0 items-center justify-center gap-0.5 rounded px-1 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand();
              }}
            >
              <span>{activeRoots.length}</span>
              <span>{expanded ? "▾" : "▸"}</span>
            </button>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content {...portalScope} className="z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
            <ContextMenu.Item className="pb-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none" onSelect={onNewChat}>
              New conversation
            </ContextMenu.Item>
            {lastViewedThreadId && threadIds.has(lastViewedThreadId) ? (
              <ContextMenu.Item className="pb-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none" onSelect={() => onSelectThread(lastViewedThreadId, false)}>
                Open last conversation
              </ContextMenu.Item>
            ) : null}
            <ContextMenu.Separator className="my-1 h-px bg-border" />
            <ContextMenu.Item className="pb-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none" onSelect={onTogglePin}>
              {pinned ? "Unpin bot" : "Pin bot"}
            </ContextMenu.Item>
            <ContextMenu.Item className="pb-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none" onSelect={onDreamNow}>
              Dream now 🌙
            </ContextMenu.Item>
            <ContextMenu.Item className="pb-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs outline-none" onSelect={onEditBot}>
              Edit bot…
            </ContextMenu.Item>
            {onDeleteBot ? (
              <ContextMenu.Item className="pb-menu-item flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-xs text-destructive outline-none" onSelect={onDeleteBot}>
                Delete bot
              </ContextMenu.Item>
            ) : null}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {expanded ? (
        <div className="ml-2 border-l border-border/50 pl-1 py-0.5">
          {activeRoots.length === 0 && settledRoots.length === 0 ? (
            <div className="px-3 py-1 text-[11px] text-muted-foreground">No conversations yet.</div>
          ) : (
            <>
              {activeRoots.length > 0 ? (
                <ul className="space-y-0.5">
                  {activeRoots.map((thread, idx) => (
                    <ThreadTreeItem
                      key={thread.id}
                      thread={thread}
                      childrenByParent={childrenByParent}
                      activeThreadId={activeThreadId}
                      activeAncestors={activeAncestors}
                      showHostPill={spansMultipleHosts}
                      settled={false}
                      special={specialThreadMap.get(thread.id) ?? null}
                      canReorder={activeRoots.length > 1}
                      isFirst={idx === 0}
                      isLast={idx === activeRoots.length - 1}
                      dropEdge={dropTarget?.threadId === thread.id ? dropTarget.edge : null}
                      onDragStartThread={setDragThreadId}
                      onDragOverThread={(id, edge) => {
                        if (dragThreadId && dragThreadId !== id) {
                          setDropTarget({ threadId: id, edge });
                        }
                      }}
                      onDropThread={handleDropThread}
                      onDragEndThread={() => {
                        setDragThreadId(null);
                        setDropTarget(null);
                      }}
                      onMoveThread={handleMoveThread}
                      onPromoteSpecial={onPromoteSpecial}
                      onDemoteSpecial={onDemoteSpecial}
                      onToggleThreadSettle={onToggleThreadSettle}
                      onSelect={onSelectThread}
                    />
                  ))}
                </ul>
              ) : null}
              {settledRoots.length > 0 ? (
                <div className={activeRoots.length > 0 ? "mt-1" : ""}>
                  <button
                    type="button"
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent/40 hover:text-foreground"
                    onClick={() => setShowSettledThreads((v) => !v)}
                  >
                    <span>{settledRoots.length} settled</span>
                    <span>{showSettledThreads ? "▾" : "▸"}</span>
                  </button>
                  {showSettledThreads ? (
                    <ul className="mt-0.5 space-y-0.5">
                      {settledRoots.map((thread) => (
                        <ThreadTreeItem
                          key={thread.id}
                          thread={thread}
                          childrenByParent={childrenByParent}
                          activeThreadId={activeThreadId}
                          activeAncestors={activeAncestors}
                          showHostPill={spansMultipleHosts}
                          settled={true}
                          onToggleThreadSettle={onToggleThreadSettle}
                          onSelect={onSelectThread}
                        />
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ProjectBotsSidebar({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const sidebar = experimental_useSidebarThreads();
  const sidebarNav = experimental_useSidebarNavigation();
  const inboxStore = useInboxStore();
  const inboxNavItem = useMemo(
    () => sidebarNav.items.find((item) => item.id === "bb-project-bots/inbox") ?? null,
    [sidebarNav.items],
  );
  const unresolvedInboxCount = inboxStore.open.length;
  const navigate = useBbNavigate();
  const {
    rpc,
    projectBots,
    unaffiliatedBots,
    hosts,
    personalProjectId,
    threadBindings,
    lastViewed,
    lastUsedAt,
    pinnedBotIds,
    settledThreads,
    threadOrder,
    specialThreads,
    settings,
    dreamConfig,
    dreamThreadId,
    loaded,
    error,
    refresh,
  } = useSidebarState();

  const [expandedBots, setExpandedBots] = useState<Set<string>>(() => new Set());
  const [chatsExpanded, setChatsExpanded] = useState(false);
  const [filterQuery, setFilterQuery] = useState("");
  const [editor, setEditor] = useState<BotEditorTarget | null>(null);
  const [specialDialog, setSpecialDialog] = useState<SpecialThreadDialogTarget | null>(null);
  const [dreamSettingsOpen, setDreamSettingsOpen] = useState(false);

  // Refresh when BB's project catalog changes
  const projectCatalogKey = JSON.stringify(sidebar.projects.map((p) => [p.id, p.name, p.isPersonal]));
  const prevCatalogKey = useRef(projectCatalogKey);
  useEffect(() => {
    if (prevCatalogKey.current === projectCatalogKey) return;
    prevCatalogKey.current = projectCatalogKey;
    void refresh();
  }, [projectCatalogKey, refresh]);

  // Notify server when viewing a thread -> auto-generates the project's <hash6>.md on first thread entry!
  useEffect(() => {
    if (!activeThreadId) return;
    void rpc
      .call("conversation_viewed", { threadId: activeThreadId })
      .then((res) => {
        if (res.botId) {
          setExpandedBots((prev) => (prev.has(res.botId!) ? prev : new Set([...prev, res.botId!])));
        }
        if (res.materializedNow) void refresh();
      })
      .catch(() => {});
  }, [activeThreadId, rpc, refresh]);

  const bindingMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const b of threadBindings) map.set(b.threadId, b.botId);
    return map;
  }, [threadBindings]);

  const lastViewedMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of lastViewed) map.set(entry.botId, entry.threadId);
    return map;
  }, [lastViewed]);

  const lastUsedMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const entry of lastUsedAt) map.set(entry.botId, entry.lastUsedAt);
    return map;
  }, [lastUsedAt]);

  const pinnedSet = useMemo(() => new Set(pinnedBotIds), [pinnedBotIds]);
  const settledThreadMap = useMemo(() => new Map(settledThreads.map((t) => [t.threadId, t.settledAt])), [settledThreads]);
  const threadOrderMap = useMemo(() => new Map(threadOrder.map((entry) => [entry.botId, entry.threadIds])), [threadOrder]);
  const specialThreadMap = useMemo(() => new Map(specialThreads.map((s) => [s.threadId, s])), [specialThreads]);
  const hostNameById = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);

  const projectBotByProjectId = useMemo(() => {
    const map = new Map<string, BotRecordDto>();
    for (const bot of projectBots) {
      if (bot.projectId) map.set(bot.projectId, bot);
    }
    return map;
  }, [projectBots]);

  // Group threads into unaffiliated bots, project bots, and personal chats
  const { threadsByBot, personalChats } = useMemo(() => {
    const byBot = new Map<string, PluginSidebarThread[]>();
    const chats: PluginSidebarThread[] = [];
    const byId = new Map(sidebar.threads.map((t) => [t.id, t]));

    const resolveUnaffiliated = (thread: PluginSidebarThread): string | null => {
      const seen = new Set<string>();
      let cur: PluginSidebarThread | undefined = thread;
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        const direct = bindingMap.get(cur.id);
        if (direct) return direct;
        cur = cur.parentThreadId ? byId.get(cur.parentThreadId) : undefined;
      }
      return null;
    };

    for (const thread of sidebar.threads) {
      if (thread.isArchived) continue;
      const unaffId = resolveUnaffiliated(thread);
      if (unaffId) {
        const list = byBot.get(unaffId) ?? [];
        list.push(thread);
        byBot.set(unaffId, list);
        continue;
      }
      const projBot = projectBotByProjectId.get(thread.projectId);
      if (projBot) {
        const list = byBot.get(projBot.id) ?? [];
        list.push(thread);
        byBot.set(projBot.id, list);
        continue;
      }
      chats.push(thread);
    }
    return { threadsByBot: byBot, personalChats: chats.sort((a, b) => b.updatedAt - a.updatedAt) };
  }, [sidebar.threads, bindingMap, projectBotByProjectId]);

  // Active ancestor thread IDs so nested active conversations auto-expand their parent chain
  const activeAncestors = useMemo(() => {
    const ancestors = new Set<string>();
    if (!activeThreadId) return ancestors;
    const byId = new Map(sidebar.threads.map((t) => [t.id, t]));
    let cur = byId.get(activeThreadId)?.parentThreadId ?? null;
    while (cur && !ancestors.has(cur)) {
      ancestors.add(cur);
      cur = byId.get(cur)?.parentThreadId ?? null;
    }
    return ancestors;
  }, [activeThreadId, sidebar.threads]);

  // Auto-unfold a bot when it transitions from idle to busy/waiting
  const busyBotsKey = useMemo(
    () =>
      [...threadsByBot]
        .filter(([, list]) => list.some(isThreadBusy))
        .map(([id]) => id)
        .sort()
        .join(" "),
    [threadsByBot],
  );
  const prevBusyBots = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(busyBotsKey ? busyBotsKey.split(" ") : []);
    const started = [...next].filter((id) => !prevBusyBots.current.has(id));
    prevBusyBots.current = next;
    if (started.length) {
      setExpandedBots((prev) =>
        started.every((id) => prev.has(id)) ? prev : new Set([...prev, ...started]),
      );
    }
  }, [busyBotsKey]);

  const normalizedFilter = filterQuery.trim().toLowerCase();

  const sortBotsPinnedThenRecent = useCallback(
    (list: BotRecordDto[]) => {
      const recency = (botId: string) => {
        const stored = lastUsedMap.get(botId) ?? 0;
        const threadLatest = (threadsByBot.get(botId) ?? []).reduce(
          (max, t) => Math.max(max, t.updatedAt, t.latestAttentionAt),
          0,
        );
        return Math.max(stored, threadLatest);
      };
      return [...list].sort((a, b) => {
        const pinA = pinnedSet.has(a.id) ? 1 : 0;
        const pinB = pinnedSet.has(b.id) ? 1 : 0;
        if (pinA !== pinB) return pinB - pinA;
        const recA = recency(a.id);
        const recB = recency(b.id);
        if (recA !== recB) return recB - recA;
        return a.name.localeCompare(b.name);
      });
    },
    [lastUsedMap, threadsByBot, pinnedSet],
  );

  const filteredUnaffiliated = useMemo(
    () =>
      sortBotsPinnedThenRecent(
        unaffiliatedBots.filter(
          (b) =>
            !normalizedFilter ||
            b.name.toLowerCase().includes(normalizedFilter) ||
            b.role.toLowerCase().includes(normalizedFilter),
        ),
      ),
    [unaffiliatedBots, normalizedFilter, sortBotsPinnedThenRecent],
  );

  // Sort projects: pinned first, then most recently used, then alphabetically
  const sortedFilteredProjects = useMemo(
    () =>
      sortBotsPinnedThenRecent(
        projectBots.filter(
          (b) =>
            !normalizedFilter ||
            b.name.toLowerCase().includes(normalizedFilter) ||
            (b.projectPath?.toLowerCase().includes(normalizedFilter) ?? false),
        ),
      ),
    [projectBots, normalizedFilter, sortBotsPinnedThenRecent],
  );

  const handleTogglePin = (bot: BotRecordDto) => {
    const nextPinned = !pinnedSet.has(bot.id);
    void rpc
      .call("bot_pin_set", { botId: bot.id, pinned: nextPinned })
      .then(() => void refresh())
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  const handleToggleThreadSettle = (threadId: string, currentlySettled: boolean) => {
    void rpc
      .call("thread_settle_set", { threadId, settled: !currentlySettled })
      .then(() => void refresh())
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  };

  const handleDreamNow = (bot: BotRecordDto) => {
    if (!dreamConfig.providerId || !dreamConfig.model) {
      toast.info("Choose a Dream agent and model first.");
      setDreamSettingsOpen(true);
      return;
    }
    const toastId = toast.loading(`Dreaming for ${bot.name}…`);
    void rpc
      .call("dream_run_now", { kind: bot.kind, botId: bot.id, projectId: bot.projectId, force: true })
      .then((res) => {
        if (res.status === "error") toast.error(res.summary, { id: toastId });
        else toast.success(`${bot.name}: ${res.summary}`, { id: toastId });
        void refresh();
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e), { id: toastId }));
  };

  const defaultHostId = useMemo(
    () => hosts.find((h) => h.connected)?.id ?? hosts[0]?.id,
    [hosts],
  );

  const toggleExpand = (botId: string) => {
    setExpandedBots((prev) => {
      const next = new Set(prev);
      if (next.has(botId)) next.delete(botId);
      else next.add(botId);
      return next;
    });
  };

  const openNewChat = (bot: BotRecordDto) => {
    if (bot.kind === "unaffiliated") {
      void rpc
        .call("stage_compose_start", { botId: bot.id })
        .catch(() => {})
        .finally(() => {
          navigate.toCompose({
            projectId: personalProjectId || undefined,
            hostId: defaultHostId,
            focusPrompt: true,
          });
          onNavigate();
        });
      return;
    }
    void rpc.call("stage_compose_start", { botId: null }).catch(() => {});
    navigate.toCompose({
      projectId: bot.projectId!,
      hostId: defaultHostId,
      focusPrompt: true,
    });
    onNavigate();
  };

  const openBot = (bot: BotRecordDto) => {
    const botThreads = (threadsByBot.get(bot.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
    const remembered = lastViewedMap.get(bot.id);
    const targetThread = (remembered && botThreads.some((t) => t.id === remembered) ? remembered : null) ?? botThreads[0]?.id;
    if (targetThread) {
      void rpc.call("stage_compose_start", { botId: null }).catch(() => {});
      navigate.toThread(targetThread);
      onNavigate();
    } else {
      openNewChat(bot);
    }
  };

  const handleSelectThread = (threadId: string, split: boolean) => {
    void rpc.call("stage_compose_start", { botId: null }).catch(() => {});
    navigate.toThread(threadId, { split });
    onNavigate();
  };

  return (
    <TooltipProvider>
      <div className="project-bots-sidebar flex h-full flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-xs font-semibold tracking-wide text-foreground">Project Bots</span>
            {unresolvedInboxCount > 0 ? (
              <button
                type="button"
                aria-label={
                  unresolvedInboxCount === 1
                    ? "1 question waiting in Inbox"
                    : `${unresolvedInboxCount} questions waiting in Inbox`
                }
                title={
                  unresolvedInboxCount === 1
                    ? "1 question waiting in Inbox"
                    : `${unresolvedInboxCount} questions waiting in Inbox`
                }
                onClick={(event) => {
                  if (inboxNavItem) {
                    sidebarNav.actions.activate(inboxNavItem.id, {
                      target: event.metaKey || event.ctrlKey ? "split" : "current",
                    });
                  } else {
                    navigate.toPluginPanel("inbox");
                  }
                  onNavigate();
                }}
                className="pb-inbox-badge-pulse inline-flex h-5 min-w-5 shrink-0 items-center justify-center gap-1 rounded-full border border-yellow-500 bg-yellow-400 px-1.5 font-mono text-[10px] font-semibold tabular-nums text-black transition-colors hover:bg-yellow-300"
              >
                <span aria-hidden="true" className="size-1.5 rounded-full bg-black/80" />
                <span>
                  {unresolvedInboxCount > 99 ? "99+" : unresolvedInboxCount}
                </span>
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant={dreamConfig.enabled ? "secondary" : "ghost"}
              className="h-6 px-1.5 text-[11px]"
              aria-label="Dream Mode settings"
              onClick={() => setDreamSettingsOpen(true)}
            >
              🌙
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              onClick={() => setEditor({ mode: "create-unaffiliated" })}
            >
              + New bot
            </Button>
          </div>
        </div>

        {error ? (
          <div className="px-3 py-2 text-xs text-destructive" role="alert">
            {error}
          </div>
        ) : null}

        {projectBots.length + unaffiliatedBots.length > 6 ? (
          <div className="border-b border-border/40 px-2.5 py-1.5">
            <input
              type="search"
              aria-label="Filter bots and projects"
              placeholder="Filter bots & projects…"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              className="h-6 w-full rounded-md border border-input bg-background/60 px-2 text-[11px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 space-y-3">
          {/* Unaffiliated Coordinator Bots */}
          <div>
            <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Coordinators ({filteredUnaffiliated.length})
            </div>
            {filteredUnaffiliated.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                {normalizedFilter
                  ? "No matching coordinators."
                  : "No unaffiliated bots yet. Create one to coordinate across projects."}
              </div>
            ) : (
              filteredUnaffiliated.map((bot, idx) => (
                <BotGroupRow
                  key={bot.id}
                  bot={bot}
                  pinned={pinnedSet.has(bot.id)}
                  idleVariant={idx % 3}
                  threads={threadsByBot.get(bot.id) ?? []}
                  expanded={expandedBots.has(bot.id)}
                  onToggleExpand={() => toggleExpand(bot.id)}
                  activeThreadId={activeThreadId}
                  activeAncestors={activeAncestors}
                  lastViewedThreadId={lastViewedMap.get(bot.id) ?? null}
                  settledThreadMap={settledThreadMap}
                  threadOrder={threadOrderMap.get(bot.id) ?? []}
                  specialThreadMap={specialThreadMap}
                  settings={settings}
                  onToggleThreadSettle={handleToggleThreadSettle}
                  onReorderThreads={(botId, ids) => {
                    void rpc
                      .call("thread_reorder", { botId, threadIds: ids })
                      .then(() => refresh())
                      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
                  }}
                  onPromoteSpecial={(thread) =>
                    setSpecialDialog({
                      threadId: thread.id,
                      botId: bot.id,
                      botName: bot.name,
                      currentTitle: thread.title ?? undefined,
                      existing: specialThreadMap.get(thread.id) ?? null,
                    })
                  }
                  onDemoteSpecial={(threadId) => {
                    void rpc
                      .call("special_thread_remove", { threadId })
                      .then(() => {
                        toast.success("Demoted from Special thread");
                        void refresh();
                      })
                      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
                  }}
                  onOpenBot={() => openBot(bot)}
                  onNewChat={() => openNewChat(bot)}
                  onTogglePin={() => handleTogglePin(bot)}
                  onDreamNow={() => handleDreamNow(bot)}
                  onEditBot={() => setEditor({ mode: "edit", bot })}
                  onDeleteBot={() => {
                    void rpc
                      .call("bot_delete_unaffiliated", { botId: bot.id })
                      .then(() => {
                        toast.success(`Deleted ${bot.name}`);
                        void refresh();
                      })
                      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
                  }}
                  onSelectThread={handleSelectThread}
                />
              ))
            )}
          </div>

          {/* Automatic Project Bots */}
          <div>
            <div className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Projects ({sortedFilteredProjects.length})
            </div>
            {!loaded ? (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">Loading projects…</div>
            ) : sortedFilteredProjects.length === 0 ? (
              <div className="px-2 py-1 text-[11px] text-muted-foreground">
                {normalizedFilter ? "No matching projects." : "No projects found."}
              </div>
            ) : (
              sortedFilteredProjects.map((bot, idx) => (
                <BotGroupRow
                  key={bot.id}
                  bot={bot}
                  hostName={bot.projectHostId ? hostNameById.get(bot.projectHostId) : null}
                  pinned={pinnedSet.has(bot.id)}
                  idleVariant={idx % 3}
                  threads={threadsByBot.get(bot.id) ?? []}
                  expanded={expandedBots.has(bot.id)}
                  onToggleExpand={() => toggleExpand(bot.id)}
                  activeThreadId={activeThreadId}
                  activeAncestors={activeAncestors}
                  lastViewedThreadId={lastViewedMap.get(bot.id) ?? null}
                  settledThreadMap={settledThreadMap}
                  threadOrder={threadOrderMap.get(bot.id) ?? []}
                  specialThreadMap={specialThreadMap}
                  settings={settings}
                  onToggleThreadSettle={handleToggleThreadSettle}
                  onReorderThreads={(botId, ids) => {
                    void rpc
                      .call("thread_reorder", { botId, threadIds: ids })
                      .then(() => refresh())
                      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
                  }}
                  onPromoteSpecial={(thread) =>
                    setSpecialDialog({
                      threadId: thread.id,
                      botId: bot.id,
                      botName: bot.name,
                      currentTitle: thread.title ?? undefined,
                      existing: specialThreadMap.get(thread.id) ?? null,
                    })
                  }
                  onDemoteSpecial={(threadId) => {
                    void rpc
                      .call("special_thread_remove", { threadId })
                      .then(() => {
                        toast.success("Demoted from Special thread");
                        void refresh();
                      })
                      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
                  }}
                  onOpenBot={() => openBot(bot)}
                  onNewChat={() => openNewChat(bot)}
                  onTogglePin={() => handleTogglePin(bot)}
                  onDreamNow={() => handleDreamNow(bot)}
                  onEditBot={() => setEditor({ mode: "edit", bot })}
                  onSelectThread={handleSelectThread}
                />
              ))
            )}
          </div>
        </div>

        {/* Collapsible Personal Chats */}
        <div className="border-t border-border/60">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent/40 hover:text-foreground"
            onClick={() => setChatsExpanded((v) => !v)}
          >
            <span>Chats ({personalChats.length})</span>
            <span>{chatsExpanded ? "▾" : "▸"}</span>
          </button>
          {chatsExpanded ? (
            <div className="max-h-48 overflow-y-auto px-2 pb-2">
              {personalChats.length === 0 ? (
                <div className="px-2 py-1 text-[11px] text-muted-foreground">No personal chats.</div>
              ) : (
                <ul className="space-y-0.5">
                  {personalChats.map((thread) => (
                    <ThreadTreeItem
                      key={thread.id}
                      thread={thread}
                      childrenByParent={new Map()}
                      activeThreadId={activeThreadId}
                      activeAncestors={activeAncestors}
                      onSelect={handleSelectThread}
                    />
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>

        {dreamSettingsOpen ? (
          <DreamSettingsDialog
            config={dreamConfig}
            dreamThreadId={dreamThreadId}
            onOpenDreamThread={(id) => handleSelectThread(id, false)}
            loadProviders={async () => (await rpc.call("dream_providers", null)).providers}
            onSave={async (next) => {
              await rpc.call("dream_config_set", next);
              toast.success(next.enabled ? `Dream Mode enabled (${next.model})` : "Dream Mode settings saved");
              void refresh();
            }}
            onClose={() => setDreamSettingsOpen(false)}
          />
        ) : null}

        {editor ? (
          <BotEditorDialog
            target={editor}
            onClose={() => setEditor(null)}
            onCreateUnaffiliated={async (input) => {
              const created = await rpc.call("bot_create_unaffiliated", input);
              toast.success(`Created ${created.name}`);
              void refresh();
            }}
            onUpdateBot={async (input) => {
              const updated = await rpc.call("bot_update", input);
              toast.success(`Saved ${updated.name}`);
              void refresh();
            }}
            onDeleteUnaffiliated={async (botId) => {
              await rpc.call("bot_delete_unaffiliated", { botId });
              toast.success("Deleted bot");
              void refresh();
            }}
          />
        ) : null}

        {specialDialog ? (
          <SpecialThreadDialog
            target={specialDialog}
            onClose={() => setSpecialDialog(null)}
            onSave={async (input) => {
              const saved = await rpc.call("special_thread_set", input);
              toast.success(`Saved Special thread: ${saved.name}`);
              void refresh();
            }}
            onRemove={async (threadId) => {
              await rpc.call("special_thread_remove", { threadId });
              toast.success("Demoted from Special thread");
              void refresh();
            }}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

const directiveRenderedIds = new Set<number>();

function useInboxBadge(): ExperimentalBadge | null {
  const { open } = useInboxStore();
  const openCount = open.length;
  if (openCount <= 0) return null;
  return {
    count: openCount,
    tone: "warning",
    label:
      openCount === 1
        ? "1 question waiting in Inbox"
        : `${openCount} questions waiting in Inbox`,
  };
}

function InlineThreadMessages({ message }: ExperimentalMessageMetadataProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [messages, setMessages] = useState<InboxMessage[]>([]);

  const load = useCallback(async () => {
    try {
      const data = await rpc.call("thread_messages", {
        threadId: message.threadId,
      });
      setMessages(data.messages);
    } catch {
      // Ignore transient errors
    }
  }, [message.threadId, rpc]);

  useEffect(() => {
    if (message.role !== "assistant") return;
    void load();
  }, [load, message.role]);

  useRealtime(INBOX_REALTIME_CHANNEL, (payload) => {
    if (message.role !== "assistant") return;
    const p = payload as { threadId?: string } | null;
    if (!p?.threadId || p.threadId === message.threadId) {
      void load();
    }
  });

  const matching = useMemo(() => {
    if (message.role !== "assistant" || messages.length === 0) return [];
    return messages.filter((item) => {
      if (directiveRenderedIds.has(item.id)) return false;
      if (message.turnId && item.turnId) {
        return item.turnId === message.turnId;
      }
      const delta = message.createdAt - item.createdAt;
      return delta >= -5_000 && delta <= 120_000;
    });
  }, [message.createdAt, message.role, message.turnId, messages]);

  const handleAnswer = useCallback(
    async (messageId: number, reply: ReplyInput) => {
      await rpc.call("answer_message", { messageId, ...reply });
      await load();
    },
    [load, rpc],
  );

  const handleDismiss = useCallback(
    async (messageId: number) => {
      await rpc.call("dismiss_message", { messageId });
      await load();
    },
    [load, rpc],
  );

  if (matching.length === 0) return null;

  return (
    <div className="mb-2 space-y-2">
      {matching.map((item) =>
        item.state === "prose" ? (
          <div
            key={item.id}
            data-inbox-prose={item.id}
            className="text-sm leading-relaxed text-foreground"
          >
            <Markdown content={item.text} />
          </div>
        ) : (
          <MessageCard
            key={item.id}
            message={item}
            onAnswer={(reply) => handleAnswer(item.id, reply)}
            onDismiss={() => handleDismiss(item.id)}
          />
        ),
      )}
    </div>
  );
}

function InboxMessageDirective({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const id = Number(attributes.id);
  const validId = Number.isSafeInteger(id) && id > 0;
  const [item, setItem] = useState<InboxMessage | null>(null);

  useEffect(() => {
    if (!validId) return;
    directiveRenderedIds.add(id);
    return () => {
      directiveRenderedIds.delete(id);
    };
  }, [id, validId]);

  const load = useCallback(async () => {
    if (!validId) return;
    try {
      const data = await rpc.call("get_message", { messageId: id });
      setItem(data.message);
    } catch {
      // Ignore transient errors
    }
  }, [id, rpc, validId]);

  useEffect(() => {
    void load();
  }, [load]);

  useRealtime(INBOX_REALTIME_CHANNEL, (payload) => {
    const p = payload as { messageId?: number } | null;
    if (!p?.messageId || p.messageId === id) {
      void load();
    }
  });

  if (!validId || !item) return null;

  if (item.state === "prose") {
    return (
      <div
        data-inbox-prose={item.id}
        className="text-sm leading-relaxed text-foreground"
      >
        <Markdown content={item.text} />
      </div>
    );
  }

  return (
    <MessageCard
      message={item}
      onAnswer={async (reply) => {
        await rpc.call("answer_message", { messageId: item.id, ...reply });
        await load();
      }}
      onDismiss={async () => {
        await rpc.call("dismiss_message", { messageId: item.id });
        await load();
      }}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "inbox",
    title: "Inbox",
    icon: "Inbox",
    path: "inbox",
    component: InboxPage,
    experimental_useBadge: useInboxBadge,
  });
  app.slots.experimental_messageMetadata({
    id: "inline-inbox-cards",
    placement: "above",
    component: InlineThreadMessages,
  });
  app.slots.messageDirective({
    id: "inbox-message",
    component: InboxMessageDirective,
  });
  app.slots.experimental_threadRowMetadata({
    id: "waits-on-you",
    useData({ threads }) {
      const keys = useMemo(() => threads.map((t) => t.id), [threads]);
      const query = experimental_useRpcKeyedQuery({
        contract: rpcContract,
        method: "open_counts_by_thread",
        keys,
      });
      return query.data ?? {};
    },
    component({ thread, data }) {
      const info = data?.[thread.id];
      if (!info || info.openCount <= 0) return null;
      return (
        <span
          className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-700 dark:text-amber-300"
          title={
            info.openCount === 1
              ? "1 unanswered question in Inbox"
              : `${info.openCount} unanswered questions in Inbox`
          }
        >
          <Icon name="Inbox" className="size-3 shrink-0" />
          <span>waits on you</span>
        </span>
      );
    },
  });
  app.commands.register({
    id: "open-inbox",
    title: "Inbox: Open Inbox",
    run() {
      window.location.assign("/plugins/bb-project-bots/inbox");
    },
  });
  app.slots.experimental_threadInfoSection({
    id: "project-bot-info",
    group: "0_project_bot",
    component: ThreadBotInfoSection,
  });
  app.slots.experimental_threadList({
    id: "project-bots",
    title: "Project Bots",
    description: "Every project automatically gets a file-backed bot, plus unaffiliated coordinator bots.",
    component: ProjectBotsSidebar,
  });
});
