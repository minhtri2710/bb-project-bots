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
}).strict();
export type PluginSettingsDto = z.infer<typeof pluginSettingsSchema>;

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
});
