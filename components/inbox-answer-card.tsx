import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Markdown, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { InboxMessage, Question, ReplyInput } from "../contract";
import {
  answerOf,
  answered,
  cardKey,
  cardOf,
  choiceForKey,
  choices,
  keyOf,
  position,
  type CardState,
  type Draft,
} from "../lib/inbox-questions";
import {
  clearStoredCard,
  readStoredCard,
  writeStoredCard,
} from "../lib/inbox-storage";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const CHECK_LANDING_BEFORE_ADVANCE_MS = 320;
const ANSWER_UNDO_WINDOW_MS = 3000;
const HOLD_TO_SEND_MS = 1000;
const REDUCED_MOTION_STEP_MS = 250;

type Phase = "answering" | "undo" | "sending" | "sent";

function Kbd({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "inline-flex h-4 min-w-4 items-center justify-center rounded-[3px] border border-border/80 bg-muted/60 px-1 font-mono text-[10px] leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

function AnimatedFill({
  duration,
  className,
}: {
  duration: number;
  className: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const anim = el.animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      {
        duration,
        easing: reduced
          ? `steps(${Math.max(1, Math.round(duration / REDUCED_MOTION_STEP_MS))})`
          : "linear",
        fill: "both",
      },
    );
    return () => anim.cancel();
  }, [duration]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 -z-10 origin-left", className)}
    />
  );
}

function SendButton({
  messageId,
  phase,
  disabled,
  label,
  onSend,
  onSendNow,
  onUndo,
}: {
  messageId: number;
  phase: Phase;
  disabled: boolean;
  label: string;
  onSend: () => void;
  onSendNow: () => void;
  onUndo: () => void;
}) {
  const [holding, setHolding] = useState(false);
  const holdTimerRef = useRef<number | null>(null);
  const heldRef = useRef(false);

  const stopHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHolding(false);
  }, []);

  useEffect(() => {
    stopHold();
    return stopHold;
  }, [phase, stopHold]);

  const answering = phase === "answering";
  const undo = phase === "undo";
  const status = undo ? "Undo" : phase === "sending" ? "Sending…" : "Sent";

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    heldRef.current = false;
    if (!event.isPrimary || event.button !== 0 || disabled || !answering) return;
    setHolding(true);
    holdTimerRef.current = window.setTimeout(() => {
      stopHold();
      heldRef.current = true;
      onSendNow();
    }, HOLD_TO_SEND_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (holdTimerRef.current === null) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    ) {
      stopHold();
    }
  };

  return (
    <Button
      type="button"
      size="sm"
      variant={answering ? "default" : "outline"}
      aria-label={`${answering ? label : status}: answer to message ${messageId}`}
      disabled={disabled || (!answering && !undo)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopHold}
      onPointerLeave={stopHold}
      onPointerCancel={stopHold}
      onContextMenu={(event) => event.preventDefault()}
      onClick={(event) => {
        if (heldRef.current && event.detail !== 0) {
          heldRef.current = false;
          return;
        }
        heldRef.current = false;
        if (undo) onUndo();
        else if (answering) onSend();
      }}
      className="relative isolate overflow-hidden"
    >
      {holding && (
        <AnimatedFill
          duration={HOLD_TO_SEND_MS}
          className="bg-primary-foreground/20"
        />
      )}
      {undo && (
        <AnimatedFill
          duration={ANSWER_UNDO_WINDOW_MS}
          className="bg-primary/15"
        />
      )}
      {undo ? (
        <span className="inline-flex items-center gap-1.5">
          <Icon name="Undo2" className="size-3.5" />
          Undo
        </span>
      ) : answering ? (
        label
      ) : (
        status
      )}
    </Button>
  );
}

