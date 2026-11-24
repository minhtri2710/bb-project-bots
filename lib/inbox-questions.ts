import type { AnswerItem, InboxMessage, Question, ReplyInput } from "../contract";

export type Choice = {
  label: string;
  key?: string;
  detail?: string;
  recommended?: boolean;
  preview?: string;
  custom?: true;
};

export type Draft = {
  chosen: number[];
  text?: string;
  other?: boolean;
};

export type CardState = {
  drafts: Record<number, Draft>;
  note: string;
  current: number;
  text: string;
};

export const EMPTY_CARD: CardState = {
  drafts: {},
  note: "",
  current: 0,
  text: "",
};

export const WAIT_WARNING_AFTER_MS = 60 * 60_000;

export const cardKey = (messageId: number) => `message:${messageId}`;

export function checkQuestions(query: Question[]): Question[] {
  if (!query.length) {
    throw new Error("query must name at least one question");
  }
  const refs = new Set<string>();
  const texts = new Set<string>();
  return query.map((question, index) => {
    const where = `question ${question.ref ?? index + 1}`;
    const text = question.text.trim();
    if (!text) throw new Error(`${where} has no text`);
    if (texts.has(text)) {
      throw new Error(`${where} repeats another question's text`);
    }
    texts.add(text);
    if (question.ref !== undefined) {
      if (refs.has(question.ref)) {
        throw new Error(`${where} repeats another question's ref`);
      }
      refs.add(question.ref);
    }
    const kept: Question = {
      text,
      kind: question.kind,
      ...(question.ref ? { ref: question.ref } : {}),
    };
    if (question.kind === "choice" || question.kind === "multi") {
      const options = (question.options ?? []).map(
        ({ label, key, detail, recommended, preview }) => ({
          label: label.trim(),
          ...(key ? { key } : {}),
          ...(detail?.trim() ? { detail: detail.trim() } : {}),
          ...(recommended ? { recommended: true } : {}),
          ...(preview?.trim() ? { preview } : {}),
        }),
      );
      if (options.length < 2) {
        throw new Error(`${where} needs at least two options`);
      }
      if (options.some((o) => !o.label)) {
        throw new Error(`${where} has an option without a label`);
      }
      if (new Set(options.map((o) => o.label)).size !== options.length) {
        throw new Error(`${where} repeats an option label`);
      }
      const keys = options.flatMap((o) => (o.key ? [o.key] : []));
      if (new Set(keys).size !== keys.length) {
        throw new Error(`${where} repeats an option key`);
      }
      if (options.some((o) => /^(something else|other)[.…]*$/i.test(o.label))) {
        throw new Error(
          `${where}: the card offers "Something else…" itself; leave that option out`,
        );
      }
      kept.options = options;
    } else if (question.kind === "scale") {
      const scale = question.scale;
      if (!scale) throw new Error(`${where} needs scale { min, max }`);
      if (scale.max <= scale.min || scale.max - scale.min > 9) {
        throw new Error(`${where}: a scale runs upward over at most 10 steps`);
      }
      kept.scale = {
        min: scale.min,
        max: scale.max,
        ...(scale.low?.trim() ? { low: scale.low.trim() } : {}),
        ...(scale.high?.trim() ? { high: scale.high.trim() } : {}),
      };
    } else if (question.kind === "text" && question.placeholder?.trim()) {
      kept.placeholder = question.placeholder.trim();
    }
    return kept;
  });
}

const steps = (question: Question): Choice[] => {
  const { min = 1, max = 5 } = question.scale ?? {};
  return Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => ({
    label: String(min + i),
  }));
};

export function choices(question: Question): Choice[] {
  if (question.kind === "text") return [];
  if (question.kind === "scale") return steps(question);
  return [
    ...(question.kind === "confirm"
      ? [
          { label: "Yes", key: "y" },
          { label: "No", key: "n" },
        ]
      : (question.options ?? [])),
    { label: "Something else…", custom: true },
  ];
}

export const position = (question: Question, index: number) =>
  question.ref ?? String(index + 1);

export function keyOf(question: Question, index: number): string | undefined {
  const list = choices(question);
  const choice = list[index];
  if (!choice) return undefined;
  if (choice.key) return choice.key;
  if (choice.custom && !list.some((c) => c.key === "o")) return "o";
  return index < 9 ? String(index + 1) : undefined;
}

export function choiceForKey(question: Question, key: string): number | undefined {
  const list = choices(question);
  if (/^[1-9]$/.test(key)) {
    return Number(key) - 1 < list.length ? Number(key) - 1 : undefined;
  }
  const index = list.findIndex((choice) => choice.key === key);
  if (index >= 0) return index;
  return key === "o" ? list.findIndex((choice) => choice.custom) : undefined;
}

function pickDraft(question: Question): Draft | undefined {
  const chosen = choices(question).flatMap((choice, index) =>
    choice.recommended ? [index] : [],
  );
  if (!chosen.length) return undefined;
  return { chosen: question.kind === "multi" ? chosen : chosen.slice(0, 1) };
}

export function cardOf(
  stored: CardState | undefined,
  questions: readonly Question[],
): CardState {
  const drafts: Record<number, Draft> = {};
  for (const [index, question] of questions.entries()) {
    const draft = stored?.drafts[index] ?? pickDraft(question);
    if (draft) drafts[index] = draft;
  }
  const firstWithoutPick = Math.max(
    0,
    questions.findIndex((_, index) => !drafts[index]),
  );
  return { ...EMPTY_CARD, current: firstWithoutPick, ...stored, drafts };
}

