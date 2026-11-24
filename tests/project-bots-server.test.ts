import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { createProjectBotsServer, type BotRecordDto } from "../server";
import { projectBotHash } from "../lib/bot-file";

type Project = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["get"]>>;

function makeProject(id: string, name: string, path: string): Project {
  return {
    id,
    name,
    kind: "standard",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: `src_${id}`,
        projectId: id,
        hostId: "host_1",
        path,
        type: "local_path",
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn();
  }
});

async function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), "bb-project-bots-test-"));
  const alpha = makeProject("proj_alpha", "Alpha App", "/work/alpha");
  const beta = makeProject("proj_beta", "Beta Lib", "/work/beta");
  const personal: Project = {
    id: "proj_personal",
    name: "Personal",
    kind: "personal",
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [],
  };

  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const outlines = new Map<string, { items: Array<{ id: string; role: "user" | "assistant"; preview: string; attachmentSummary: null }>; maxSeq: number }>();
  const queuedByThread = new Map<string, Array<{ id: string; threadId: string; state: "queued"; initiator: "user" | "agent"; senderThreadId: string | null; sendAt: null; createdAt: number; updatedAt: number; waitingOn: { kind: "thread-busy" } | null; content: Array<{ type: "text"; text: string; mentions: [] }> }>>();
  let seq = 0;
  const sendMock = vi.fn(async () => ({ ok: true as const, delivery: "sent" as const }));
  const spawnMock = vi.fn(async (args: { projectId: string; visibility?: string }) => {
    const id = `thr_spawn_${++seq}`;
    const thread = makeThreadResponse({
      id,
      projectId: args.projectId,
      visibility: (args.visibility as "visible" | "hidden" | undefined) ?? "visible",
    });
    threads.set(id, thread);
    return thread;
  });
  const waitMock = vi.fn(async ({ threadId }: { threadId: string }) => ({
    matched: true as const,
    target: { kind: "status" as const, status: "idle" as const },
    threadId,
    status: "idle" as const,
  }));
  const archiveMock = vi.fn(async () => ({ ok: true as const }));
  const clearContextMock = vi.fn(async () => ({ ok: true as const }));
  const updateThreadMock = vi.fn(async () => ({ ok: true as const }));

  const host = createFakePluginHost({
    pluginId: "bb-project-bots",
    agentSkillIds: ["project-bots"],
    sdk: {
      projects: {
        list: async (args) => (args?.includePersonal ? [alpha, beta, personal] : [alpha, beta]),
        get: async ({ projectId }) => {
          const found = [alpha, beta, personal].find((p) => p.id === projectId);
          if (!found) throw new Error(`Missing project ${projectId}`);
          return found;
        },
      },
      hosts: {
        list: async () => [{ id: "host_1", name: "Local", status: "connected" }],
      },
      threads: {
        list: async () => [...threads.values()],
        get: async ({ threadId }) => {
          const t = threads.get(threadId);
          if (!t) throw new Error(`Missing thread ${threadId}`);
          return t;
        },
        conversationOutline: async ({ threadId }) => outlines.get(threadId) ?? { items: [], maxSeq: 0 },
        queue: {
          list: async () => [...queuedByThread.values()].flat() as never,
        },
        queuedMessages: {
          list: async ({ threadId }) => (queuedByThread.get(threadId) ?? []) as never,
        },
        send: sendMock,
        spawn: spawnMock,
        wait: waitMock,
        archive: archiveMock,
        clearContext: clearContextMock,
        update: updateThreadMock,
      },
    },
  });

  await createProjectBotsServer({ rootDir })(host.bb);
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    rmSync(rootDir, { recursive: true, force: true });
  });

  return { rootDir, alpha, beta, personal, threads, outlines, queuedByThread, host, sendMock, spawnMock, waitMock, archiveMock, clearContextMock, updateThreadMock };
}

