import { describe, expect, it } from "vitest";
import {
  applyMemoryOperation,
  DEFAULT_MEMORY_TEMPLATE,
  deterministicAvatar,
  parseBotMarkdown,
  projectBotHash,
  serializeBotMarkdown,
  type BotFrontmatter,
} from "../lib/bot-file";
import { analyzeMemoryDecay } from "../lib/memory-decay";

describe("bot-file frontmatter and memory operations", () => {
  it("hashes project paths to 6 hex chars deterministically", () => {
    const h1 = projectBotHash("/home/tobi/src/alpha");
    const h2 = projectBotHash("/home/tobi/src/alpha");
    const h3 = projectBotHash("/home/tobi/src/beta");
    expect(h1).toMatch(/^[0-9a-f]{6}$/);
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
    expect(deterministicAvatar("/home/tobi/src/alpha")).toEqual(deterministicAvatar("/home/tobi/src/alpha"));
  });

  it("round-trips frontmatter and markdown memory cleanly", () => {
    const fm: BotFrontmatter = {
      id: "projbot_a1b2c3",
      kind: "project",
      projectId: "proj_1",
      projectPath: "/home/tobi/src/alpha",
      name: "Alpha: Main",
      role: "Project Bot",
      color: "#6d5efc",
      shape: "blob",
      expression: "curious",
      motion: "calm",
      soul: "Line one\nLine two with: colons",
      createdAt: 1000,
      updatedAt: 2000,
    };
    const serialized = serializeBotMarkdown(fm, "## Facts\n- Uses Vitest\n");
    const parsed = parseBotMarkdown(serialized);
    expect(parsed.frontmatter).toEqual(fm);
    expect(parsed.body).toBe("## Facts\n- Uses Vitest\n");
  });

  it("supports fact, lesson, preference, add, append, forget, replace, read", () => {
    let body = DEFAULT_MEMORY_TEMPLATE;

    const r1 = applyMemoryOperation(body, { action: "fact", text: "Uses pnpm workspaces" });
    expect(r1.changed).toBe(true);
    expect(r1.body).toMatch(/## Facts\n- Uses pnpm workspaces \[\d{4}-\d{2}-\d{2} \| high\]/);
    body = r1.body;

    // Duplicate fact is idempotent
    const rDup = applyMemoryOperation(body, { action: "fact", text: "Uses pnpm workspaces" });
    expect(rDup.changed).toBe(false);

    const r2 = applyMemoryOperation(body, { action: "lesson", text: "Run typecheck before build", confidence: "medium" });
    expect(r2.body).toMatch(/## Lessons\n- Run typecheck before build \[\d{4}-\d{2}-\d{2} \| medium\]/);
    body = r2.body;

    const r3 = applyMemoryOperation(body, { action: "preference", text: "Keep PRs small" });
    expect(r3.body).toMatch(/## Preferences\n- Keep PRs small \[\d{4}-\d{2}-\d{2} \| high\]/);
    body = r3.body;

    const r4 = applyMemoryOperation(body, { action: "add", section: "notes", text: "Check CI logs" });
    expect(r4.body).toMatch(/## Notes\n- Check CI logs \[\d{4}-\d{2}-\d{2} \| high\]/);
    body = r4.body;

    const r5 = applyMemoryOperation(body, { action: "append", text: "Extra context paragraph." });
    expect(r5.body).toContain("Extra context paragraph.");
    body = r5.body;

    const r6 = applyMemoryOperation(body, { action: "forget", text: "Keep PRs small" });
    expect(r6.changed).toBe(true);
    expect(r6.body).not.toContain("Keep PRs small");
    body = r6.body;

    const rRead = applyMemoryOperation(body, { action: "read" });
    expect(rRead.changed).toBe(false);
    expect(rRead.body).toBe(body);

    const rReplace = applyMemoryOperation(body, { action: "replace", text: "## Facts\n- Compacted" });
    expect(rReplace.changed).toBe(true);
    expect(rReplace.body).toBe("## Facts\n- Compacted\n");
  });
});

describe("memory-decay", () => {
  it("classifies entries across Rune forgetting-curve buckets", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    const memory = [
      "## Facts",
      "- Fresh item [2026-11-20 | high]",
      "- Soft stale item [2026-10-25 | medium]",
      "- Hard stale item [2026-09-15 | low]",
      "- Prune candidate [2026-07-01 | low]",
      "- Untagged legacy note",
    ].join("\n");
    const report = analyzeMemoryDecay(memory, now);
    expect(report.counts.fresh).toBe(1);
    expect(report.counts["soft-stale"]).toBe(1);
    expect(report.counts["hard-stale"]).toBe(1);
    expect(report.counts["prune-candidate"]).toBe(1);
    expect(report.counts.untagged).toBe(1);
    expect(report.staleCount).toBe(3);
  });
});
