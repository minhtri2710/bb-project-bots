import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import type { PluginSettingsDto } from "../contract";
import { createBotStore } from "../lib/bot-store";
import { runLifecycleSweep } from "../lib/lifecycle-sweep";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const BASE_SETTINGS: PluginSettingsDto = {
  autoSettle: true,
  autoSettleAfterHours: 72,
  autoArchiveSettled: false,
  autoArchiveSettledAfterDays: 7,
  autoDeleteArchived: false,
  autoDeleteArchivedAfterDays: 30,
  autoSettleBots: false,
  autoSettleBotsAfterHours: 168,
  autoDeleteProjects: false,
  autoDeleteProjectsAfterDays: 30,
};

// Like the host: filters by archived/projectId, then pages by offset/limit. Rows default to the host's
// unpinned, read shape.
function makeFakeBb(options: {
  activeThreads?: Array<Record<string, unknown>>;
  archivedThreads?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
  failList?: (args: { archived?: boolean; projectId?: string; offset?: number }) => boolean;
}) {
  const hostRow = (t: Record<string, unknown>) => ({ pinnedAt: null, lastReadAt: null, latestAttentionAt: 0, ...t });
  options = {
    ...options,
    activeThreads: options.activeThreads?.map(hostRow),
    archivedThreads: options.archivedThreads?.map(hostRow),
  };
  const archive = vi.fn(async () => ({}));
  const deleteThread = vi.fn(async () => ({}));
  const deleteProject = vi.fn(async () => ({}));
  const bb = {
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sdk: {
      threads: {
        list: vi.fn(
          async (
            args: {
              archived?: boolean;
              projectId?: string;
              parentThreadId?: string;
              threadIds?: string[];
              includeHidden?: boolean;
              limit?: number;
              offset?: number;
            } = {},
          ) => {
            if (options.failList?.(args)) throw new Error("thread list unavailable");
            const source = (args.archived ? options.archivedThreads : options.activeThreads) ?? [];
            const matching = source.filter(
              (t) =>
                (!args.projectId || t.projectId === args.projectId) &&
                (!args.parentThreadId || t.parentThreadId === args.parentThreadId) &&
                (!args.threadIds || args.threadIds.includes(t.id as string)) &&
                (args.includeHidden || t.visibility !== "hidden"),
            );
            const offset = args.offset ?? 0;
            // The host caps rows per page below the requested limit
            return matching.slice(offset, offset + Math.min(args.limit ?? 50, 200));
          },
        ),
        archive,
        delete: deleteThread,
      },
      projects: {
        list: vi.fn(async () => options.projects ?? []),
        get: vi.fn(async ({ projectId }: { projectId: string }) => {
          const found = (options.projects ?? []).find((p) => p.id === projectId);
          if (!found) throw new Error(`Missing project ${projectId}`);
          return found;
        }),
        delete: deleteProject,
      },
    },
  } as unknown as BbPluginApi;
  return { bb, archive, deleteThread, deleteProject };
}

// Changes the rows the sweep re-reads (by id or by parent) after its first paged read; null drops a row.
function onReread(bb: BbPluginApi, change: (row: Record<string, unknown>) => Record<string, unknown> | null) {
  const realList = bb.sdk.threads.list;
  (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { threadIds?: string[]; parentThreadId?: string }) => {
    const rows = (await realList(args as never)) as Array<Record<string, unknown>>;
    if (!args.threadIds && !args.parentThreadId) return rows;
    return rows.map(change).filter((row): row is Record<string, unknown> => row !== null);
  });
}

