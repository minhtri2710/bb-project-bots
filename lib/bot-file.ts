import { createHash } from "node:crypto";
import {
  AVATAR_COLORS,
  AVATAR_EXPRESSION_IDS,
  AVATAR_MOTION_IDS,
  AVATAR_SHAPE_IDS,
  type BotAvatar,
} from "./appearance";
import { ensureMemoryTag, stripMemoryTag, type MemoryConfidence } from "./memory-decay";

export type BotKind = "project" | "unaffiliated";

export type BotFrontmatter = {
  id: string;
  kind: BotKind;
  name: string;
  role: string;
  color: string;
  shape: BotAvatar["shape"];
  expression: BotAvatar["expression"];
  motion: BotAvatar["motion"];
  soul: string;
  projectId?: string;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
};

export type ParsedBotFile = {
  frontmatter: Partial<BotFrontmatter>;
  body: string;
};

export const MEMORY_MAX_CHARS = 12000;

export const DEFAULT_MEMORY_TEMPLATE = [
  "## Facts",
  "",
  "## Lessons",
  "",
  "## Preferences",
  "",
].join("\n");

export function projectBotHash(projectPath: string): string {
  return createHash("sha256").update(projectPath, "utf8").digest("hex").slice(0, 6);
}

export function projectBotIdForPath(projectPath: string): string {
  return `projbot_${projectBotHash(projectPath)}`;
}

/**
 * Deterministic chromatic avatar derived from a project path or seed so every
 * project gets a stable, distinct generated bot before its file is even created.
 */
export function deterministicAvatar(seed: string): BotAvatar {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const color = AVATAR_COLORS[digest[0]! % AVATAR_COLORS.length]!;
  const shape = AVATAR_SHAPE_IDS[digest[1]! % AVATAR_SHAPE_IDS.length]!;
  // Prefer friendly default expressions for generated bots
  const friendlyExpressions: BotAvatar["expression"][] = [
    "curious", "happy", "focused", "neutral", "proud", "excited", "surprised",
  ];
  const expression = friendlyExpressions[digest[2]! % friendlyExpressions.length]!;
  const motion = AVATAR_MOTION_IDS[digest[3]! % 2]!; // calm or playful
  return { color, shape, expression, motion };
}

export function defaultProjectSoul(projectName: string): string {
  return `You are the dedicated project bot for ${projectName}. Help with development, debugging, architecture, and maintenance of this codebase. Keep important facts, lessons, and preferences updated using update_memory_state.`;
}

export function defaultUnaffiliatedSoul(name: string, role: string): string {
  const roleClause = role ? ` (${role})` : "";
  return `You are ${name}${roleClause}, an unaffiliated coordinator bot. You do not perform direct repository or coding work yourself — you receive requests and coordinate with project bots and other bots to get them done.`;
}

function formatYamlScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (
    value === "" ||
    /[\n\r\t:#"'[\]{},&*?|>!%@`\\]/.test(value) ||
    /^\s|\s$/.test(value) ||
    /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(value)
  ) {
    return JSON.stringify(value);
  }
  return value;
}

function parseYamlScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num)) return num;
  }
  return trimmed;
}

export function parseBotMarkdown(raw: string): ParsedBotFile {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized.trim() ? `${normalized.trim()}\n` : "" };
  }
  const endIndex = normalized.indexOf("\n---\n", 4);
  const altEnd = endIndex === -1 && normalized.endsWith("\n---") ? normalized.length - 4 : endIndex;
  if (altEnd === -1) {
    return { frontmatter: {}, body: normalized.trim() ? `${normalized.trim()}\n` : "" };
  }
  const fmBlock = normalized.slice(4, altEnd);
  const bodyRaw = normalized.slice(altEnd + 5).replace(/^\n+/, "");
  const frontmatter: Record<string, unknown> = {};
  for (const line of fmBlock.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    frontmatter[key!] = parseYamlScalar(value!);
  }
  return {
    frontmatter: frontmatter as Partial<BotFrontmatter>,
    body: bodyRaw,
  };
}

export function serializeBotMarkdown(fm: BotFrontmatter, body: string): string {
  const lines: string[] = ["---"];
  const entries: Array<[string, string | number | undefined]> = [
    ["id", fm.id],
    ["kind", fm.kind],
    ["projectId", fm.projectId],
    ["projectPath", fm.projectPath],
    ["name", fm.name],
    ["role", fm.role],
    ["color", fm.color],
    ["shape", fm.shape],
    ["expression", fm.expression],
    ["motion", fm.motion],
    ["soul", fm.soul],
    ["createdAt", fm.createdAt],
    ["updatedAt", fm.updatedAt],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) continue;
    lines.push(`${key}: ${formatYamlScalar(value)}`);
  }
  lines.push("---", "");
  const cleanBody = body.replace(/\r\n/g, "\n").trim();
  if (cleanBody) {
    lines.push(cleanBody, "");
  }
  return lines.join("\n");
}

export function isValidShape(value: unknown): value is BotAvatar["shape"] {
  return typeof value === "string" && (AVATAR_SHAPE_IDS as readonly string[]).includes(value);
}

export function isValidExpression(value: unknown): value is BotAvatar["expression"] {
  return typeof value === "string" && (AVATAR_EXPRESSION_IDS as readonly string[]).includes(value);
}

export function isValidMotion(value: unknown): value is BotAvatar["motion"] {
  return typeof value === "string" && (AVATAR_MOTION_IDS as readonly string[]).includes(value);
}

export function isValidColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export type MemorySection = "facts" | "lessons" | "preferences" | "notes";
export type MemoryAction = "read" | "add" | "append" | "fact" | "lesson" | "preference" | "forget" | "replace";

