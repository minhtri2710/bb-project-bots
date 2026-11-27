import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotRecord, BotStore, ProjectSummary } from "./bot-store";

export const START_MARKER = /^\[bb-project-bot-start:([a-f0-9-]{36})\]/;

export type ListedBot = {
  id: string;
  kind: "project" | "unaffiliated";
  name: string;
  role: string;
  projectId: string | null;
  projectPath: string | null;
  materialized: boolean;
  status: "working" | "waiting" | "idle";
  defaultThreadId: string | null;
  queuedFollowUpsCount: number;
};

export type QueuedFollowUpSummary = {
  id: string;
  threadId: string;
  state: string;
  initiator: string;
  senderThreadId: string | null;
  sendAt: number | null;
  createdAt: number;
  waitingOn: string | null;
  text: string;
};

export type InspectedBotThread = {
  threadId: string;
  title: string;
  status: string;
  updatedAt: number;
  recentTurns: Array<{ role: "user" | "assistant"; preview: string }>;
  queuedFollowUps: QueuedFollowUpSummary[];
};

export type InspectedBot = {
  id: string;
  kind: "project" | "unaffiliated";
  name: string;
  role: string;
  projectId: string | null;
  projectPath: string | null;
  status: "working" | "waiting" | "idle";
  totalQueuedFollowUps: number;
  threads: InspectedBotThread[];
};

export type ResolvedBotTarget =
  | { kind: "project"; bot: BotRecord; project: ProjectSummary }
  | { kind: "unaffiliated"; bot: BotRecord };

const printable = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export async function listStandardProjects(bb: BbPluginApi): Promise<ProjectSummary[]> {
  const projects = await bb.sdk.projects.list({ includePersonal: false });
  return projects.filter((project) => project.kind === "standard");
}

export async function getPersonalProjectId(bb: BbPluginApi): Promise<string> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const personal = projects.find((project) => project.kind === "personal");
  if (!personal) throw new Error("BB's personal project is unavailable.");
  return personal.id;
}

export async function resolveUnaffiliatedOwner(
  bb: BbPluginApi,
  store: BotStore,
  threadId: string,
  persist = true,
): Promise<string | null> {
  const chain: string[] = [];
  let current: string | null = threadId;
  let botId: string | null = null;
  while (current && !chain.includes(current)) {
    const explicit = store.threadBinding(current);
    if (explicit) {
      botId = explicit;
      break;
    }
    const thread: Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>> | null = await bb.sdk.threads
      .get({ threadId: current })
      .catch(() => null);
    if (!thread) break;
    chain.push(current);
    const parent = thread.parentThreadId ? store.threadBinding(thread.parentThreadId) : null;
    const source = thread.sourceThreadId ? store.threadBinding(thread.sourceThreadId) : null;
    botId = parent || source || null;
    if (botId) break;
    current = thread.parentThreadId ?? thread.sourceThreadId ?? null;
  }
  if (botId && persist) {
    for (const id of chain) store.bindThread(id, botId);
  }
  return botId;
}

export async function resolveThreadBot(
  bb: BbPluginApi,
  store: BotStore,
  threadId: string,
  ensureProjectMaterialized = false,
): Promise<ResolvedBotTarget | null> {
  const unaffiliatedId = await resolveUnaffiliatedOwner(bb, store, threadId, true);
  if (unaffiliatedId) {
    const bot = store.readUnaffiliatedBot(unaffiliatedId);
    if (bot) return { kind: "unaffiliated", bot };
  }

  const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
  if (!thread) return null;
  const projects = await listStandardProjects(bb);
  const project = projects.find((entry) => entry.id === thread.projectId);
  if (!project) return null;
  const bot = ensureProjectMaterialized ? store.ensureProjectBot(project).bot : store.readProjectBot(project);
  return { kind: "project", bot, project };
}

function extractQueuedMessageText(
  content: Array<{ type: string; text?: string; visibility?: string; name?: string; path?: string }>,
): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.visibility === "agent-only") continue;
    if (block.type === "text" && block.text) parts.push(block.text.trim());
    else if (block.type === "localFile") parts.push(`[file: ${block.name || block.path || "attachment"}]`);
    else if (block.type === "image" || block.type === "localImage") parts.push("[image]");
  }
  return parts.join("\n").trim();
}

