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
    agentSkillIds: ["project-bots", "inbox"],
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
      expect.arrayContaining(["update_memory_state", "list_bots", "inspect_bot", "message"]),
    );
    expect(cfg.tools.map((t) => t.name)).not.toContain("message_bot");
    expect(cfg.tools.map((t) => t.name)).not.toContain("manage_goals");
    expect(cfg.skills).toEqual(expect.arrayContaining(["project-bots", "inbox"]));
    expect(cfg.instructions).toContain("unaffiliated coordinator bot");
    expect(cfg.instructions).toContain("do **NOT** perform direct repository work");

    // Chief discovers Alpha App's project bot
    const listRes = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool("list_bots", {}, { threadId: created.threadId, projectId: personal.id }),
      ),
    );
    expect(listRes.total).toBe(3); // Chief + Alpha + Beta

    // Deliver message via unified message({ to, text }) tool -> auto-spawns a thread in Alpha & materializes its <hash6>.md
    const msgRes = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "message",
          { to: "Alpha App", text: "Please prepare the v2 release." },
          { threadId: created.threadId, projectId: personal.id },
        ),
      ),
    ) as { botId: string; botName: string; threadId: string; spawned: boolean };
    expect(msgRes.spawned).toBe(true);
    expect(msgRes.botName).toBe("Alpha App");
    expect(spawnMock).toHaveBeenCalledTimes(2); // 1 for Chief's thread + 1 auto-spawned for Alpha
    expect(spawnMock.mock.calls[1]![0]).toMatchObject({ projectId: "proj_alpha" });
    expect(spawnMock.mock.calls[1]![0]).not.toHaveProperty("startedOnBehalfOf");
    expect(existsSync(join(rootDir, `${projectBotHash("/work/alpha")}.md`))).toBe(true);

    // Messaging an unaffiliated bot with no thread auto-spawns a personal thread on Chief's behalf
    const scout = (await host.harness.behavior.callRpc("bot_create_unaffiliated", {
      name: "Scout",
      role: "Researcher",
      avatar: { color: "#6d5efc", shape: "blob", expression: "curious", motion: "calm" },
    })) as BotRecordDto;
    const scoutRes = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "message",
          { to: scout.id, text: "Research release risks." },
          { threadId: created.threadId, projectId: personal.id },
        ),
      ),
    ) as { botId: string; spawned: boolean };
    expect(scoutRes).toMatchObject({ botId: scout.id, spawned: true });
    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(spawnMock.mock.calls[2]![0]).toMatchObject({ projectId: personal.id });
    expect(spawnMock.mock.calls[2]![0]).not.toHaveProperty("startedOnBehalfOf");
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

  it("supports thread reordering and Special threads with skill injection and name routing", async () => {
    const { alpha, beta, threads, host, sendMock } = await setup();
    const alphaBotId = `projbot_${projectBotHash("/work/alpha")}`;
    threads.set("thr_lander", makeThreadResponse({ id: "thr_lander", projectId: alpha.id }));
    threads.set("thr_worker", makeThreadResponse({ id: "thr_worker", projectId: alpha.id }));
    threads.set("thr_beta", makeThreadResponse({ id: "thr_beta", projectId: beta.id }));

    // Reorder threads for Alpha
    await host.harness.behavior.callRpc("thread_reorder", {
      botId: alphaBotId,
      threadIds: ["thr_worker", "thr_lander"],
    });

    // Promote thr_lander to a Special thread ("Lander")
    const special = (await host.harness.behavior.callRpc("special_thread_set", {
      threadId: "thr_lander",
      botId: alphaBotId,
      name: "Lander",
      icon: "merge",
      color: "#f59e0b",
      instruction: "Work in a git worktree and message Lander with your worktree directory when ready to merge.",
      rolePrompt: "You are the Lander responsible for merging worktrees into main and pushing.",
    })) as { threadId: string; name: string; icon: string };
    expect(special.name).toBe("Lander");

    // sidebar_state reflects special thread and puts newly promoted special thread at top of threadOrder
    const state = (await host.harness.behavior.callRpc("sidebar_state", null)) as {
      threadOrder: Array<{ botId: string; threadIds: string[] }>;
      specialThreads: Array<{ threadId: string; name: string }>;
    };
    expect(state.specialThreads).toHaveLength(1);
    expect(state.specialThreads[0]!.threadId).toBe("thr_lander");
    expect(state.threadOrder.find((o) => o.botId === alphaBotId)?.threadIds).toEqual(["thr_lander", "thr_worker"]);

    // Sibling thread in Alpha receives Lander's standing skill instruction
    const workerCfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_worker" },
        project: { id: alpha.id, kind: "standard", name: alpha.name },
      }),
    );
    expect(workerCfg.instructions).toContain("Special Threads for Alpha App (Standing Skills)");
    expect(workerCfg.instructions).toContain("Work in a git worktree and message Lander");
    expect(workerCfg.instructions).toContain('to: "thr_lander"');

    // Lander itself receives its Special Thread Role prompt
    const landerCfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_lander" },
        project: { id: alpha.id, kind: "standard", name: alpha.name },
      }),
    );
    expect(landerCfg.instructions).toContain("Special Thread Role: Lander");
    expect(landerCfg.instructions).toContain("merging worktrees into main");

    // Beta's threads do NOT receive Alpha's Lander instruction
    const betaCfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_beta" },
        project: { id: beta.id, kind: "standard", name: beta.name },
      }),
    );
    expect(betaCfg.instructions).not.toContain("Special Threads for Alpha App");

    // Sibling thread can message Special thread by name ("Lander")
    const delivered = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "message",
          { to: "Lander", text: "Ready to merge: /tmp/wt-feature-x" },
          { threadId: "thr_worker", projectId: alpha.id },
        ),
      ),
    ) as { specialThread: string; threadId: string; delivered: boolean };
    expect(delivered.delivered).toBe(true);
    expect(delivered.specialThread).toBe("Lander");
    expect(delivered.threadId).toBe("thr_lander");
    expect(sendMock).toHaveBeenCalledTimes(1);

    // Demoting removes the injected instruction
    await host.harness.behavior.callRpc("special_thread_remove", { threadId: "thr_lander" });
    const workerAfter = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_worker" },
        project: { id: alpha.id, kind: "standard", name: alpha.name },
      }),
    );
    expect(workerAfter.instructions).not.toContain("Work in a git worktree and message Lander");

    // Rejects promoting a thread that belongs to a different bot
    await expect(
      host.harness.behavior.callRpc("special_thread_set", {
        threadId: "thr_beta",
        botId: alphaBotId,
        name: "Sneaky",
        icon: "shield",
        instruction: "Should fail",
      }),
    ).rejects.toThrow(/belongs to bot/);

    // Rejects duplicate Special thread names on the same bot (case-insensitive)
    await host.harness.behavior.callRpc("special_thread_set", {
      threadId: "thr_lander",
      botId: alphaBotId,
      name: "Reviewer",
      icon: "shield",
      instruction: "Review changes",
    });
    await expect(
      host.harness.behavior.callRpc("special_thread_set", {
        threadId: "thr_worker",
        botId: alphaBotId,
        name: "reviewer",
        icon: "shield",
        instruction: "Duplicate",
      }),
    ).rejects.toThrow(/already exists/);

    // Ambiguous name routing: special thread with same name as a bot errors instead of silently shadowing
    await host.harness.behavior.callRpc("special_thread_set", {
      threadId: "thr_lander",
      botId: alphaBotId,
      name: "Beta Lib",
      icon: "shield",
      instruction: "Shadows Beta Lib bot name",
    });
    const ambiguous = await host.harness.behavior.callAgentTool(
      "message",
      { to: "Beta Lib", text: "Hello?" },
      { threadId: "thr_worker", projectId: alpha.id },
    );
    expect(JSON.stringify(ambiguous)).toContain("ambiguous");
  });

  it("routes message({ to: botId }) to a non-Special thread, spawning one when only Special threads exist", async () => {
    const { alpha, beta, threads, host, sendMock, spawnMock } = await setup();
    const alphaBotId = `projbot_${projectBotHash("/work/alpha")}`;
    threads.set("thr_main", makeThreadResponse({ id: "thr_main", projectId: alpha.id, updatedAt: 10 }));
    threads.set("thr_lander", makeThreadResponse({ id: "thr_lander", projectId: alpha.id, updatedAt: 20 }));
    threads.set("thr_beta", makeThreadResponse({ id: "thr_beta", projectId: beta.id }));
    await host.harness.behavior.callRpc("special_thread_set", {
      threadId: "thr_lander",
      botId: alphaBotId,
      name: "Lander",
      icon: "merge",
      instruction: "Message Lander to merge.",
    });
    // Lander is both the newest and the last-viewed thread of the bot
    await host.harness.behavior.callRpc("conversation_viewed", { threadId: "thr_lander" });

    const listed = JSON.parse(String(await host.harness.behavior.callAgentTool("list_bots", {}, { threadId: "thr_beta", projectId: beta.id }))) as {
      bots: Array<{ id: string; defaultThreadId: string | null }>;
    };
    expect(listed.bots.find((b) => b.id === alphaBotId)?.defaultThreadId).toBe("thr_main");

    const toBot = JSON.parse(
      String(await host.harness.behavior.callAgentTool("message", { to: alphaBotId, text: "Status?" }, { threadId: "thr_beta", projectId: beta.id })),
    ) as { threadId: string; spawned: boolean };
    expect(toBot).toMatchObject({ threadId: "thr_main", spawned: false });
    expect(sendMock).toHaveBeenCalledTimes(1);

    threads.set("thr_main", makeThreadResponse({ id: "thr_main", projectId: alpha.id, archivedAt: 30 }));
    const spawnedRes = JSON.parse(
      String(await host.harness.behavior.callAgentTool("message", { to: alphaBotId, text: "Status?" }, { threadId: "thr_beta", projectId: beta.id })),
    ) as { threadId: string; spawned: boolean };
    expect(spawnedRes.spawned).toBe(true);
    expect(spawnedRes.threadId).not.toBe("thr_lander");
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("viewing or creating a Special thread keeps routing on the bot's last working thread", async () => {
    const { alpha, beta, threads, host, sendMock } = await setup();
    const alphaBotId = `projbot_${projectBotHash("/work/alpha")}`;
    threads.set("thr_work", makeThreadResponse({ id: "thr_work", projectId: alpha.id, updatedAt: 10 }));
    threads.set("thr_newer", makeThreadResponse({ id: "thr_newer", projectId: alpha.id, updatedAt: 30 }));
    threads.set("thr_lander", makeThreadResponse({ id: "thr_lander", projectId: alpha.id, updatedAt: 40 }));
    threads.set("thr_beta", makeThreadResponse({ id: "thr_beta", projectId: beta.id }));
    await host.harness.behavior.callRpc("special_thread_set", {
      threadId: "thr_lander",
      botId: alphaBotId,
      name: "Lander",
      icon: "merge",
      instruction: "Message Lander to merge.",
    });
    const toAlpha = async () =>
      (JSON.parse(
        String(await host.harness.behavior.callAgentTool("message", { to: alphaBotId, text: "Status?" }, { threadId: "thr_beta", projectId: beta.id })),
      ) as { threadId: string }).threadId;

    await host.harness.behavior.callRpc("conversation_viewed", { threadId: "thr_work" });
    await host.harness.behavior.callRpc("conversation_viewed", { threadId: "thr_lander" });
    expect(await toAlpha()).toBe("thr_work");

    const created = (await host.harness.behavior.callRpc("special_thread_create", {
      botId: alphaBotId,
      name: "Reviewer",
      icon: "shield",
      instruction: "Message Reviewer before landing.",
    })) as { threadId: string };
    expect(await toAlpha()).toBe("thr_work");
    expect(sendMock).toHaveBeenCalledTimes(2);

    // The sidebar still reopens the Special thread the user last viewed
    const state = (await host.harness.behavior.callRpc("sidebar_state", null)) as { lastViewed: Array<{ botId: string; threadId: string }> };
    expect(state.lastViewed.find((v) => v.botId === alphaBotId)?.threadId).toBe(created.threadId);

    // Demoting the Special thread the user is on makes it the routing thread
    await host.harness.behavior.callRpc("special_thread_remove", { threadId: created.threadId });
    expect(await toAlpha()).toBe(created.threadId);
  });

  it("dismiss_message lets an agent dismiss only Inbox questions its own thread asked", async () => {
    const { alpha, threads, host } = await setup();
    threads.set("thr_asker", makeThreadResponse({ id: "thr_asker", projectId: alpha.id }));
    threads.set("thr_other", makeThreadResponse({ id: "thr_other", projectId: alpha.id }));
    host.harness.sdk.stub("threads.timeline", async () => ({ items: [] }) as never);

    const cfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_asker" },
        project: { id: alpha.id, kind: "standard", name: alpha.name },
      }),
    );
    expect(cfg.tools.map((tool) => tool.name)).toContain("dismiss_message");

    const asked = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "message",
          { text: "**Ship it?**", query: [{ text: "Ship now?", kind: "confirm" }] },
          { threadId: "thr_asker", projectId: alpha.id },
        ),
      ),
    ) as { id: number; mode: string };
    expect(asked.mode).toBe("inbox");

    const foreign = await host.harness.behavior.callAgentTool(
      "dismiss_message",
      { messageId: asked.id },
      { threadId: "thr_other", projectId: alpha.id },
    );
    expect(JSON.stringify(foreign)).toContain("only its own thread can dismiss it");
    const stillOpen = (await host.harness.behavior.callRpc("get_message", { messageId: asked.id })) as {
      message: { state: string };
    };
    expect(stillOpen.message.state).toBe("open");

    const own = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "dismiss_message",
          { messageId: asked.id },
          { threadId: "thr_asker", projectId: alpha.id },
        ),
      ),
    ) as { id: number; state: string };
    expect(own).toEqual({ id: asked.id, state: "dismissed" });

    const again = await host.harness.behavior.callAgentTool(
      "dismiss_message",
      { messageId: asked.id },
      { threadId: "thr_asker", projectId: alpha.id },
    );
    expect(JSON.stringify(again)).toContain("no longer open");
  });

  it("special_thread tool: project bots manage only their own Special threads; coordinators manage any project bot's", async () => {
    const { alpha, beta, threads, host, spawnMock } = await setup();
    const alphaBotId = `projbot_${projectBotHash("/work/alpha")}`;
    const betaBotId = `projbot_${projectBotHash("/work/beta")}`;
    threads.set("thr_alpha", makeThreadResponse({ id: "thr_alpha", projectId: alpha.id }));
    threads.set("thr_alpha_2", makeThreadResponse({ id: "thr_alpha_2", projectId: alpha.id }));
    threads.set("thr_beta", makeThreadResponse({ id: "thr_beta", projectId: beta.id }));
    const asAlpha = { threadId: "thr_alpha", projectId: alpha.id };
    const call = (input: Record<string, unknown>, ctx = asAlpha) =>
      host.harness.behavior.callAgentTool("special_thread", input, ctx);

    const alphaCfg = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_alpha" }, project: { id: alpha.id, kind: "standard", name: alpha.name } }),
    );
    expect(alphaCfg.tools.map((tool) => tool.name)).toContain("special_thread");

    // Project bot creates a Special thread on itself (botId defaults to its own bot)
    const created = JSON.parse(
      String(await call({ action: "create", name: "Reviewer", icon: "shield", instruction: "Message Reviewer before landing." })),
    ) as { threadId: string; special: { botId: string; name: string } };
    expect(created.special).toMatchObject({ botId: alphaBotId, name: "Reviewer" });
    expect(spawnMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: alpha.id }));

    // ...but not on another project's bot, by create, promote, or demote
    await expect(call({ action: "create", botId: betaBotId, name: "Critic", icon: "flame", instruction: "Challenge." })).rejects.toThrow(
      /only manage its own Special threads/,
    );
    await expect(call({ action: "set", threadId: "thr_beta", botId: betaBotId, name: "Lander", icon: "merge", instruction: "Land." })).rejects.toThrow(
      /only manage its own Special threads/,
    );
    await host.harness.behavior.callRpc("special_thread_set", {
      threadId: "thr_beta",
      botId: betaBotId,
      name: "Lander",
      icon: "merge",
      instruction: "Land.",
    });
    await expect(call({ action: "remove", threadId: "thr_beta" })).rejects.toThrow(/only manage its own Special threads/);

    // Name stays unique per bot (case-insensitive) and the 4000-character limit holds
    await expect(call({ action: "set", threadId: "thr_alpha_2", name: "reviewer", icon: "shield", instruction: "Dup." })).rejects.toThrow(
      /already exists/,
    );
    await expect(call({ action: "set", threadId: "thr_alpha_2", name: "Deployer", icon: "rocket", instruction: "x".repeat(4001) })).rejects.toThrow(
      /4000/,
    );

    // create never promotes: a threadId is rejected instead of silently spawning a new thread
    await expect(call({ action: "create", threadId: "thr_alpha_2", name: "Deployer", icon: "rocket", instruction: "Deploy." })).rejects.toThrow(
      /use action "set"/,
    );

    // set edits an existing Special thread, keeping omitted fields; an empty color clears the accent
    await call({ action: "set", threadId: created.threadId, color: "#22c55e" });
    const edited = JSON.parse(
      String(await call({ action: "set", threadId: created.threadId, instruction: "Message Reviewer with the diff.", color: "" })),
    ) as { name: string; icon: string; instruction: string; color?: string };
    expect(edited).toMatchObject({ name: "Reviewer", icon: "shield", instruction: "Message Reviewer with the diff." });
    expect(edited.color).toBeUndefined();

    // Coordinator manages any project bot's Special threads, but must name the bot and it must be a project bot
    const chief = (await host.harness.behavior.callRpc("bot_create_unaffiliated", {
      name: "Chief",
      role: "Coordinator",
      avatar: { color: "#6d5efc", shape: "blob", expression: "curious", motion: "calm" },
    })) as BotRecordDto;
    const chiefThread = (await host.harness.behavior.callRpc("conversation_create", {
      kind: "unaffiliated",
      botId: chief.id,
      request: {
        projectId: "proj_personal",
        providerId: "pi",
        model: "test",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        executionInputSources: {},
        environment: { type: "host", hostId: "host_1", workspace: { type: "personal" } },
        input: [{ type: "text", text: "Coordinate Special threads", mentions: [] }],
      },
    })) as { threadId: string };
    const asChief = { threadId: chiefThread.threadId, projectId: "proj_personal" };
    await expect(call({ action: "create", name: "Critic", icon: "flame", instruction: "Challenge." }, asChief)).rejects.toThrow(/botId is required/);
    await expect(call({ action: "create", botId: chief.id, name: "Critic", icon: "flame", instruction: "Challenge." }, asChief)).rejects.toThrow(
      /project-specific/,
    );
    const promoted = JSON.parse(
      String(await call({ action: "set", threadId: "thr_alpha_2", name: "Deployer", icon: "rocket", instruction: "Deploy." }, asChief)),
    ) as { botId: string; name: string };
    expect(promoted).toMatchObject({ botId: alphaBotId, name: "Deployer" });
    expect(JSON.parse(String(await call({ action: "remove", threadId: "thr_beta" }, asChief)))).toEqual({ threadId: "thr_beta", removed: true });

    const state = (await host.harness.behavior.callRpc("sidebar_state", null)) as { specialThreads: Array<{ threadId: string }> };
    expect(state.specialThreads.map((s) => s.threadId).sort()).toEqual([created.threadId, "thr_alpha_2"].sort());
  });

  it("ignores malformed specialThreads and threadOrder entries in .state.json", async () => {
    const { rootDir, host } = await setup();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(rootDir, ".state.json"),
      JSON.stringify({
        threadOrder: { bot_ok: ["thr_1", 123, ""], bot_bad: "not-an-array" },
        specialThreads: {
          thr_bad: { threadId: "thr_bad", name: 42, icon: "invalid" },
          thr_mismatch: {
            threadId: "thr_other",
            botId: "bot_1",
            name: "Lander",
            icon: "merge",
            instruction: "hi",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      "utf8",
    );
    const state = (await host.harness.behavior.callRpc("sidebar_state", null)) as {
      threadOrder: Array<{ botId: string; threadIds: string[] }>;
      specialThreads: unknown[];
    };
    expect(state.specialThreads).toEqual([]);
    expect(state.threadOrder).toEqual([{ botId: "bot_ok", threadIds: ["thr_1"] }]);
  });

  it("creates Special threads directly on project bots; cross-project delivery needs the exact thread ID", async () => {
    const { alpha, beta, threads, host, sendMock } = await setup();
    const alphaBotId = `projbot_${projectBotHash("/work/alpha")}`;
    threads.set("thr_alpha_worker", makeThreadResponse({ id: "thr_alpha_worker", projectId: alpha.id }));
    threads.set("thr_beta_worker", makeThreadResponse({ id: "thr_beta_worker", projectId: beta.id }));

    // Create Special thread directly from project bot
    const created = (await host.harness.behavior.callRpc("special_thread_create", {
      botId: alphaBotId,
      name: "Design Reviewer",
      icon: "sparkles",
      color: "#ec4899",
      instruction: "Share UI screenshots with Design Reviewer before shipping.",
      rolePrompt: "Critique UI hierarchy, contrast, and spacing.",
    })) as { threadId: string; special: { name: string; botId: string } };
    expect(created.special.name).toBe("Design Reviewer");
    expect(created.special.botId).toBe(alphaBotId);

    // Rejects creating Special thread on an unaffiliated bot
    const chief = (await host.harness.behavior.callRpc("bot_create_unaffiliated", {
      name: "Chief",
      role: "Coordinator",
      avatar: { color: "#6d5efc", shape: "blob", expression: "curious", motion: "calm" },
    })) as BotRecordDto;
    await expect(
      host.harness.behavior.callRpc("special_thread_create", {
        botId: chief.id,
        name: "Critic",
        icon: "flame",
        instruction: "Challenge assumptions",
      }),
    ).rejects.toThrow(/project-specific/);

    // Cross-project message by Special thread name is rejected
    const crossByName = await host.harness.behavior.callAgentTool(
      "message",
      { to: "Design Reviewer", text: "Review beta UI" },
      { threadId: "thr_beta_worker", projectId: beta.id },
    );
    expect(JSON.stringify(crossByName)).toContain("another project");
    expect(sendMock).not.toHaveBeenCalled();

    // Cross-project message by exact threadId is delivered: the sender named the thread explicitly
    const crossById = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "message",
          { to: created.threadId, text: "Review beta UI" },
          { threadId: "thr_beta_worker", projectId: beta.id },
        ),
      ),
    ) as { delivered: boolean; threadId: string };
    expect(crossById).toEqual({ to: created.threadId, threadId: created.threadId, delivered: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    sendMock.mockClear();

    // Same-project message by threadId succeeds
    const sameProject = JSON.parse(
      String(
        await host.harness.behavior.callAgentTool(
          "message",
          { to: created.threadId, text: "Review alpha UI" },
          { threadId: "thr_alpha_worker", projectId: alpha.id },
        ),
      ),
    ) as { delivered: boolean; threadId: string };
    expect(sameProject.delivered).toBe(true);
    expect(sameProject.threadId).toBe(created.threadId);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
