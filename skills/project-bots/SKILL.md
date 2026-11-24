---
name: project-bots
description: Work with Project Bots (automatic per-project file-backed bots in ~/.bb/project-bots/<hash6>.md) and Unaffiliated Coordinator Bots (which coordinate across projects by talking to other bots).
---

# Project Bots

## Project Bots (1 per project)
- Every standard BB project automatically has 1 project bot attached.
- Its state lives in `~/.bb/project-bots/<sha256(projectPath)[0:6]>.md` with YAML frontmatter (name, role, avatar, SOUL) and markdown memory (`## Facts`, `## Lessons`, `## Preferences`).
- The file is auto-generated on the first time you enter a thread of that project.
- Use `update_memory_state` with `action: "fact" | "lesson" | "preference" | "add" | "append" | "forget" | "replace" | "read"` to keep memory clean and durable.

## Unaffiliated Coordinator Bots
- Unaffiliated bots live in their own directory (`~/.bb/project-bots/unaffiliated/<botId>/`) with `bot.md`.
- They have no project membership and do NOT perform direct repository work.
- They accomplish work exclusively by coordinating with project bots and other bots using `list_bots`, `inspect_bot`, and `message({ to, text })`.

## Inter-bot Messaging
- `list_bots`: discover all project bots and unaffiliated bots (including `queuedFollowUpsCount`).
- `inspect_bot`: inspect a bot's recent threads, recent turns, and **all queued follow-up messages** before messaging or re-steering it.
- `message({ to, text })`: send an asynchronous attributed message to any bot (by bot ID, project ID, exact name, or thread ID). If the target bot has no active thread yet, a new thread is spawned automatically.
- CLI equivalent: `bb project-bots list`, `bb project-bots inspect <target>`, and `bb project-bots message <target> "<message>" [--thread <id>]`.