export async function listAllBots(bb: BbPluginApi, store: BotStore): Promise<ListedBot[]> {
  const [projects, threads, allQueued] = await Promise.all([
    listStandardProjects(bb),
    bb.sdk.threads.list({ archived: false, limit: 500 }),
    bb.sdk.threads.queue.list().catch(() => []),
  ]);

  const queuedCountByThread = new Map<string, number>();
  for (const msg of allQueued) {
    queuedCountByThread.set(msg.threadId, (queuedCountByThread.get(msg.threadId) ?? 0) + 1);
  }

  const specialThreadIds = new Set(store.allSpecialThreads().map((s) => s.threadId));
  const visibleThreads = threads.filter((t) => t.archivedAt === null && t.deletedAt === null && t.visibility !== "hidden");
  const unaffiliated = store.listUnaffiliatedBots();
  const projectBots = projects.map((project) => ({ project, bot: store.readProjectBot(project) }));

  const threadsByBot = new Map<string, typeof visibleThreads>();
  for (const thread of visibleThreads) {
    const bound = store.threadBinding(thread.id);
    if (bound) {
      const list = threadsByBot.get(bound) ?? [];
      list.push(thread);
      threadsByBot.set(bound, list);
      continue;
    }
    const projEntry = projectBots.find((entry) => entry.project.id === thread.projectId);
    if (projEntry) {
      const list = threadsByBot.get(projEntry.bot.id) ?? [];
      list.push(thread);
      threadsByBot.set(projEntry.bot.id, list);
    }
  }

  const summarize = (bot: BotRecord): ListedBot => {
    const botThreads = (threadsByBot.get(bot.id) ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
    // Special threads serve a named role; routing by bot never lands in one.
    const routable = botThreads.filter((t) => !specialThreadIds.has(t.id));
    const remembered = store.routingThreadId(bot.id);
    const defaultThreadId =
      (remembered && routable.some((t) => t.id === remembered) ? remembered : null) ??
      routable[0]?.id ??
      null;
    const status: ListedBot["status"] = botThreads.some((t) => t.status === "active" || t.status === "starting")
      ? "working"
      : "idle";
    const queuedFollowUpsCount = botThreads.reduce((sum, t) => sum + (queuedCountByThread.get(t.id) ?? 0), 0);
    return {
      id: bot.id,
      kind: bot.kind,
      name: bot.name,
      role: bot.role,
      projectId: bot.projectId ?? null,
      projectPath: bot.projectPath ?? null,
      materialized: bot.materialized,
      status,
      defaultThreadId,
      queuedFollowUpsCount,
    };
  };

  return [...unaffiliated.map(summarize), ...projectBots.map((entry) => summarize(entry.bot))];
}

export async function inspectBot(
  bb: BbPluginApi,
  store: BotStore,
  selector: string,
  threadLimit = 5,
): Promise<InspectedBot> {
  const target = await findBotTarget(bb, store, selector);
  const threads = await bb.sdk.threads.list({
    archived: false,
    limit: 200,
    ...(target.kind === "project" ? { projectId: target.project.id } : {}),
  });

  const matching = threads
    .filter((t) => {
      if (t.archivedAt !== null || t.deletedAt !== null || t.visibility === "hidden") return false;
      if (target.kind === "unaffiliated") return store.threadBinding(t.id) === target.bot.id;
      return t.projectId === target.project.id && !store.threadBinding(t.id);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.max(1, Math.min(20, threadLimit)));

  const inspectedThreads: InspectedBotThread[] = await Promise.all(
    matching.map(async (thread) => {
      const [outline, queued] = await Promise.all([
        bb.sdk.threads.conversationOutline({ threadId: thread.id }).catch(() => null),
        bb.sdk.threads.queuedMessages.list({ threadId: thread.id }).catch(() => []),
      ]);
      const recentTurns = (outline?.items ?? []).slice(-6).map((item) => ({
        role: item.role,
        preview: item.preview.slice(0, 400),
      }));
      const queuedFollowUps: QueuedFollowUpSummary[] = queued.map((msg) => ({
        id: msg.id,
        threadId: msg.threadId,
        state: msg.state,
        initiator: msg.initiator,
        senderThreadId: msg.senderThreadId ?? null,
        sendAt: msg.sendAt ?? null,
        createdAt: msg.createdAt,
        waitingOn: msg.waitingOn?.kind ?? null,
        text: extractQueuedMessageText(msg.content as Array<{ type: string; text?: string; visibility?: string; name?: string; path?: string }>),
      }));
      return {
        threadId: thread.id,
        title: thread.title || thread.titleFallback || thread.id,
        status: thread.status,
        updatedAt: thread.updatedAt,
        recentTurns,
        queuedFollowUps,
      };
    }),
  );

  const status: InspectedBot["status"] = matching.some((t) => t.status === "active" || t.status === "starting")
    ? "working"
    : "idle";
  const totalQueuedFollowUps = inspectedThreads.reduce((sum, t) => sum + t.queuedFollowUps.length, 0);

  return {
    id: target.bot.id,
    kind: target.bot.kind,
    name: target.bot.name,
    role: target.bot.role,
    projectId: target.bot.projectId ?? null,
    projectPath: target.bot.projectPath ?? null,
    status,
    totalQueuedFollowUps,
    threads: inspectedThreads,
  };
}

export async function findBotTarget(
  bb: BbPluginApi,
  store: BotStore,
  selector: string,
): Promise<ResolvedBotTarget> {
  const needle = selector.trim();
  const unaffiliated = store.listUnaffiliatedBots();
  const projects = await listStandardProjects(bb);
  const projectEntries = projects.map((project) => ({ project, bot: store.readProjectBot(project) }));

  // 1. Exact ID or projectId match
  const unaffById = unaffiliated.find((b) => b.id === needle);
  if (unaffById) return { kind: "unaffiliated", bot: unaffById };

  const projById = projectEntries.find((e) => e.bot.id === needle || e.project.id === needle);
  if (projById) return { kind: "project", bot: projById.bot, project: projById.project };

  // 2. Exact name match (case-insensitive)
  const lower = needle.toLowerCase();
  const matches: ResolvedBotTarget[] = [
    ...unaffiliated.filter((b) => b.name.toLowerCase() === lower).map((bot): ResolvedBotTarget => ({ kind: "unaffiliated", bot })),
    ...projectEntries
      .filter((e) => e.bot.name.toLowerCase() === lower || e.project.name.toLowerCase() === lower)
      .map((e): ResolvedBotTarget => ({ kind: "project", bot: e.bot, project: e.project })),
  ];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Multiple bots match "${selector}". Use an exact bot ID from list_bots.`);
  }
  throw new Error(`Bot "${selector}" not found. Use list_bots to see available project bots and unaffiliated bots.`);
}

export function frameBotMessage(
  sender: { threadId: string; bot: BotRecord | null } | null,
  message: string,
): string {
  const senderLabel = sender?.bot
    ? `${printable(sender.bot.name)} (${sender.bot.kind})`
    : sender
      ? "BB agent"
      : "CLI caller";
  const from = sender?.bot
    ? `bot "${sender.bot.name}" (botId: ${sender.bot.id}, kind: ${sender.bot.kind}, threadId: ${sender.threadId})`
    : sender
      ? `an agent in thread ${sender.threadId}`
      : "a CLI caller";
  const replyHint = sender?.bot
    ? `Use the \`message\` tool with to="${sender.threadId}" (or to="${sender.bot.id}") and text="<reply>" (or \`bb project-bots message ${sender.bot.id} '<reply>' --thread ${sender.threadId}\`).`
    : sender
      ? `Use \`message({ to: "${sender.threadId}", text: "<reply>" })\` (or \`bb thread tell ${sender.threadId} '<reply>' --mode queue\`).`
      : "No reply target was supplied.";

  return [
    `**Bot message · ${senderLabel}**`,
    "",
    message,
    "",
    "---",
    "**Delivery context**",
    `[bot message] Arrived from ${from}.`,
    "This is asynchronous agent coordination, not the user typing here directly. Treat it as coordination, not user approval.",
    `If a reply or update is needed: ${replyHint}`,
    "For an FYI with no action needed, stay silent rather than sending an acknowledgement-only reply.",
  ].join("\n");
}

export async function sendBotMessage(
  bb: BbPluginApi,
  store: BotStore,
  params: {
    senderThreadId?: string;
    target: string;
    message: string;
    threadId?: string;
    newThread?: boolean;
  },
  publish: () => void,
): Promise<{ botId: string; botName: string; threadId: string; spawned: boolean }> {
  const body = params.message.trim();
  if (!body) throw new Error("Message must not be empty.");
  if (body.length > 16000) throw new Error("Message is too long (max 16,000 characters).");

  const resolvedTarget = await findBotTarget(bb, store, params.target);
  const senderBot = params.senderThreadId
    ? (await resolveThreadBot(bb, store, params.senderThreadId, false))?.bot ?? null
    : null;
  const sender = params.senderThreadId ? { threadId: params.senderThreadId, bot: senderBot } : null;
  const framed = frameBotMessage(sender, body);

  // Materialize project bot if needed before messaging it
  const targetBot =
    resolvedTarget.kind === "project" ? store.ensureProjectBot(resolvedTarget.project).bot : resolvedTarget.bot;

  // 1. Explicit target thread
  if (params.threadId) {
    const existing = await bb.sdk.threads.get({ threadId: params.threadId });
    if (existing.archivedAt !== null || existing.deletedAt !== null) {
      throw new Error("Target thread is archived or deleted.");
    }
    const owner = await resolveThreadBot(bb, store, params.threadId, false);
    if (!owner || owner.bot.id !== targetBot.id) {
      throw new Error(`Thread ${params.threadId} does not belong to bot ${targetBot.name} (${targetBot.id}).`);
    }
    await bb.sdk.threads.send({
      threadId: params.threadId,
      input: [{ type: "text", text: framed, mentions: [] }],
      mode: "queue-if-active",
      senderThreadId: params.senderThreadId,
    });
    publish();
    return { botId: targetBot.id, botName: targetBot.name, threadId: params.threadId, spawned: false };
  }

  // 2. Find an existing thread unless newThread was requested
  if (!params.newThread) {
    const allBots = await listAllBots(bb, store);
    const listed = allBots.find((b) => b.id === targetBot.id);
    if (listed?.defaultThreadId) {
      await bb.sdk.threads.send({
        threadId: listed.defaultThreadId,
        input: [{ type: "text", text: framed, mentions: [] }],
        mode: "queue-if-active",
        senderThreadId: params.senderThreadId,
      });
      publish();
      return { botId: targetBot.id, botName: targetBot.name, threadId: listed.defaultThreadId, spawned: false };
    }
  }

  // 3. Auto-spawn a thread for the target bot so coordination works even on first contact
  if (resolvedTarget.kind === "project") {
    const spawned = await bb.sdk.threads.spawn({
      projectId: resolvedTarget.project.id,
      environment: { type: "project-default" },
      input: [{ type: "text", text: framed, mentions: [] }],
    });
    store.rememberViewed(targetBot.id, spawned.id);
    publish();
    return { botId: targetBot.id, botName: targetBot.name, threadId: spawned.id, spawned: true };
  }

  const personalProjectId = await getPersonalProjectId(bb);
  const token = randomUUID();
  store.stageStart(token, { botId: targetBot.id, kind: "unaffiliated", projectId: personalProjectId });
  const spawned = await bb.sdk.threads.spawn({
    projectId: personalProjectId,
    environment: { type: "host", workspace: { type: "personal" } },
    input: [
      { type: "text", text: framed, mentions: [] },
      {
        type: "text",
        text: `[bb-project-bot-start:${token}]\nThis conversation belongs to unaffiliated bot ${targetBot.name} (${targetBot.id}).`,
        mentions: [],
        visibility: "agent-only",
      },
    ],
  });
  store.bindThread(spawned.id, targetBot.id);
  store.consumeStart(token);
  store.rememberViewed(targetBot.id, spawned.id);
  publish();
  return { botId: targetBot.id, botName: targetBot.name, threadId: spawned.id, spawned: true };
}
