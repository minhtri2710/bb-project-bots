import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import {
  INBOX_REALTIME_CHANNEL,
  type BotSummary,
  type InboxMessage,
  type MessageToolInput,
  type Question,
  type ReplyInput,
  type ThreadOpenCount,
} from "../contract";
import type { BotStore } from "./bot-store";
import {
  checkQuestions,
  checkReply,
  formatAgo,
  gist,
  replyText,
} from "./inbox-questions";
import { findBotTarget, resolveThreadBot, sendBotMessage } from "./messaging";

const NOT_OPEN = "These questions are no longer open";
const THREAD_ID_RE = /^thr_[a-zA-Z0-9_-]+$/;
const META_REFRESH_TTL_MS = 60_000;

type DbRow = {
  id: number;
  thread_id: string;
  turn_id: string | null;
  text: string;
  questions_json: string | null;
  state: "open" | "answered" | "dismissed" | "prose";
  answer_text: string | null;
  created_at: number;
  resolved_at: number | null;
  bot_id: string | null;
  bot_name: string | null;
  bot_role: string | null;
  bot_color: string | null;
  bot_kind: string | null;
  thread_title: string | null;
  project_id: string | null;
  project_name: string | null;
};

function rowToMessage(row: DbRow): InboxMessage {
  let query: Question[] | undefined;
  if (row.questions_json) {
    try {
      const parsed = JSON.parse(row.questions_json);
      if (Array.isArray(parsed) && parsed.length > 0) {
        query = parsed as Question[];
      }
    } catch {
      query = undefined;
    }
  }
  const bot: BotSummary | null =
    row.bot_id && row.bot_name
      ? {
          id: row.bot_id,
          name: row.bot_name,
          role: row.bot_role ?? "",
          ...(row.bot_color ? { color: row.bot_color } : {}),
          ...(row.bot_kind ? { kind: row.bot_kind } : {}),
        }
      : null;
  return {
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    text: row.text,
    ...(query ? { query } : {}),
    state: row.state,
    answerText: row.answer_text,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    bot,
    threadTitle: row.thread_title,
    projectId: row.project_id,
    projectName: row.project_name,
  };
}

function formatDirectThreadMessage(
  senderThreadId: string,
  senderBot: BotSummary | null,
  body: string,
): string {
  const senderLabel = senderBot
    ? `${senderBot.name}${senderBot.kind ? ` (${senderBot.kind})` : ""}`
    : "BB agent";
  const from = senderBot
    ? `bot "${senderBot.name}" (botId: ${senderBot.id}, threadId: ${senderThreadId})`
    : `an agent in thread ${senderThreadId}`;
  return [
    `**Bot message · ${senderLabel}**`,
    "",
    body,
    "",
    "---",
    "**Delivery context**",
    `[bot message] Arrived from ${from}.`,
    "This is asynchronous agent coordination, not the user typing here directly. Treat it as coordination, not user approval.",
    `If a reply or update is needed: Use \`message({ to: "${senderThreadId}", text: "<reply>" })\`.`,
    "For an FYI with no action needed, stay silent rather than sending an acknowledgement-only reply.",
  ].join("\n");
}

