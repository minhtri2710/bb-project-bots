import { useEffect, useState } from "react";
import type { DreamConfigDto, ProviderModelsDto } from "../contract";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

const INTERVAL_OPTIONS = [
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 180, label: "Every 3 hours" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 1440, label: "Daily" },
];

export function DreamSettingsDialog({
  config,
  dreamThreadId,
  onOpenDreamThread,
  loadProviders,
  onSave,
  onClose,
}: {
  config: DreamConfigDto;
  dreamThreadId: string | null;
  onOpenDreamThread?: (threadId: string) => void;
  loadProviders: () => Promise<ProviderModelsDto[]>;
  onSave: (next: DreamConfigDto) => Promise<void>;
  onClose: () => void;
}) {
  const [providers, setProviders] = useState<ProviderModelsDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(config.enabled);
  const [providerId, setProviderId] = useState(config.providerId);
  const [model, setModel] = useState(config.model);
  const [intervalMinutes, setIntervalMinutes] = useState(config.intervalMinutes || 60);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadProviders()
      .then((list) => {
        if (cancelled) return;
        setProviders(list);
        setLoading(false);
        if (!providerId && list.length > 0) {
          const first = list[0]!;
          setProviderId(first.id);
          const defModel = first.models.find((m) => m.isDefault) ?? first.models[0];
          if (defModel) setModel(defModel.id);
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadProviders]);

  const activeProvider = providers.find((p) => p.id === providerId);
  const models = activeProvider?.models ?? [];

  const handleProviderChange = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    const prov = providers.find((p) => p.id === nextProviderId);
    const defModel = prov?.models.find((m) => m.isDefault) ?? prov?.models[0];
    setModel(defModel?.id ?? "");
  };

  const handleSave = async () => {
    if (enabled && (!providerId || !model)) {
      setError("Select an agent/provider and model to enable automatic Dream Mode.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ enabled, providerId, model, intervalMinutes });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-md" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Dream Mode</DialogTitle>
          <DialogDescription>
            Automatically reads unprocessed project conversations, consolidates durable facts/lessons/preferences, and prunes stale memory.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1 text-xs">
          <label className="flex items-center gap-2 font-medium text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-input"
            />
            <span>Run Dream Mode automatically in the background</span>
          </label>

          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="pb-dream-provider">
              Agent / Provider
            </label>
            <select
              id="pb-dream-provider"
              disabled={loading}
              value={providerId}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {providers.length === 0 ? (
                <option value="">{loading ? "Loading providers…" : "No providers available"}</option>
              ) : (
                providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.id})
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="pb-dream-model">
              Model
            </label>
            {models.length > 0 ? (
              <select
                id="pb-dream-model"
                disabled={loading}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="pb-dream-model"
                type="text"
                placeholder="Model ID (e.g. claude-sonnet-4-5)"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            )}
          </div>

          <div className="space-y-1">
            <label className="block text-[11px] font-medium text-muted-foreground" htmlFor="pb-dream-interval">
              Cadence per bot
            </label>
            <select
              id="pb-dream-interval"
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {INTERVAL_OPTIONS.map((opt) => (
                <option key={opt.minutes} value={opt.minutes}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <p className="rounded-md bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground">
            Dream runs on one visible thread (<span className="font-mono">🌙 Dream Mode</span>) with access only to <span className="font-mono">update_memory_state</span>, clearing context (<span className="font-mono">/new</span>) between bots.
          </p>
        </div>

        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}

        <DialogFooter className="flex items-center justify-between gap-2 border-t border-border pt-3">
          <div>
            {dreamThreadId && onOpenDreamThread ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  onOpenDreamThread(dreamThreadId);
                  onClose();
                }}
              >
                Open Dream thread
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