describe("runLifecycleSweep", () => {
  it("does nothing when all destructive/archive toggles are off by default", async () => {
    const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
    const { bb, archive, deleteThread, deleteProject } = makeFakeBb({});
    const summary = await runLifecycleSweep(bb, store, BASE_SETTINGS, () => {}, Date.now());
    expect(summary).toEqual({ archivedThreads: [], deletedThreads: [], deletedProjects: [] });
    expect(archive).not.toHaveBeenCalled();
    expect(deleteThread).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("auto-archives settled threads past threshold while sparing newest, pinned, busy, and Special threads", async () => {
    const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
    const now = 1_800_000_000_000;
    store.setSpecialThread({
      threadId: "thr_special",
      botId: "projbot_1",
      name: "Reviewer",
      icon: "shield",
      instruction: "Review changes",
    });

    const { bb, archive } = makeFakeBb({
      activeThreads: [
        // Old settled thread -> should archive (settled 10d ago, threshold 7d)
        { id: "thr_old", projectId: "proj_1", status: "idle", updatedAt: now - 13 * DAY_MS, archivedAt: null, deletedAt: null },
        // Newest (only) thread in proj_2 -> spared even though 20d old
        { id: "thr_newest", projectId: "proj_2", status: "idle", updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
        // Special thread -> spared
        { id: "thr_special", projectId: "proj_1", status: "idle", updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
        // Pinned thread -> spared
        { id: "thr_pinned", projectId: "proj_1", status: "idle", pinnedAt: now - 30 * DAY_MS, updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
        // Unread thread (new activity after the last read) -> spared
        { id: "thr_unread", projectId: "proj_1", status: "idle", lastReadAt: now - 21 * DAY_MS, latestAttentionAt: now - 20 * DAY_MS, updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
        // Read child of an old root goes with it
        { id: "thr_old_child", projectId: "proj_1", parentThreadId: "thr_old", status: "idle", lastReadAt: now - 14 * DAY_MS, latestAttentionAt: now - 14 * DAY_MS, updatedAt: now - 14 * DAY_MS, archivedAt: null, deletedAt: null },
        // A queued send failed and needs the user's attention -> spared
        { id: "thr_failed_send", projectId: "proj_1", status: "idle", queuedWork: "failed", updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
        // Busy thread -> spared
        { id: "thr_busy", projectId: "proj_1", status: "active", updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
        // Settled only 2 days ago (updated 5d ago, auto-settled after 3d -> settled 2d ago < 7d) -> spared
        { id: "thr_recent_settled", projectId: "proj_1", status: "idle", updatedAt: now - 5 * DAY_MS, archivedAt: null, deletedAt: null },
      ],
    });

    const summary = await runLifecycleSweep(
      bb,
      store,
      { ...BASE_SETTINGS, autoArchiveSettled: true, autoArchiveSettledAfterDays: 7 },
      () => {},
      now,
    );
    expect(summary.archivedThreads).toEqual(["thr_old"]);
    expect(archive).toHaveBeenCalledWith({ threadId: "thr_old" });
  });

  it("auto-deletes archived threads older than threshold and empty idle projects while preserving bot markdown files", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pb-life-"));
    const store = createBotStore(rootDir);
    const now = 1_800_000_000_000;

    const projEmpty = {
      id: "proj_empty",
      name: "Old Empty",
      kind: "standard",
      createdAt: now - 60 * DAY_MS,
      updatedAt: now - 45 * DAY_MS,
      sources: [{ id: "s1", hostId: "h1", path: "/work/old-empty", isDefault: true }],
    };
    const projActive = {
      id: "proj_active",
      name: "Still Active",
      kind: "standard",
      createdAt: now - 60 * DAY_MS,
      updatedAt: now - 45 * DAY_MS,
      sources: [{ id: "s2", hostId: "h1", path: "/work/still-active", isDefault: true }],
    };
    const { bot: emptyBot } = store.ensureProjectBot(projEmpty as Parameters<typeof store.ensureProjectBot>[0]);
    expect(existsSync(emptyBot.filePath)).toBe(true);

    const { bb, deleteThread, deleteProject } = makeFakeBb({
      activeThreads: [
        { id: "thr_live", projectId: "proj_active", status: "idle", updatedAt: now - 1 * HOUR_MS, archivedAt: null, deletedAt: null },
      ],
      archivedThreads: [
        { id: "thr_arch_old", projectId: "proj_empty", status: "idle", updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS, deletedAt: null },
        { id: "thr_arch_fresh", projectId: "proj_active", status: "idle", updatedAt: now - 5 * DAY_MS, archivedAt: now - 5 * DAY_MS, deletedAt: null },
      ],
      projects: [projEmpty, projActive],
    });

    const summary = await runLifecycleSweep(
      bb,
      store,
      {
        ...BASE_SETTINGS,
        autoDeleteArchived: true,
        autoDeleteArchivedAfterDays: 30,
        autoDeleteProjects: true,
        autoDeleteProjectsAfterDays: 30,
      },
      () => {},
      now,
    );

    expect(summary.deletedThreads).toEqual(["thr_arch_old"]);
    expect(deleteThread).toHaveBeenCalledWith({ threadId: "thr_arch_old", childThreadsConfirmed: true });
    expect(summary.deletedProjects).toEqual(["proj_empty"]);
    expect(deleteProject).toHaveBeenCalledWith({ projectId: "proj_empty" });
    // Bot markdown file stays intact so it auto-reuses if the path is re-added!
    expect(existsSync(emptyBot.filePath)).toBe(true);
  });

  it("forgets the runtime state a deleted project owned, unless another project shares its bot", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "pb-life-"));
    const store = createBotStore(rootDir);
    const now = 1_800_000_000_000;
    const project = (id: string, path: string) => ({
      id,
      name: id,
      kind: "standard",
      createdAt: now - 60 * DAY_MS,
      updatedAt: now - 45 * DAY_MS,
      sources: [{ id: `src_${id}`, hostId: "h1", path, isDefault: true }],
    });
    const projEmpty = project("proj_empty", "/work/old-empty");
    const projActive = project("proj_active", "/work/still-active");
    // Same source path as projActive, so it shares projActive's bot
    const projTwin = project("proj_twin", "/work/still-active");
    type ProjectArg = Parameters<typeof store.ensureProjectBot>[0];
    const { bot: emptyBot } = store.ensureProjectBot(projEmpty as ProjectArg);
    const { bot: activeBot } = store.ensureProjectBot(projActive as ProjectArg);

    vi.useFakeTimers();
    vi.setSystemTime(now - 40 * DAY_MS);
    try {
      store.rememberViewed(emptyBot.id, "thr_empty_work");
      store.setSettled(emptyBot.id, true);
      store.setThreadOrder(emptyBot.id, ["thr_empty_work"]);
      store.setSpecialThread({ threadId: "thr_empty_special", botId: emptyBot.id, name: "Lander", icon: "merge", instruction: "Land." });
      store.updateDreamState(emptyBot.id, { lastDreamAt: now - 41 * DAY_MS, processedThreadSeq: { thr_empty_work: 3 } });
      store.setThreadSettled("thr_empty_hidden", true);
      store.setThreadOrder(activeBot.id, ["thr_twin_work", "thr_live_work"]);
      store.setSpecialThread({ threadId: "thr_live", botId: activeBot.id, name: "Lander", icon: "merge", instruction: "Land." });
      store.rememberViewed(activeBot.id, "thr_live_work");
    } finally {
      vi.useRealTimers();
    }

    const { bb } = makeFakeBb({
      activeThreads: [
        { id: "thr_live", projectId: "proj_active", status: "idle", updatedAt: now - HOUR_MS, archivedAt: null, deletedAt: null },
        { id: "thr_empty_hidden", projectId: "proj_empty", status: "idle", visibility: "hidden", updatedAt: now - 50 * DAY_MS, archivedAt: null, deletedAt: null },
      ],
      archivedThreads: [
        { id: "thr_empty_work", projectId: "proj_empty", status: "idle", updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS, deletedAt: null },
        { id: "thr_twin_work", projectId: "proj_twin", status: "idle", updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS, deletedAt: null },
      ],
      projects: [projEmpty, projActive, projTwin],
    });

    const summary = await runLifecycleSweep(
      bb,
      store,
      { ...BASE_SETTINGS, autoDeleteProjects: true },
      () => {},
      now,
    );
    expect(summary.deletedProjects).toEqual(["proj_empty", "proj_twin"]);

    // The deleted project's own bot keeps its markdown file but no runtime state
    expect(existsSync(emptyBot.filePath)).toBe(true);
    expect(store.allLastViewed().map((v) => v.botId)).not.toContain(emptyBot.id);
    expect(store.routingThreadId(emptyBot.id)).toBeNull();
    expect(store.allLastUsedAt().map((u) => u.botId)).not.toContain(emptyBot.id);
    expect(store.settledBotIds()).not.toContain(emptyBot.id);
    expect(store.threadOrderForBot(emptyBot.id)).toEqual([]);
    expect(store.listSpecialThreadsForBot(emptyBot.id)).toEqual([]);
    expect(store.allDreamStates().map((d) => d.botId)).not.toContain(emptyBot.id);
    // ...including hidden, non-archived threads deleted with the project
    expect(store.allSettledThreads()).toEqual([]);

    // proj_twin shares a bot with the surviving proj_active: only proj_twin's threads go
    expect(store.listSpecialThreadsForBot(activeBot.id).map((t) => t.threadId)).toEqual(["thr_live"]);
    expect(store.threadOrderForBot(activeBot.id)).not.toContain("thr_twin_work");
    expect(store.routingThreadId(activeBot.id)).toBe("thr_live_work");
    expect(store.allLastUsedAt().map((u) => u.botId)).toContain(activeBot.id);
  });
  describe("reads every page before deciding", () => {
    const now = 1_800_000_000_000;
    const idle = (id: string, projectId: string, extra: Record<string, unknown> = {}) => ({
      id,
      projectId,
      status: "idle",
      updatedAt: now - 20 * DAY_MS,
      archivedAt: null,
      deletedAt: null,
      ...extra,
    });
    // More than one 500-row page of other threads, listed first
    const filler = Array.from({ length: 520 }, (_, i) => idle(`thr_fill_${i}`, "proj_busy", { updatedAt: now - HOUR_MS }));
    const oldProject = (id: string, path: string) => ({
      id,
      name: id,
      kind: "standard",
      createdAt: now - 60 * DAY_MS,
      updatedAt: now - 45 * DAY_MS,
      sources: [{ id: `src_${id}`, hostId: "h1", path, isDefault: true }],
    });

    it("does not delete a project that has an active thread, however many threads other projects have", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const { bb, deleteProject } = makeFakeBb({
        activeThreads: [...filler, idle("thr_target_live", "proj_target")],
        projects: [oldProject("proj_target", "/work/target"), oldProject("proj_busy", "/work/busy")],
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
      expect(summary.deletedProjects).toEqual([]);
      expect(deleteProject).not.toHaveBeenCalled();
    });

    it("does not archive a settled root whose pinned child sits past row 500", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const { bb, archive } = makeFakeBb({
        activeThreads: [
          idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS }),
          idle("thr_newest", "proj_1", { updatedAt: now - 25 * DAY_MS }),
          ...filler,
          idle("thr_child", "proj_1", { parentThreadId: "thr_root", pinnedAt: now - 30 * DAY_MS, updatedAt: now - 30 * DAY_MS }),
        ],
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
      expect(summary.archivedThreads).not.toContain("thr_root");
      expect(archive).not.toHaveBeenCalledWith({ threadId: "thr_root" });
    });

    it("deletes an old archived thread that sits past row 500 and spares a pinned one", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const archivedAt = now - 40 * DAY_MS;
      const freshArchived = filler.map((t) => ({ ...t, archivedAt: now - HOUR_MS }));
      const { bb } = makeFakeBb({
        archivedThreads: [
          ...freshArchived,
          idle("thr_old_arch", "proj_1", { archivedAt }),
          idle("thr_pinned_arch", "proj_1", { archivedAt, pinnedAt: archivedAt }),
        ],
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteArchived: true }, () => {}, now);
      expect(summary.deletedThreads).toEqual(["thr_old_arch"]);
    });

    it("keeps a project whose full live read finds a visible thread or a running hidden one", async () => {
      const hidden = (extra: Record<string, unknown>) =>
        idle("thr_bg", "proj_target", { visibility: "hidden", updatedAt: now - 50 * DAY_MS, ...extra });
      const lateThreads = [
        idle("thr_late", "proj_target"),
        hidden({ status: "active" }),
        hidden({ status: "pending" }),
        hidden({ hasPendingInteraction: true }),
        hidden({ queuedWork: "waiting" }),
        hidden({ activity: { activeBackgroundAgentCount: 1 } }),
        hidden({ updatedAt: now - HOUR_MS }),
      ];
      for (const late of lateThreads) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, deleteProject } = makeFakeBb({
          activeThreads: [late],
          projects: [oldProject("proj_target", "/work/target")],
        });
        // The one-row live check runs before the thread shows up (or never sees a hidden thread)
        const realList = bb.sdk.threads.list;
        (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { limit?: number }) =>
          args.limit === 1 ? [] : realList(args as never),
        );
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
        expect(summary.deletedProjects).toEqual([]);
        expect(deleteProject).not.toHaveBeenCalled();
      }
    });

    it("re-reads an archived thread before deleting it and keeps it if it was pinned meanwhile", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const row = idle("thr_old_arch", "proj_1", { archivedAt: now - 40 * DAY_MS });
      const { bb, deleteThread } = makeFakeBb({ archivedThreads: [row] });
      onReread(bb, (t) => (t.id === "thr_old_arch" ? { ...t, pinnedAt: now } : t));
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteArchived: true }, () => {}, now);
      expect(summary.deletedThreads).toEqual([]);
      expect(deleteThread).not.toHaveBeenCalled();
    });

    it("checks every thread below an archived thread before deleting it, and deletes each tree once", async () => {
      const old = { updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS };
      const root = idle("thr_root", "proj_1", old);
      const cases: Array<[string, Record<string, unknown>, string[]]> = [
        ["old archived child", { ...old }, ["thr_root"]],
        ["pinned archived child", { ...old, pinnedAt: now - 40 * DAY_MS }, []],
        ["recently archived child", { ...old, archivedAt: now - HOUR_MS }, []],
        ["archived child with queued work", { ...old, queuedWork: "waiting" }, []],
        ["archived child with a failed queued send", { ...old, queuedWork: "failed" }, ["thr_root"]],
        ["visible live child", { archivedAt: null }, []],
        ["running hidden child", { archivedAt: null, visibility: "hidden", status: "active" }, []],
        ["recently active hidden child", { archivedAt: null, visibility: "hidden", updatedAt: now - HOUR_MS }, []],
      ];
      for (const [, extra, deleted] of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const child = idle("thr_child", "proj_1", { parentThreadId: "thr_root", ...extra });
        const live = child.archivedAt == null;
        const { bb, deleteThread } = makeFakeBb({
          activeThreads: live ? [child] : [],
          archivedThreads: live ? [root] : [root, child],
        });
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteArchived: true }, () => {}, now);
        expect(summary.deletedThreads).toEqual(deleted);
        expect(deleteThread).toHaveBeenCalledTimes(deleted.length);
      }
    });

    it("re-reads an archived thread after its descendants, so a pin made meanwhile keeps it", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const row = idle("thr_old_arch", "proj_1", { updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS });
      const { bb, deleteThread } = makeFakeBb({ archivedThreads: [row] });
      const realList = bb.sdk.threads.list;
      let descendantsRead = false;
      (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { threadIds?: string[]; parentThreadId?: string }) => {
        if (args.parentThreadId) descendantsRead = true;
        if (args.threadIds && descendantsRead) return [{ ...row, pinnedAt: now }];
        return realList(args as never);
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteArchived: true }, () => {}, now);
      expect(summary.deletedThreads).toEqual([]);
      expect(deleteThread).not.toHaveBeenCalled();
    });

    it("keeps an archived thread whose descendants differ between two reads", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const old = { updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS };
      const { bb, deleteThread } = makeFakeBb({ archivedThreads: [idle("thr_root", "proj_1", old)] });
      // A pinned child the first descendant read skipped shows up in the second
      const realList = bb.sdk.threads.list;
      let childReads = 0;
      (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { archived?: boolean; parentThreadId?: string; offset?: number }) => {
        const rows = (await realList(args as never)) as unknown[];
        if (args.parentThreadId === "thr_root" && args.archived && args.offset === 0 && ++childReads === 2) {
          return [...rows, idle("thr_child", "proj_1", { ...old, parentThreadId: "thr_root" })];
        }
        return rows;
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteArchived: true }, () => {}, now);
      expect(summary.deletedThreads).toEqual([]);
      expect(deleteThread).not.toHaveBeenCalled();
    });

    it("keeps a project that holds a pinned archived thread or a pinned hidden one", async () => {
      const pinned = { updatedAt: now - 50 * DAY_MS, pinnedAt: now - 40 * DAY_MS };
      const cases = [
        { archivedThreads: [idle("thr_pinned", "proj_target", { ...pinned, archivedAt: now - 40 * DAY_MS })] },
        { activeThreads: [idle("thr_pinned", "proj_target", { ...pinned, visibility: "hidden" })] },
      ];
      for (const threads of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, deleteProject } = makeFakeBb({ ...threads, projects: [oldProject("proj_target", "/work/target")] });
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
        expect(summary.deletedProjects).toEqual([]);
        expect(deleteProject).not.toHaveBeenCalled();
      }
    });

    it("keeps a project whose archived threads differ between two reads", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const archivedThreads = [idle("thr_a", "proj_target", { updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS })];
      const { bb, deleteProject } = makeFakeBb({ archivedThreads, projects: [oldProject("proj_target", "/work/target")] });
      // A row the first read skipped shows up in the second
      const realList = bb.sdk.threads.list;
      let archivedReads = 0;
      (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { archived?: boolean; offset?: number }) => {
        if (args.archived && args.offset === 0 && ++archivedReads === 2) {
          return [...(await realList(args as never)), idle("thr_moved", "proj_target", { updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS })];
        }
        return realList(args as never);
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
      expect(summary.deletedProjects).toEqual([]);
      expect(deleteProject).not.toHaveBeenCalled();
    });

    it("decides project deletion on its last reads: a thread pinned or made Special in between keeps it", async () => {
      const row = idle("thr_arch", "proj_target", { updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS });
      type Store = ReturnType<typeof createBotStore>;
      const cases: Array<(store: Store, args: { archived?: boolean }, reads: number) => Record<string, unknown>[] | null> = [
        // The second archived read returns the thread pinned
        (_store, args, reads) => (args.archived && reads === 2 ? [{ ...row, pinnedAt: now }] : null),
        // Made Special during the last live read
        (store, args, reads) => {
          if (!args.archived && reads === 2) {
            store.setSpecialThread({ threadId: "thr_arch", botId: "projbot_1", name: "Lander", icon: "merge", instruction: "Land." });
          }
          return null;
        },
      ];
      for (const during of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, deleteProject } = makeFakeBb({ archivedThreads: [row], projects: [oldProject("proj_target", "/work/target")] });
        const realList = bb.sdk.threads.list;
        const reads = { archived: 0, live: 0 };
        (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { archived?: boolean; includeHidden?: boolean; offset?: number }) => {
          if (args.includeHidden && args.offset === 0) {
            const n = args.archived ? ++reads.archived : ++reads.live;
            const replaced = during(store, args, n);
            if (replaced) return replaced;
          }
          return realList(args as never);
        });
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
        expect(summary.deletedProjects).toEqual([]);
        expect(deleteProject).not.toHaveBeenCalled();
      }
    });

    it("keeps a project that was edited while the sweep read its threads", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const project = oldProject("proj_target", "/work/target");
      const { bb, deleteProject } = makeFakeBb({ projects: [project] });
      (bb.sdk.projects as { get: unknown }).get = vi.fn(async () => ({ ...project, updatedAt: now - HOUR_MS }));
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
      expect(summary.deletedProjects).toEqual([]);
      expect(deleteProject).not.toHaveBeenCalled();
    });

    it("keeps a project whose bot was pinned while the sweep read it", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const project = oldProject("proj_target", "/work/target");
      const { bot } = store.ensureProjectBot(project as Parameters<typeof store.ensureProjectBot>[0]);
      const { bb, deleteProject } = makeFakeBb({ projects: [project] });
      const realList = bb.sdk.threads.list;
      (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: unknown) => {
        store.setPinned(bot.id, true);
        return realList(args as never);
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
      expect(summary.deletedProjects).toEqual([]);
      expect(deleteProject).not.toHaveBeenCalled();
    });

    it("re-reads the project's live threads, hidden included, as the last read before deleting it", async () => {
      for (const late of [idle("thr_new", "proj_target"), idle("thr_bg", "proj_target", { visibility: "hidden" })]) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, deleteProject } = makeFakeBb({ projects: [oldProject("proj_target", "/work/target")] });
        // The thread appears only in the second full live read
        const realList = bb.sdk.threads.list;
        let fullLiveReads = 0;
        (bb.sdk.threads as { list: unknown }).list = vi.fn(
          async (args: { archived?: boolean; includeHidden?: boolean; offset?: number }) => {
            const rows = (await realList(args as never)) as unknown[];
            const fullLive = args.archived === false && args.includeHidden && args.offset === 0;
            return fullLive && ++fullLiveReads === 2 ? [...rows, late] : rows;
          },
        );
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
        expect(summary.deletedProjects).toEqual([]);
        expect(deleteProject).not.toHaveBeenCalled();
      }
    });

    it("fails closed: a project whose threads cannot be listed is kept", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const { bb, deleteProject } = makeFakeBb({
        projects: [oldProject("proj_target", "/work/target")],
        failList: (args) => args.projectId === "proj_target" && args.archived === true,
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoDeleteProjects: true }, () => {}, now);
      expect(summary.deletedProjects).toEqual([]);
      expect(deleteProject).not.toHaveBeenCalled();
    });

    it("fails closed: a failed thread read skips auto-archive instead of acting on partial data", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const { bb, archive } = makeFakeBb({
        activeThreads: [idle("thr_old", "proj_1", { updatedAt: now - 30 * DAY_MS }), idle("thr_newest", "proj_1")],
        failList: (args) => args.offset === 0 && args.archived === false,
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
      expect(summary.archivedThreads).toEqual([]);
      expect(archive).not.toHaveBeenCalled();
    });

    it("keeps a root that became Special after the sweep started", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const { bb, archive } = makeFakeBb({
        activeThreads: [idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS }), idle("thr_newest", "proj_1")],
      });
      // Made Special while the sweep pages through threads, after its start-of-sweep snapshot
      const realList = bb.sdk.threads.list;
      (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: unknown) => {
        store.setSpecialThread({ threadId: "thr_root", botId: "projbot_1", name: "Lander", icon: "shield", instruction: "x" });
        return realList(args as never);
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
      expect(summary.archivedThreads).toEqual([]);
      expect(archive).not.toHaveBeenCalled();
    });

    it("archives a manually settled root, but not one reparented, rebound or unsettled mid-sweep", async () => {
      const root = idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS });
      type Store = ReturnType<typeof createBotStore>;
      const settle = (store: Store) => {
        vi.useFakeTimers();
        vi.setSystemTime(now - 10 * DAY_MS);
        try {
          store.setThreadSettled("thr_root", true);
        } finally {
          vi.useRealTimers();
        }
      };
      const cases: Array<[string[], (store: Store, bb: BbPluginApi) => void]> = [
        [["thr_root"], (store) => settle(store)],
        [[], (store, bb) => {
          settle(store);
          onReread(bb, (t) => (t.id === "thr_root" ? { ...t, parentThreadId: "thr_newest" } : t));
        }],
        [[], (store, bb) => {
          settle(store);
          onReread(bb, (t) => {
            store.bindThread("thr_root", "bot_other");
            return t;
          });
        }],
        [[], (store, bb) => {
          settle(store);
          const realList = bb.sdk.threads.list;
          (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: unknown) => {
            store.setThreadSettled("thr_root", false);
            return realList(args as never);
          });
        }],
      ];
      for (const [archived, arrange] of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, archive } = makeFakeBb({ activeThreads: [root, idle("thr_newest", "proj_1")] });
        arrange(store, bb);
        // Auto-settle off, so the manual settle is the only reason to archive
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true, autoSettle: false }, () => {}, now);
        expect(summary.archivedThreads).toEqual(archived);
        expect(archive).toHaveBeenCalledTimes(archived.length);
      }
    });

    it("keeps a root when the owner's newest root was archived mid-sweep, or got recent attention", async () => {
      const root = idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS });
      const newest = idle("thr_newest", "proj_1");
      const cases: Array<[Record<string, unknown>, (bb: BbPluginApi, store: ReturnType<typeof createBotStore>) => void]> = [
        // Archived, so it drops out of the live re-read
        [{}, (bb) => onReread(bb, (t) => (t.id === "thr_newest" ? null : t))],
        // Promoted to Special, so it no longer counts as the owner's regular thread
        [{}, (bb, store) => onReread(bb, (t) => {
          store.setSpecialThread({ threadId: "thr_newest", botId: "projbot_1", name: "Lander", icon: "merge", instruction: "Land." });
          return t;
        })],
        // Read, but its latest attention (not updatedAt) is recent
        [{ lastReadAt: now - HOUR_MS, latestAttentionAt: now - HOUR_MS }, () => {}],
      ];
      for (const [extra, arrange] of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, archive } = makeFakeBb({ activeThreads: [{ ...root, ...extra }, newest] });
        arrange(bb, store);
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
        expect(summary.archivedThreads).not.toContain("thr_root");
        expect(archive).not.toHaveBeenCalledWith({ threadId: "thr_root" });
      }
    });

    it("keeps a root with an unread child, a running or pinned hidden child, or a live thread below a hidden or archived one", async () => {
      const helper = (extra: Record<string, unknown>) =>
        idle("thr_helper", "proj_1", { parentThreadId: "thr_root", visibility: "hidden", updatedAt: now - 30 * DAY_MS, ...extra });
      const cases = [
        [helper({ status: "active" })],
        [helper({ pinnedAt: now - 30 * DAY_MS })],
        [helper({}), idle("thr_grandchild", "proj_1", { parentThreadId: "thr_helper", updatedAt: now - 30 * DAY_MS })],
        [idle("thr_child", "proj_1", { parentThreadId: "thr_root", updatedAt: now - 30 * DAY_MS, latestAttentionAt: now - 30 * DAY_MS })],
        [
          idle("thr_arch_child", "proj_1", { parentThreadId: "thr_root", archivedAt: now - 30 * DAY_MS }),
          idle("thr_grandchild", "proj_1", { parentThreadId: "thr_arch_child", updatedAt: now - 30 * DAY_MS }),
        ],
      ];
      for (const below of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        const { bb, archive } = makeFakeBb({
          activeThreads: [
            idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS }),
            idle("thr_newest", "proj_1"),
            ...below.filter((t) => t.archivedAt == null),
          ],
          archivedThreads: below.filter((t) => t.archivedAt != null),
        });
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
        expect(summary.archivedThreads).not.toContain("thr_root");
        expect(archive).not.toHaveBeenCalledWith({ threadId: "thr_root" });
      }
    });

    it("keeps the owner's only regular root next to a newer Special one, and an unread root under a hidden parent", async () => {
      const cases: Array<Array<Record<string, unknown>>> = [
        [idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS }), idle("thr_lander", "proj_1")],
        [
          idle("thr_root", "proj_1", { parentThreadId: "thr_hidden", updatedAt: now - 30 * DAY_MS, lastReadAt: 0, latestAttentionAt: now - 30 * DAY_MS }),
          idle("thr_hidden", "proj_1", { visibility: "hidden", updatedAt: now - 30 * DAY_MS }),
          idle("thr_newest", "proj_1"),
        ],
      ];
      for (const activeThreads of cases) {
        const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
        store.setSpecialThread({ threadId: "thr_lander", botId: "projbot_1", name: "Lander", icon: "merge", instruction: "Land." });
        const { bb, archive } = makeFakeBb({ activeThreads });
        const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
        expect(summary.archivedThreads).toEqual([]);
        expect(archive).not.toHaveBeenCalled();
      }
    });

    it("keeps a thread that looked like a root only because the paged read missed its live parent", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const { bb, archive } = makeFakeBb({
        activeThreads: [
          idle("thr_parent", "proj_1", { updatedAt: now - 30 * DAY_MS }),
          idle("thr_child", "proj_1", { parentThreadId: "thr_parent", updatedAt: now - 30 * DAY_MS }),
          idle("thr_newest", "proj_1"),
        ],
      });
      // The first full read skips thr_parent (a row shifted between pages); re-reads see it
      const realList = bb.sdk.threads.list;
      (bb.sdk.threads as { list: unknown }).list = vi.fn(async (args: { threadIds?: string[]; parentThreadId?: string }) => {
        const rows = (await realList(args as never)) as Array<{ id: string }>;
        return args.threadIds || args.parentThreadId ? rows : rows.filter((t) => t.id !== "thr_parent");
      });
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
      expect(summary.archivedThreads).not.toContain("thr_child");
    });

    it("keeps a root whose child became busy after the list was read", async () => {
      const store = createBotStore(mkdtempSync(join(tmpdir(), "pb-life-")));
      const child = idle("thr_child", "proj_1", { parentThreadId: "thr_root", updatedAt: now - 30 * DAY_MS });
      const { bb, archive } = makeFakeBb({
        activeThreads: [idle("thr_root", "proj_1", { updatedAt: now - 30 * DAY_MS }), idle("thr_newest", "proj_1"), child],
      });
      // The child gets queued work between the paged list and the pre-archive re-check
      onReread(bb, (t) => (t.id === "thr_child" ? { ...t, queuedWork: "waiting" } : t));
      const summary = await runLifecycleSweep(bb, store, { ...BASE_SETTINGS, autoArchiveSettled: true }, () => {}, now);
      expect(summary.archivedThreads).toEqual([]);
      expect(archive).not.toHaveBeenCalled();
    });
  });
});
