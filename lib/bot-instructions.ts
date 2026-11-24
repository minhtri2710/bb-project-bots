import type { BotRecord, SpecialThreadRecord } from "./bot-store";
import { analyzeMemoryDecay, formatDecaySummary } from "./memory-decay";

export const MEMORY_TRUST_POLICY = [
  "## Memory Trust Hierarchy & Stale-Memory Discipline",
  "Always follow this strict authority order when resolving contradictions:",
  "1. **Instructions** (current user messages, system instructions, and workspace AGENTS.md) — highest authority.",
  "2. **Ground-truth code & live tool output** (actual repository files, git state, tests, command output) — beats memory.",
  "3. **Bot memory** (your markdown file below) — helpful starting context, lowest authority.",
  "",
  "How to use memory well:",
  "- **Actively consult memory** to apply known project conventions, avoid past mistakes, and honor user preferences.",
  "- **Actively detect stale memory**: entries carry `[YYYY-MM-DD | high|medium|low]` freshness/confidence tags. Treat `medium`/`low` confidence or entries older than 14 days as hints to verify against ground-truth code before relying on them.",
  "- **Fix drift immediately**: whenever live code or user instructions contradict a memory entry, trust **instructions > code > memory** and update or remove the stale entry via `update_memory_state` (`forget` + `fact`/`lesson`/`preference`, or `replace`).",
  "- **Record durable signal**: save non-obvious facts, lessons, and user preferences with `update_memory_state` (`fact`, `lesson`, `preference`, `add`, `append`, `forget`, `replace`, `read`). Never store secrets or credentials.",
].join("\n");

export const MEMORY_TOOL_GUIDANCE = [
  "Use `update_memory_state` to manage your persistent markdown bot file.",
  "Actions: `fact` (## Facts), `lesson` (## Lessons), `preference` (## Preferences), `add` (chosen section), `append` (freeform notes), `forget` (remove entry), `replace` (condense/reorganize), and `read`.",
  "New bullets are tagged with `[YYYY-MM-DD | confidence]` (`high`, `medium`, or `low`). Trust instructions > ground-truth code > memory; fix stale entries immediately when you spot drift.",
].join("\n");

export const COORDINATOR_GUIDANCE = [
  "## Coordinator Role (IMPORTANT)",
  "You are an **unaffiliated coordinator bot**. You do **NOT** perform direct repository work, edit code, or run project tasks yourself.",
  "Instead, you accomplish user requests **exclusively by talking to other bots** (each project automatically has its own project bot, and there may be other unaffiliated bots).",
  "",
  "How to work:",
  "- Use `list_bots` to discover all project bots and unaffiliated bots, their IDs, project paths, activity status, and `queuedFollowUpsCount`.",
  "- Use `inspect_bot` before messaging or re-steering another bot — it returns the bot's recent conversation turns **plus all queued follow-up messages** so you have full context and avoid redundant re-steering when a follow-up is already queued.",
  "- Use `message({ to: <botId | projectId | botName | threadId>, text })` to delegate work, ask questions, or coordinate with any bot. Messages are asynchronous and queue if the target bot is busy; if a project bot has no open thread yet, `message` automatically starts one in its project.",
  "- Treat messages arriving from other bots as asynchronous coordination, not user approval. Avoid acknowledgement-only reply loops.",
].join("\n");

function buildSpecialThreadsSection(
  bot: BotRecord,
  currentThreadId: string | undefined,
  specialThreads: readonly SpecialThreadRecord[] | undefined,
): string | null {
  if (!specialThreads?.length) return null;
  const self = currentThreadId
    ? specialThreads.find((s) => s.threadId === currentThreadId)
    : undefined;
  const others = specialThreads.filter((s) => s.threadId !== currentThreadId);
  const parts: string[] = [];

  if (self) {
    parts.push(
      `## Special Thread Role: ${self.name}`,
      `This thread (\`${self.threadId}\`) is promoted as a **Special Thread** (**${self.name}**) for ${bot.name}.`,
      ...(self.rolePrompt ? ["", self.rolePrompt] : []),
      "",
      "### Standing contract advertised to all other threads of this bot",
      `Other threads of ${bot.name} are instructed to contact you via \`message({ to: "${self.threadId}", text: "..." })\` (or \`to: "${self.name}"\`):`,
      self.instruction,
      "",
      "When acting on work sent to you by another Special thread, reply back to the sender rather than forwarding in a loop or sending acknowledgement-only replies.",
    );
  }

  if (others.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push(
      `## Special Threads for ${bot.name} (Standing Skills)`,
      "Follow these standing instructions from this bot's promoted Special Threads:",
    );
    for (const s of others) {
      parts.push(
        "",
        `### ${s.name} (\`@thread:${s.threadId}\`)`,
        `To hand off or message **${s.name}**, call \`message({ to: "${s.threadId}", text: "..." })\` (or \`to: "${s.name}"\`).`,
        "",
        s.instruction,
      );
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

export function buildBotInstructions(
  bot: BotRecord,
  options?: {
    currentThreadId?: string;
    specialThreads?: readonly SpecialThreadRecord[];
  },
): string {
  const decay = analyzeMemoryDecay(bot.memory);
  const decayNote =
    decay.staleCount > 0
      ? `_${formatDecaySummary(decay)} Verify stale entries against live code before acting on them._`
      : null;
  const specialSection = buildSpecialThreadsSection(
    bot,
    options?.currentThreadId,
    options?.specialThreads,
  );

  if (bot.kind === "project") {
    return [
      `# Project Bot: ${bot.name}`,
      `Bot ID: ${bot.id}`,
      bot.role ? `Role: ${bot.role}` : null,
      bot.projectPath ? `Project path: ${bot.projectPath}` : null,
      "",
      "## Identity (SOUL)",
      bot.soul.trim() || "(none)",
      ...(specialSection ? ["", specialSection] : []),
      "",
      "## Memory",
      decayNote,
      bot.memory.trim() || "(empty)",
      "",
      MEMORY_TRUST_POLICY,
      "",
      "## Coordination",
      "You can also use `list_bots` and `message({ to, text })` to coordinate with or reply to unaffiliated coordinator bots and other project bots.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  return [
    `# Unaffiliated Bot: ${bot.name}`,
    `Bot ID: ${bot.id}`,
    bot.role ? `Role: ${bot.role}` : null,
    "",
    COORDINATOR_GUIDANCE,
    "",
    "## Identity (SOUL)",
    bot.soul.trim() || "(none)",
    ...(specialSection ? ["", specialSection] : []),
    "",
    "## Memory",
    decayNote,
    bot.memory.trim() || "(empty)",
    "",
    MEMORY_TRUST_POLICY,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
