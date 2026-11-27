import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { AVATAR_EXPRESSION_IDS, AVATAR_MOTION_IDS, AVATAR_SHAPE_IDS } from "./lib/appearance";
import { newThreadRequestSchema } from "./lib/new-thread-request";

const id = z.string().min(1);

export const avatarSchema = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  shape: z.enum(AVATAR_SHAPE_IDS),
  expression: z.enum(AVATAR_EXPRESSION_IDS),
  motion: z.enum(AVATAR_MOTION_IDS),
}).strict();
export type BotAvatar = z.infer<typeof avatarSchema>;

export const botRecordSchema = z.object({
  id,
  kind: z.enum(["project", "unaffiliated"]),
  name: z.string().min(1).max(120),
  role: z.string().max(120),
  avatar: avatarSchema,
  soul: z.string().max(8192),
  memory: z.string().max(16384),
  filePath: z.string().min(1),
  directoryPath: z.string().optional(),
  projectId: id.optional(),
  projectPath: z.string().optional(),
  projectHostId: id.optional(),
  fileHash: z.string().optional(),
  materialized: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type BotRecordDto = z.infer<typeof botRecordSchema>;

export const hostSchema = z.object({
  id,
  name: z.string(),
  connected: z.boolean(),
}).strict();

export const memoryToolSchema = z.object({
  action: z.enum(["read", "add", "append", "fact", "lesson", "preference", "forget", "replace"])
    .describe("Operation to perform on the bot's markdown memory file."),
  text: z.string().max(12000).nullish()
    .describe("Memory entry or text body. Required for all actions except read."),
  section: z.enum(["facts", "lessons", "preferences", "notes"]).nullish()
    .describe("Optional section when using action='add' (defaults to 'notes')."),
  confidence: z.enum(["high", "medium", "low"]).nullish()
    .describe("Confidence tag for new entries (default 'high')."),
}).strict();

export const listBotsToolSchema = z.object({
  kind: z.enum(["all", "project", "unaffiliated"]).nullish()
    .describe("Filter by bot kind. Defaults to 'all'."),
}).strict();

export const inspectBotToolSchema = z.object({
  target: z.string().trim().min(1).max(200)
    .describe("Target bot ID, project ID, or exact bot name from list_bots."),
  threadLimit: z.number().int().min(1).max(20).nullish()
    .describe("Maximum number of recent threads to inspect (default 5)."),
}).strict();

export const dreamConfigSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string(),
  model: z.string(),
  intervalMinutes: z.number().int().min(5).max(1440),
}).strict();
export type DreamConfigDto = z.infer<typeof dreamConfigSchema>;

export const dreamStateSummarySchema = z.object({
  botId: id,
  lastDreamAt: z.number().nullable(),
  lastDreamSummary: z.string().nullable(),
  lastDreamError: z.string().nullable(),
}).strict();
export type DreamStateSummaryDto = z.infer<typeof dreamStateSummarySchema>;

export const providerModelsSchema = z.object({
  id: z.string(),
  name: z.string(),
  models: z.array(z.object({ id: z.string(), displayName: z.string(), isDefault: z.boolean() }).strict()),
}).strict();
export type ProviderModelsDto = z.infer<typeof providerModelsSchema>;

export const threadBotInfoSchema = z.object({
  bot: botRecordSchema.nullable(),
  tools: z.array(z.string()),
  instructions: z.string(),
}).strict();
export type ThreadBotInfo = z.infer<typeof threadBotInfoSchema>;

export const pluginSettingsSchema = z.object({
  autoSettle: z.boolean(),
  autoSettleAfterHours: z.number().int().min(1).max(2160),
  autoArchiveSettled: z.boolean(),
  autoArchiveSettledAfterDays: z.number().int().min(0).max(365),
  autoDeleteArchived: z.boolean(),
  autoDeleteArchivedAfterDays: z.number().int().min(1).max(365),
  autoSettleBots: z.boolean(),
  autoSettleBotsAfterHours: z.number().int().min(1).max(8760),
  autoDeleteProjects: z.boolean(),
  autoDeleteProjectsAfterDays: z.number().int().min(1).max(365),
}).strict();
export type PluginSettingsDto = z.infer<typeof pluginSettingsSchema>;

export const SPECIAL_THREAD_ICON_IDS = [
  "rocket",
  "merge",
  "shield",
  "sparkles",
  "flame",
  "compass",
  "wrench",
  "crown",
] as const;
export type SpecialThreadIconId = (typeof SPECIAL_THREAD_ICON_IDS)[number];

export const specialThreadSchema = z.object({
  threadId: id,
  botId: id,
  name: z.string().trim().min(1).max(80),
  icon: z.enum(SPECIAL_THREAD_ICON_IDS),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  instruction: z.string().trim().min(1).max(4000),
  rolePrompt: z.string().trim().max(4000).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
}).strict();
export type SpecialThreadDto = z.infer<typeof specialThreadSchema>;

// --- Decision Inbox & unified message({ text, to?, query? }) schemas ---