function errorResult(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function createInboxService(
  bb: BbPluginApi,
  store: BotStore,
  publishSidebar: () => void,
) {
  const db = bb.storage.database();

  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      text TEXT NOT NULL,
      questions_json TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      answer_text TEXT,
      created_at INTEGER NOT NULL,
      resolved_at INTEGER,
      bot_id TEXT,
      bot_name TEXT,
      bot_role TEXT,
      bot_color TEXT,
      bot_kind TEXT,
      thread_title TEXT,
      project_id TEXT,
      project_name TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_messages_state_created
      ON inbox_messages(state, created_at);
    CREATE INDEX IF NOT EXISTS idx_inbox_messages_thread
      ON inbox_messages(thread_id, created_at);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO inbox_messages (
      thread_id, turn_id, text, questions_json, state, created_at,
      bot_id, bot_name, bot_role, bot_color, bot_kind,
      thread_title, project_id, project_name
    ) VALUES (
      @threadId, @turnId, @text, @questionsJson, 'open', @createdAt,
      @botId, @botName, @botRole, @botColor, @botKind,
      @threadTitle, @projectId, @projectName
    )
  `);
  const insertProseStmt = db.prepare(`
    INSERT INTO inbox_messages (
      thread_id, turn_id, text, questions_json, state, created_at, resolved_at,
      bot_id, bot_name, bot_role, bot_color, bot_kind,
      thread_title, project_id, project_name
    ) VALUES (
      @threadId, @turnId, @text, NULL, 'prose', @createdAt, @createdAt,
      @botId, @botName, @botRole, @botColor, @botKind,
      @threadTitle, @projectId, @projectName
    )
  `);
  const pruneProseStmt = db.prepare(`
    DELETE FROM inbox_messages
    WHERE state = 'prose'
      AND id NOT IN (
        SELECT id FROM inbox_messages
        WHERE state = 'prose'
        ORDER BY created_at DESC, id DESC
        LIMIT 500
      )
  `);
  const getByIdStmt = db.prepare(`SELECT * FROM inbox_messages WHERE id = ?`);
  const listOpenStmt = db.prepare(
    `SELECT * FROM inbox_messages WHERE state = 'open' ORDER BY created_at ASC, id ASC`,
  );
  const listResolvedSinceStmt = db.prepare(
    `SELECT * FROM inbox_messages WHERE state IN ('answered', 'dismissed') AND resolved_at >= ? ORDER BY resolved_at DESC, id DESC`,
  );
  const listByThreadStmt = db.prepare(
    `SELECT * FROM inbox_messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC`,
  );
  const listOpenByThreadStmt = db.prepare(
    `SELECT * FROM inbox_messages WHERE thread_id = ? AND state = 'open' ORDER BY created_at ASC, id ASC`,
  );
  const updateAnswerStmt = db.prepare(`
    UPDATE inbox_messages
    SET state = 'answered', answer_text = ?, resolved_at = ?
    WHERE id = ? AND state = 'open'
  `);
  const updateDismissStmt = db.prepare(`
    UPDATE inbox_messages
    SET state = 'dismissed', resolved_at = ?
    WHERE id = ? AND state = 'open'
  `);
  const updateMetaStmt = db.prepare(`
    UPDATE inbox_messages
    SET bot_id = ?, bot_name = ?, bot_role = ?, bot_color = ?, bot_kind = ?,
        thread_title = ?, project_id = ?, project_name = ?
    WHERE id = ?
  `);

  const lastMetaRefreshByThread = new Map<string, number>();

  async function resolveBotSummary(threadId: string): Promise<BotSummary | null> {
    try {
      const resolved = await resolveThreadBot(bb, store, threadId, false);
      if (!resolved) return null;
      return {
        id: resolved.bot.id,
        name: resolved.bot.name,
        role: resolved.bot.role ?? "",
        ...(resolved.bot.avatar?.color ? { color: resolved.bot.avatar.color } : {}),
        kind: resolved.bot.kind,
      };
    } catch {
      return null;
    }
  }

  async function resolveThreadMeta(threadId: string) {
    let threadTitle: string | null = null;
    let projectId: string | null = null;
    let projectName: string | null = null;
    let turnId: string | null = null;

    const [threadResult, botResult, timelineResult] = await Promise.allSettled([
      bb.sdk.threads.get({ threadId }),
      resolveBotSummary(threadId),
      bb.sdk.threads.timeline({ threadId }),
    ]);

    if (threadResult.status === "fulfilled" && threadResult.value) {
      const t = threadResult.value as {
        title?: string | null;
        projectId?: string | null;
      };
      threadTitle = t.title ?? null;
      projectId = t.projectId ?? null;
    }

    if (projectId) {
      try {
        const project = (await bb.sdk.projects.get({ projectId })) as {
          name?: string | null;
        } | null;
        projectName = project?.name ?? null;
      } catch {
        projectName = null;
      }
    }

    if (timelineResult.status === "fulfilled" && timelineResult.value) {
      const tl = timelineResult.value as {
        items?: Array<{ turnId?: string | null }>;
        turns?: Array<{ id?: string | null }>;
      };
      const items = tl.items ?? [];
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const candidate = items[i]?.turnId;
        if (typeof candidate === "string" && candidate.length > 0) {
          turnId = candidate;
          break;
        }
      }
      if (!turnId && Array.isArray(tl.turns) && tl.turns.length > 0) {
        const lastTurn = tl.turns[tl.turns.length - 1];
        if (typeof lastTurn?.id === "string" && lastTurn.id.length > 0) {
          turnId = lastTurn.id;
        }
      }
    }

    const bot = botResult.status === "fulfilled" ? botResult.value : null;
    return { bot, threadTitle, projectId, projectName, turnId };
  }

  function scheduleBackgroundMetadataRefresh(rows: DbRow[]): void {
    const now = Date.now();
    const staleThreadIds = [...new Set(rows.map((r) => r.thread_id))].filter(
      (tid) => now - (lastMetaRefreshByThread.get(tid) ?? 0) > META_REFRESH_TTL_MS,
    );
    if (staleThreadIds.length === 0) return;
    for (const tid of staleThreadIds) {
      lastMetaRefreshByThread.set(tid, now);
    }

    void (async () => {
      let anyChanged = false;
      await Promise.all(
        staleThreadIds.map(async (threadId) => {
          const [threadRes, botRes] = await Promise.allSettled([
            bb.sdk.threads.get({ threadId }),
            resolveBotSummary(threadId),
          ]);
          const t =
            threadRes.status === "fulfilled"
              ? (threadRes.value as {
                  title?: string | null;
                  projectId?: string | null;
                } | null)
              : null;
          let projectName: string | null = null;
          if (t?.projectId) {
            try {
              const p = (await bb.sdk.projects.get({
                projectId: t.projectId,
              })) as { name?: string | null } | null;
              projectName = p?.name ?? null;
            } catch {
              projectName = null;
            }
          }
          const freshBot = botRes.status === "fulfilled" ? botRes.value : null;
          const freshTitle = t?.title ?? null;
          const freshProjectId = t?.projectId ?? null;

          const matchingRows = rows.filter((r) => r.thread_id === threadId);
          for (const row of matchingRows) {
            const existing = rowToMessage(row);
            const bot = freshBot ?? existing.bot;
            const threadTitle = freshTitle ?? row.thread_title;
            const projectId = freshProjectId ?? row.project_id;
            const projName = projectName ?? row.project_name;
            if (
              bot?.id !== row.bot_id ||
              bot?.name !== row.bot_name ||
              bot?.role !== (row.bot_role ?? "") ||
              bot?.color !== (row.bot_color ?? undefined) ||
              threadTitle !== row.thread_title ||
              projectId !== row.project_id ||
              projName !== row.project_name
            ) {
              updateMetaStmt.run(
                bot?.id ?? null,
                bot?.name ?? null,
                bot?.role ?? null,
                bot?.color ?? null,
                bot?.kind ?? null,
                threadTitle,
                projectId,
                projName,
                row.id,
              );
              anyChanged = true;
            }
          }
        }),
      );
      if (anyChanged) {
        bb.realtime.publish(INBOX_REALTIME_CHANNEL, { kind: "meta_refreshed" });
      }
    })().catch(() => {});
  }

  function listInbox(includeResolvedToday = true) {
    const openRows = listOpenStmt.all() as DbRow[];
    const open = openRows.map(rowToMessage);
    scheduleBackgroundMetadataRefresh(openRows);
    let resolvedToday: InboxMessage[] = [];
    if (includeResolvedToday) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      const resolvedRows = listResolvedSinceStmt.all(
        midnight.getTime(),
      ) as DbRow[];
      resolvedToday = resolvedRows.map(rowToMessage);
    }
    return { open, resolvedToday };
  }

  function listThreadMessages(threadId: string): InboxMessage[] {
    const rows = listByThreadStmt.all(threadId) as DbRow[];
    return rows.map(rowToMessage);
  }

  function getMessage(messageId: number): InboxMessage | null {
    const row = getByIdStmt.get(messageId) as DbRow | undefined;
    return row ? rowToMessage(row) : null;
  }

  function openCountsByThread(keys: string[]): Record<string, ThreadOpenCount> {
    const result: Record<string, ThreadOpenCount> = {};
    if (keys.length === 0) return result;
    const placeholders = keys.map(() => "?").join(",");
    const stmt = db.prepare(`
      SELECT thread_id, COUNT(*) AS open_count, MIN(created_at) AS oldest_at
      FROM inbox_messages
      WHERE state = 'open' AND thread_id IN (${placeholders})
      GROUP BY thread_id
    `);
    const rows = stmt.all(...keys) as Array<{
      thread_id: string;
      open_count: number;
      oldest_at: number | null;
    }>;
    const byThread = new Map(rows.map((r) => [r.thread_id, r]));
    for (const key of keys) {
      const found = byThread.get(key);
      result[key] = {
        openCount: found?.open_count ?? 0,
        oldestAt: found?.oldest_at ?? null,
      };
    }
    return result;
  }

  function openQuestionsInstruction(threadId: string): string | null {
    const openRows = listOpenByThreadStmt.all(threadId) as DbRow[];
    if (openRows.length === 0) return null;
    const now = Date.now();
    const lines = openRows.map((row) => {
      const msg = rowToMessage(row);
      return `- message #${msg.id}: ${gist(msg)} (asked ${formatAgo(msg.createdAt, now, { ago: true })})`;
    });
    return `Open Inbox questions to the user in this thread (unanswered until they answer or dismiss them):\n${lines.join("\n")}`;
  }

  async function answerMessage(
    messageId: number,
    reply: ReplyInput,
  ): Promise<InboxMessage> {
    checkReply(reply);
    const now = Date.now();
    const tx = db.transaction(() => {
      const existing = getByIdStmt.get(messageId) as DbRow | undefined;
      if (!existing || existing.state !== "open") {
        throw new Error(NOT_OPEN);
      }
      const message = rowToMessage(existing);
      const formatted = replyText(reply, message.query ?? []);
      const res = updateAnswerStmt.run(formatted, now, messageId);
      if (res.changes !== 1) {
        throw new Error(NOT_OPEN);
      }
      const updated = getByIdStmt.get(messageId) as DbRow;
      return { updated: rowToMessage(updated), formatted };
    });

    const { updated, formatted } = tx();

    bb.realtime.publish(INBOX_REALTIME_CHANNEL, {
      kind: "answered",
      messageId: updated.id,
      threadId: updated.threadId,
    });

    const deliveryText = `Answer to message #${updated.id}:\n\n${formatted}`;
    try {
      await bb.sdk.threads.send({
        threadId: updated.threadId,
        mode: "auto",
        input: [{ type: "text", text: deliveryText, mentions: [] }],
      });
    } catch (error) {
      bb.log.warn(
        `Failed to deliver inbox answer #${updated.id} to thread ${updated.threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return updated;
  }

  function dismissMessage(messageId: number): InboxMessage {
    const now = Date.now();
    const tx = db.transaction(() => {
      const existing = getByIdStmt.get(messageId) as DbRow | undefined;
      if (!existing || existing.state !== "open") {
        throw new Error(NOT_OPEN);
      }
      const res = updateDismissStmt.run(now, messageId);
      if (res.changes !== 1) {
        throw new Error(NOT_OPEN);
      }
      const updated = getByIdStmt.get(messageId) as DbRow;
      return rowToMessage(updated);
    });

    const updated = tx();

    bb.realtime.publish(INBOX_REALTIME_CHANNEL, {
      kind: "dismissed",
      messageId: updated.id,
      threadId: updated.threadId,
    });

    return updated;
  }

  async function executeMessageTool(
    input: MessageToolInput,
    ctx: { threadId: string },
  ): Promise<string | PluginAgentToolResult> {
    const text = input.text.trim();
    if (!text) return errorResult("text must be non-empty");

    const to = (input.to ?? "user").trim();
    if (!to) return errorResult("to must be non-empty when provided");

    // 1. User recipient (default)
    if (to === "user") {
      const meta = await resolveThreadMeta(ctx.threadId);
      const createdAt = Date.now();

      // Without query -> render inline in chat as prose, skip Inbox completely
      if (input.query === undefined) {
        const info = insertProseStmt.run({
          threadId: ctx.threadId,
          turnId: meta.turnId,
          text,
          createdAt,
          botId: meta.bot?.id ?? null,
          botName: meta.bot?.name ?? null,
          botRole: meta.bot?.role ?? null,
          botColor: meta.bot?.color ?? null,
          botKind: meta.bot?.kind ?? null,
          threadTitle: meta.threadTitle,
          projectId: meta.projectId,
          projectName: meta.projectName,
        });
        const id = Number(info.lastInsertRowid);
        try {
          pruneProseStmt.run();
        } catch {
          // Best-effort prose retention cleanup
        }
        bb.realtime.publish(INBOX_REALTIME_CHANNEL, {
          kind: "prose",
          messageId: id,
          threadId: ctx.threadId,
        });
        return JSON.stringify({
          id,
          mode: "prose",
          previewDirective: `::inbox-message{id="${id}"}`,
          instruction: `Emit ::inbox-message{id="${id}"} once on its own line in your reply (not in backticks or a code fence, and do not repeat the message text) so it renders in chat.`,
        });
      }

      let normalizedQuery: Question[];
      try {
        normalizedQuery = checkQuestions(input.query);
      } catch (error) {
        return errorResult(
          error instanceof Error ? error.message : String(error),
        );
      }

      const info = insertStmt.run({
        threadId: ctx.threadId,
        turnId: meta.turnId,
        text,
        questionsJson: JSON.stringify(normalizedQuery),
        createdAt,
        botId: meta.bot?.id ?? null,
        botName: meta.bot?.name ?? null,
        botRole: meta.bot?.role ?? null,
        botColor: meta.bot?.color ?? null,
        botKind: meta.bot?.kind ?? null,
        threadTitle: meta.threadTitle,
        projectId: meta.projectId,
        projectName: meta.projectName,
      });

      const id = Number(info.lastInsertRowid);

      bb.realtime.publish(INBOX_REALTIME_CHANNEL, {
        kind: "created",
        messageId: id,
        threadId: ctx.threadId,
      });

      return JSON.stringify({
        id,
        mode: "inbox",
        previewDirective: `::inbox-message{id="${id}"}`,
        instruction: `Queued in the user's Inbox awaiting decision. Emit ::inbox-message{id="${id}"} once on its own line in your reply (not in backticks or a code fence, and do not repeat the message text or options) so the interactive decision card renders in chat. End your turn if you need their answer before continuing.`,
      });
    }

    // Non-user targets do not accept `query`
    if (input.query !== undefined) {
      return errorResult(
        'query is only supported when messaging the user (to: "user").',
      );
    }

    // 2. Parent thread
    if (to === "parent") {
      let parentThreadId: string | null = null;
      try {
        const current = (await bb.sdk.threads.get({
          threadId: ctx.threadId,
        })) as { parentThreadId?: string | null } | null;
        parentThreadId = current?.parentThreadId ?? null;
      } catch (error) {
        return errorResult(
          `Could not inspect current thread: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!parentThreadId) {
        return errorResult(
          'Cannot send to "parent": this thread has no parent thread.',
        );
      }
      const senderBot = await resolveBotSummary(ctx.threadId);
      const framed = formatDirectThreadMessage(ctx.threadId, senderBot, text);
      try {
        await bb.sdk.threads.send({
          threadId: parentThreadId,
          mode: "queue-if-active",
          senderThreadId: ctx.threadId,
          input: [{ type: "text", text: framed, mentions: [] }],
        });
      } catch (error) {
        return errorResult(
          `Failed to send to parent thread ${parentThreadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return JSON.stringify({
        to: "parent",
        threadId: parentThreadId,
        delivered: true,
      });
    }

    // 3. Direct thread ID (thr_...)
    if (THREAD_ID_RE.test(to)) {
      if (to === ctx.threadId) {
        return errorResult("Cannot send a message to your own thread.");
      }
      try {
        const targetThread = (await bb.sdk.threads.get({ threadId: to })) as {
          archivedAt?: number | null;
          deletedAt?: number | null;
        } | null;
        if (!targetThread || targetThread.deletedAt != null) {
          return errorResult(`Thread "${to}" not found.`);
        }
        if (targetThread.archivedAt != null) {
          return errorResult(`Thread "${to}" is archived.`);
        }
      } catch (error) {
        return errorResult(
          `Thread "${to}" not found: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const senderBot = await resolveBotSummary(ctx.threadId);
      const framed = formatDirectThreadMessage(ctx.threadId, senderBot, text);
      try {
        await bb.sdk.threads.send({
          threadId: to,
          mode: "queue-if-active",
          senderThreadId: ctx.threadId,
          input: [{ type: "text", text: framed, mentions: [] }],
        });
      } catch (error) {
        return errorResult(
          `Failed to send to thread ${to}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return JSON.stringify({
        to,
        threadId: to,
        delivered: true,
      });
    }

    // 4. Special thread name match on the sender's own bot (e.g. to: "Lander")
    const senderBot = await resolveBotSummary(ctx.threadId);
    if (senderBot) {
      const needle = to.toLowerCase();
      const matchingSpecials = store
        .listSpecialThreadsForBot(senderBot.id)
        .filter((s) => s.name.toLowerCase() === needle && s.threadId !== ctx.threadId);
      if (matchingSpecials.length > 1) {
        return errorResult(
          `Multiple Special threads match "${to}" (${matchingSpecials.map((s) => s.threadId).join(", ")}). Use the exact thread ID.`,
        );
      }
      const matchingSpecial = matchingSpecials[0];
      if (matchingSpecial) {
        // Check for ambiguity with a bot of the exact same name
        let botConflict: { bot: { id: string; name: string } } | null = null;
        try {
          botConflict = await findBotTarget(bb, store, to);
        } catch {
          botConflict = null;
        }
        if (botConflict) {
          return errorResult(
            `"${to}" is ambiguous: it matches both Special thread "${matchingSpecial.name}" (${matchingSpecial.threadId}) and bot "${botConflict.bot.name}" (${botConflict.bot.id}). Use the exact thread ID or bot ID.`,
          );
        }

        // Verify special thread is still active (not archived or deleted)
        try {
          const targetThread = (await bb.sdk.threads.get({
            threadId: matchingSpecial.threadId,
          })) as { archivedAt?: number | null; deletedAt?: number | null } | null;
          if (!targetThread || targetThread.deletedAt != null || targetThread.archivedAt != null) {
            store.removeSpecialThread(matchingSpecial.threadId);
            publishSidebar();
            return errorResult(
              `Special thread "${matchingSpecial.name}" (${matchingSpecial.threadId}) is archived or deleted and has been demoted.`,
            );
          }
        } catch {
          store.removeSpecialThread(matchingSpecial.threadId);
          publishSidebar();
          return errorResult(
            `Special thread "${matchingSpecial.name}" (${matchingSpecial.threadId}) no longer exists and has been demoted.`,
          );
        }

        const framed = formatDirectThreadMessage(ctx.threadId, senderBot, text);
        try {
          await bb.sdk.threads.send({
            threadId: matchingSpecial.threadId,
            mode: "queue-if-active",
            senderThreadId: ctx.threadId,
            input: [{ type: "text", text: framed, mentions: [] }],
          });
        } catch (error) {
          return errorResult(
            `Failed to send to Special thread "${matchingSpecial.name}" (${matchingSpecial.threadId}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return JSON.stringify({
          to: matchingSpecial.name,
          specialThread: matchingSpecial.name,
          threadId: matchingSpecial.threadId,
          delivered: true,
        });
      }
    }

    // 5. Direct in-process bot target (botId, projectId, or exact bot name)
    try {
      const delivered = await sendBotMessage(
        bb,
        store,
        {
          senderThreadId: ctx.threadId,
          target: to,
          message: text,
        },
        publishSidebar,
      );
      return JSON.stringify(delivered);
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    listInbox,
    listThreadMessages,
    getMessage,
    openCountsByThread,
    openQuestionsInstruction,
    answerMessage,
    dismissMessage,
    executeMessageTool,
  };
}
