import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BotRecord, BotStore, ProjectSummary } from "./bot-store";
import { analyzeMemoryDecay, formatDecaySummary, todayIsoDate } from "./memory-decay";
import { getPersonalProjectId, listStandardProjects, type ResolvedBotTarget } from "./messaging";

export const DREAM_MARKER = /^\[bb-project-bot-dream:([a-f0-9-]{36})\]/;

export type UnprocessedConversation = {
  threadId: string;
  title: string;
  maxSeq: number;
  turns: Array<{ role: "user" | "assistant"; preview: string }>;
};

export type DreamRunResult = {
  botId: string;
  botName: string;
  status: "completed" | "skipped" | "error";
  processedConversations: number;
  summary: string;
};

const MAX_THREADS_PER_DREAM = 8;
const MAX_TURNS_PER_THREAD = 12;
const MAX_PREVIEW_CHARS = 450;

export function buildDreamPrompt(
  bot: BotRecord,
  unprocessed: UnprocessedConversation[],
  now: number = Date.now(),
): string {
  const today = todayIsoDate(now);
  const decay = analyzeMemoryDecay(bot.memory, now);
  const staleEntries = decay.entries.filter((e) => e.bucket !== "fresh");

  const conversationBlocks = unprocessed.length
    ? unprocessed
        .map((c) => {
          const lines = c.turns.map(
            (t) => `  - **${t.role}**: ${t.preview.replace(/\s+/g, " ").slice(0, MAX_PREVIEW_CHARS)}`,
          );
          return [`### Conversation: ${c.title} (${c.threadId}, seq ${c.maxSeq})`, ...lines].join("\n");
        })
        .join("\n\n")
    : "_No new conversations since last dream — focus on pruning stale or redundant memory entries._";

  const staleBlock = staleEntries.length
    ? staleEntries
        .slice(0, 20)
        .map((e) => `- [${e.bucket}${e.date ? `, ${e.date}` : ""}${e.confidence ? `, ${e.confidence}` : ""}] (${e.section}) ${e.text}`)
        .join("\n")
    : "_No stale entries detected._";

  return [
    `# Dream Mode — Memory Consolidation for ${bot.name}`,
    `Today's date: **${today}**`,
    "",
    "You are running Dream Mode for this bot. Your ONLY job is to consolidate and clean up the bot's markdown memory file using `update_memory_state`. Do NOT edit any repository files or run project commands.",
    "",
    "## Trust & Quality Bar",
    "- Trust hierarchy: **User/system instructions > Ground-truth code > Bot memory**.",
    "- The bar for keeping any entry: **will a future session make a better decision because this memory exists?** If not, drop it.",
    "- Tag every bullet with `[YYYY-MM-DD | high|medium|low]`:",
    "  - `high`: directly confirmed by the user or live tool/code output.",
    "  - `medium`: synthesized across conversations, not freshly re-verified.",
    "  - `low`: tentative inference or aging assumption.",
    "",
    "## Phase 1 — Orient (Current Memory & Staleness)",
    formatDecaySummary(decay),
    "",
    "### Flagged / Aging Entries",
    staleBlock,
    "",
    "### Current Memory File",
    "```markdown",
    bot.memory.trim() || "## Facts\n\n## Lessons\n\n## Preferences",
    "```",
    "",
    "## Phase 2 — Signal (Unprocessed Conversations Since Last Dream)",
    conversationBlocks,
    "",
    "## Phase 3 & 4 — Consolidate & Prune",
    "1. Extract durable facts, lessons, and user preferences from the unprocessed conversations.",
    "2. Resolve contradictions at the source (replace or delete outdated claims — never keep both).",
    "3. Normalize relative dates ('yesterday', 'last week') to absolute `YYYY-MM-DD` dates.",
    "4. Prune hard-stale (>45d), prune-candidate (>90d), or easily re-derivable fluff.",
    "5. Keep the structure clean under `## Facts`, `## Lessons`, `## Preferences` (and optional `## Notes`).",
    "6. Call `update_memory_state({ action: \"replace\", text: \"...\" })` once with the full consolidated markdown body (or skip calling it if no changes are needed), then reply with a concise 1-sentence summary of what changed.",
  ].join("\n");
}