export const optionSchema = z.object({
  label: z
    .string()
    .min(1)
    .describe("A few words; the reasoning goes in detail."),
  key: z
    .string()
    .regex(/^[a-z]$/)
    .optional()
    .describe('Its letter, "a".'),
  detail: z.string().optional(),
  recommended: z.boolean().optional().describe("Your pick."),
  preview: z
    .string()
    .optional()
    .describe("Markdown shown beside the option."),
});
export type QuestionOption = z.infer<typeof optionSchema>;

export const scaleSchema = z.object({
  min: z.number().int(),
  max: z.number().int(),
  low: z.string().optional(),
  high: z.string().optional(),
});
export type QuestionScale = z.infer<typeof scaleSchema>;

export const questionKindSchema = z.enum([
  "choice",
  "multi",
  "confirm",
  "text",
  "scale",
]);
export type QuestionKind = z.infer<typeof questionKindSchema>;

export const questionSchema = z.object({
  text: z.string().min(1),
  kind: questionKindSchema,
  ref: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe('Its number, "2".'),
  options: z.array(optionSchema).optional(),
  scale: scaleSchema.optional(),
  placeholder: z.string().optional(),
});
export type Question = z.infer<typeof questionSchema>;

export const messageToolSchema = z.object({
  text: z
    .string()
    .min(1)
    .describe(
      "Message body (Markdown supported). For to='user', this text is always added to the chat as prose; with query, its bold lead or first line also becomes the Inbox title.",
    ),
  to: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      'Recipient (default: "user"). Use "user" for the user, "parent" for the current thread\'s parent thread, a thread ID (e.g. "thr_..."), or a bot ID / project ID / exact bot name from list_bots.',
    ),
  query: z
    .array(questionSchema)
    .optional()
    .describe(
      'With to="user", optional structured decisions/clarifications to get answered in the Inbox and inline in the thread: choice (one option), multi (any), confirm (yes/no), text (typed), scale (min–max with end labels). The card adds "Something else…" and a note field itself. Omit query for normal chat prose (skips Inbox).',
    ),
});
export type MessageToolInput = z.infer<typeof messageToolSchema>;

export const dismissMessageToolSchema = z.object({
  messageId: z
    .number()
    .int()
    .positive()
    .describe("ID of an open Inbox question this thread asked (the `id` returned by `message`, also listed as message #N in your instructions)."),
}).strict();
export type DismissMessageToolInput = z.infer<typeof dismissMessageToolSchema>;

export const answerItemSchema = z.object({
  question: z.string().min(1),
  answer: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
});
export type AnswerItem = z.infer<typeof answerItemSchema>;

export const replyInputSchema = z.object({
  answers: z.array(answerItemSchema).optional(),
  note: z.string().optional(),
  text: z.string().optional(),
});
export type ReplyInput = z.infer<typeof replyInputSchema>;

export const botSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().default(""),
  color: z.string().optional(),
  kind: z.string().optional(),
});
export type BotSummary = z.infer<typeof botSummarySchema>;

export const messageStateSchema = z.enum(["open", "answered", "dismissed", "prose"]);
export type MessageState = z.infer<typeof messageStateSchema>;

export const inboxMessageSchema = z.object({
  id: z.number().int().positive(),
  threadId: z.string().min(1),
  turnId: z.string().nullable(),
  text: z.string(),
  query: z.array(questionSchema).optional(),
  state: messageStateSchema,
  answerText: z.string().nullable(),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
  bot: botSummarySchema.nullable(),
  threadTitle: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
});
export type InboxMessage = z.infer<typeof inboxMessageSchema>;

export const threadOpenCountSchema = z.object({
  openCount: z.number().int().nonnegative(),
  oldestAt: z.number().nullable(),
});
export type ThreadOpenCount = z.infer<typeof threadOpenCountSchema>;

export const INBOX_REALTIME_CHANNEL = "inbox:changed";