export type MemoryOperation = {
  action: MemoryAction;
  text?: string;
  section?: MemorySection;
  confidence?: MemoryConfidence;
};

const SECTION_HEADINGS: Record<MemorySection, string> = {
  facts: "## Facts",
  lessons: "## Lessons",
  preferences: "## Preferences",
  notes: "## Notes",
};

function sanitizeSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().replace(/^[-*]\s+/, "");
}

function insertBulletUnderSection(
  body: string,
  section: MemorySection,
  rawText: string,
  confidence: MemoryConfidence = "high",
): { body: string; changed: boolean } {
  const item = sanitizeSingleLine(rawText);
  if (!item) throw new Error("Memory text must not be empty.");
  const taggedItem = ensureMemoryTag(item, confidence);
  const baseText = stripMemoryTag(item);
  const bullet = `- ${taggedItem}`;
  const heading = SECTION_HEADINGS[section];
  const lines = (body.trim() ? body.replace(/\r\n/g, "\n") : DEFAULT_MEMORY_TEMPLATE).trimEnd().split("\n");

  const headingIdx = lines.findIndex((line) => line.trim().toLowerCase() === heading.toLowerCase());
  if (headingIdx === -1) {
    // Append new section at end
    if (lines.length && lines[lines.length - 1]!.trim() !== "") lines.push("");
    lines.push(heading, bullet);
    return { body: `${lines.join("\n")}\n`, changed: true };
  }

  // Find end of this section (next ## heading or EOF)
  let nextHeadingIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      nextHeadingIdx = i;
      break;
    }
  }

  // Deduplicate or refresh date/confidence if same fact already exists
  for (let i = headingIdx + 1; i < nextHeadingIdx; i++) {
    const existingLine = lines[i]!.trim();
    const existingBase = stripMemoryTag(existingLine.replace(/^[-*]\s+/, ""));
    if (existingBase === baseText) {
      if (existingLine === bullet) {
        return { body: `${lines.join("\n")}\n`, changed: false };
      }
      lines[i] = bullet;
      return { body: `${lines.join("\n")}\n`, changed: true };
    }
  }

  // Find last non-empty line before nextHeadingIdx
  let insertAt = nextHeadingIdx;
  while (insertAt > headingIdx + 1 && lines[insertAt - 1]!.trim() === "") {
    insertAt--;
  }
  lines.splice(insertAt, 0, bullet);
  return { body: `${lines.join("\n")}\n`, changed: true };
}

export function applyMemoryOperation(currentBody: string, op: MemoryOperation): { body: string; changed: boolean; summary: string } {
  if (op.action === "read") {
    return { body: currentBody, changed: false, summary: "Read current memory." };
  }

  let result: { body: string; changed: boolean };
  let summary = "";

  if (op.action === "fact" || op.action === "lesson" || op.action === "preference") {
    const section: MemorySection = op.action === "fact" ? "facts" : op.action === "lesson" ? "lessons" : "preferences";
    if (!op.text?.trim()) throw new Error(`Provide text for ${op.action}.`);
    result = insertBulletUnderSection(currentBody, section, op.text, op.confidence ?? "high");
    summary = result.changed ? `Added ${op.action} to ${SECTION_HEADINGS[section]}.` : `Already recorded in ${SECTION_HEADINGS[section]}.`;
  } else if (op.action === "add") {
    if (!op.text?.trim()) throw new Error("Provide text for add.");
    const section = op.section ?? "notes";
    result = insertBulletUnderSection(currentBody, section, op.text, op.confidence ?? "high");
    summary = result.changed ? `Added entry to ${SECTION_HEADINGS[section]}.` : `Already recorded in ${SECTION_HEADINGS[section]}.`;
  } else if (op.action === "append") {
    const text = op.text?.replace(/\r\n/g, "\n").trim();
    if (!text) throw new Error("Provide text for append.");
    const base = currentBody.replace(/\r\n/g, "\n").trimEnd();
    const next = base ? `${base}\n\n${text}\n` : `${text}\n`;
    result = { body: next, changed: true };
    summary = "Appended text to memory.";
  } else if (op.action === "forget") {
    const needle = stripMemoryTag(sanitizeSingleLine(op.text ?? ""));
    if (!needle) throw new Error("Provide text to forget.");
    const lines = currentBody.replace(/\r\n/g, "\n").split("\n");
    const kept = lines.filter((line) => {
      const stripped = line.trim().replace(/^[-*]\s+/, "");
      const strippedBase = stripMemoryTag(stripped);
      return stripped !== needle && strippedBase !== needle && line.trim() !== needle;
    });
    const changed = kept.length !== lines.length;
    const next = changed ? `${kept.join("\n").trimEnd()}\n` : currentBody;
    result = { body: next, changed };
    summary = changed ? "Removed matching memory entry." : "No matching memory entry found.";
  } else if (op.action === "replace") {
    if (op.text === undefined) throw new Error("Provide text for replace.");
    const next = op.text.replace(/\r\n/g, "\n").trimEnd();
    const formatted = next ? `${next}\n` : "";
    result = { body: formatted, changed: formatted !== currentBody };
    summary = result.changed ? "Replaced memory body." : "Memory unchanged.";
  } else {
    throw new Error(`Unsupported memory action: ${String(op.action)}`);
  }

  if (result.body.length > MEMORY_MAX_CHARS) {
    throw new Error(
      `Memory exceeds the ${MEMORY_MAX_CHARS}-character limit (${result.body.length} chars). Read memory, condense it, and use action "replace".`,
    );
  }

  return { ...result, summary };
}
