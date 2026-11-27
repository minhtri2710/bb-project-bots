import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BotAvatar } from "./appearance";
import { specialThreadSchema, type SpecialThreadDto, type SpecialThreadIconId } from "../contract";
import {
  applyMemoryOperation,
  DEFAULT_MEMORY_TEMPLATE,
  defaultProjectSoul,
  defaultUnaffiliatedSoul,
  deterministicAvatar,
  isValidColor,
  isValidExpression,
  isValidMotion,
  isValidShape,
  parseBotMarkdown,
  projectBotHash,
  projectBotIdForPath,
  serializeBotMarkdown,
  type BotFrontmatter,
  type BotKind,
  type MemoryOperation,
} from "./bot-file";

export type ProjectSummary = {
  id: string;
  kind: "standard" | "personal";
  name: string;
  sources?: Array<{ id: string; hostId: string; path: string; isDefault: boolean }>;
};

export type BotRecord = {
  id: string;
  kind: BotKind;
  name: string;
  role: string;
  avatar: BotAvatar;
  soul: string;
  memory: string;
  filePath: string;
  directoryPath?: string;
  projectId?: string;
  projectPath?: string;
  projectHostId?: string;
  fileHash?: string;
  materialized: boolean;
  createdAt: number;
  updatedAt: number;
};

export type DreamConfig = {
  enabled: boolean;
  providerId: string;
  model: string;
  intervalMinutes: number;
};

export type BotDreamState = {
  lastDreamAt: number | null;
  lastDreamSummary: string | null;
  lastDreamError: string | null;
  processedThreadSeq: Record<string, number>;
};

export type SpecialThreadRecord = SpecialThreadDto;

type RuntimeState = {
  threadBindings: Record<string, string>;
  lastViewed: Record<string, string>;
  // Per bot: the last regular (non-Special) thread opened in the sidebar or started by this plugin; message({ to: botId }) routes here.
  routingThreads: Record<string, string>;
  lastUsedAt: Record<string, number>;
  pinnedBotIds: string[];
  settledBotIds: string[];
  settledThreads: Record<string, number>;
  threadOrder: Record<string, string[]>;
  specialThreads: Record<string, SpecialThreadRecord>;
  dreamConfig: DreamConfig;
  dreamThreadId: string | null;
  dreamState: Record<string, BotDreamState>;
};

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: false,
  providerId: "",
  model: "",
  intervalMinutes: 60,
};

export type DreamSessionTarget = {
  botId: string;
  kind: BotKind;
  projectId?: string;
};

type PendingStart = {
  botId: string;
  kind: BotKind;
  projectId: string;
  createdAt: number;
};

function atomicWrite(filePath: string, content: string): void {
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, filePath);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup errors
    }
    throw error;
  }
}

export function resolveProjectPath(project: ProjectSummary): string {
  const defaultSource = project.sources?.find((source) => source.isDefault) ?? project.sources?.[0];
  return defaultSource?.path?.trim() || project.id;
}

export function resolveProjectHostId(project: ProjectSummary): string | undefined {
  const defaultSource = project.sources?.find((source) => source.isDefault) ?? project.sources?.[0];
  return defaultSource?.hostId || undefined;
}

export function defaultRootDir(): string {
  return process.env.BB_PROJECT_BOTS_DIR?.trim() || join(homedir(), ".bb", "project-bots");
}

function assertSafeBotId(botId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(botId)) {
    throw new Error(`Invalid bot ID: ${botId}`);
  }
}

function buildAvatar(fm: Partial<BotFrontmatter>, fallback: BotAvatar): BotAvatar {
  return {
    color: isValidColor(fm.color) ? fm.color : fallback.color,
    shape: isValidShape(fm.shape) ? fm.shape : fallback.shape,
    expression: isValidExpression(fm.expression) ? fm.expression : fallback.expression,
    motion: isValidMotion(fm.motion) ? fm.motion : fallback.motion,
  };
}