export const rpcContract = defineRpcContract({
  sidebar_state: {
    input: z.null(),
    output: z.object({
      projectBots: z.array(botRecordSchema),
      unaffiliatedBots: z.array(botRecordSchema),
      hosts: z.array(hostSchema),
      personalProjectId: id,
      threadBindings: z.array(z.object({ threadId: id, botId: id }).strict()),
      lastViewed: z.array(z.object({ botId: id, threadId: id }).strict()),
      lastUsedAt: z.array(z.object({ botId: id, lastUsedAt: z.number() }).strict()),
      pinnedBotIds: z.array(id),
      settledBotIds: z.array(id),
      settledThreads: z.array(z.object({ threadId: id, settledAt: z.number() }).strict()),
      threadOrder: z.array(z.object({ botId: id, threadIds: z.array(id) }).strict()),
      specialThreads: z.array(specialThreadSchema),
      settings: pluginSettingsSchema,
      dreamConfig: dreamConfigSchema,
      dreamThreadId: id.nullable(),
      dreamStates: z.array(dreamStateSummarySchema),
      rootDir: z.string(),
    }).strict(),
  },
  bot_pin_set: {
    input: z.object({ botId: id, pinned: z.boolean() }).strict(),
    output: z.object({ pinnedBotIds: z.array(id) }).strict(),
  },
  bot_settle_set: {
    input: z.object({ botId: id, settled: z.boolean() }).strict(),
    output: z.object({ settledBotIds: z.array(id) }).strict(),
  },
  thread_settle_set: {
    input: z.object({ threadId: id, settled: z.boolean() }).strict(),
    output: z.object({ settledThreads: z.array(z.object({ threadId: id, settledAt: z.number() }).strict()) }).strict(),
  },
  thread_reorder: {
    input: z.object({ botId: id, threadIds: z.array(id) }).strict(),
    output: z.object({ botId: id, threadIds: z.array(id) }).strict(),
  },
  special_thread_set: {
    input: z.object({
      threadId: id,
      botId: id,
      name: z.string().trim().min(1).max(80),
      icon: z.enum(SPECIAL_THREAD_ICON_IDS),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      instruction: z.string().trim().min(1).max(4000),
      rolePrompt: z.string().trim().max(4000).optional(),
    }).strict(),
    output: specialThreadSchema,
  },
  special_thread_create: {
    input: z.object({
      botId: id,
      name: z.string().trim().min(1).max(80),
      icon: z.enum(SPECIAL_THREAD_ICON_IDS),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      instruction: z.string().trim().min(1).max(4000),
      rolePrompt: z.string().trim().max(4000).optional(),
    }).strict(),
    output: z.object({
      threadId: id,
      special: specialThreadSchema,
    }).strict(),
  },
  special_thread_remove: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  dream_providers: {
    input: z.null(),
    output: z.object({ providers: z.array(providerModelsSchema) }).strict(),
  },
  dream_config_set: {
    input: dreamConfigSchema,
    output: dreamConfigSchema,
  },
  dream_run_now: {
    input: z.object({
      kind: z.enum(["project", "unaffiliated"]),
      botId: id,
      projectId: id.optional(),
      force: z.boolean().optional(),
    }).strict(),
    output: z.object({
      botId: id,
      botName: z.string(),
      status: z.enum(["completed", "skipped", "error"]),
      processedConversations: z.number(),
      summary: z.string(),
    }).strict(),
  },
  conversation_viewed: {
    input: z.object({ threadId: id }).strict(),
    output: z.object({
      botId: id.nullable(),
      materializedNow: z.boolean(),
    }).strict(),
  },
  bot_create_unaffiliated: {
    input: z.object({
      name: z.string().trim().min(1).max(120),
      role: z.string().trim().max(120),
      avatar: avatarSchema,
      soul: z.string().max(8192).optional(),
      memory: z.string().max(12000).optional(),
    }).strict(),
    output: botRecordSchema,
  },
  bot_update: {
    input: z.object({
      kind: z.enum(["project", "unaffiliated"]),
      botId: id,
      projectId: id.optional(),
      name: z.string().trim().min(1).max(120),
      role: z.string().trim().max(120),
      avatar: avatarSchema,
      soul: z.string().max(8192),
      memory: z.string().max(12000),
    }).strict(),
    output: botRecordSchema,
  },
  bot_delete_unaffiliated: {
    input: z.object({ botId: id }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  deliver_message: {
    input: z.object({
      senderThreadId: id.optional(),
      target: z.string().trim().min(1).max(200),
      message: z.string().trim().min(1).max(16000),
      threadId: id.optional(),
      newThread: z.boolean().optional(),
    }).strict(),
    output: z.object({
      botId: id,
      botName: z.string(),
      threadId: id,
      spawned: z.boolean(),
    }).strict(),
  },
  conversation_create: {
    input: z.object({
      kind: z.enum(["project", "unaffiliated"]),
      botId: id,
      request: newThreadRequestSchema,
    }).strict(),
    output: z.object({ threadId: id }).strict(),
  },
  stage_compose_start: {
    input: z.object({ botId: id.nullable() }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  thread_bot_info: {
    input: z.object({ threadId: id }).strict(),
    output: threadBotInfoSchema,
  },
  inbox_list: {
    input: z
      .object({
        includeResolvedToday: z.boolean().optional(),
      })
      .optional(),
    output: z.object({
      open: z.array(inboxMessageSchema),
      resolvedToday: z.array(inboxMessageSchema),
    }),
  },
  thread_messages: {
    input: z.object({
      threadId: z.string().min(1),
    }),
    output: z.object({
      messages: z.array(inboxMessageSchema),
    }),
  },
  get_message: {
    input: z.object({
      messageId: z.number().int().positive(),
    }),
    output: z.object({
      message: inboxMessageSchema.nullable(),
    }),
  },
  answer_message: {
    input: z.object({
      messageId: z.number().int().positive(),
      answers: z.array(answerItemSchema).optional(),
      note: z.string().optional(),
      text: z.string().optional(),
    }),
    output: z.object({
      message: inboxMessageSchema,
    }),
  },
  dismiss_message: {
    input: z.object({
      messageId: z.number().int().positive(),
    }),
    output: z.object({
      message: inboxMessageSchema,
    }),
  },
  open_counts_by_thread: {
    input: z.object({
      keys: z.array(z.string().min(1)).max(200),
    }),
    output: z.record(z.string(), threadOpenCountSchema),
  },
});
