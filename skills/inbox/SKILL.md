---
name: inbox
description: Primary communication tool `message({ text, to?, query? })` — always renders body as chat prose for the user, routes cross-bot/thread messages with `to`, and queues important clarifications in the Inbox with `query`.
---

# `message` Tool & Decision Inbox

Prefer `message({ text, to?, query? })` for all communication with the user and across bots/threads.

## Schema

```ts
message({
  text: string, // Markdown body — for to="user", always rendered in the chat as prose (and bold lead / first line becomes the Inbox title when `query` is set)
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

## How it works

- **Communicating with the user (`to: "user"`, default)**:
  - After `message` succeeds, copy its returned `previewDirective` (`::inbox-message{id="..."}`) into your reply **exactly once on its own line** (not in backticks or a code fence) and do not repeat `text` — BB renders the message right there in chat.
  - **Without `query`**: renders as plain Markdown prose in the chat and **skips the Inbox** (no Inbox item, no badge increment, no decision card).
  - **With `query`**: renders the body + an interactive decision card inline in the thread **and** queues it in the Inbox (incrementing the unresolved badge). End your turn if you need the user's answer before continuing; their reply is delivered back to this thread automatically.
- **Cross-bot / cross-thread comms (`to`)**:
  - `to: "<botId | projectId | botName>"`: sends an asynchronous attributed message to that bot (continuing its last-viewed or latest thread, or spawning one automatically). It never lands in one of the bot's Special threads.
  - `to: "thr_..."`: sends an asynchronous message directly to that thread, including a Special thread of any project.
  - `to: "<Special thread name>"` (e.g. `"Lander"`): reaches a Special thread of your own project bot only. Use its thread ID to reach a Special thread of another project.
  - `to: "parent"`: sends an asynchronous message to the current thread's parent thread (errors if there is no parent).
- **Rules**:
  - `query` is only valid when `to` is `"user"` (or omitted).
  - `choice` / `multi` require at least two options with unique labels and unique `key`s; never include `"Something else"` or `"Other"` (the card adds `"Something else…"` and a note field automatically).