describe("bb-project-bots server", () => {
  it("shows generated project bots and auto-creates <hash6>.md on first thread entry", async () => {
    const { rootDir, alpha, threads, host } = await setup();
    const expectedFile = join(rootDir, `${projectBotHash("/work/alpha")}.md`);

    // Before entering a thread: preview exists, file does NOT exist yet
    const initial = (await host.harness.behavior.callRpc("sidebar_state", null)) as {
      projectBots: BotRecordDto[];
    };
    expect(initial.projectBots).toHaveLength(2);
    const alphaPreview = initial.projectBots.find((b) => b.projectId === alpha.id)!;
    expect(alphaPreview.materialized).toBe(false);
    expect(alphaPreview.filePath).toBe(expectedFile);
    expect(existsSync(expectedFile)).toBe(false);

    // First time entering a thread of Alpha -> auto-generates <hash6>.md!
    threads.set("thr_a1", makeThreadResponse({ id: "thr_a1", projectId: alpha.id }));
    const viewed = (await host.harness.behavior.callRpc("conversation_viewed", { threadId: "thr_a1" })) as {
      botId: string | null;
      materializedNow: boolean;
    };
    expect(viewed.materializedNow).toBe(true);
    expect(existsSync(expectedFile)).toBe(true);

    const diskContent = readFileSync(expectedFile, "utf8");
    expect(diskContent).toContain("projectId: proj_alpha");
    expect(diskContent).toContain("name: Alpha App");
    expect(diskContent).toContain("## Facts");
    expect(diskContent).toContain("## Lessons");
    expect(diskContent).toContain("## Preferences");

    // Second view does not re-materialize
    const viewed2 = (await host.harness.behavior.callRpc("conversation_viewed", { threadId: "thr_a1" })) as {
      materializedNow: boolean;
    };
    expect(viewed2.materializedNow).toBe(false);
  });

  it("updates project bot markdown memory via update_memory_state tool", async () => {
    const { rootDir, alpha, threads, host } = await setup();
    threads.set("thr_a1", makeThreadResponse({ id: "thr_a1", projectId: alpha.id }));

    const res = await host.harness.behavior.callAgentTool(
      "update_memory_state",
      { action: "lesson", text: "Always run migrations before tests" },
      { threadId: "thr_a1", projectId: alpha.id },
    );
    const parsed = JSON.parse(String(res)) as { changed: boolean; filePath: string };
    expect(parsed.changed).toBe(true);
    expect(parsed.filePath).toBe(join(rootDir, `${projectBotHash("/work/alpha")}.md`));
    expect(readFileSync(parsed.filePath, "utf8")).toContain("- Always run migrations before tests");
  });

  it("creates unaffiliated coordinator bots in their own directory and delivers bot-to-bot messages via RPC", async () => {
    const { rootDir, personal, host, spawnMock } = await setup();

    const chief = (await host.harness.behavior.callRpc("bot_create_unaffiliated", {
      name: "Chief",
      role: "Coordinator",
      avatar: { color: "#6d5efc", shape: "blob", expression: "curious", motion: "calm" },
    })) as BotRecordDto;

    expect(chief.kind).toBe("unaffiliated");
    expect(chief.directoryPath).toBe(join(rootDir, "unaffiliated", chief.id));
    expect(existsSync(join(chief.directoryPath!, "bot.md"))).toBe(true);
    expect(existsSync(join(chief.directoryPath!, "goals.md"))).toBe(false);

    // Start a conversation with Chief
    const created = (await host.harness.behavior.callRpc("conversation_create", {
      kind: "unaffiliated",
      botId: chief.id,
      request: {
        projectId: personal.id,
        providerId: "pi",
        model: "test",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        executionInputSources: {
          providerId: "explicit",
          model: "explicit",
          reasoningLevel: "explicit",
          permissionMode: "explicit",
        },
        environment: { type: "host", hostId: "host_1", workspace: { type: "personal" } },
        input: [{ type: "text", text: "Ship Alpha v2", mentions: [] }],
      },
    })) as { threadId: string };

    // Configure agent for Chief's thread -> coordinator-only instructions (no manage_goals or message_bot)
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: created.threadId },
        project: { id: personal.id, kind: "personal", name: personal.name },
      }),
    );
    expect(cfg.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["update_memory_state", "list_bots", "inspect_bot"]),
    );
    expect(cfg.tools.map((t) => t.name)).not.toContain("message_bot");
    expect(cfg.tools.map((t) => t.name)).not.toContain("manage_goals");
    expect(cfg.skills).toEqual(["project-bots"]);
    expect(cfg.instructions).toContain("unaffiliated coordinator bot");
    expect(cfg.instructions).toContain("do **NOT** perform direct repository work");

    // Chief discovers Alpha App's project bot
    const listRes = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool("list_bots", {}, { threadId: created.threadId, projectId: personal.id }),
      ),
    );
    expect(listRes.total).toBe(3); // Chief + Alpha + Beta

    // Deliver message via RPC (used by unified message({ to, text }) tool) -> auto-spawns a thread in Alpha & materializes its <hash6>.md
    const msgRes = (await host.harness.behavior.callRpc("deliver_message", {
      senderThreadId: created.threadId,
      target: "Alpha App",
      message: "Please prepare the v2 release.",
    })) as { botId: string; botName: string; threadId: string; spawned: boolean };
    expect(msgRes.spawned).toBe(true);
    expect(msgRes.botName).toBe("Alpha App");
    expect(spawnMock).toHaveBeenCalledTimes(2); // 1 for Chief's thread + 1 auto-spawned for Alpha
    expect(existsSync(join(rootDir, `${projectBotHash("/work/alpha")}.md`))).toBe(true);
  });

  it("supports bb project-bots list CLI", async () => {
    const { host } = await setup();
    const res = await host.harness.behavior.runCli(["list", "--json"]);
    expect(res.exitCode).toBe(0);
    const data = JSON.parse(res.stdout!);
    expect(data.total).toBe(2);
    expect(data.bots.map((b: { name: string }) => b.name)).toEqual(["Alpha App", "Beta Lib"]);
  });

  it("deep-link compose staging binds the next personal thread to the unaffiliated bot", async () => {
    const { personal, threads, host } = await setup();
    const chief = (await host.harness.behavior.callRpc("bot_create_unaffiliated", {
      name: "Chief",
      role: "Coordinator",
      avatar: { color: "#6d5efc", shape: "blob", expression: "curious", motion: "calm" },
    })) as BotRecordDto;

    await host.harness.behavior.callRpc("stage_compose_start", { botId: chief.id });

    // Simulate BB creating a personal thread from the native compose screen
    const thread = makeThreadResponse({ id: "thr_compose_1", projectId: personal.id });
    threads.set(thread.id, thread);
    await host.harness.behavior.emitThreadEvent("thread.created", { thread });

    const info = (await host.harness.behavior.callRpc("thread_bot_info", { threadId: thread.id })) as {
      bot: BotRecordDto | null;
    };
    expect(info.bot?.id).toBe(chief.id);

    // Subsequent personal thread is NOT captured (staged target was consumed)
    const thread2 = makeThreadResponse({ id: "thr_compose_2", projectId: personal.id });
    threads.set(thread2.id, thread2);
    await host.harness.behavior.emitThreadEvent("thread.created", { thread: thread2 });
    const info2 = (await host.harness.behavior.callRpc("thread_bot_info", { threadId: thread2.id })) as {
      bot: BotRecordDto | null;
    };
    expect(info2.bot).toBeNull();
  });

  it("supports pinning bots, caches real project paths for agents.configure, and runs Dream Mode on one visible thread under top unaffiliated bot with /new", async () => {
    const { alpha, beta, threads, outlines, host, spawnMock, sendMock, archiveMock, clearContextMock } = await setup();

    // Create an unaffiliated bot so Dream thread attaches under it
    const chief = (await host.harness.behavior.callRpc("bot_create_unaffiliated", {
      name: "Chief",
      role: "Coordinator",
      avatar: { color: "#6d5efc", shape: "blob", expression: "curious", motion: "calm" },
    })) as BotRecordDto;

    // agents.configure resolves real filesystem path (/work/alpha), NOT project.id!
    threads.set("thr_alpha_1", makeThreadResponse({ id: "thr_alpha_1", projectId: alpha.id, status: "idle", updatedAt: Date.now() }));
    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_alpha_1" },
        project: { id: alpha.id, kind: "standard", name: alpha.name },
      }),
    );
    expect(cfg.instructions).toContain("Project path: /work/alpha");
    expect(cfg.instructions).toContain("trust **instructions > code > memory**");

    // Pinning persists in sidebar_state
    const alphaBotId = `projbot_${projectBotHash("/work/alpha")}`;
    await host.harness.behavior.callRpc("bot_pin_set", { botId: alphaBotId, pinned: true });
    const state = (await host.harness.behavior.callRpc("sidebar_state", null)) as { pinnedBotIds: string[] };
    expect(state.pinnedBotIds).toContain(alphaBotId);

    // Configure Dream Mode provider & model
    await host.harness.behavior.callRpc("dream_config_set", {
      enabled: true,
      providerId: "pi",
      model: "claude-sonnet-4-5",
      intervalMinutes: 60,
    });

    // Seed an unprocessed conversation outline for Alpha and Beta
    outlines.set("thr_alpha_1", {
      maxSeq: 4,
      items: [
        { id: "m1", role: "user", preview: "Remember we always use uv instead of python directly.", attachmentSummary: null },
        { id: "m2", role: "assistant", preview: "Got it, using uv.", attachmentSummary: null },
      ],
    });
    threads.set("thr_beta_1", makeThreadResponse({ id: "thr_beta_1", projectId: beta.id, status: "idle", updatedAt: Date.now() }));
    outlines.set("thr_beta_1", {
      maxSeq: 2,
      items: [{ id: "m3", role: "user", preview: "Beta uses Rust 1.82.", attachmentSummary: null }],
    });

    const dream1 = (await host.harness.behavior.callRpc("dream_run_now", {
      kind: "project",
      botId: alphaBotId,
      projectId: alpha.id,
      force: false,
    })) as { status: string; processedConversations: number };
    expect(dream1.status).toBe("completed");
    expect(dream1.processedConversations).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]![0]).toMatchObject({ visibility: "visible" });
    expect(archiveMock).not.toHaveBeenCalled();
    expect(clearContextMock).toHaveBeenCalledTimes(0);

    // Dream thread is bound under top-most unaffiliated bot ("Chief")
    const afterDream1 = (await host.harness.behavior.callRpc("sidebar_state", null)) as {
      dreamThreadId: string | null;
      threadBindings: Array<{ threadId: string; botId: string }>;
    };
    expect(afterDream1.dreamThreadId).toBeTruthy();
    expect(afterDream1.threadBindings).toContainEqual({ threadId: afterDream1.dreamThreadId, botId: chief.id });

    // Second bot ("Beta") REUSES the same visible Dream thread: calls clearContext before sending (preserves history above)
    const betaBotId = `projbot_${projectBotHash("/work/beta")}`;
    const dreamBeta = (await host.harness.behavior.callRpc("dream_run_now", {
      kind: "project",
      botId: betaBotId,
      projectId: beta.id,
      force: false,
    })) as { status: string; processedConversations: number };
    expect(dreamBeta.status).toBe("completed");
    expect(spawnMock).toHaveBeenCalledTimes(1); // still only 1 Dream thread!
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(clearContextMock).toHaveBeenCalledTimes(1);

    // Re-running Alpha with no new turns skips cleanly (maxSeq already processed)
    const dream2 = (await host.harness.behavior.callRpc("dream_run_now", {
      kind: "project",
      botId: alphaBotId,
      projectId: alpha.id,
      force: false,
    })) as { status: string; processedConversations: number };
    expect(dream2.status).toBe("skipped");
    expect(dream2.processedConversations).toBe(0);
  });

  it("inspect_bot and list_bots expose queued follow-up messages for coordinator context", async () => {
    const { alpha, personal, threads, outlines, queuedByThread, host } = await setup();
    threads.set("thr_alpha_busy", makeThreadResponse({ id: "thr_alpha_busy", projectId: alpha.id, status: "active" }));
    outlines.set("thr_alpha_busy", {
      maxSeq: 2,
      items: [{ id: "m1", role: "user", preview: "Implement feature X", attachmentSummary: null }],
    });
    queuedByThread.set("thr_alpha_busy", [
      {
        id: "q_1",
        threadId: "thr_alpha_busy",
        state: "queued",
        initiator: "user",
        senderThreadId: null,
        sendAt: null,
        createdAt: 100,
        updatedAt: 100,
        waitingOn: { kind: "thread-busy" },
        content: [{ type: "text", text: "Also add unit tests after feature X", mentions: [] }],
      },
    ]);

    const listRes = JSON.parse(
      String(await host.harness.behavior.callAgentTool("list_bots", {}, { threadId: "thr_coord", projectId: personal.id })),
    ) as { bots: Array<{ name: string; queuedFollowUpsCount: number }> };
    expect(listRes.bots.find((b) => b.name === "Alpha App")?.queuedFollowUpsCount).toBe(1);

    const inspectRes = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "inspect_bot",
          { target: "Alpha App" },
          { threadId: "thr_coord", projectId: personal.id },
        ),
      ),
    ) as {
      totalQueuedFollowUps: number;
      threads: Array<{ threadId: string; queuedFollowUps: Array<{ text: string; state: string }> }>;
    };
    expect(inspectRes.totalQueuedFollowUps).toBe(1);
    expect(inspectRes.threads[0]!.queuedFollowUps[0]!.text).toBe("Also add unit tests after feature X");
    expect(inspectRes.threads[0]!.queuedFollowUps[0]!.state).toBe("queued");
  });
});