export function createBotStore(rootDir: string = defaultRootDir()) {
  const unaffiliatedRoot = join(rootDir, "unaffiliated");
  const statePath = join(rootDir, ".state.json");
  const pendingStarts = new Map<string, PendingStart>();
  const pendingDreams = new Map<string, DreamSessionTarget & { createdAt: number }>();
  const dreamSessions = new Map<string, DreamSessionTarget>();
  let stagedCompose: { botId: string; projectId: string; expiresAt: number } | null = null;

  function ensureDirs(): void {
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(unaffiliatedRoot, { recursive: true });
  }

  function loadState(): RuntimeState {
    if (!existsSync(statePath)) {
      return {
        threadBindings: {},
        lastViewed: {},
        routingThreads: {},
        lastUsedAt: {},
        pinnedBotIds: [],
        settledBotIds: [],
        settledThreads: {},
        threadOrder: {},
        specialThreads: {},
        dreamConfig: { ...DEFAULT_DREAM_CONFIG },
        dreamThreadId: null,
        dreamState: {},
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Partial<RuntimeState>;
      const dc = parsed.dreamConfig;
      const rawThreadOrder =
        parsed.threadOrder && typeof parsed.threadOrder === "object" && !Array.isArray(parsed.threadOrder)
          ? parsed.threadOrder
          : {};
      const cleanThreadOrder: Record<string, string[]> = {};
      for (const [botId, ids] of Object.entries(rawThreadOrder)) {
        if (!Array.isArray(ids)) continue;
        const validIds = ids.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
        if (validIds.length > 0) cleanThreadOrder[botId] = [...new Set(validIds)];
      }

      const rawSpecials =
        parsed.specialThreads && typeof parsed.specialThreads === "object" && !Array.isArray(parsed.specialThreads)
          ? parsed.specialThreads
          : {};
      const cleanSpecials: Record<string, SpecialThreadRecord> = {};
      for (const [threadId, value] of Object.entries(rawSpecials)) {
        const res = specialThreadSchema.safeParse(value);
        if (res.success && res.data.threadId === threadId) {
          cleanSpecials[threadId] = res.data;
        }
      }

      return {
        threadBindings: parsed.threadBindings && typeof parsed.threadBindings === "object" ? parsed.threadBindings : {},
        lastViewed: parsed.lastViewed && typeof parsed.lastViewed === "object" ? parsed.lastViewed : {},
        routingThreads: parsed.routingThreads && typeof parsed.routingThreads === "object" ? parsed.routingThreads : {},
        lastUsedAt: parsed.lastUsedAt && typeof parsed.lastUsedAt === "object" ? parsed.lastUsedAt : {},
        pinnedBotIds: Array.isArray(parsed.pinnedBotIds) ? parsed.pinnedBotIds.filter((x): x is string => typeof x === "string") : [],
        settledBotIds: Array.isArray(parsed.settledBotIds) ? parsed.settledBotIds.filter((x): x is string => typeof x === "string") : [],
        settledThreads: parsed.settledThreads && typeof parsed.settledThreads === "object" ? parsed.settledThreads : {},
        threadOrder: cleanThreadOrder,
        specialThreads: cleanSpecials,
        dreamConfig: {
          enabled: Boolean(dc?.enabled),
          providerId: typeof dc?.providerId === "string" ? dc.providerId : "",
          model: typeof dc?.model === "string" ? dc.model : "",
          intervalMinutes: typeof dc?.intervalMinutes === "number" && dc.intervalMinutes >= 5 ? dc.intervalMinutes : 60,
        },
        dreamThreadId: typeof parsed.dreamThreadId === "string" && parsed.dreamThreadId ? parsed.dreamThreadId : null,
        dreamState: parsed.dreamState && typeof parsed.dreamState === "object" ? parsed.dreamState : {},
      };
    } catch {
      return {
        threadBindings: {},
        lastViewed: {},
        routingThreads: {},
        lastUsedAt: {},
        pinnedBotIds: [],
        settledBotIds: [],
        settledThreads: {},
        threadOrder: {},
        specialThreads: {},
        dreamConfig: { ...DEFAULT_DREAM_CONFIG },
        dreamThreadId: null,
        dreamState: {},
      };
    }
  }

  function saveState(state: RuntimeState): void {
    ensureDirs();
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  function projectBotFilePath(projectPath: string): { fileHash: string; filePath: string } {
    const fileHash = projectBotHash(projectPath);
    return { fileHash, filePath: join(rootDir, `${fileHash}.md`) };
  }

  function buildProjectFrontmatter(project: ProjectSummary, projectPath: string, now: number): BotFrontmatter {
    const avatar = deterministicAvatar(projectPath);
    return {
      id: projectBotIdForPath(projectPath),
      kind: "project",
      projectId: project.id,
      projectPath,
      name: project.name,
      role: "Project Bot",
      color: avatar.color,
      shape: avatar.shape,
      expression: avatar.expression,
      motion: avatar.motion,
      soul: defaultProjectSoul(project.name),
      createdAt: now,
      updatedAt: now,
    };
  }

  function readProjectBot(project: ProjectSummary): BotRecord {
    const projectPath = resolveProjectPath(project);
    const projectHostId = resolveProjectHostId(project);
    const { fileHash, filePath } = projectBotFilePath(projectPath);
    const fallbackAvatar = deterministicAvatar(projectPath);
    const defaultId = projectBotIdForPath(projectPath);

    if (!existsSync(filePath)) {
      return {
        id: defaultId,
        kind: "project",
        name: project.name,
        role: "Project Bot",
        avatar: fallbackAvatar,
        soul: defaultProjectSoul(project.name),
        memory: DEFAULT_MEMORY_TEMPLATE,
        filePath,
        projectId: project.id,
        projectPath,
        ...(projectHostId ? { projectHostId } : {}),
        fileHash,
        materialized: false,
        createdAt: 0,
        updatedAt: 0,
      };
    }

    const parsed = parseBotMarkdown(readFileSync(filePath, "utf8"));
    const fm = parsed.frontmatter;
    return {
      id: typeof fm.id === "string" && fm.id ? fm.id : defaultId,
      kind: "project",
      name: typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : project.name,
      role: typeof fm.role === "string" ? fm.role : "Project Bot",
      avatar: buildAvatar(fm, fallbackAvatar),
      soul: typeof fm.soul === "string" ? fm.soul : defaultProjectSoul(project.name),
      memory: parsed.body || DEFAULT_MEMORY_TEMPLATE,
      filePath,
      projectId: project.id,
      projectPath,
      ...(projectHostId ? { projectHostId } : {}),
      fileHash,
      materialized: true,
      createdAt: typeof fm.createdAt === "number" ? fm.createdAt : 0,
      updatedAt: typeof fm.updatedAt === "number" ? fm.updatedAt : 0,
    };
  }

  function ensureProjectBot(project: ProjectSummary): { bot: BotRecord; created: boolean } {
    ensureDirs();
    const projectPath = resolveProjectPath(project);
    const { filePath } = projectBotFilePath(projectPath);
    if (existsSync(filePath)) {
      return { bot: readProjectBot(project), created: false };
    }
    const now = Date.now();
    const fm = buildProjectFrontmatter(project, projectPath, now);
    atomicWrite(filePath, serializeBotMarkdown(fm, DEFAULT_MEMORY_TEMPLATE));
    return { bot: readProjectBot(project), created: true };
  }

  function updateProjectBot(
    project: ProjectSummary,
    patch: { name?: string; role?: string; avatar?: BotAvatar; soul?: string; memory?: string },
  ): BotRecord {
    const { bot } = ensureProjectBot(project);
    const now = Math.max(Date.now(), bot.updatedAt + 1);
    const nextFm: BotFrontmatter = {
      id: bot.id,
      kind: "project",
      projectId: project.id,
      projectPath: bot.projectPath,
      name: patch.name !== undefined ? patch.name.trim() || bot.name : bot.name,
      role: patch.role !== undefined ? patch.role.trim() : bot.role,
      color: patch.avatar?.color ?? bot.avatar.color,
      shape: patch.avatar?.shape ?? bot.avatar.shape,
      expression: patch.avatar?.expression ?? bot.avatar.expression,
      motion: patch.avatar?.motion ?? bot.avatar.motion,
      soul: patch.soul !== undefined ? patch.soul : bot.soul,
      createdAt: bot.createdAt || now,
      updatedAt: now,
    };
    const nextBody = patch.memory !== undefined ? patch.memory : bot.memory;
    atomicWrite(bot.filePath, serializeBotMarkdown(nextFm, nextBody));
    return readProjectBot(project);
  }

  function unaffiliatedDir(botId: string): string {
    assertSafeBotId(botId);
    return join(unaffiliatedRoot, botId);
  }

  function readUnaffiliatedBot(botId: string): BotRecord | null {
    const dir = unaffiliatedDir(botId);
    const botFile = join(dir, "bot.md");
    if (!existsSync(botFile)) return null;
    const parsed = parseBotMarkdown(readFileSync(botFile, "utf8"));
    const fm = parsed.frontmatter;
    const fallbackAvatar = deterministicAvatar(botId);
    const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : botId;
    const role = typeof fm.role === "string" ? fm.role : "Coordinator";
    return {
      id: typeof fm.id === "string" && fm.id ? fm.id : botId,
      kind: "unaffiliated",
      name,
      role,
      avatar: buildAvatar(fm, fallbackAvatar),
      soul: typeof fm.soul === "string" ? fm.soul : defaultUnaffiliatedSoul(name, role),
      memory: parsed.body || DEFAULT_MEMORY_TEMPLATE,
      filePath: botFile,
      directoryPath: dir,
      materialized: true,
      createdAt: typeof fm.createdAt === "number" ? fm.createdAt : 0,
      updatedAt: typeof fm.updatedAt === "number" ? fm.updatedAt : 0,
    };
  }

  function listUnaffiliatedBots(): BotRecord[] {
    if (!existsSync(unaffiliatedRoot)) return [];
    const entries = readdirSync(unaffiliatedRoot, { withFileTypes: true });
    const bots: BotRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(entry.name)) continue;
      const bot = readUnaffiliatedBot(entry.name);
      if (bot) bots.push(bot);
    }
    return bots.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }

  function createUnaffiliatedBot(input: {
    name: string;
    role: string;
    avatar: BotAvatar;
    soul?: string;
    memory?: string;
  }): BotRecord {
    ensureDirs();
    const id = `bot_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const dir = unaffiliatedDir(id);
    mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const name = input.name.trim();
    const role = input.role.trim();
    const fm: BotFrontmatter = {
      id,
      kind: "unaffiliated",
      name,
      role,
      color: input.avatar.color,
      shape: input.avatar.shape,
      expression: input.avatar.expression,
      motion: input.avatar.motion,
      soul: input.soul?.trim() ? input.soul : defaultUnaffiliatedSoul(name, role),
      createdAt: now,
      updatedAt: now,
    };
    const memory = input.memory?.trim() ? input.memory : DEFAULT_MEMORY_TEMPLATE;
    atomicWrite(join(dir, "bot.md"), serializeBotMarkdown(fm, memory));
    return readUnaffiliatedBot(id)!;
  }

  function updateUnaffiliatedBot(
    botId: string,
    patch: { name?: string; role?: string; avatar?: BotAvatar; soul?: string; memory?: string },
  ): BotRecord {
    const existing = readUnaffiliatedBot(botId);
    if (!existing) throw new Error(`Unaffiliated bot ${botId} not found.`);
    const now = Math.max(Date.now(), existing.updatedAt + 1);
    const nextFm: BotFrontmatter = {
      id: existing.id,
      kind: "unaffiliated",
      name: patch.name !== undefined ? patch.name.trim() || existing.name : existing.name,
      role: patch.role !== undefined ? patch.role.trim() : existing.role,
      color: patch.avatar?.color ?? existing.avatar.color,
      shape: patch.avatar?.shape ?? existing.avatar.shape,
      expression: patch.avatar?.expression ?? existing.avatar.expression,
      motion: patch.avatar?.motion ?? existing.avatar.motion,
      soul: patch.soul !== undefined ? patch.soul : existing.soul,
      createdAt: existing.createdAt || now,
      updatedAt: now,
    };
    const nextBody = patch.memory !== undefined ? patch.memory : existing.memory;
    atomicWrite(existing.filePath, serializeBotMarkdown(nextFm, nextBody));
    return readUnaffiliatedBot(botId)!;
  }

  function deleteUnaffiliatedBot(botId: string): void {
    const dir = unaffiliatedDir(botId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    forgetState({ botIds: [botId] });
  }

  // Drops runtime state of deleted bots and deleted threads in one state write. Bot markdown files are untouched.
  function forgetState(gone: { botIds?: readonly string[]; threadIds?: readonly string[] }): boolean {
    const bots = new Set(gone.botIds ?? []);
    const threads = new Set(gone.threadIds ?? []);
    for (const threadId of threads) dreamSessions.delete(threadId);
    if (bots.size === 0 && threads.size === 0) return false;
    const state = loadState();
    const before = JSON.stringify(state);
    for (const [threadId, botId] of Object.entries(state.threadBindings)) {
      if (bots.has(botId) || threads.has(threadId)) delete state.threadBindings[threadId];
    }
    for (const [threadId, special] of Object.entries(state.specialThreads)) {
      if (bots.has(special.botId) || threads.has(threadId)) delete state.specialThreads[threadId];
    }
    for (const threadId of threads) delete state.settledThreads[threadId];
    for (const map of [state.lastViewed, state.routingThreads]) {
      for (const [botId, threadId] of Object.entries(map)) {
        if (bots.has(botId) || threads.has(threadId)) delete map[botId];
      }
    }
    for (const [botId, threadIds] of Object.entries(state.threadOrder)) {
      const kept = bots.has(botId) ? [] : threadIds.filter((id) => !threads.has(id));
      if (kept.length > 0) state.threadOrder[botId] = kept;
      else delete state.threadOrder[botId];
    }
    for (const [botId, dream] of Object.entries(state.dreamState)) {
      if (bots.has(botId)) {
        delete state.dreamState[botId];
        continue;
      }
      for (const threadId of threads) delete dream.processedThreadSeq?.[threadId];
    }
    for (const botId of bots) delete state.lastUsedAt[botId];
    state.pinnedBotIds = state.pinnedBotIds.filter((id) => !bots.has(id));
    state.settledBotIds = state.settledBotIds.filter((id) => !bots.has(id));
    if (state.dreamThreadId && threads.has(state.dreamThreadId)) state.dreamThreadId = null;
    if (JSON.stringify(state) === before) return false;
    saveState(state);
    return true;
  }

  function updateBotMemory(
    bot: { kind: "project"; project: ProjectSummary } | { kind: "unaffiliated"; botId: string },
    op: MemoryOperation,
  ): { bot: BotRecord; changed: boolean; summary: string } {
    if (bot.kind === "project") {
      const current = ensureProjectBot(bot.project).bot;
      const result = applyMemoryOperation(current.memory, op);
      if (!result.changed) return { bot: current, changed: false, summary: result.summary };
      const updated = updateProjectBot(bot.project, { memory: result.body });
      return { bot: updated, changed: true, summary: result.summary };
    }
    const current = readUnaffiliatedBot(bot.botId);
    if (!current) throw new Error(`Unaffiliated bot ${bot.botId} not found.`);
    const result = applyMemoryOperation(current.memory, op);
    if (!result.changed) return { bot: current, changed: false, summary: result.summary };
    const updated = updateUnaffiliatedBot(bot.botId, { memory: result.body });
    return { bot: updated, changed: true, summary: result.summary };
  }

  function bindThread(threadId: string, unaffiliatedBotId: string): boolean {
    const state = loadState();
    if (state.threadBindings[threadId] === unaffiliatedBotId) return false;
    state.threadBindings[threadId] = unaffiliatedBotId;
    saveState(state);
    return true;
  }

  function threadBinding(threadId: string): string | null {
    return loadState().threadBindings[threadId] ?? null;
  }

  function allBindings(): Array<{ threadId: string; botId: string }> {
    return Object.entries(loadState().threadBindings).map(([threadId, botId]) => ({ threadId, botId }));
  }

  function rememberViewed(botId: string, threadId: string): boolean {
    const state = loadState();
    const now = Date.now();
    const viewChanged = state.lastViewed[botId] !== threadId;
    state.lastViewed[botId] = threadId;
    if (!state.specialThreads[threadId]) state.routingThreads[botId] = threadId;
    state.lastUsedAt[botId] = Math.max(now, state.lastUsedAt[botId] ?? 0);
    saveState(state);
    return viewChanged;
  }

  function touchUsed(botId: string, at: number = Date.now()): void {
    const state = loadState();
    const prev = state.lastUsedAt[botId] ?? 0;
    const wasSettled = state.settledBotIds.includes(botId);
    if (at <= prev && !wasSettled) return;
    state.lastUsedAt[botId] = Math.max(at, prev);
    if (wasSettled) {
      state.settledBotIds = state.settledBotIds.filter((id) => id !== botId);
    }
    saveState(state);
  }

  function allLastUsedAt(): Array<{ botId: string; lastUsedAt: number }> {
    return Object.entries(loadState().lastUsedAt).map(([botId, lastUsedAt]) => ({ botId, lastUsedAt }));
  }

  function setPinned(botId: string, pinned: boolean): string[] {
    const state = loadState();
    const has = state.pinnedBotIds.includes(botId);
    if (pinned && !has) {
      state.pinnedBotIds = [...state.pinnedBotIds, botId];
      saveState(state);
    } else if (!pinned && has) {
      state.pinnedBotIds = state.pinnedBotIds.filter((id) => id !== botId);
      saveState(state);
    }
    return state.pinnedBotIds;
  }

  function pinnedBotIds(): string[] {
    return loadState().pinnedBotIds;
  }

  function setSettled(botId: string, settled: boolean): string[] {
    const state = loadState();
    const has = state.settledBotIds.includes(botId);
    if (settled && !has) {
      state.settledBotIds = [...state.settledBotIds, botId];
      // Settling a bot unpins it
      state.pinnedBotIds = state.pinnedBotIds.filter((id) => id !== botId);
      saveState(state);
    } else if (!settled && has) {
      state.settledBotIds = state.settledBotIds.filter((id) => id !== botId);
      state.lastUsedAt[botId] = Math.max(Date.now(), state.lastUsedAt[botId] ?? 0);
      saveState(state);
    }
    return state.settledBotIds;
  }

  function settledBotIds(): string[] {
    return loadState().settledBotIds;
  }

  function setThreadSettled(threadId: string, settled: boolean): Array<{ threadId: string; settledAt: number }> {
    const state = loadState();
    if (settled) {
      state.settledThreads[threadId] = Date.now();
      saveState(state);
    } else if (state.settledThreads[threadId] !== undefined) {
      delete state.settledThreads[threadId];
      saveState(state);
    }
    return Object.entries(state.settledThreads).map(([id, settledAt]) => ({ threadId: id, settledAt }));
  }

  function allSettledThreads(): Array<{ threadId: string; settledAt: number }> {
    return Object.entries(loadState().settledThreads).map(([threadId, settledAt]) => ({ threadId, settledAt }));
  }

  function getDreamConfig(): DreamConfig {
    return loadState().dreamConfig;
  }

  function getDreamThreadId(): string | null {
    return loadState().dreamThreadId;
  }

  function setDreamThreadId(threadId: string | null): void {
    const state = loadState();
    if (state.dreamThreadId === threadId) return;
    state.dreamThreadId = threadId;
    saveState(state);
  }

  function setDreamConfig(config: DreamConfig): DreamConfig {
    const state = loadState();
    state.dreamConfig = {
      enabled: Boolean(config.enabled),
      providerId: config.providerId.trim(),
      model: config.model.trim(),
      intervalMinutes: Math.max(5, Math.min(1440, Math.round(config.intervalMinutes || 60))),
    };
    saveState(state);
    return state.dreamConfig;
  }

  function getDreamState(botId: string): BotDreamState {
    const existing = loadState().dreamState[botId];
    if (existing) return existing;
    return { lastDreamAt: null, lastDreamSummary: null, lastDreamError: null, processedThreadSeq: {} };
  }

  function allDreamStates(): Array<{ botId: string; lastDreamAt: number | null; lastDreamSummary: string | null; lastDreamError: string | null }> {
    return Object.entries(loadState().dreamState).map(([botId, s]) => ({
      botId,
      lastDreamAt: s.lastDreamAt ?? null,
      lastDreamSummary: s.lastDreamSummary ?? null,
      lastDreamError: s.lastDreamError ?? null,
    }));
  }

  function updateDreamState(botId: string, patch: Partial<BotDreamState>): BotDreamState {
    const state = loadState();
    const prev: BotDreamState = state.dreamState[botId] ?? {
      lastDreamAt: null,
      lastDreamSummary: null,
      lastDreamError: null,
      processedThreadSeq: {},
    };
    const next: BotDreamState = {
      lastDreamAt: patch.lastDreamAt !== undefined ? patch.lastDreamAt : prev.lastDreamAt,
      lastDreamSummary: patch.lastDreamSummary !== undefined ? patch.lastDreamSummary : prev.lastDreamSummary,
      lastDreamError: patch.lastDreamError !== undefined ? patch.lastDreamError : prev.lastDreamError,
      processedThreadSeq: patch.processedThreadSeq
        ? { ...prev.processedThreadSeq, ...patch.processedThreadSeq }
        : prev.processedThreadSeq,
    };
    state.dreamState[botId] = next;
    saveState(state);
    return next;
  }

  function registerDreamSession(threadId: string, target: DreamSessionTarget): void {
    dreamSessions.set(threadId, target);
  }

  function getDreamSession(threadId: string): DreamSessionTarget | null {
    return dreamSessions.get(threadId) ?? null;
  }

  function clearDreamSession(threadId: string): void {
    dreamSessions.delete(threadId);
  }

  function stageDreamStart(token: string, target: DreamSessionTarget): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, v] of pendingDreams) {
      if (v.createdAt < cutoff) pendingDreams.delete(k);
    }
    pendingDreams.set(token, { ...target, createdAt: Date.now() });
  }

  function consumeDreamStart(token: string): DreamSessionTarget | null {
    const val = pendingDreams.get(token) ?? null;
    if (val) pendingDreams.delete(token);
    return val;
  }

  function routingThreadId(botId: string): string | null {
    return loadState().routingThreads[botId] ?? null;
  }

  function allLastViewed(): Array<{ botId: string; threadId: string }> {
    return Object.entries(loadState().lastViewed).map(([botId, threadId]) => ({ botId, threadId }));
  }

  function stageStart(token: string, start: Omit<PendingStart, "createdAt">): void {
    // Prune stale tokens older than 10 minutes
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [key, value] of pendingStarts) {
      if (value.createdAt < cutoff) pendingStarts.delete(key);
    }
    pendingStarts.set(token, { ...start, createdAt: Date.now() });
  }

  function consumeStart(token: string): PendingStart | null {
    const value = pendingStarts.get(token) ?? null;
    if (value) pendingStarts.delete(token);
    return value;
  }

  function setThreadOrder(botId: string, threadIds: string[]): string[] {
    const deduped = [...new Set(threadIds.filter((t) => typeof t === "string" && t.trim().length > 0))];
    const state = loadState();
    state.threadOrder[botId] = deduped;
    saveState(state);
    return deduped;
  }

  function threadOrderForBot(botId: string): string[] {
    return loadState().threadOrder[botId] ?? [];
  }

  function allThreadOrders(): Array<{ botId: string; threadIds: string[] }> {
    return Object.entries(loadState().threadOrder).map(([botId, threadIds]) => ({
      botId,
      threadIds: Array.isArray(threadIds) ? threadIds : [],
    }));
  }

  function setSpecialThread(input: {
    threadId: string;
    botId: string;
    name: string;
    icon: SpecialThreadIconId;
    color?: string;
    instruction: string;
    rolePrompt?: string;
  }): { record: SpecialThreadRecord; created: boolean } {
    const state = loadState();
    const trimmedName = input.name.trim();
    const lowerName = trimmedName.toLowerCase();
    const duplicate = Object.values(state.specialThreads).find(
      (s) =>
        s.botId === input.botId &&
        s.threadId !== input.threadId &&
        s.name.toLowerCase() === lowerName,
    );
    if (duplicate) {
      throw new Error(
        `A Special thread named "${duplicate.name}" (${duplicate.threadId}) already exists on this bot. Pick a unique name.`,
      );
    }
    const existing = state.specialThreads[input.threadId];
    const now = Date.now();
    const record: SpecialThreadRecord = {
      threadId: input.threadId,
      botId: input.botId,
      name: trimmedName,
      icon: input.icon,
      ...(input.color ? { color: input.color } : {}),
      instruction: input.instruction.trim(),
      ...(input.rolePrompt?.trim() ? { rolePrompt: input.rolePrompt.trim() } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    state.specialThreads[input.threadId] = record;
    delete state.settledThreads[input.threadId];
    if (!existing) {
      const currentOrder = state.threadOrder[input.botId] ?? [];
      state.threadOrder[input.botId] = [
        input.threadId,
        ...currentOrder.filter((id) => id !== input.threadId),
      ];
    }
    saveState(state);
    return { record, created: !existing };
  }

  function removeSpecialThread(threadId: string): boolean {
    const state = loadState();
    const record = state.specialThreads[threadId];
    if (!record) return false;
    delete state.specialThreads[threadId];
    // The demoted thread is regular again; if the user is on it, route there.
    if (state.lastViewed[record.botId] === threadId) state.routingThreads[record.botId] = threadId;
    saveState(state);
    return true;
  }

  function getSpecialThread(threadId: string): SpecialThreadRecord | null {
    return loadState().specialThreads[threadId] ?? null;
  }

  function listSpecialThreadsForBot(botId: string): SpecialThreadRecord[] {
    return Object.values(loadState().specialThreads)
      .filter((s) => s.botId === botId)
      .sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }

  function allSpecialThreads(): SpecialThreadRecord[] {
    return Object.values(loadState().specialThreads).sort(
      (a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name),
    );
  }

  function stageComposeTarget(botId: string | null, projectId: string | null): void {
    if (!botId || !projectId) {
      stagedCompose = null;
      return;
    }
    stagedCompose = { botId, projectId, expiresAt: Date.now() + 10 * 60 * 1000 };
  }

  function consumeComposeTarget(projectId: string): string | null {
    if (!stagedCompose) return null;
    if (Date.now() > stagedCompose.expiresAt) {
      stagedCompose = null;
      return null;
    }
    if (stagedCompose.projectId !== projectId) return null;
    const botId = stagedCompose.botId;
    stagedCompose = null;
    return botId;
  }

  return {
    rootDir,
    readProjectBot,
    ensureProjectBot,
    updateProjectBot,
    readUnaffiliatedBot,
    listUnaffiliatedBots,
    createUnaffiliatedBot,
    updateUnaffiliatedBot,
    deleteUnaffiliatedBot,
    forgetState,
    updateBotMemory,
    bindThread,
    threadBinding,
    allBindings,
    rememberViewed,
    routingThreadId,
    allLastViewed,
    touchUsed,
    allLastUsedAt,
    setPinned,
    pinnedBotIds,
    setSettled,
    settledBotIds,
    setThreadSettled,
    allSettledThreads,
    setThreadOrder,
    threadOrderForBot,
    allThreadOrders,
    setSpecialThread,
    removeSpecialThread,
    getSpecialThread,
    listSpecialThreadsForBot,
    allSpecialThreads,
    getDreamConfig,
    setDreamConfig,
    getDreamThreadId,
    setDreamThreadId,
    getDreamState,
    allDreamStates,
    updateDreamState,
    registerDreamSession,
    getDreamSession,
    clearDreamSession,
    stageDreamStart,
    consumeDreamStart,
    stageStart,
    consumeStart,
    stageComposeTarget,
    consumeComposeTarget,
  };
}

export type BotStore = ReturnType<typeof createBotStore>;
