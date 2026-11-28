import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { PluginSettingsDto } from "../contract";
import type { BotStore } from "./bot-store";
import { DAY_MS, HOUR_MS } from "./completion";
import { listStandardProjects } from "./messaging";
import { mostRecentRootId } from "./thread-order";

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
  pinnedAt?: number | null;
  lastReadAt?: number | null;
  latestAttentionAt?: number;
  hasPendingInteraction?: boolean;
  queuedWork?: string;
  activity?: Record<string, number>;
  updatedAt: number;
  createdAt?: number;
};

const BUSY_STATUSES = new Set(["pending", "starting", "active", "stopping"]);

// Running, queued, waiting on the user, or with background work, from the fields host list rows carry
// (the sidebar's isBusy in lib/conversations.ts reads sidebar-only indicators). A failed queued send is not work in progress; it only blocks archiving (it
// needs the user's attention), not deleting a thread the user already archived.
function isBusy(thread: ThreadLike): boolean {
  return (
    BUSY_STATUSES.has(thread.status ?? "") ||
    thread.hasPendingInteraction === true ||
    thread.queuedWork === "waiting" ||
    Object.values(thread.activity ?? {}).some((count) => count > 0)
  );
}

// Latest attention came after the last read. Like the conversation list (lib/conversations.ts), an
// unread visible thread anywhere in a tree keeps the tree.
function isUnread(thread: ThreadLike): boolean {
  return (thread.lastReadAt ?? 0) < (thread.latestAttentionAt ?? 0);
}

const freshSpecialIds = (store: BotStore) => new Set(store.allSpecialThreads().map((s) => s.threadId));

const PAGE_SIZE = 500;
// shortcut: past MAX_ROWS a step fails closed on every sweep; process page by page if a host gets there.
const MAX_ROWS = 100_000;

// Reads every page so archive/delete decisions never rest on a truncated list. Advances by the rows
// actually returned and stops only on an empty page, so a host-side cap below PAGE_SIZE cannot end it
// early. Throws on any failed or runaway read so callers fail closed. Offset paging is not a snapshot
// (a row can shift into the next page and repeat, so rows are keyed by id): destructive callers
// re-check their target right before acting.
async function listAllThreads(
  bb: BbPluginApi,
  args: { archived: boolean; projectId?: string; parentThreadId?: string; includeHidden?: boolean },
): Promise<ThreadLike[]> {
  const byId = new Map<string, ThreadLike>();
  for (let offset = 0; ; ) {
    const rows = (await bb.sdk.threads.list({ ...args, limit: PAGE_SIZE, offset })) as ThreadLike[];
    if (rows.length === 0) return [...byId.values()];
    offset += rows.length;
    if (offset > MAX_ROWS) throw new Error(`more than ${MAX_ROWS} threads`);
    for (const row of rows) byId.set(row.id, row);
  }
}

const isVisibleLive = (t: ThreadLike) => t.archivedAt == null && t.deletedAt == null && t.visibility !== "hidden";
// Same activity measure as the conversation list (lib/conversations.ts).
const activityOf = (t: ThreadLike) => Math.max(t.updatedAt, t.latestAttentionAt ?? 0);

const sameIds = (a: ThreadLike[], b: ThreadLike[]) => {
  const ids = new Set(b.map((t) => t.id));
  return a.length === ids.size && a.every((t) => ids.has(t.id));
};

// Fresh read of one thread as a list row: list rows carry the busy fields (queuedWork,
// hasPendingInteraction, activity) that threads.get does not. Null when it no longer matches.
async function readRow(bb: BbPluginApi, threadId: string, archived: boolean): Promise<ThreadLike | null> {
  const rows = (await bb.sdk.threads.list({ threadIds: [threadId], archived, includeHidden: true, limit: 1 })) as ThreadLike[];
  return rows.find((row) => row.id === threadId) ?? null;
}

