# bb-project-bots

A BB plugin that attaches an automatic, file-backed bot to every project and adds lightweight unaffiliated coordinator bots that coordinate across projects by talking to other bots.

## Model

### 1. Project Bots (1 per project)
- Every standard BB project automatically has 1 project bot attached.
- The sidebar displays a deterministic generated Bloub avatar and name for every project.
- On the first time you enter a thread of a project (or dispatch/edit it), its markdown file is auto-generated at:
  `~/.bb/project-bots/<sha256(projectPath)[0:6]>.md`
- Frontmatter stores appearance (`color`, `shape`, `expression`, `motion`), `name`, `role`, `soul`, `projectId`, and `projectPath`.
- The markdown body stores durable memory (`## Facts`, `## Lessons`, `## Preferences`), managed by the `update_memory_state` tool (`fact`, `lesson`, `preference`, `add`, `append`, `forget`, `replace`, `read`).

### 2. Unaffiliated Coordinator Bots
- No project membership or project ownership.
- Each unaffiliated bot lives in its own directory `~/.bb/project-bots/unaffiliated/<botId>/` containing `bot.md`.
- Configured as coordinator-only agents: they do **not** perform direct repository work themselves.
- They coordinate across projects by discovering and messaging project bots and other bots via `list_bots`, `inspect_bot`, and `message({ to, text })`.

## CLI

```bash
bb project-bots list [--json]
bb project-bots message <bot-id-or-name> "<message>" [--thread <id>] [--new-thread] [--json]
```

## Development

```bash
npm run typecheck
npm test
bb plugin build
bb plugin reload bb-project-bots
```