async function collectUnprocessed(
  bb: BbPluginApi,
  store: BotStore,
  target: ResolvedBotTarget,
  sinceTimestamp: number | null,
): Promise<UnprocessedConversation[]> {
  const dreamState = store.getDreamState(target.bot.id);
  const threads = await bb.sdk.threads.list({
    archived: false,
    limit: 200,
    ...(target.kind === "project" ? { projectId: target.project.id } : {}),
  });

  const dreamThreadId = store.getDreamThreadId();
  const matching = threads
    .filter((t) => {
      if (t.archivedAt !== null || t.deletedAt !== null || t.visibility === "hidden") return false;
      if (t.id === dreamThreadId || store.getDreamSession(t.id)) return false;
      if (t.status === "active" || t.status === "starting") return false;
      if (sinceTimestamp !== null && t.updatedAt <= sinceTimestamp) return false;
      if (target.kind === "unaffiliated") {
        return store.threadBinding(t.id) === target.bot.id;
      }
      return t.projectId === target.project.id && !store.threadBinding(t.id);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_THREADS_PER_DREAM * 2);

  const unprocessed: UnprocessedConversation[] = [];
  for (const thread of matching) {
    if (unprocessed.length >= MAX_THREADS_PER_DREAM) break;
    const outline = await bb.sdk.threads.conversationOutline({ threadId: thread.id }).catch(() => null);
    if (!outline || outline.maxSeq <= 0) continue;
    const lastSeq = dreamState.processedThreadSeq[thread.id] ?? 0;
    if (outline.maxSeq <= lastSeq) continue;

    const turns = outline.items.slice(-MAX_TURNS_PER_THREAD).map((item) => ({
      role: item.role,
      preview: item.preview,
    }));
    if (!turns.length) continue;

    unprocessed.push({
      threadId: thread.id,
      title: thread.title || thread.titleFallback || thread.id,
      maxSeq: outline.maxSeq,
      turns,
    });
  }
  return unprocessed;
}

// Serialize all dream runs through the single shared visible Dream agent instance
let dreamRunChain: Promise<unknown> = Promise.resolve();

async function ensureUsableDreamThread(bb: BbPluginApi, store: BotStore): Promise<string | null> {
  const existingId = store.getDreamThreadId();
  if (!existingId) return null;
  const thread = await bb.sdk.threads.get({ threadId: existingId }).catch(() => null);
  if (!thread || thread.archivedAt !== null || thread.deletedAt !== null) {
    store.setDreamThreadId(null);
    return null;
  }
  return existingId;
}

function topUnaffiliatedBotId(store: BotStore): string | null {
  const bots = store.listUnaffiliatedBots();
  if (!bots.length) return null;
  const pinned = new Set(store.pinnedBotIds());
  const lastUsed = new Map(store.allLastUsedAt().map((e) => [e.botId, e.lastUsedAt]));
  const sorted = [...bots].sort((a, b) => {
    const pA = pinned.has(a.id) ? 1 : 0;
    const pB = pinned.has(b.id) ? 1 : 0;
    if (pA !== pB) return pB - pA;
    const rA = lastUsed.get(a.id) ?? 0;
    const rB = lastUsed.get(b.id) ?? 0;
    if (rA !== rB) return rB - rA;
    return a.name.localeCompare(b.name);
  });
  return sorted[0]!.id;
}

export async function runDreamForBot(
  bb: BbPluginApi,
  store: BotStore,
  target: ResolvedBotTarget,
  publish: () => void,
  options?: { force?: boolean },
): Promise<DreamRunResult> {
  const execute = async (): Promise<DreamRunResult> => {
    const config = store.getDreamConfig();
    if (!config.providerId || !config.model) {
      return {
        botId: target.bot.id,
        botName: target.bot.name,
        status: "error",
        processedConversations: 0,
        summary: "Choose a Dream agent/provider and model in Dream Settings first.",
      };
    }

    let dreamThreadId: string | null = null;
    try {
      const bot =
        target.kind === "project" ? store.ensureProjectBot(target.project).bot : target.bot;
      const dreamState = store.getDreamState(bot.id);
      const periodStart = options?.force
        ? null
        : dreamState.lastDreamAt ?? Date.now() - config.intervalMinutes * 60_000;
      const unprocessed = await collectUnprocessed(bb, store, target, periodStart);
      if (unprocessed.length === 0 && !options?.force) {
        return {
          botId: bot.id,
          botName: bot.name,
          status: "skipped",
          processedConversations: 0,
          summary: "No activity in this dream period.",
        };
      }

      const prompt = buildDreamPrompt(bot, unprocessed);
      const dreamTarget = {
        botId: bot.id,
        kind: target.kind,
        projectId: target.kind === "project" ? target.project.id : undefined,
      };

      const existingDreamId = await ensureUsableDreamThread(bb, store);
      if (existingDreamId) {
        dreamThreadId = existingDreamId;
        // Reset model context before starting the next bot while preserving transcript history above
        await bb.sdk.threads.clearContext({ threadId: dreamThreadId }).catch(() => {});
        store.registerDreamSession(dreamThreadId, dreamTarget);
        await bb.sdk.threads.send({
          threadId: dreamThreadId,
          input: [{ type: "text", text: prompt, mentions: [] }],
          mode: "queue-if-active",
        });
      } else {
        const personalProjectId = await getPersonalProjectId(bb);
        const dreamToken = randomUUID();
        store.stageDreamStart(dreamToken, dreamTarget);
        const spawned = await bb.sdk.threads.spawn({
          projectId: personalProjectId,
          providerId: config.providerId,
          model: config.model,
          visibility: "visible",
          environment: { type: "host", workspace: { type: "personal" } },
          input: [
            { type: "text", text: prompt, mentions: [] },
            {
              type: "text",
              text: `[bb-project-bot-dream:${dreamToken}]\nDream consolidation session for ${bot.name} (${bot.id}).`,
              mentions: [],
              visibility: "agent-only",
            },
          ],
        } as Parameters<BbPluginApi["sdk"]["threads"]["spawn"]>[0]);

        dreamThreadId = spawned.id;
        store.setDreamThreadId(dreamThreadId);
        const topBotId = topUnaffiliatedBotId(store);
        if (topBotId) {
          store.bindThread(dreamThreadId, topBotId);
        }
        store.registerDreamSession(dreamThreadId, dreamTarget);
        store.consumeDreamStart(dreamToken);
        await bb.sdk.threads.update({ threadId: dreamThreadId, title: "🌙 Dream Mode" }).catch(() => {});
      }

      await bb.sdk.threads.wait({ threadId: dreamThreadId, status: "idle", timeoutMs: 120_000 });

      const seqUpdates: Record<string, number> = {};
      for (const c of unprocessed) seqUpdates[c.threadId] = c.maxSeq;
      const summary =
        unprocessed.length > 0
          ? `Processed ${unprocessed.length} conversation${unprocessed.length === 1 ? "" : "s"}.`
          : "Pruned stale memory.";

      store.updateDreamState(bot.id, {
        lastDreamAt: Date.now(),
        lastDreamSummary: summary,
        lastDreamError: null,
        processedThreadSeq: seqUpdates,
      });
      publish();

      return {
        botId: bot.id,
        botName: bot.name,
        status: "completed",
        processedConversations: unprocessed.length,
        summary,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.updateDreamState(target.bot.id, { lastDreamError: message });
      publish();
      return {
        botId: target.bot.id,
        botName: target.bot.name,
        status: "error",
        processedConversations: 0,
        summary: message,
      };
    } finally {
      if (dreamThreadId) {
        store.clearDreamSession(dreamThreadId);
      }
    }
  };

  const run = dreamRunChain.catch(() => {}).then(execute);
  dreamRunChain = run;
  return run;
}

export async function runDreamSweep(
  bb: BbPluginApi,
  store: BotStore,
  publish: () => void,
): Promise<DreamRunResult[]> {
  const config = store.getDreamConfig();
  if (!config.enabled || !config.providerId || !config.model) return [];

  const intervalMs = config.intervalMinutes * 60_000;
  const now = Date.now();
  const projects: ProjectSummary[] = await listStandardProjects(bb);
  const targets: ResolvedBotTarget[] = [
    ...store.listUnaffiliatedBots().map((bot): ResolvedBotTarget => ({ kind: "unaffiliated", bot })),
    ...projects
      .map((project) => ({ project, bot: store.readProjectBot(project) }))
      .filter((entry) => entry.bot.materialized)
      .map((entry): ResolvedBotTarget => ({ kind: "project", bot: entry.bot, project: entry.project })),
  ];

  const results: DreamRunResult[] = [];
  let ranCount = 0;
  for (const target of targets) {
    if (ranCount >= 2) break; // gentle cap per sweep tick
    const state = store.getDreamState(target.bot.id);
    if (state.lastDreamAt && now - state.lastDreamAt < intervalMs) continue;
    const result = await runDreamForBot(bb, store, target, publish, { force: false });
    results.push(result);
    if (result.status === "completed") ranCount++;
  }
  return results;
}
