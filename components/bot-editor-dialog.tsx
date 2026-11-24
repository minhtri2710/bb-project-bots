import { useState } from "react";
import type { BotRecordDto } from "../contract";
import { randomAvatar, type BotAvatar } from "../lib/appearance";
import * as Popover from "@radix-ui/react-popover";
import { AvatarAppearance } from "./avatar-appearance";
import { BotIcon } from "./bot-icon";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { usePortalScopeProps } from "../lib/portal-scope";

export type BotEditorTarget =
  | { mode: "create-unaffiliated" }
  | { mode: "edit"; bot: BotRecordDto; initialTab?: "identity" | "memory" };

export function BotEditorDialog({
  target,
  onClose,
  onCreateUnaffiliated,
  onUpdateBot,
  onDeleteUnaffiliated,
}: {
  target: BotEditorTarget;
  onClose: () => void;
  onCreateUnaffiliated: (input: { name: string; role: string; avatar: BotAvatar; soul: string; memory: string }) => Promise<void>;
  onUpdateBot: (input: {
    kind: "project" | "unaffiliated";
    botId: string;
    projectId?: string;
    name: string;
    role: string;
    avatar: BotAvatar;
    soul: string;
    memory: string;
  }) => Promise<void>;
  onDeleteUnaffiliated: (botId: string) => Promise<void>;
}) {
  const isCreate = target.mode === "create-unaffiliated";
  const initialBot = target.mode === "edit" ? target.bot : null;
  const isUnaffiliated = isCreate || initialBot?.kind === "unaffiliated";
  const portalScope = usePortalScopeProps();

  const [tab, setTab] = useState<"identity" | "memory">(
    target.mode === "edit" && target.initialTab ? target.initialTab : "identity",
  );
  const [name, setName] = useState(initialBot?.name ?? "");
  const [role, setRole] = useState(initialBot?.role ?? (isCreate ? "Coordinator" : "Project Bot"));
  const [avatar, setAvatar] = useState<BotAvatar>(() => initialBot?.avatar ?? randomAvatar());
  const [soul, setSoul] = useState(initialBot?.soul ?? "");
  const [memory, setMemory] = useState(initialBot?.memory ?? "## Facts\n\n## Lessons\n\n## Preferences\n");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isCreate) {
        await onCreateUnaffiliated({ name: trimmedName, role: role.trim(), avatar, soul, memory });
      } else if (initialBot) {
        await onUpdateBot({
          kind: initialBot.kind,
          botId: initialBot.id,
          projectId: initialBot.projectId,
          name: trimmedName,
          role: role.trim(),
          avatar,
          soul,
          memory,
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!initialBot || initialBot.kind !== "unaffiliated") return;
    setSaving(true);
    setError(null);
    try {
      await onDeleteUnaffiliated(initialBot.id);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="max-h-[88vh] flex flex-col sm:max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>
            {isCreate
              ? "New unaffiliated bot"
              : initialBot?.kind === "project"
                ? `Edit project bot · ${initialBot.name}`
                : `Edit bot · ${initialBot?.name ?? ""}`}
          </DialogTitle>
          <DialogDescription>
            {isUnaffiliated
              ? "Coordinator bot living in its own directory. Coordinates across projects by talking to other bots."
              : "Project bot stored in ~/.bb/project-bots/ as frontmatter + markdown memory."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 border-b border-border pb-3">
          <div className="flex items-center gap-1">
            <Popover.Root>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="Edit bot appearance"
                  className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/40 hover:bg-muted/80 transition-colors"
                >
                  <BotIcon avatar={avatar} size={36} />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content {...portalScope} className="z-50 w-80 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md" align="start" sideOffset={6}>
                  <AvatarAppearance avatar={avatar} onChange={setAvatar} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="Randomize appearance"
              onClick={() => setAvatar(randomAvatar())}
            >
              🎲
            </Button>
          </div>
          <div className="flex-1 space-y-1.5">
            <Input
              aria-label="Bot name"
              placeholder={isCreate ? "e.g. Chief of Staff" : "Bot name"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              aria-label="Bot role"
              placeholder="Role (e.g. Coordinator, Project Bot)"
              value={role}
              onChange={(e) => setRole(e.target.value)}
            />
          </div>
        </div>

        <div className="flex gap-1 border-b border-border pb-2">
          <Button type="button" size="sm" variant={tab === "identity" ? "secondary" : "ghost"} onClick={() => setTab("identity")}>
            Identity
          </Button>
          <Button type="button" size="sm" variant={tab === "memory" ? "secondary" : "ghost"} onClick={() => setTab("memory")}>
            Memory
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto space-y-3 py-1">
          {tab === "identity" ? (
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="pb-soul">
                  SOUL / Instructions
                </label>
                <textarea
                  id="pb-soul"
                  rows={6}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder="Describe this bot's focus, tone, and responsibilities..."
                  value={soul}
                  onChange={(e) => setSoul(e.target.value)}
                />
              </div>
              {initialBot ? (
                <div className="rounded-md bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground space-y-0.5">
                  <div className="font-mono truncate" title={initialBot.filePath}>
                    File: {initialBot.filePath}
                  </div>
                  {initialBot.kind === "project" ? (
                    <div>
                      Status: {initialBot.materialized ? "Initialized on disk" : "Preview (will initialize on first thread entry or Save)"}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {tab === "memory" ? (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground" htmlFor="pb-memory">
                Memory (Markdown body)
              </label>
              <textarea
                id="pb-memory"
                rows={10}
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={memory}
                onChange={(e) => setMemory(e.target.value)}
              />
            </div>
          ) : null}
        </div>

        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <div>
            {!isCreate && initialBot?.kind === "unaffiliated" ? (
              <Button type="button" size="sm" variant="destructive" onClick={() => void handleDelete()} disabled={saving}>
                Delete bot
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving…" : isCreate ? "Create bot" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
