import { randomUUID } from "node:crypto";
import type { BbPluginApi, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import {
  inspectBotToolSchema,
  listBotsToolSchema,
  memoryToolSchema,
  messageToolSchema,
  rpcContract,
} from "./contract";
import { buildBotInstructions, MEMORY_TOOL_GUIDANCE } from "./lib/bot-instructions";
import { createBotStore, type BotRecord, type ProjectSummary } from "./lib/bot-store";
import { DREAM_MARKER, runDreamForBot, runDreamSweep } from "./lib/dream-runner";
import { createInboxService } from "./lib/inbox-server";
import {
  findBotTarget,
  getPersonalProjectId,
  inspectBot,
  listAllBots,
  listStandardProjects,
  resolveThreadBot,
  resolveUnaffiliatedOwner,
  sendBotMessage,
  START_MARKER,
} from "./lib/messaging";

export { rpcContract, avatarSchema } from "./contract";
export type { BotAvatar, BotRecordDto, DreamConfigDto, DreamStateSummaryDto, PluginSettingsDto, ProviderModelsDto } from "./contract";

const CHANGED = "project-bots-changed";

const CLI_USAGE = `bb project-bots list [--json]
bb project-bots inspect <bot-id-or-name> [--json]
bb project-bots message <bot-id-or-name> <message> [--thread <thread-id>] [--new-thread] [--json]
bb project-bots dream <bot-id-or-name> [--force] [--json]`;

export function createProjectBotsServer(options?: { rootDir?: string }) {
  return async function plugin(bb: BbPluginApi) {
    const store = createBotStore(options?.rootDir);
    const publish = () => bb.realtime.publish(CHANGED, { updatedAt: Date.now() });
    const inbox = createInboxService(bb, store, publish);

    const settingsHandle = bb.settings.define({
      autoSettle: {
        type: "boolean",
        label: "Auto-settle idle threads",
        description: "Fold idle threads behind a Settled toggle after the idle threshold (always keeps the most recent thread per bot).",
        default: true,
      },
      autoSettleAfterHours: {
        type: "number",
        label: "Auto-settle threads after (hours idle)",
        description: "Hours of inactivity before a thread settles (1–2160). Default 72 (3 days).",
        default: 72,
      },
      dreamEnabled: {
        type: "boolean",
        label: "Enable automatic Dream Mode",
        description: "Automatically consolidate unprocessed conversations into bot memory when there is activity in the dream window.",
        default: false,
      },
      dreamIntervalMinutes: {
        type: "number",
        label: "Dream cadence per bot (minutes)",
        description: "How often each active bot runs Dream Mode (5–1440 minutes). Default 60.",
        default: 60,
      },
    });

    async function readPluginSettings() {
      const raw = await settingsHandle.get().catch(() => ({} as Record<string, unknown>));
      const autoSettle = typeof raw.autoSettle === "boolean" ? raw.autoSettle : true;
      const hoursRaw = typeof raw.autoSettleAfterHours === "number" ? raw.autoSettleAfterHours : 72;
      const autoSettleAfterHours = Math.max(1, Math.min(2160, Math.round(hoursRaw)));
      return { autoSettle, autoSettleAfterHours };
    }

    // Cache standard projects (including sources/paths) so synchronous agents.configure
    // always hashes the real filesystem path rather than falling back to project.id.
    const projectCache = new Map<string, ProjectSummary>();
    async function refreshProjectCache(): Promise<ProjectSummary[]> {
      const projects = await listStandardProjects(bb);
      projectCache.clear();
      for (const p of projects) projectCache.set(p.id, p);
      return projects;
    }
    await refreshProjectCache().catch(() => {});

    const locks = new Map<string, Promise<unknown>>();
    function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const run = (locks.get(key) ?? Promise.resolve()).catch(() => {}).then(fn);
      locks.set(key, run);
      void run.finally(() => {
        if (locks.get(key) === run) locks.delete(key);
      }).catch(() => {});
      return run;
    }

    function unaffiliatedOwnerSync(thread: { id: string; parentThreadId?: string | null; sourceThreadId?: string | null }): string | null {
      const direct = store.threadBinding(thread.id);
      if (direct) return direct;
      if (thread.parentThreadId) {
        const fromParent = store.threadBinding(thread.parentThreadId);
        if (fromParent) return fromParent;
      }
      if (thread.sourceThreadId) {
        const fromSource = store.threadBinding(thread.sourceThreadId);
        if (fromSource) return fromSource;
      }
      return null;
    }

    function configForBot(bot: BotRecord) {
      return {
        tools: ["update_memory_state", "list_bots", "inspect_bot", "message"],
        skills: ["project-bots", "inbox"],
        instructions: buildBotInstructions(bot),
      };
    }

    function toProjectSummary(project: PluginAgentConfigurationContext["project"]): ProjectSummary {
      const cached = projectCache.get(project.id);
      const sources =
        "sources" in project && Array.isArray(project.sources) && project.sources.length > 0
          ? (project.sources as ProjectSummary["sources"])
          : cached?.sources;
      return {
        id: project.id,
        kind: project.kind,
        name: project.name,
        sources,
      };
    }

    // Configure every thread's agent context automatically:
    // - Hidden Dream Mode threads get ONLY update_memory_state scoped to the target bot
    // - Unaffiliated bot threads get coordinator instructions + memory
    // - Standard project threads automatically get their project's file-backed bot
    bb.agents.configure((ctx) => {
      const dreamSession = store.getDreamSession(ctx.thread.id);
      if (dreamSession || ctx.thread.id === store.getDreamThreadId()) {
        return {
          tools: ["update_memory_state"],
          skills: [],
          instructions:
            "You are the shared Dream Mode agent instance consolidating a bot's markdown memory file. Only use `update_memory_state` to update the target bot's memory file. Do not edit project code or run repository commands.",
        };
      }
      const unaffiliatedId = unaffiliatedOwnerSync(ctx.thread);
      if (unaffiliatedId) {
        const bot = store.readUnaffiliatedBot(unaffiliatedId);
        if (bot) return configForBot(bot);
      }
      if (ctx.project.kind === "standard") {
        const { bot, created } = store.ensureProjectBot(toProjectSummary(ctx.project));
        if (created) publish();
        return configForBot(bot);
      }
      return { tools: ["message"], skills: ["inbox"] };
    });

    bb.agents.contributeInstructions(({ threadId }) =>
      inbox.openQuestionsInstruction(threadId),
    );

    // Unified message({ text, to?, query? }) tool for all user and cross-bot communication
    bb.agents.registerTool({
      name: "message",
      description:
        'Primary communication tool. Sends `text` to the user (default to="user"), to another bot (by botId, projectId, or exact bot name), to a thread (thr_...), or to "parent". For to="user", copy the returned `previewDirective` onto its own line in your response (not in a code fence, without repeating `text`) so BB renders it in chat. Add `query` when you need important clarifications or decisions answered — that also queues an interactive answer card in the Inbox.',
      instructions:
        'Prefer `message({ text, to?, query? })` for all communication. With default `to: "user"`, always copy the returned `previewDirective` (`::inbox-message{id="..."}`) into your response exactly once as a standalone line (not in backticks or a code fence) and do not repeat `text` — BB renders it as chat prose (skipping the Inbox when `query` is omitted) or as an interactive decision card + Inbox item when `query` is provided. Use `to: "<botId | projectId | botName | threadId | parent>"` (without `query`) for cross-bot or cross-thread communication.',
      presentation: {
        label: {
          pending: "Sending message",
          completed: "Sent message",
        },
        icon: { glyph: "Inbox" },
      },
      parameters: messageToolSchema,
      execute: (input, ctx) => inbox.executeMessageTool(input, ctx),
    });

    // 1. update_memory_state: manages the bot's markdown file directly
    bb.agents.registerTool({
      name: "update_memory_state",
      description:
        "Read or update this bot's persistent markdown memory file. Supports actions: read, add, append, fact, lesson, preference, forget, replace.",
      instructions: MEMORY_TOOL_GUIDANCE,
      parameters: memoryToolSchema,
      execute: async (input, ctx) => {
        const dreamSession = store.getDreamSession(ctx.threadId);
        let target: Awaited<ReturnType<typeof resolveThreadBot>> = null;
        if (dreamSession) {
          if (dreamSession.kind === "unaffiliated") {
            const bot = store.readUnaffiliatedBot(dreamSession.botId);
            if (bot) target = { kind: "unaffiliated", bot };
          } else if (dreamSession.projectId) {
            const projects = await refreshProjectCache();
            const project = projects.find((p) => p.id === dreamSession.projectId);
            if (project) target = { kind: "project", project, bot: store.ensureProjectBot(project).bot };
          }
        } else {
          target = await resolveThreadBot(bb, store, ctx.threadId, true);
        }
        if (!target) throw new Error("This conversation does not belong to a project bot or unaffiliated bot.");
        return serial(target.bot.id, async () => {
          const op = {
            action: input.action,
            text: input.text ?? undefined,
            section: input.section ?? undefined,
            confidence: input.confidence ?? undefined,
          };
          const result = store.updateBotMemory(
            target.kind === "project"
              ? { kind: "project", project: target.project }
              : { kind: "unaffiliated", botId: target.bot.id },
            op,
          );
          if (result.changed) publish();
          return JSON.stringify({
            botId: result.bot.id,
            kind: result.bot.kind,
            filePath: result.bot.filePath,
            changed: result.changed,
            summary: result.summary,
            memory: result.bot.memory,
          });
        });
      },
    });

    // 2. list_bots: discover all project bots and unaffiliated bots
    bb.agents.registerTool({
      name: "list_bots",
      description:
        "List all available bots (both unaffiliated coordinator bots and every project's automatic project bot) with their IDs, names, project paths, and activity status.",
      parameters: listBotsToolSchema,
      execute: async (input) => {
        const bots = await listAllBots(bb, store);
        const filter = input.kind ?? "all";
        const filtered = filter === "all" ? bots : bots.filter((b) => b.kind === filter);
        return JSON.stringify({ bots: filtered, total: filtered.length });
      },
    });

    // 2b. inspect_bot: check a bot's recent turns AND all queued follow-ups before re-steering
    bb.agents.registerTool({
      name: "inspect_bot",
      description:
        "Inspect another bot's active/recent threads, recent conversation turns, AND all queued follow-up messages so you have full context and avoid redundant re-steering.",
      parameters: inspectBotToolSchema,
      execute: async (input) => {
        const result = await inspectBot(bb, store, input.target, input.threadLimit ?? 5);
        return JSON.stringify(result);
      },
    });

    // Bind new unaffiliated bot threads & dream sessions on first dispatch, and auto-generate project bot files
    bb.experimental_hooks.on("message.dispatch", async (ctx) => {
      // Any new message dispatched to a settled thread wakes it automatically
      store.setThreadSettled(ctx.thread.id, false);
      for (const block of ctx.input.blocks) {
        if (block.type !== "text" || block.visibility !== "agent-only") continue;
        const dreamToken = block.text.match(DREAM_MARKER)?.[1];
        if (dreamToken) {
          const dreamTarget = store.consumeDreamStart(dreamToken);
          if (dreamTarget) {
            store.registerDreamSession(ctx.thread.id, dreamTarget);
            return { action: "proceed" };
          }
        }
        const token = block.text.match(START_MARKER)?.[1];
        if (!token) continue;
        const staged = store.consumeStart(token);
        if (staged && staged.kind === "unaffiliated") {
          store.bindThread(ctx.thread.id, staged.botId);
          store.touchUsed(staged.botId);
          publish();
          return { action: "proceed" };
        }
      }

      const inherited = await resolveUnaffiliatedOwner(bb, store, ctx.thread.id, true);
      if (inherited) {
        store.touchUsed(inherited);
        publish();
        return { action: "proceed" };
      }

      const stagedBotId = store.consumeComposeTarget(ctx.thread.projectId);
      if (stagedBotId && store.readUnaffiliatedBot(stagedBotId)) {
        store.bindThread(ctx.thread.id, stagedBotId);
        store.rememberViewed(stagedBotId, ctx.thread.id);
        publish();
        return { action: "proceed" };
      }

      // Auto-generate project bot file on first dispatch in a standard project
      const projects = await refreshProjectCache();
      const project = projects.find((p) => p.id === ctx.thread.projectId);
      if (project) {
        const { bot, created } = store.ensureProjectBot(project);
        store.touchUsed(bot.id);
        if (created) publish();
      }
      return { action: "proceed" };
    });

    bb.events.on("thread.created", async ({ thread }) => {
      if (thread.visibility === "hidden" || store.getDreamSession(thread.id)) return;
      const inherited = await resolveUnaffiliatedOwner(bb, store, thread.id, true);
      if (inherited) {
        store.touchUsed(inherited);
        publish();
        return;
      }
      const stagedBotId = store.consumeComposeTarget(thread.projectId);
      if (stagedBotId && store.readUnaffiliatedBot(stagedBotId)) {
        store.bindThread(thread.id, stagedBotId);
        store.rememberViewed(stagedBotId, thread.id);
        publish();
        return;
      }
      const projects = await refreshProjectCache();
      const project = projects.find((p) => p.id === thread.projectId);
      if (project) {
        const { bot, created } = store.ensureProjectBot(project);
        store.touchUsed(bot.id);
        if (created) publish();
      }
    });

    // Automatic Dream Mode background schedule (checks every 15 minutes for bots due to dream)
    bb.background.schedule("dream-sweep", "*/15 * * * *", async () => {
      await runDreamSweep(bb, store, publish);
    });

    // CLI: bb project-bots list | message
    bb.cli.register({
      name: "project-bots",
      summary: "List project bots & unaffiliated bots and send attributed messages between them",
      commands: [
        { name: "list", summary: "List all project bots and unaffiliated bots", usage: "bb project-bots list [--json]" },
        {
          name: "inspect",
          summary: "Inspect a bot's recent threads, turns, and queued follow-up messages",
          usage: "bb project-bots inspect <bot-id-or-name> [--json]",
        },
        {
          name: "message",
          summary: "Send an asynchronous message to a project bot or unaffiliated bot",
          usage: "bb project-bots message <bot-id-or-name> <message> [--thread <id>] [--new-thread] [--json]",
        },
        {
          name: "dream",
          summary: "Run Dream Mode memory consolidation for a bot now",
          usage: "bb project-bots dream <bot-id-or-name> [--force] [--json]",
        },
      ],
      async run(argv, ctx) {
        try {
          const [sub, ...rest] = argv;
          if (!sub || sub === "help" || sub === "--help") {
            return { exitCode: 0, stdout: CLI_USAGE };
          }
          const json = rest.includes("--json");
          if (sub === "list") {
            const bots = await listAllBots(bb, store);
            if (json) return { exitCode: 0, stdout: JSON.stringify({ bots, total: bots.length }) };
            const lines = [
              "BOT ID\tKIND\tNAME\tSTATUS\tDEFAULT THREAD\tPROJECT PATH",
              ...bots.map((b) =>
                [b.id, b.kind, b.name, b.status, b.defaultThreadId ?? "—", b.projectPath ?? "—"].join("\t"),
              ),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          if (sub === "inspect") {
            const selector = rest.find((arg) => !arg.startsWith("--"));
            if (!selector) return { exitCode: 1, stderr: `Usage:\n${CLI_USAGE}` };
            const info = await inspectBot(bb, store, selector);
            if (json) return { exitCode: 0, stdout: JSON.stringify(info) };
            const lines = [
              `${info.name} (${info.id}, ${info.kind}) — status: ${info.status}, queued follow-ups: ${info.totalQueuedFollowUps}`,
              ...info.threads.flatMap((t) => [
                `  Thread ${t.threadId} [${t.status}] ${t.title} (${t.queuedFollowUps.length} queued)`,
                ...t.queuedFollowUps.map((q) => `    [queued:${q.state}] (${q.initiator}) ${q.text.replace(/\s+/g, " ").slice(0, 160)}`),
              ]),
            ];
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          if (sub === "message") {
            let threadId: string | undefined;
            let newThread = false;
            const positional: string[] = [];
            for (let i = 0; i < rest.length; i++) {
              const arg = rest[i]!;
              if (arg === "--json") continue;
              if (arg === "--new-thread") {
                newThread = true;
                continue;
              }
              if (arg === "--thread") {
                threadId = rest[++i];
                continue;
              }
              positional.push(arg);
            }
            const [target, message] = positional;
            if (!target || !message) {
              return { exitCode: 1, stderr: `Usage:\n${CLI_USAGE}` };
            }
            const result = await sendBotMessage(
              bb,
              store,
              { senderThreadId: ctx.threadId ?? undefined, target, message, threadId, newThread },
              publish,
            );
            return {
              exitCode: 0,
              stdout: json
                ? JSON.stringify(result)
                : `Delivered to ${result.botName} (${result.botId}) in thread ${result.threadId}${result.spawned ? " (new thread)" : ""}.`,
            };
          }
          if (sub === "dream") {
            const selector = rest.find((arg) => !arg.startsWith("--"));
            if (!selector) return { exitCode: 1, stderr: `Usage:\n${CLI_USAGE}` };
            const force = rest.includes("--force");
            const target = await findBotTarget(bb, store, selector);
            const result = await runDreamForBot(bb, store, target, publish, { force });
            return {
              exitCode: result.status === "error" ? 1 : 0,
              stdout: json ? JSON.stringify(result) : `${result.botName} (${result.status}): ${result.summary}`,
            };
          }
          return { exitCode: 1, stderr: `Unknown command: ${sub}\n${CLI_USAGE}` };
        } catch (error) {
          return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) };
        }
      },
    });

    // @ mentions for project bots and unaffiliated bots
    bb.ui.registerMentionProvider({
      id: "project-bots",
      label: "Project Bots",
      triggers: ["@"],
      async search({ trigger, query }) {
        if (trigger !== "@") return [];
        const needle = query.trim().toLowerCase();
        const bots = await listAllBots(bb, store);
        return bots
          .filter(
            (b) =>
              !needle ||
              b.name.toLowerCase().includes(needle) ||
              b.role.toLowerCase().includes(needle) ||
              b.id.toLowerCase().includes(needle),
          )
          .slice(0, 30)
          .map((b) => ({
            id: b.id,
            title: b.name,
            subtitle: `${b.kind === "unaffiliated" ? "Coordinator" : "Project Bot"} · ${b.id}`,
            icon: "Bot",
          }));
      },
      async resolve(itemId) {
        const bots = await listAllBots(bb, store);
        const bot = bots.find((b) => b.id === itemId);
        if (!bot) throw new Error(`Bot ${itemId} not found.`);
        return {
          context: [
            `Referenced ${bot.kind} bot: ${bot.name} (id: ${bot.id}${bot.projectPath ? `, project: ${bot.projectPath}` : ""}).`,
            `To coordinate with or delegate to this bot, call \`message({ to: "${bot.id}", text: "..." })\`.`,
          ].join("\n"),
        };
      },
    });

    // RPC handlers for the sidebar app
    bb.rpc.register(rpcContract, {
      sidebar_state: async () => {
        const [projects, hosts, personalProjectId, settings] = await Promise.all([
          refreshProjectCache(),
          bb.sdk.hosts.list(),
          getPersonalProjectId(bb),
          readPluginSettings(),
        ]);
        const projectBots = projects.map((project) => store.readProjectBot(project));
        const unaffiliatedBots = store.listUnaffiliatedBots();
        return {
          projectBots,
          unaffiliatedBots,
          hosts: hosts.map((host) => ({ id: host.id, name: host.name, connected: host.status === "connected" })),
          personalProjectId,
          threadBindings: store.allBindings(),
          lastViewed: store.allLastViewed(),
          lastUsedAt: store.allLastUsedAt(),
          pinnedBotIds: store.pinnedBotIds(),
          settledBotIds: store.settledBotIds(),
          settledThreads: store.allSettledThreads(),
          settings,
          dreamConfig: store.getDreamConfig(),
          dreamThreadId: store.getDreamThreadId(),
          dreamStates: store.allDreamStates(),
          rootDir: store.rootDir,
        };
      },

      bot_pin_set: async ({ botId, pinned }) => {
        if (pinned) store.setSettled(botId, false);
        const pinnedBotIds = store.setPinned(botId, pinned);
        publish();
        return { pinnedBotIds };
      },

      bot_settle_set: async ({ botId, settled }) => {
        const settledBotIds = store.setSettled(botId, settled);
        publish();
        return { settledBotIds };
      },

      thread_settle_set: async ({ threadId, settled }) => {
        const settledThreads = store.setThreadSettled(threadId, settled);
        publish();
        return { settledThreads };
      },

      dream_providers: async () => {
        const providerList = await bb.sdk.providers.list().catch(() => []);
        const results = await Promise.all(
          providerList.map(async (p) => {
            const resp = await bb.sdk.providers.models({ providerId: p.id }).catch(() => null);
            return {
              id: p.id,
              name: p.displayName || p.id,
              models: (resp?.models ?? []).map((m) => ({
                id: m.model || m.id,
                displayName: m.displayName || m.model || m.id,
                isDefault: Boolean(m.isDefault),
              })),
            };
          }),
        );
        return { providers: results };
      },

      dream_config_set: async (config) => {
        const saved = store.setDreamConfig(config);
        publish();
        return saved;
      },

      dream_run_now: async ({ kind, botId, projectId, force }) => {
        if (kind === "unaffiliated") {
          const bot = store.readUnaffiliatedBot(botId);
          if (!bot) throw new Error("Unaffiliated bot not found.");
          return runDreamForBot(bb, store, { kind: "unaffiliated", bot }, publish, { force: force ?? true });
        }
        const projects = await refreshProjectCache();
        const project = projects.find((p) => p.id === projectId || store.readProjectBot(p).id === botId);
        if (!project) throw new Error("Project for this bot was not found.");
        return runDreamForBot(
          bb,
          store,
          { kind: "project", project, bot: store.readProjectBot(project) },
          publish,
          { force: force ?? true },
        );
      },

      // Auto-generates the project bot's <hash6>.md file on the first time you enter a thread of the project!
      conversation_viewed: async ({ threadId }) => {
        const unaffiliatedId = await resolveUnaffiliatedOwner(bb, store, threadId, true);
        if (unaffiliatedId) {
          if (store.rememberViewed(unaffiliatedId, threadId)) publish();
          return { botId: unaffiliatedId, materializedNow: false };
        }
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        if (!thread) return { botId: null, materializedNow: false };
        const projects = await listStandardProjects(bb);
        const project = projects.find((p) => p.id === thread.projectId);
        if (!project) return { botId: null, materializedNow: false };
        const { bot, created } = store.ensureProjectBot(project);
        const remembered = store.rememberViewed(bot.id, threadId);
        if (created || remembered) publish();
        return { botId: bot.id, materializedNow: created };
      },

      bot_create_unaffiliated: async (input) =>
        serial("registry", async () => {
          const created = store.createUnaffiliatedBot(input);
          publish();
          return created;
        }),

      bot_update: async (input) =>
        serial(input.botId, async () => {
          if (input.kind === "unaffiliated") {
            const updated = store.updateUnaffiliatedBot(input.botId, {
              name: input.name,
              role: input.role,
              avatar: input.avatar,
              soul: input.soul,
              memory: input.memory,
            });
            publish();
            return updated;
          }
          const projects = await listStandardProjects(bb);
          const project = projects.find(
            (p) => p.id === input.projectId || store.readProjectBot(p).id === input.botId,
          );
          if (!project) throw new Error("Project for this bot was not found.");
          const updated = store.updateProjectBot(project, {
            name: input.name,
            role: input.role,
            avatar: input.avatar,
            soul: input.soul,
            memory: input.memory,
          });
          publish();
          return updated;
        }),

      bot_delete_unaffiliated: async ({ botId }) =>
        serial(botId, async () => {
          store.deleteUnaffiliatedBot(botId);
          publish();
          return { ok: true as const };
        }),

      deliver_message: async (input) =>
        sendBotMessage(
          bb,
          store,
          {
            senderThreadId: input.senderThreadId,
            target: input.target,
            message: input.message,
            threadId: input.threadId,
            newThread: input.newThread,
          },
          publish,
        ),

      conversation_create: async ({ kind, botId, request }) => {
        if (kind === "project") {
          const projects = await listStandardProjects(bb);
          const project = projects.find((p) => p.id === request.projectId);
          if (project) store.ensureProjectBot(project);
          const thread = await bb.sdk.threads.spawn(request);
          store.rememberViewed(botId, thread.id);
          publish();
          return { threadId: thread.id };
        }

        const bot = store.readUnaffiliatedBot(botId);
        if (!bot) throw new Error("Unaffiliated bot not found.");
        const personalProjectId = await getPersonalProjectId(bb);
        const token = randomUUID();
        store.stageStart(token, { botId: bot.id, kind: "unaffiliated", projectId: personalProjectId });
        const thread = await bb.sdk.threads.spawn({
          ...request,
          projectId: personalProjectId,
          input: [
            ...request.input,
            {
              type: "text",
              text: `[bb-project-bot-start:${token}]\nThis conversation belongs to unaffiliated coordinator bot ${bot.name} (${bot.id}).`,
              mentions: [],
              visibility: "agent-only",
            },
          ],
        });
        store.bindThread(thread.id, bot.id);
        store.consumeStart(token);
        store.rememberViewed(bot.id, thread.id);
        publish();
        return { threadId: thread.id };
      },

      stage_compose_start: async ({ botId }) => {
        if (!botId) {
          store.stageComposeTarget(null, null);
          return { ok: true as const };
        }
        if (!store.readUnaffiliatedBot(botId)) throw new Error("Unaffiliated bot not found.");
        const personalProjectId = await getPersonalProjectId(bb);
        store.stageComposeTarget(botId, personalProjectId);
        return { ok: true as const };
      },

      thread_bot_info: async ({ threadId }) => {
        const resolved = await resolveThreadBot(bb, store, threadId, false);
        if (!resolved) return { bot: null, tools: [], instructions: "" };
        const cfg = configForBot(resolved.bot);
        return {
          bot: resolved.bot,
          tools: cfg.tools,
          instructions: cfg.instructions,
        };
      },

      inbox_list: async (input) =>
        inbox.listInbox(input?.includeResolvedToday ?? true),

      thread_messages: async ({ threadId }) => ({
        messages: inbox.listThreadMessages(threadId),
      }),

      get_message: async ({ messageId }) => ({
        message: inbox.getMessage(messageId),
      }),

      answer_message: async ({ messageId, answers, note, text }) => ({
        message: await inbox.answerMessage(messageId, { answers, note, text }),
      }),

      dismiss_message: async ({ messageId }) => ({
        message: inbox.dismissMessage(messageId),
      }),

      open_counts_by_thread: async ({ keys }) =>
        inbox.openCountsByThread(keys),
    });

    bb.onInstall(async () => {
      const INBOX_PANEL_KEY = "bb-project-bots/inbox";
      try {
        const { preferences } = await bb.sdk.system.uiPreferences.list();
        const orderEntry = preferences["sidebar.pluginPanelOrder"];
        const visibleEntry = preferences["sidebar.visiblePluginPanels"];
        const currentOrder = Array.isArray(orderEntry.value) ? orderEntry.value : [];
        await bb.sdk.system.uiPreferences.set({
          key: "sidebar.pluginPanelOrder",
          value: [INBOX_PANEL_KEY, ...currentOrder.filter((id) => id !== INBOX_PANEL_KEY && id !== "inbox/inbox")],
          expectedRevision: orderEntry.revision,
        });
        if (Array.isArray(visibleEntry.value)) {
          const filtered = visibleEntry.value.filter((id) => id !== "inbox/inbox");
          if (!filtered.includes(INBOX_PANEL_KEY)) {
            await bb.sdk.system.uiPreferences.set({
              key: "sidebar.visiblePluginPanels",
              value: [INBOX_PANEL_KEY, ...filtered],
              expectedRevision: visibleEntry.revision,
            });
          }
        }
      } catch (error) {
        bb.log.warn(
          `Could not pin Inbox to top of sidebar on install: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
  };
}

export default createProjectBotsServer();
