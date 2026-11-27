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

function makeFakeBb(options: {
  activeThreads?: Array<Record<string, unknown>>;
  archivedThreads?: Array<Record<string, unknown>>;
  projects?: Array<Record<string, unknown>>;
}) {
  const archive = vi.fn(async () => ({}));
  const deleteThread = vi.fn(async () => ({}));
  const deleteProject = vi.fn(async () => ({}));
  const bb = {
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sdk: {
      threads: {
        list: vi.fn(async (args?: { archived?: boolean }) =>
          args?.archived ? (options.archivedThreads ?? []) : (options.activeThreads ?? []),
        ),
        archive,
        delete: deleteThread,
      },
      projects: {
        list: vi.fn(async () => options.projects ?? []),
        delete: deleteProject,
      },
    },
  } as unknown as BbPluginApi;
  return { bb, archive, deleteThread, deleteProject };
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
        { id: "thr_pinned", projectId: "proj_1", status: "idle", pinned: true, updatedAt: now - 20 * DAY_MS, archivedAt: null, deletedAt: null },
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
      store.setSpecialThread({ threadId: "thr_twin_special", botId: activeBot.id, name: "Reviewer", icon: "shield", instruction: "Review." });
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
        { id: "thr_twin_special", projectId: "proj_twin", status: "idle", updatedAt: now - 50 * DAY_MS, archivedAt: now - 40 * DAY_MS, deletedAt: null },
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
    expect(store.routingThreadId(activeBot.id)).toBe("thr_live_work");
    expect(store.allLastUsedAt().map((u) => u.botId)).toContain(activeBot.id);
  });
});