function labelsIncludingTypedMultiAnswer(question: Question, draft: Draft): string[] {
  const list = choices(question);
  const typed = draft.text?.trim() ?? "";
  const labels = draft.chosen.flatMap((i) =>
    list[i] && !list[i].custom ? [list[i].label] : [],
  );
  return question.kind === "multi" && draft.other && typed
    ? [...labels, typed]
    : labels;
}

export function answerOf(question: Question, draft: Draft | undefined): string {
  if (!draft) return "";
  if (question.kind === "text" || (question.kind !== "multi" && draft.other)) {
    return draft.text?.trim() ?? "";
  }
  const labels = labelsIncludingTypedMultiAnswer(question, draft);
  return question.kind === "multi" ? labels.join(", ") : (labels[0] ?? "");
}

export function answered(
  questions: readonly Question[],
  drafts: Record<number, Draft | undefined>,
): AnswerItem[] {
  return questions.flatMap((question, index) => {
    const draft = drafts[index];
    const answer =
      question.kind === "multi" && draft
        ? labelsIncludingTypedMultiAnswer(question, draft)
        : answerOf(question, draft);
    return answer.length ? [{ question: question.text, answer }] : [];
  });
}

const filled = (text: unknown): text is string =>
  typeof text === "string" && !!text.trim();

export function validAnswers(value: unknown): value is AnswerItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (a: { question?: unknown; answer?: unknown } | null) =>
        Boolean(a) &&
        typeof a?.question === "string" &&
        (Array.isArray(a.answer)
          ? a.answer.length > 0 && a.answer.every(filled)
          : filled(a.answer)),
    )
  );
}

export function checkAnswers(
  answers: readonly { question: string }[],
  questions: readonly Question[],
) {
  if (
    new Set(answers.map((a) => a.question)).size !== answers.length ||
    answers.some((a) => !questions.some((q) => q.text === a.question))
  ) {
    throw new Error("Unknown question");
  }
}

function keysOf(question: Question, labels: string[]) {
  const keys = (question.options ?? []).flatMap((o) =>
    o.key && labels.includes(o.label) ? [o.key] : [],
  );
  return keys.length === labels.length ? keys.join(",") : "";
}

export function answerText(
  answers: readonly AnswerItem[],
  questions: readonly Question[],
  note?: string,
) {
  const lines = answers.map(({ question, answer: given }) => {
    const q = questions.find((candidate) => candidate.text === question)!;
    const labels = Array.isArray(given) ? given : [given];
    const keys = keysOf(q, labels);
    const answer = labels.join(", ");
    if (!q.ref) return `${q.text}: ${answer}`;
    return keys ? `${q.ref}${keys}. ${q.text}: ${answer}` : `${q.ref}: ${answer}`;
  });
  if (note?.trim()) {
    lines.push(answers.length ? `Note: ${note.trim()}` : note.trim());
  }
  return lines.join("\n\n");
}

export function checkReply(input: {
  answers?: unknown;
  note?: unknown;
  text?: unknown;
}) {
  const optionalString = (value: unknown) => {
    if (value !== undefined && typeof value !== "string") {
      throw new Error("Invalid answers");
    }
    return value?.trim();
  };
  const text = optionalString(input.text);
  const note = optionalString(input.note);
  const answers = input.answers ?? [];
  const invalid =
    text === undefined
      ? !validAnswers(answers) || (!answers.length && !note)
      : !text || input.answers !== undefined || !!note;
  if (invalid) throw new Error("Invalid answers");
}

export function replyText(input: ReplyInput, questions: readonly Question[]) {
  const text = input.text?.trim();
  const note = input.note?.trim();
  const answers = input.answers ?? [];
  if (text !== undefined) return text;
  checkAnswers(answers, questions);
  return answerText(answers, questions, note);
}

export function gist(message: Pick<InboxMessage, "text" | "query">): string {
  const lines = message.query?.length
    ? [
        `query ${message.query
          .map((q, i) => `${q.ref ?? i + 1}. ${q.text}`)
          .join("; ")}`,
      ]
    : message.text
        .split("\n")
        .map((line) => line.replace(/\*\*/g, "").trim())
        .filter(Boolean);
  const line = lines.find((candidate) => candidate.includes("?")) ?? lines[0] ?? "";
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

export function lead(text: string): { title: string; body: string } {
  const trimmed = text.trimStart();
  const bold = /^\*\*(.+?)\*\*[:.]?\s*/.exec(trimmed);
  if (bold) {
    return { title: bold[1].trim(), body: trimmed.slice(bold[0].length) };
  }
  const [first = "", ...rest] = trimmed.split("\n");
  return {
    title: first
      .replace(/^[#>\-*\s]+/, "")
      .replace(/[*_`]/g, "")
      .trim(),
    body: rest.join("\n").trim(),
  };
}

export function previewUrl(text: string): string | undefined {
  return /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s)<>\]`*]*)?/.exec(
    text,
  )?.[0];
}

export function tagOf(message: Pick<InboxMessage, "text">): "preview" | "question" {
  return previewUrl(message.text) ? "preview" : "question";
}

export function formatAgo(
  at: number,
  now: number,
  options?: { ago?: boolean },
): string {
  const diff = Math.max(0, now - at);
  const mins = Math.floor(diff / 60_000);
  const suffix = options?.ago ? " ago" : "";
  if (mins < 1) return options?.ago ? "just now" : "now";
  if (mins < 60) return `${mins}m${suffix}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  const days = Math.floor(hours / 24);
  return `${days}d${suffix}`;
}
