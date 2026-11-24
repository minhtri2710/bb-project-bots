---
name: inbox
description: Unified `message({ text, to?, query? })` tool for user decision cards in the Inbox and asynchronous messaging to bots, threads, or parent threads.
---

# Unified `message` Tool & Decision Inbox

Use `message({ text, to?, query? })` to ask the user for decisions or to send asynchronous messages to other bots and threads.

## Schema

```ts
message({
  text: string, // Message body (Markdown supported; bold lead or first line becomes the Inbox title)
  to?: string,  // Default "user". Also accepts "parent", a thread ID ("thr_..."), or a bot ID / project ID / exact bot name from list_bots.
  query?: Array<{
    text: string,
    kind: "choice" | "multi" | "confirm" | "text" | "scale",
    ref?: string, // e.g. "1", "2"
    options?: Array<{
      label: string,
      key?: string, // single lowercase letter, e.g. "a"
      detail?: string,
      recommended?: boolean, // pre-selected with a "my pick" chip
      preview?: string, // Markdown shown beside the option
    }>,
    scale?: { min: number, max: number, low?: string, high?: string }, // at most 10 steps
    placeholder?: string,
  }>
})
```

## Routing & Rules

- **`to: "user"` (default) with `query`**: creates an Inbox item awaiting decision, increments the unresolved Inbox badge, and renders an interactive answer card inline in the thread and in the Inbox. Do not repeat the options in prose; end your turn if you need the answer before continuing.
- **`to: "user"` without `query`**: thread prose only — skips the Inbox completely (no Inbox item, no badge, no decision card).
- **`to: "<botId | projectId | botName>"`**: sends an asynchronous attributed message to that bot (continuing its latest thread or spawning one automatically).
- **`to: "thr_..."`**: sends an asynchronous message directly to that thread.
- **`to: "parent"`**: sends an asynchronous message to the current thread's parent thread (errors if there is no parent).
- `query` is only valid when `to` is `"user"` (or omitted).
- `choice` / `multi` require at least two options with unique labels and unique `key`s; never include `"Something else"` or `"Other"` (the card adds `"Something else…"` and a note field automatically).
