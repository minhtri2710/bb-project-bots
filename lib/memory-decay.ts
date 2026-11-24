export type MemoryConfidence = "high" | "medium" | "low";
export type DecayBucket = "fresh" | "soft-stale" | "hard-stale" | "prune-candidate" | "untagged";

export type AnalyzedMemoryEntry = {
  section: string;
  text: string;
  date: string | null;
  confidence: MemoryConfidence | null;
  ageDays: number | null;
  bucket: DecayBucket;
};

export type MemoryDecayReport = {
  entries: AnalyzedMemoryEntry[];
  counts: Record<DecayBucket, number>;
  staleCount: number;
};

const TAG_REGEX = /\s*\[(\d{4}-\d{2}-\d{2})(?:\s*\|\s*(high|medium|low))?\]\s*$/i;

export function todayIsoDate(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function stripMemoryTag(line: string): string {
  return line.replace(TAG_REGEX, "").trim();
}

export function formatMemoryTag(confidence: MemoryConfidence = "high", now: number = Date.now()): string {
  return `[${todayIsoDate(now)} | ${confidence}]`;
}

export function ensureMemoryTag(text: string, confidence: MemoryConfidence = "high", now: number = Date.now()): string {
  const trimmed = text.trim();
  if (TAG_REGEX.test(trimmed)) return trimmed;
  return `${trimmed} ${formatMemoryTag(confidence, now)}`;
}

function classifyAge(days: number): DecayBucket {
  if (days <= 14) return "fresh";
  if (days <= 45) return "soft-stale";
  if (days <= 90) return "hard-stale";
  return "prune-candidate";
}

export function analyzeMemoryDecay(memory: string, now: number = Date.now()): MemoryDecayReport {
  const entries: AnalyzedMemoryEntry[] = [];
  const counts: Record<DecayBucket, number> = {
    fresh: 0,
    "soft-stale": 0,
    "hard-stale": 0,
    "prune-candidate": 0,
    untagged: 0,
  };

  let currentSection = "General";
  for (const rawLine of memory.replace(/\r\n/g, "\n").split("\n")) {
    const heading = rawLine.match(/^##\s+(.+)$/);
    if (heading) {
      currentSection = heading[1]!.trim();
      continue;
    }
    const bullet = rawLine.match(/^\s*[-*]\s+(.+)$/);
    if (!bullet) continue;
    const content = bullet[1]!.trim();
    const tagMatch = content.match(TAG_REGEX);
    if (!tagMatch) {
      counts.untagged++;
      entries.push({
        section: currentSection,
        text: content,
        date: null,
        confidence: null,
        ageDays: null,
        bucket: "untagged",
      });
      continue;
    }
    const dateStr = tagMatch[1]!;
    const conf = (tagMatch[2]?.toLowerCase() as MemoryConfidence | undefined) ?? "medium";
    const parsed = Date.parse(`${dateStr}T00:00:00Z`);
    const ageDays = Number.isFinite(parsed) ? Math.max(0, Math.floor((now - parsed) / 86_400_000)) : null;
    const bucket: DecayBucket = ageDays === null ? "untagged" : classifyAge(ageDays);
    counts[bucket]++;
    entries.push({
      section: currentSection,
      text: stripMemoryTag(content),
      date: dateStr,
      confidence: conf,
      ageDays,
      bucket,
    });
  }

  const staleCount = counts["soft-stale"] + counts["hard-stale"] + counts["prune-candidate"];
  return { entries, counts, staleCount };
}

export function formatDecaySummary(report: MemoryDecayReport): string {
  if (report.entries.length === 0) return "Memory is currently empty.";
  const parts: string[] = [];
  if (report.counts.fresh) parts.push(`${report.counts.fresh} fresh`);
  if (report.counts["soft-stale"]) parts.push(`${report.counts["soft-stale"]} soft-stale (15–45d)`);
  if (report.counts["hard-stale"]) parts.push(`${report.counts["hard-stale"]} hard-stale (45–90d)`);
  if (report.counts["prune-candidate"]) parts.push(`${report.counts["prune-candidate"]} prune-candidate (>90d)`);
  if (report.counts.untagged) parts.push(`${report.counts.untagged} untagged`);
  return `Memory health: ${parts.join(", ")}.`;
}
