import { describe, expect, it } from "vitest";
import type { Question } from "../contract";
import {
  answerOf,
  answerText,
  answered,
  cardOf,
  checkQuestions,
  checkReply,
  choiceForKey,
  choices,
  gist,
  keyOf,
  lead,
  previewUrl,
  replyText,
  tagOf,
} from "../lib/inbox-questions";

describe("inbox checkQuestions", () => {
  it("normalizes valid questions and strips inapplicable fields", () => {
    const out = checkQuestions([
      {
        text: "  Which storage engine?  ",
        kind: "choice",
        ref: "1",
        options: [
          {
            label: "  SQLite ",
            key: "a",
            detail: " Single file ",
            recommended: true,
            preview: "```sql\nSELECT 1;\n```",
          },
          { label: "Postgres", key: "b" },
        ],
        placeholder: "ignored",
      },
      {
        text: "Confidence?",
        kind: "scale",
        ref: "2",
        scale: { min: 1, max: 5, low: " Low ", high: " High " },
      },
      {
        text: "Branch name?",
        kind: "text",
        placeholder: "  feat/inbox  ",
      },
    ]);

    expect(out[0]!.text).toBe("Which storage engine?");
    expect(out[0]!.placeholder).toBeUndefined();
    expect(out[0]!.options?.[0]!.label).toBe("SQLite");
    expect(out[0]!.options?.[0]!.detail).toBe("Single file");
    expect(out[0]!.options?.[0]!.recommended).toBe(true);
    expect(out[1]!.scale?.low).toBe("Low");
    expect(out[1]!.scale?.high).toBe("High");
    expect(out[2]!.placeholder).toBe("feat/inbox");
  });

  it("rejects empty questions, duplicate texts/refs, bad options, 'Other', and invalid scales", () => {
    expect(() => checkQuestions([])).toThrow(/at least one question/);
    expect(() =>
      checkQuestions([
        { text: "Q1", kind: "confirm" },
        { text: "Q1", kind: "confirm" },
      ]),
    ).toThrow(/repeats another question's text/);
    expect(() =>
      checkQuestions([
        { text: "Q1", kind: "confirm", ref: "1" },
        { text: "Q2", kind: "confirm", ref: "1" },
      ]),
    ).toThrow(/repeats another question's ref/);
    expect(() =>
      checkQuestions([
        {
          text: "Pick one",
          kind: "choice",
          options: [{ label: "Only one" }],
        },
      ]),
    ).toThrow(/at least two options/);
    expect(() =>
      checkQuestions([
        {
          text: "Pick one",
          kind: "choice",
          options: [{ label: "A" }, { label: "Other…" }],
        },
      ]),
    ).toThrow(/Something else/);
    expect(() =>
      checkQuestions([
        {
          text: "Rate",
          kind: "scale",
          scale: { min: 1, max: 12 },
        },
      ]),
    ).toThrow(/at most 10 steps/);
  });
});

describe("inbox card state and reply formatting", () => {
  const questions: Question[] = [
    {
      text: "Deployment target",
      kind: "choice",
      ref: "1",
      options: [
        { label: "Canary", key: "a", recommended: true },
        { label: "Full rollout", key: "b" },
      ],
    },
    {
      text: "Checks to run",
      kind: "multi",
      ref: "2",
      options: [
        { label: "Unit", key: "a" },
        { label: "E2E", key: "b" },
        { label: "Lint", key: "c" },
      ],
    },
    {
      text: "Proceed?",
      kind: "confirm",
    },
  ];

  it("pre-selects recommended picks and opens on first question without a pick", () => {
    const state = cardOf(undefined, questions);
    expect(state.drafts[0]).toEqual({ chosen: [0] });
    expect(state.drafts[1]).toBeUndefined();
    expect(state.current).toBe(1);
  });

  it("computes keys and choiceForKey including custom 'o'", () => {
    expect(keyOf(questions[0]!, 0)).toBe("a");
    expect(keyOf(questions[0]!, 2)).toBe("o");
    expect(choiceForKey(questions[0]!, "a")).toBe(0);
    expect(choiceForKey(questions[0]!, "o")).toBe(2);
    expect(choices(questions[2]!)[0]!.key).toBe("y");
    expect(choices(questions[2]!)[1]!.key).toBe("n");
  });

  it("formats answers matching ultimate's exact replyText format", () => {
    const drafts = {
      0: { chosen: [0] },
      1: { chosen: [0, 2] },
      2: { chosen: [0] },
    };
    const items = answered(questions, drafts);
    expect(answerOf(questions[1]!, drafts[1])).toBe("Unit, Lint");
    const formatted = answerText(items, questions, "Ship before 5pm");
    expect(formatted).toBe(
      [
        "1a. Deployment target: Canary",
        "2a,c. Checks to run: Unit, Lint",
        "Proceed?: Yes",
        "Note: Ship before 5pm",
      ].join("\n\n"),
    );
  });

  it("validates replies and supports note-only and text-only replies", () => {
    expect(() => checkReply({})).toThrow(/Invalid answers/);
    expect(replyText({ note: "Let's wait" }, questions)).toBe("Let's wait");
    expect(replyText({ text: "Looks good" }, [])).toBe("Looks good");
    expect(() =>
      replyText(
        { answers: [{ question: "Nonexistent", answer: "Yes" }] },
        questions,
      ),
    ).toThrow(/Unknown question/);
  });
});

describe("inbox lead, gist, previewUrl, tagOf", () => {
  it("extracts bold lead or first line, preview URLs, and tags", () => {
    expect(lead("**Ship v2?**\nDetails here")).toEqual({
      title: "Ship v2?",
      body: "Details here",
    });
    expect(lead("# Header title\nLine 2")).toEqual({
      title: "Header title",
      body: "Line 2",
    });
    expect(
      previewUrl("Check http://localhost:3000/demo before approving"),
    ).toBe("http://localhost:3000/demo");
    expect(tagOf({ text: "See http://127.0.0.1:5173/app" })).toBe("preview");
    expect(tagOf({ text: "Should we merge?" })).toBe("question");
    expect(
      gist({
        text: "Context",
        query: [{ text: "Pick one", kind: "confirm" }],
      }),
    ).toBe("query 1. Pick one");
  });
});