function ScaleControl({
  question,
  draft,
  name,
  disabled,
  onSelect,
}: {
  question: Question;
  draft: Draft | undefined;
  name: string;
  disabled: boolean;
  onSelect: (index: number) => void;
}) {
  const list = useMemo(() => choices(question), [question]);
  const value = draft?.chosen[0] ?? -1;

  return (
    <div>
      <div className="flex gap-1">
        {list.map((step, index) => {
          const isSelected = value === index;
          const isFilled = value >= index;
          return (
            <button
              key={step.label}
              type="button"
              aria-current={isSelected ? "true" : undefined}
              aria-label={`Rating ${step.label} · ${name}`}
              disabled={disabled}
              onClick={() => onSelect(index)}
              className={cn(
                "h-9 min-w-0 flex-1 rounded-md border font-mono text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                isSelected
                  ? "border-primary bg-primary text-primary-foreground"
                  : isFilled
                    ? "border-primary/40 bg-primary/15 text-foreground"
                    : "border-border/70 bg-background/40 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {step.label}
            </button>
          );
        })}
      </div>
      {(question.scale?.low || question.scale?.high) && (
        <div className="mt-1.5 flex justify-between font-mono text-[11px] text-muted-foreground">
          <span>{question.scale?.low}</span>
          <span>{question.scale?.high}</span>
        </div>
      )}
    </div>
  );
}

function QuestionItem({
  question,
  index,
  messageId,
  draft,
  current,
  disabled,
  hints,
  onOpen,
  onSelect,
  onText,
  onFieldKey,
}: {
  question: Question;
  index: number;
  messageId: number;
  draft: Draft | undefined;
  current: boolean;
  disabled: boolean;
  hints: boolean;
  onOpen: () => void;
  onSelect: (choiceIndex: number, pressed?: boolean) => void;
  onText: (text: string) => void;
  onFieldKey: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
}) {
  const list = useMemo(() => choices(question), [question]);
  const [activePreviewIndex, setActivePreviewIndex] = useState<number>();
  const words = useMemo(() => answerOf(question, draft), [question, draft]);
  const number = position(question, index);
  const name = `question ${number} · message ${messageId}`;
  const multi = question.kind === "multi";
  const confirm = question.kind === "confirm";
  const hasPreviews = useMemo(
    () => list.some((choice) => Boolean(choice.preview)),
    [list],
  );
  const activePreview = useMemo(() => {
    const idx =
      activePreviewIndex ??
      draft?.chosen[0] ??
      Math.max(
        0,
        list.findIndex((choice) => choice.recommended),
      );
    return list[idx];
  }, [activePreviewIndex, draft, list]);

  const tag = useMemo(() => {
    const keys =
      question.kind === "scale" || draft?.other
        ? ""
        : (draft?.chosen ?? [])
            .map((i) => list[i]?.key ?? "")
            .filter(Boolean)
            .join(",");
    return `${number}${keys}`;
  }, [question.kind, draft, list, number]);

  const customInputRef = useRef<HTMLInputElement | null>(null);
  const isCustomOpen = Boolean(draft?.other);

  useEffect(() => {
    if (isCustomOpen && current) {
      customInputRef.current?.focus();
    }
  }, [isCustomOpen, current]);

  return (
    <fieldset
      disabled={disabled}
      data-current={current ? "" : undefined}
      className={cn(
        "min-w-0 rounded-md border transition-colors",
        current ? "border-border/80 bg-background/50" : "border-transparent",
      )}
    >
      <legend className="sr-only">{question.text}</legend>
      <button
        type="button"
        aria-label={`Open ${name}: ${question.text}`}
        aria-expanded={current}
        tabIndex={current ? -1 : 0}
        disabled={disabled}
        onClick={onOpen}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left font-normal whitespace-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          current ? "cursor-default" : "hover:bg-muted/40",
        )}
      >
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] transition-colors",
            words
              ? "bg-primary/15 text-primary"
              : current
                ? "border border-foreground/30 text-foreground"
                : "border border-dashed border-muted-foreground/40 text-muted-foreground",
          )}
        >
          {words && !current ? (
            <Icon name="Check" className="size-3" />
          ) : (
            number
          )}
        </span>
        <span
          className={cn(
            "min-w-0 text-[13px] leading-snug",
            current
              ? "flex-1 font-medium text-foreground"
              : "shrink truncate text-foreground/85",
          )}
        >
          {question.text}
        </span>
        {!current && (
          <span
            className={cn(
              "ml-auto flex min-w-0 shrink-[2] items-center gap-1.5 font-mono text-[11px]",
              words ? "text-muted-foreground" : "text-muted-foreground/60",
            )}
          >
            {words ? (
              <>
                <span className="shrink-0 text-primary">{tag}</span>
                <span className="truncate font-sans text-xs text-foreground/80">
                  {words}
                </span>
              </>
            ) : (
              <span className="whitespace-nowrap">not answered</span>
            )}
          </span>
        )}
        {current && multi && (
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            pick any
          </span>
        )}
      </button>

      {current && (
        <div className="px-2.5 pt-0.5 pb-2.5">
          {question.kind === "text" ? (
            <Input
              aria-label={`Your answer to ${name}`}
              placeholder={question.placeholder ?? "Your answer…"}
              value={draft?.text ?? ""}
              disabled={disabled}
              onChange={(event) => onText(event.target.value)}
              onKeyDown={onFieldKey}
              className="h-9 text-[13px]"
            />
          ) : question.kind === "scale" ? (
            <ScaleControl
              question={question}
              draft={draft}
              name={name}
              disabled={disabled}
              onSelect={(idx) => onSelect(idx)}
            />
          ) : (
            <div
              className={
                hasPreviews ? "grid gap-2 md:grid-cols-2" : "contents"
              }
            >
              <div
                className={cn(
                  "grid content-start gap-1.5",
                  confirm && "grid-cols-2",
                )}
              >
                {list.map((choice, optionIndex) => {
                  const chosen = choice.custom
                    ? Boolean(draft?.other)
                    : Boolean(draft?.chosen.includes(optionIndex));
                  const hintKey = hints ? keyOf(question, optionIndex) : undefined;
                  const showPreview = () => {
                    if (!choice.custom) setActivePreviewIndex(optionIndex);
                  };
                  return (
                    <div
                      key={`${choice.label}-${optionIndex}`}
                      onPointerEnter={showPreview}
                      className={cn(
                        "rounded-md border transition-colors",
                        choice.custom && confirm && "col-span-2",
                        chosen
                          ? "border-primary/50 bg-primary/10"
                          : choice.recommended
                            ? "border-primary/25 bg-background/40 hover:bg-muted/60"
                            : "border-border/70 bg-background/40 hover:border-border hover:bg-muted/60",
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={multi ? chosen : undefined}
                        aria-current={!multi && chosen ? "true" : undefined}
                        aria-label={`Option ${optionIndex + 1} · ${choice.label} · ${name}`}
                        disabled={disabled}
                        onClick={() => onSelect(optionIndex, multi ? !chosen : undefined)}
                        onFocus={showPreview}
                        className="group/option flex min-h-9 w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] leading-snug font-normal whitespace-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            "mt-px flex size-5 shrink-0 items-center justify-center border font-mono text-[10px] transition-colors",
                            multi ? "rounded-[5px]" : "rounded-full",
                            chosen
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background/60 text-muted-foreground group-hover/option:border-foreground/30 group-hover/option:text-foreground",
                          )}
                        >
                          {chosen ? (
                            <Icon name="Check" className="size-3" />
                          ) : (
                            hintKey
                          )}
                        </span>
                        <span className="min-w-0 flex-1 pt-px">
                          <span
                            className={
                              choice.custom && !chosen
                                ? "text-muted-foreground"
                                : "text-foreground"
                            }
                          >
                            {choice.label}
                          </span>
                          {choice.detail && (
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {choice.detail}
                            </span>
                          )}
                        </span>
                        {choice.recommended && (
                          <span className="mt-0.5 shrink-0 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px font-mono text-[10px] text-primary">
                            my pick
                          </span>
                        )}
                      </button>
                      {choice.custom && chosen && (
                        <div className="px-2.5 pb-2.5 pl-10">
                          <Input
                            ref={customInputRef}
                            aria-label={`Your answer to ${name}`}
                            placeholder="Your answer…"
                            value={draft?.text ?? ""}
                            disabled={disabled}
                            onChange={(event) => onText(event.target.value)}
                            onKeyDown={onFieldKey}
                            className="h-9 text-[13px]"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {hasPreviews && (
                <div className="flex min-h-24 min-w-0 flex-col rounded-md border border-border/70 bg-background/70">
                  <div className="border-b border-border/60 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
                    preview · {activePreview?.label ?? ""}
                  </div>
                  <div className="min-h-0 flex-1 overflow-auto px-2.5 py-2 text-xs leading-relaxed">
                    {activePreview?.preview ? (
                      <Markdown content={activePreview.preview} />
                    ) : (
                      <span className="text-muted-foreground">
                        No preview for this option.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </fieldset>
  );
}

export function AnswerCard({
  message,
  keys = false,
  className,
  onAnswer,
  onDismiss,
}: {
  message: InboxMessage;
  keys?: boolean;
  className?: string;
  onAnswer: (reply: ReplyInput) => Promise<void>;
  onDismiss: () => Promise<void>;
}) {
  const questions = useMemo(() => message.query ?? [], [message.query]);
  const storageKey = cardKey(message.id);

  const [state, setState] = useState<CardState>(() =>
    cardOf(readStoredCard(storageKey), questions),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("answering");
  const [heldDraft, setHeldDraft] = useState<Pick<CardState, "drafts" | "note"> | null>(
    null,
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  const pendingFireRef = useRef<(() => void) | null>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    setState(cardOf(readStoredCard(storageKey), questions));
    setPhase("answering");
    setHeldDraft(null);
    setError(null);
    committedRef.current = false;
  }, [storageKey, questions]);

  const updateState = useCallback(
    (edit: (prev: CardState) => CardState) => {
      setState((prev) => {
        const next = edit(prev);
        writeStoredCard(storageKey, next);
        return next;
      });
    },
    [storageKey],
  );

  const drafts = heldDraft?.drafts ?? state.drafts;
  const note = heldDraft?.note ?? state.note;
  const current = Math.min(Math.max(0, state.current), Math.max(0, questions.length - 1));
  const ready = useMemo(() => answered(questions, drafts), [questions, drafts]);
  const locked = phase !== "answering";
  const disabled = busy || locked;
  const left = questions.length - ready.length;
  const beforeLast = current < questions.length - 1;

  const sendLabel =
    !ready.length && note.trim()
      ? "Send note"
      : left > 0 && ready.length > 0
        ? `Send ${ready.length} of ${questions.length}`
        : "Send";

  const clearAdvance = useCallback(() => {
    if (advanceTimerRef.current !== null) {
      window.clearTimeout(advanceTimerRef.current);
      advanceTimerRef.current = null;
    }
  }, []);

  const go = useCallback(
    (index: number) => {
      clearAdvance();
      const next = Math.min(questions.length - 1, Math.max(0, index));
      updateState((prev) => ({ ...prev, current: next }));
      if (questions[next]?.kind === "text") {
        window.requestAnimationFrame(() => {
          rootRef.current
            ?.querySelector<HTMLInputElement>(`[data-question="${next}"] input`)
            ?.focus({ preventScroll: true });
        });
      }
    },
    [clearAdvance, questions, updateState],
  );

  const select = useCallback(
    (index: number, optionIndex: number, click = false, pressed?: boolean) => {
      const question = questions[index];
      const choice = question && choices(question)[optionIndex];
      if (!question || !choice) return;
      updateState((prev) => {
        const previous = prev.drafts[index] ?? { chosen: [] };
        const on =
          pressed ??
          !(choice.custom
            ? previous.other
            : previous.chosen.includes(optionIndex));
        const nextDraft: Draft =
          question.kind === "multi"
            ? choice.custom
              ? { ...previous, other: on }
              : {
                  ...previous,
                  chosen: on
                    ? [...new Set([...previous.chosen, optionIndex])].sort(
                        (a, b) => a - b,
                      )
                    : previous.chosen.filter((i) => i !== optionIndex),
                }
            : {
                ...previous,
                chosen: choice.custom ? [] : [optionIndex],
                other: Boolean(choice.custom),
              };
        return {
          ...prev,
          current: index,
          drafts: { ...prev.drafts, [index]: nextDraft },
        };
      });
      clearAdvance();
      if (
        question.kind !== "multi" &&
        click &&
        !choice.custom &&
        index < questions.length - 1
      ) {
        advanceTimerRef.current = window.setTimeout(() => {
          go(index + 1);
        }, CHECK_LANDING_BEFORE_ADVANCE_MS);
      }
    },
    [clearAdvance, go, questions, updateState],
  );

  const unlock = useCallback(() => {
    committedRef.current = false;
    setHeldDraft(null);
    setPhase("answering");
  }, []);

  const undo = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    pendingFireRef.current = null;
    unlock();
  }, [unlock]);

  const flushAnswer = useCallback(() => {
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    const fire = pendingFireRef.current;
    pendingFireRef.current = null;
    fire?.();
  }, []);

  const send = useCallback(
    (immediately = false) => {
      const extra = note.trim();
      if ((!ready.length && !extra) || committedRef.current || busy) return;
      committedRef.current = true;
      clearAdvance();
      setHeldDraft({ drafts, note });
      const payload: ReplyInput = {
        answers: ready,
        ...(extra ? { note: extra } : {}),
      };
      const fire = () => {
        undoTimerRef.current = null;
        pendingFireRef.current = null;
        setPhase("sending");
        setBusy(true);
        setError(null);
        void onAnswer(payload)
          .then(() => {
            clearStoredCard(storageKey);
            setPhase("sent");
          })
          .catch((err) => {
            unlock();
            setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            setBusy(false);
          });
      };

      if (immediately) {
        fire();
      } else {
        pendingFireRef.current = fire;
        undoTimerRef.current = window.setTimeout(fire, ANSWER_UNDO_WINDOW_MS);
        setPhase("undo");
      }
    },
    [busy, clearAdvance, drafts, note, onAnswer, ready, storageKey, unlock],
  );

  const handleDismiss = useCallback(async () => {
    if (busy || locked) return;
    setBusy(true);
    setError(null);
    try {
      await onDismiss();
      clearStoredCard(storageKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, locked, onDismiss, storageKey]);

  const enterAction = useCallback(() => {
    if (phase === "undo") {
      flushAnswer();
      return;
    }
    if (locked) return;
    if (beforeLast) go(current + 1);
    else send(false);
  }, [beforeLast, current, flushAnswer, go, locked, phase, send]);

  const handleFieldKey = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) send(true);
        else enterAction();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.currentTarget.blur();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.currentTarget.blur();
        go(current + (event.key === "ArrowDown" ? 1 : -1));
      }
    },
    [current, enterAction, go, send],
  );

  useEffect(() => {
    if (!keys || questions.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (locked && phase !== "undo") return;
      const root = rootRef.current;
      const target = event.target instanceof Element ? event.target : null;
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest('input, textarea, select, [contenteditable="true"]') ||
        (root &&
          !root.contains(target) &&
          target?.closest("[data-questions-card], button, a")) ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
        )
      ) {
        return;
      }
      if (phase === "undo") {
        if (event.key === "Escape" || event.key === "u") {
          event.preventDefault();
          undo();
        } else if (event.key === "Enter") {
          event.preventDefault();
          flushAnswer();
        }
        return;
      }
      const question = questions[current];
      const choiceIdx =
        question && /^[1-9a-z]$/.test(event.key)
          ? choiceForKey(question, event.key)
          : undefined;
      if (choiceIdx !== undefined) {
        event.preventDefault();
        select(current, choiceIdx, true);
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        go(current + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) send(true);
        else enterAction();
      } else if (
        event.key === "Escape" &&
        question &&
        answerOf(question, drafts[current])
      ) {
        event.preventDefault();
        clearAdvance();
        updateState((prev) => ({
          ...prev,
          drafts: { ...prev.drafts, [current]: { chosen: [] } },
        }));
      } else if (event.key === "/") {
        event.preventDefault();
        noteRef.current?.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    clearAdvance,
    current,
    drafts,
    enterAction,
    flushAnswer,
    go,
    keys,
    locked,
    phase,
    questions,
    select,
    send,
    undo,
    updateState,
  ]);

  useEffect(() => {
    return () => {
      clearAdvance();
      flushAnswer();
    };
  }, [clearAdvance, flushAnswer]);

  if (questions.length === 0) {
    return (
      <form
        data-questions-card={storageKey}
        onSubmit={(event) => {
          event.preventDefault();
          const text = state.text.trim();
          if (!text || busy) return;
          setBusy(true);
          setError(null);
          void onAnswer({ text })
            .then(() => clearStoredCard(storageKey))
            .catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            )
            .finally(() => setBusy(false));
        }}
        className={cn(
          "flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2.5",
          className,
        )}
      >
        <Icon name="MessageCircleQuestion" className="size-3.5 shrink-0 text-primary" />
        <Input
          aria-label={`Your answer to message ${message.id}`}
          placeholder="Your answer…"
          value={state.text}
          disabled={busy}
          onChange={(event) =>
            updateState((prev) => ({ ...prev, text: event.target.value }))
          }
          className="h-8 flex-1 basis-40 text-[13px]"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void handleDismiss()}
        >
          Dismiss
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!state.text.trim() || busy}
        >
          {busy ? "Sending…" : "Send"}
        </Button>
        {error && (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
    );
  }

  const shownQuestion = questions[current];
  const shownKeys = shownQuestion
    ? [0, 1].flatMap((i) => {
        const k = keyOf(shownQuestion, i);
        return k ? [k] : [];
      })
    : [];

  return (
    <div
      ref={rootRef}
      data-questions-card={storageKey}
      className={cn("border-t border-border/60", className)}
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1 font-mono text-[11px] text-muted-foreground">
        <Icon name="MessageCircleQuestion" className="size-3.5 text-primary" />
        <span className="text-foreground">
          {questions.length === 1
            ? "1 question"
            : `${questions.length} questions`}
        </span>
        {questions.length > 1 && (
          <span className="ml-auto flex items-center gap-2">
            <span>
              {ready.length}/{questions.length}
            </span>
            <span className="flex items-center gap-1" aria-hidden="true">
              {questions.map((q, i) => (
                <span
                  key={q.text}
                  className={cn(
                    "h-1 rounded-full transition-all duration-300",
                    answerOf(q, drafts[i])
                      ? "w-3 bg-primary"
                      : "w-1.5 bg-muted-foreground/30",
                  )}
                />
              ))}
            </span>
          </span>
        )}
      </div>

      <div className="space-y-0.5 px-1.5">
        {questions.map((question, index) => (
          <div key={question.text} data-question={index}>
            <QuestionItem
              question={question}
              index={index}
              messageId={message.id}
              draft={drafts[index]}
              current={index === current}
              disabled={disabled}
              hints={keys}
              onOpen={() => go(index)}
              onSelect={(optionIndex, pressed) =>
                select(index, optionIndex, true, pressed)
              }
              onText={(value) =>
                updateState((prev) => ({
                  ...prev,
                  drafts: {
                    ...prev.drafts,
                    [index]: {
                      ...(prev.drafts[index] ?? { chosen: [] }),
                      text: value,
                    },
                  },
                }))
              }
              onFieldKey={handleFieldKey}
            />
          </div>
        ))}
      </div>

      <div className="px-3 pt-2">
        <div className="relative">
          <textarea
            ref={noteRef}
            aria-label={`A note to send with your answer to message ${message.id}`}
            placeholder="Anything else? Sent with your answers, or on its own…"
            rows={1}
            value={note}
            disabled={disabled}
            onChange={(event) =>
              updateState((prev) => ({ ...prev, note: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.stopPropagation();
                send(false);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            className="w-full max-h-40 min-h-9 resize-none rounded-md border border-border/70 bg-background/40 px-2.5 py-2 pr-8 text-[13px] leading-snug text-foreground placeholder:text-muted-foreground/70 transition-colors hover:border-border focus:border-primary/60 focus:bg-background focus:outline-none disabled:opacity-50"
          />
          {keys && !note && (
            <Kbd className="pointer-events-none absolute top-2.5 right-2.5 bg-transparent">
              /
            </Kbd>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 pt-2 pb-2.5">
        {keys && phase === "undo" && (
          <span className="hidden items-center gap-x-2.5 font-mono text-[10px] text-muted-foreground/80 md:flex">
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> undo
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> send now
            </span>
          </span>
        )}
        {keys && !locked && (
          <span className="hidden flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10px] text-muted-foreground/80 md:flex">
            {shownKeys.length > 0 && (
              <span className="flex items-center gap-1">
                {shownKeys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}{" "}
                choose
              </span>
            )}
            {questions.length > 1 && (
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> move
              </span>
            )}
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              {beforeLast ? "next" : "send"}
            </span>
            {shownQuestion && answerOf(shownQuestion, drafts[current]) && (
              <span className="flex items-center gap-1">
                <Kbd>esc</Kbd> clear
              </span>
            )}
          </span>
        )}

        <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => void handleDismiss()}
            aria-label={`Dismiss message ${message.id}`}
          >
            Dismiss
          </Button>
          <SendButton
            messageId={message.id}
            phase={phase}
            disabled={(!locked && !ready.length && !note.trim()) || busy}
            label={sendLabel}
            onSend={() => send(false)}
            onSendNow={() => send(true)}
            onUndo={undo}
          />
        </span>

        {error && (
          <p role="alert" className="w-full text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
