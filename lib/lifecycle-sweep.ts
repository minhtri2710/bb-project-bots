import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginSettingsDto } from "../contract";
import type { BotStore } from "./bot-store";
import { listStandardProjects } from "./messaging";
import { mostRecentRootId } from "./thread-order";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export type LifecycleSweepSummary = {
  archivedThreads: string[];
  deletedThreads: string[];
  deletedProjects: string[];
};

type ThreadLike = {
  id: string;
  projectId: string;
  parentThreadId?: string | null;
  status?: string;
  archivedAt?: number | null;
  deletedAt?: number | null;
  visibility?: string;
  pinned?: boolean;
  unread?: boolean;
  updatedAt: number;
  createdAt?: number;
};

function isBusy(thread: ThreadLike): boolean {
  return thread.status === "active" || thread.status === "starting";
}

export async function runLifecycleSweep(
  bb: BbPluginApi,
  store: BotStore,
  settings: PluginSettingsDto,
  publish: () => void,
  now = Date.now(),
): Promise<LifecycleSweepSummary> {
  const summary: LifecycleSweepSummary = {
    archivedThreads: [],
    deletedThreads: [],
    deletedProjects: [],
  };

  if (
    !settings.autoArchiveSettled &&
    !settings.autoDeleteArchived &&
    !settings.autoDeleteProjects
  ) {
    return summary;
  }

  const specialIds = new Set(store.allSpecialThreads().map((s) => s.threadId));
  const settledMap = new Map(
    store.allSettledThreads().map((s) => [s.threadId, s.settledAt]),
  );
  const bindingsMap = new Map(
    store.allBindings().map((b) => [b.threadId, b.botId]),
  );
  const pinnedBots = new Set(store.pinnedBotIds());
  const lastUsedMap = new Map(
    store.allLastUsedAt().map((entry) => [entry.botId, entry.lastUsedAt]),
  );

  // 1. Auto-archive threads that have been settled for N days
  if (settings.autoArchiveSettled) {
    const activeThreads = (await bb.sdk.threads.list({
      archived: false,
      limit: 500,
    })) as ThreadLike[];
    const visible = activeThreads.filter(
      (t) =>
        t.archivedAt == null &&
        t.deletedAt == null &&
        t.visibility !== "hidden",
    );
    const byId = new Map(visible.map((t) => [t.id, t]));
    const childrenByParent = new Map<string, ThreadLike[]>();
    for (const t of visible) {
      if (t.parentThreadId && byId.has(t.parentThreadId)) {
        const list = childrenByParent.get(t.parentThreadId) ?? [];
        list.push(t);
        childrenByParent.set(t.parentThreadId, list);
      }
    }

    const roots = visible.filter(
      (t) => !t.parentThreadId || !byId.has(t.parentThreadId),
    );
    const rootsByOwner = new Map<string, ThreadLike[]>();
    for (const root of roots) {
      const ownerKey = bindingsMap.get(root.id) ?? `proj:${root.projectId}`;
      const list = rootsByOwner.get(ownerKey) ?? [];
      list.push(root);
      rootsByOwner.set(ownerKey, list);
    }

    const collectSubtree = (root: ThreadLike): ThreadLike[] => {
      const out: ThreadLike[] = [root];
      const q: ThreadLike[] = [root];
      while (q.length > 0) {
        const cur = q.shift()!;
        for (const child of childrenByParent.get(cur.id) ?? []) {
          out.push(child);
          q.push(child);
        }
      }
      return out;
    };

    const archiveDelayMs = settings.autoArchiveSettledAfterDays * DAY_MS;
    const autoSettleDelayMs = settings.autoSettleAfterHours * HOUR_MS;

    for (const ownerRoots of rootsByOwner.values()) {
      const activityByRoot = new Map<string, number>();
      const subtreeByRoot = new Map<string, ThreadLike[]>();
      for (const root of ownerRoots) {
        const subtree = collectSubtree(root);
        subtreeByRoot.set(root.id, subtree);
        activityByRoot.set(
          root.id,
          subtree.reduce((max, t) => Math.max(max, t.updatedAt), 0),
        );
      }
      const newestId = mostRecentRootId(
        ownerRoots,
        (r) => activityByRoot.get(r.id) ?? r.updatedAt,
      );

      for (const root of ownerRoots) {
        if (root.id === newestId) continue;
        const subtree = subtreeByRoot.get(root.id) ?? [root];
        if (
          subtree.some(
            (t) =>
              isBusy(t) ||
              Boolean(t.pinned) ||
              Boolean(t.unread) ||
              specialIds.has(t.id),
          )
        ) {
          continue;
        }
        const latestActivity = activityByRoot.get(root.id) ?? 0;
        if (latestActivity <= 0) continue;

        let settledAt: number | null = null;
        const manual = settledMap.get(root.id);
        if (manual !== undefined && manual >= latestActivity) {
          settledAt = manual;
        } else if (
          settings.autoSettle &&
          now - latestActivity >= autoSettleDelayMs
        ) {
          settledAt = latestActivity + autoSettleDelayMs;
        }
        if (settledAt === null) continue;
        if (now - settledAt < archiveDelayMs) continue;

        try {
          await bb.sdk.threads.archive({ threadId: root.id });
          store.setThreadSettled(root.id, false);
          summary.archivedThreads.push(root.id);
        } catch (error) {
          bb.log.warn(
            `lifecycle-sweep: failed to archive settled thread ${root.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  // 2. Auto-delete archived threads after N days
  if (settings.autoDeleteArchived) {
    const archivedThreads = (await bb.sdk.threads.list({
      archived: true,
      limit: 500,
    })) as ThreadLike[];
    const deleteCutoff = now - settings.autoDeleteArchivedAfterDays * DAY_MS;

    for (const thread of archivedThreads) {
      if (thread.deletedAt != null || thread.archivedAt == null) continue;
      if (thread.pinned || specialIds.has(thread.id)) continue;
      const archivedAt = thread.archivedAt ?? thread.updatedAt;
      if (archivedAt > deleteCutoff) continue;
      try {
        await bb.sdk.threads.delete({ threadId: thread.id, childThreadsConfirmed: true });
        summary.deletedThreads.push(thread.id);
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: failed to delete archived thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // 3. Auto-delete projects after N days with no active threads (bot .md files stay untouched for auto-reuse)
  if (settings.autoDeleteProjects) {
    const [projects, activeThreads, archivedThreads] = await Promise.all([
      listStandardProjects(bb),
      bb.sdk.threads.list({ archived: false, limit: 500 }) as Promise<ThreadLike[]>,
      bb.sdk.threads.list({ archived: true, limit: 500 }) as Promise<ThreadLike[]>,
    ]);

    const activeByProject = new Set<string>();
    for (const t of activeThreads) {
      if (t.archivedAt == null && t.deletedAt == null && t.visibility !== "hidden") {
        activeByProject.add(t.projectId);
      }
    }

    const botIdByProject = new Map(projects.map((p) => [p.id, store.readProjectBot(p).id]));
    const lastArchivedByProject = new Map<string, number>();
    for (const t of archivedThreads) {
      if (t.deletedAt != null) continue;
      const prev = lastArchivedByProject.get(t.projectId) ?? 0;
      const at = Math.max(t.archivedAt ?? 0, t.updatedAt ?? 0);
      if (at > prev) lastArchivedByProject.set(t.projectId, at);
    }

    const projectCutoff = now - settings.autoDeleteProjectsAfterDays * DAY_MS;

    for (const project of projects) {
      if (activeByProject.has(project.id)) continue;
      const botId = botIdByProject.get(project.id)!;
      if (pinnedBots.has(botId)) continue;
      const projMeta = project as { createdAt?: number; updatedAt?: number };
      const latestActivity = Math.max(
        projMeta.updatedAt ?? 0,
        projMeta.createdAt ?? 0,
        lastUsedMap.get(botId) ?? 0,
        lastArchivedByProject.get(project.id) ?? 0,
      );
      if (latestActivity <= 0 || latestActivity > projectCutoff) continue;

      try {
        await bb.sdk.projects.delete({ projectId: project.id });
        summary.deletedProjects.push(project.id);
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: failed to delete idle project ${project.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      // BB has no project.deleted event, so the sweep forgets what the deleted project owned. Its bot's
      // markdown file stays for reuse; its bot state stays if another project shares the same source path.
      const botShared = projects.some(
        (other) => !summary.deletedProjects.includes(other.id) && botIdByProject.get(other.id) === botId,
      );
      try {
        store.forgetState({
          botIds: botShared ? [] : [botId],
          threadIds: [...activeThreads, ...archivedThreads].filter((t) => t.projectId === project.id).map((t) => t.id),
        });
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: deleted project ${project.id} but failed to forget its state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  if (
    summary.archivedThreads.length > 0 ||
    summary.deletedThreads.length > 0 ||
    summary.deletedProjects.length > 0
  ) {
    publish();
  }

  return summary;
}
