import { useState } from "react";
import {
  SPECIAL_THREAD_ICON_IDS,
  type SpecialThreadDto,
  type SpecialThreadIconId,
} from "../contract";
import {
  SPECIAL_THREAD_COLORS,
  SPECIAL_THREAD_ICON_LABELS,
  SPECIAL_THREAD_PRESETS,
  SpecialThreadBadgeIcon,
} from "./special-thread-icon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

export type SpecialThreadDialogTarget =
  | {
      mode: "create";
      botId: string;
      botName: string;
    }
  | {
      mode: "promote";
      threadId: string;
      botId: string;
      botName: string;
      currentTitle?: string;
      existing?: SpecialThreadDto | null;
    };

export function SpecialThreadDialog({
  target,
  onClose,
  onCreate,
  onSave,
  onRemove,
}: {
  target: SpecialThreadDialogTarget;
  onClose: () => void;
  onCreate: (input: {
    botId: string;
    name: string;
    icon: SpecialThreadIconId;
    color?: string;
    instruction: string;
    rolePrompt?: string;
  }) => Promise<void>;
  onSave: (input: {
    threadId: string;
    botId: string;
    name: string;
    icon: SpecialThreadIconId;
    color?: string;
    instruction: string;
    rolePrompt?: string;
  }) => Promise<void>;
  onRemove: (threadId: string) => Promise<void>;
}) {
  const isCreate = target.mode === "create";
  const existing = target.mode === "promote" ? (target.existing ?? null) : null;
  const [name, setName] = useState(
    existing?.name ?? (target.mode === "promote" ? (target.currentTitle ?? "") : ""),
  );
  const [icon, setIcon] = useState<SpecialThreadIconId>(existing?.icon ?? "merge");
  const [color, setColor] = useState<string>(existing?.color ?? SPECIAL_THREAD_COLORS[0]);
  const [instruction, setInstruction] = useState(existing?.instruction ?? "");
  const [rolePrompt, setRolePrompt] = useState(existing?.rolePrompt ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (presetId: string) => {
    const preset = SPECIAL_THREAD_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    setName(preset.name);
    setIcon(preset.icon);
    setColor(preset.color);
    setInstruction(preset.instruction);
    setRolePrompt(preset.rolePrompt);
    setError(null);
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedInstruction = instruction.trim();
    if (!trimmedName) {
      setError("Name is required.");
      return;
    }
    if (!trimmedInstruction) {
      setError("Skill instruction for sibling threads is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isCreate) {
        await onCreate({
          botId: target.botId,
          name: trimmedName,
          icon,
          color,
          instruction: trimmedInstruction,
          ...(rolePrompt.trim() ? { rolePrompt: rolePrompt.trim() } : {}),
        });
      } else {
        await onSave({
          threadId: target.threadId,
          botId: target.botId,
          name: trimmedName,
          icon,
          color,
          instruction: trimmedInstruction,
          ...(rolePrompt.trim() ? { rolePrompt: rolePrompt.trim() } : {}),
        });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const handleDemote = async () => {
    if (target.mode !== "promote") return;
    setSaving(true);
    setError(null);
    try {
      await onRemove(target.threadId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <SpecialThreadBadgeIcon icon={icon} color={color} size="md" />
            <span>
              {isCreate
                ? `New Special thread · ${target.botName}`
                : existing
                  ? `Edit Special thread · ${existing.name}`
                  : "Promote to Special thread"}
            </span>
          </DialogTitle>
          <DialogDescription className="text-xs">
            Special threads stay pinned out of auto-settle and inject their standing skill instruction into all other threads of <strong>{target.botName}</strong>.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto py-1 pr-0.5">
          {!existing ? (
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-muted-foreground">Presets</div>
              <div className="flex flex-wrap gap-1.5">
                {SPECIAL_THREAD_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    onClick={() => applyPreset(preset.id)}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/30 px-2 py-1 text-xs text-foreground transition-colors hover:bg-accent"
                  >
                    <SpecialThreadBadgeIcon icon={preset.icon} color={preset.color} size="sm" />
                    <span>{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-1">
            <label htmlFor="pb-special-name" className="text-xs font-medium text-muted-foreground">
              Name
            </label>
            <Input
              id="pb-special-name"
              value={name}
              placeholder="e.g. Lander, Deployer, Reviewer"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.preventDefault();
              }}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Icon</div>
              <div className="flex flex-wrap gap-1.5">
                {SPECIAL_THREAD_ICON_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    title={SPECIAL_THREAD_ICON_LABELS[id]}
                    aria-label={SPECIAL_THREAD_ICON_LABELS[id]}
                    aria-pressed={icon === id}
                    onClick={() => setIcon(id)}
                    className={`rounded-md p-1 transition-colors ${
                      icon === id
                        ? "bg-accent ring-1 ring-primary"
                        : "hover:bg-accent/50"
                    }`}
                  >
                    <SpecialThreadBadgeIcon icon={id} color={color} size="sm" />
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-xs font-medium text-muted-foreground">Accent</div>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                {SPECIAL_THREAD_COLORS.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    aria-label={`Color ${swatch}`}
                    aria-pressed={color === swatch}
                    onClick={() => setColor(swatch)}
                    className={`size-5 rounded-full border transition-transform ${
                      color === swatch
                        ? "scale-110 ring-2 ring-ring ring-offset-1 ring-offset-background"
                        : "border-border/60 hover:scale-105"
                    }`}
                    style={{ backgroundColor: swatch }}
                  />
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="pb-special-instruction" className="text-xs font-medium text-muted-foreground">
              Standing skill instruction (injected into all other threads of {target.botName})
            </label>
            <textarea
              id="pb-special-instruction"
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. Work in a git worktree and message Lander with your worktree directory when ready to merge..."
              className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs leading-relaxed text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="pb-special-role" className="text-xs font-medium text-muted-foreground">
              Role prompt for this thread itself (optional)
            </label>
            <textarea
              id="pb-special-role"
              rows={3}
              value={rolePrompt}
              onChange={(e) => setRolePrompt(e.target.value)}
              placeholder="e.g. You are the Lander. Merge worktrees into main, resolve conflicts, run checks, and push..."
              className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-xs leading-relaxed text-foreground shadow-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>

          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <div>
            {existing ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                disabled={saving}
                onClick={() => void handleDemote()}
              >
                Demote
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
              {saving
                ? "Saving…"
                : isCreate
                  ? "Create Special thread"
                  : existing
                    ? "Save Special thread"
                    : "Promote"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