// Every descendant below threadId, archived and hidden ones included. Throws on any failed read.
async function descendantsOf(bb: BbPluginApi, threadId: string): Promise<ThreadLike[]> {
  const seen = new Set([threadId]);
  const out: ThreadLike[] = [];
  const queue = [threadId];
  while (queue.length > 0) {
    const parentThreadId = queue.shift()!;
    for (const archived of [false, true]) {
      for (const child of await listAllThreads(bb, { archived, parentThreadId, includeHidden: true })) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        queue.push(child.id);
      }
    }
  }
  return out;
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

  const specialIds = freshSpecialIds(store);
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

  const listOrSkip = (step: string, args: Parameters<typeof listAllThreads>[1]) =>
    listAllThreads(bb, args).catch((error: unknown) => {
      bb.log.warn(
        `lifecycle-sweep: skipped ${step}: could not list threads: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    });

  // 1. Auto-archive threads that have been settled for N days
  const activeThreads = settings.autoArchiveSettled ? await listOrSkip("auto-archive", { archived: false }) : null;
  if (activeThreads) {
    const visible = activeThreads.filter(isVisibleLive);
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

    const blocksArchive = (t: ThreadLike) =>
      isBusy(t) || t.queuedWork === "failed" || t.pinnedAt != null || isUnread(t) || specialIds.has(t.id);
    // Fresh read of the root and everything below it right before archiving: the paged list above can
    // miss a thread that moved while it was read, and it leaves out hidden and archived threads, which
    // the archive cascade may reach through. The owner's newest root must still be live, so the owner
    // keeps a regular thread. Store state is read last, after every network read. Any failed read keeps
    // the root.
    const subtreeStillIdle = async (root: ThreadLike, latestActivity: number, newestId: string): Promise<boolean> => {
      const rootId = root.id;
      try {
        const newest = await readRow(bb, newestId, false);
        if (!newest || !isVisibleLive(newest)) return false;
        const fresh = await readRow(bb, rootId, false);
        if (!fresh || !isVisibleLive(fresh) || (fresh.parentThreadId ?? null) !== (root.parentThreadId ?? null)) return false;
        // A root only because the paged list missed (or hid) its parent: inside a visible tree, keep it.
        if (fresh.parentThreadId) {
          const parent = await readRow(bb, fresh.parentThreadId, false);
          if (parent && isVisibleLive(parent)) return false;
        }
        if (blocksArchive(fresh) || activityOf(fresh) > latestActivity) return false;
        const seen = new Set([rootId]);
        const queue = [fresh];
        while (queue.length > 0) {
          const parent = queue.shift()!;
          for (const archived of [false, true]) {
            const children = await listAllThreads(bb, { archived, parentThreadId: parent.id, includeHidden: true });
            for (const child of children.filter((c) => c.deletedAt == null && !seen.has(c.id))) {
              seen.add(child.id);
              if (child.archivedAt == null) {
                if (child.visibility === "hidden") {
                  if (isBusy(child) || child.pinnedAt != null) return false;
                } else if (!isVisibleLive(parent)) {
                  // Below a hidden or archived thread the sidebar shows it as a conversation of its own,
                  // which this decision did not cover.
                  return false;
                } else if (blocksArchive(child) || activityOf(child) > latestActivity) {
                  return false;
                }
              }
              queue.push(child);
            }
          }
        }
        const special = freshSpecialIds(store);
        if (special.has(newestId) || [...seen].some((id) => special.has(id))) return false;
        // Rebinding the root or the newest root changes the owner group the newest-root rule was applied to.
        return [rootId, newestId].every((id) => (store.threadBinding(id) ?? undefined) === bindingsMap.get(id));
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: kept ${rootId}: could not re-check it before archiving: ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
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
          subtree.reduce((max, t) => Math.max(max, activityOf(t)), 0),
        );
      }
      // A Special thread does not count as the owner's regular thread.
      const newestId = mostRecentRootId(
        ownerRoots.filter((r) => !specialIds.has(r.id)),
        (r) => activityByRoot.get(r.id) ?? r.updatedAt,
      );

      for (const root of ownerRoots) {
        if (newestId === null || root.id === newestId) continue;
        const subtree = subtreeByRoot.get(root.id) ?? [root];
        if (subtree.some((t) => blocksArchive(t))) continue;
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
        if (!(await subtreeStillIdle(root, latestActivity, newestId))) continue;
        // A manual settle the user withdrew mid-sweep no longer counts (read after the last await).
        const stillSettled =
          settledAt !== manual || store.allSettledThreads().some((s) => s.threadId === root.id && s.settledAt === manual);
        if (!stillSettled) continue;

        try {
          await bb.sdk.threads.archive({ threadId: root.id });
          summary.archivedThreads.push(root.id);
        } catch (error) {
          bb.log.warn(
            `lifecycle-sweep: failed to archive settled thread ${root.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }
        try {
          store.setThreadSettled(root.id, false);
        } catch (error) {
          bb.log.warn(
            `lifecycle-sweep: archived ${root.id} but failed to clear its settled mark: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }

  // 2. Auto-delete archived threads after N days
  const archivedThreads = settings.autoDeleteArchived ? await listOrSkip("auto-delete of archived threads", { archived: true }) : null;
  if (archivedThreads) {
    const deleteCutoff = now - settings.autoDeleteArchivedAfterDays * DAY_MS;
    // Ids already deleted as descendants of an earlier delete.
    const gone = new Set<string>();

    for (const thread of archivedThreads) {
      if (gone.has(thread.id) || thread.deletedAt != null || thread.archivedAt == null) continue;
      if (thread.pinnedAt != null || specialIds.has(thread.id)) continue;
      if (thread.archivedAt > deleteCutoff) continue;
      // Deletion is permanent and cascades to every descendant: re-read the thread and all threads below
      // it right before deleting: the threads below twice (offset paging can skip a row that moves; the
      // two reads must name the same threads), then the thread itself last. Keep it if any of them is pinned, Special, busy, archived recently, live and
      // visible, or hidden and active after the cutoff (an idle hidden helper goes with its parent, as in
      // project deletion). Store state is read after the network reads.
      let fresh: ThreadLike | null;
      let below: ThreadLike[];
      try {
        below = (await descendantsOf(bb, thread.id)).filter((t) => t.deletedAt == null);
        const belowAgain = (await descendantsOf(bb, thread.id)).filter((t) => t.deletedAt == null);
        if (!sameIds(belowAgain, below)) continue;
        below = belowAgain;
        fresh = await readRow(bb, thread.id, true);
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: kept ${thread.id}: could not re-check it before deleting: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!fresh || fresh.deletedAt != null || fresh.archivedAt == null) continue;
      const special = freshSpecialIds(store);
      const keep = (t: ThreadLike) =>
        t.pinnedAt != null ||
        special.has(t.id) ||
        isBusy(t) ||
        (t.archivedAt == null ? t.visibility !== "hidden" || activityOf(t) > deleteCutoff : t.archivedAt > deleteCutoff);
      if (keep(fresh) || below.some(keep)) continue;
      try {
        await bb.sdk.threads.delete({ threadId: thread.id, childThreadsConfirmed: true });
        summary.deletedThreads.push(thread.id);
        for (const t of below) gone.add(t.id);
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: failed to delete archived thread ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  // 3. Auto-delete projects after N days with no active threads (bot .md files stay untouched for auto-reuse)
  const projects = settings.autoDeleteProjects
    ? await listStandardProjects(bb).catch((error: unknown) => {
        bb.log.warn(
          `lifecycle-sweep: skipped idle-project deletion: could not list projects: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      })
    : null;
  if (projects) {
    const botIdByProject = new Map(projects.map((p) => [p.id, store.readProjectBot(p).id]));
    const projectCutoff = now - settings.autoDeleteProjectsAfterDays * DAY_MS;

    for (const project of projects) {
      const botId = botIdByProject.get(project.id)!;
      if (pinnedBots.has(botId)) continue;
      const projMeta = project as { createdAt?: number; updatedAt?: number };
      const metaActivity = Math.max(projMeta.updatedAt ?? 0, projMeta.createdAt ?? 0, lastUsedMap.get(botId) ?? 0);
      if (metaActivity <= 0 || metaActivity > projectCutoff) continue;

      // Any failed read keeps the project this sweep. Reads run in order: a thread archived in between
      // is either still active in the first read or already archived in the second.
      // One-row query, so no paging: does the project have a visible live thread right now? (Hidden
      // threads are excluded by default; if the host returned one anyway, the project is kept.)
      try {
        const live = (await bb.sdk.threads.list({ projectId: project.id, archived: false, limit: 1 })) as ThreadLike[];
        if (live.length > 0) continue;
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: kept ${project.id}: could not check for live threads: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      // Deleting the project deletes every thread in it. One of them keeps the project if it is pinned,
      // busy, live and visible, or active (or archived) after the cutoff; idle hidden threads go with it.
      const blocksDelete = (t: ThreadLike) =>
        t.deletedAt == null &&
        (t.pinnedAt != null ||
          isBusy(t) ||
          isVisibleLive(t) ||
          Math.max(t.archivedAt ?? 0, activityOf(t)) > projectCutoff);
      const readProject = (what: string, archived: boolean) =>
        listOrSkip(`deletion of ${project.id} (${what})`, { archived, projectId: project.id, includeHidden: true });
      const projectArchived = await readProject("archived threads", true);
      if (!projectArchived || projectArchived.some(blocksDelete)) continue;
      const projectHidden = await readProject("live threads", false);
      if (!projectHidden || projectHidden.some(blocksDelete)) continue;
      // Offset paging can skip a row that moved during a read, and rows can change between reads: read
      // both sets again, require the same ids, and decide on these last reads.
      const archivedAgain = await readProject("archived threads, re-read", true);
      if (!archivedAgain || !sameIds(archivedAgain, projectArchived) || archivedAgain.some(blocksDelete)) continue;
      const liveAgain = await readProject("live threads, re-read", false);
      if (!liveAgain || !sameIds(liveAgain, projectHidden) || liveAgain.some(blocksDelete)) continue;
      // The project itself may have been edited (or removed) while its threads were read.
      try {
        const fresh = (await bb.sdk.projects.get({ projectId: project.id })) as { createdAt?: number; updatedAt?: number };
        if (Math.max(fresh.updatedAt ?? 0, fresh.createdAt ?? 0) > projectCutoff) continue;
      } catch (error) {
        bb.log.warn(
          `lifecycle-sweep: kept ${project.id}: could not re-read it: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      // Store state last, after every network read: Special threads, and the bot's pin and last use.
      const special = freshSpecialIds(store);
      if ([...archivedAgain, ...liveAgain].some((t) => special.has(t.id))) continue;
      const lastUsedNow = store.allLastUsedAt().find((u) => u.botId === botId)?.lastUsedAt ?? 0;
      if (store.pinnedBotIds().includes(botId) || lastUsedNow > projectCutoff) continue;

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
          threadIds: [...projectHidden, ...projectArchived].map((t) => t.id),
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
