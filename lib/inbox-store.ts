import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import {
  INBOX_REALTIME_CHANNEL,
  rpcContract,
  type InboxMessage,
} from "../contract";

const CACHE_KEY = "bb-plugin-inbox:cache:v1";

export type InboxSnapshot = {
  open: InboxMessage[];
  resolvedToday: InboxMessage[];
  hydrated: boolean;
  error: string | null;
};

function readInitialCache(): InboxSnapshot {
  if (typeof window === "undefined") {
    return { open: [], resolvedToday: [], hydrated: false, error: null };
  }
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) {
      return { open: [], resolvedToday: [], hydrated: false, error: null };
    }
    const parsed = JSON.parse(raw) as {
      open?: InboxMessage[];
      resolvedToday?: InboxMessage[];
    };
    return {
      open: Array.isArray(parsed.open) ? parsed.open : [],
      resolvedToday: Array.isArray(parsed.resolvedToday)
        ? parsed.resolvedToday
        : [],
      hydrated: true,
      error: null,
    };
  } catch {
    return { open: [], resolvedToday: [], hydrated: false, error: null };
  }
}

function persistCache(open: InboxMessage[], resolvedToday: InboxMessage[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ open, resolvedToday }),
    );
  } catch {
    // Ignore storage quota / private mode failures
  }
}

let snapshot: InboxSnapshot = readInitialCache();
const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function emit(next: InboxSnapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return snapshot;
}

export function optimisticResolveInboxItem(
  messageId: number,
  state: "answered" | "dismissed",
) {
  const target = snapshot.open.find((m) => m.id === messageId);
  if (!target) return;
  const nextOpen = snapshot.open.filter((m) => m.id !== messageId);
  const resolvedItem: InboxMessage = {
    ...target,
    state,
    resolvedAt: Date.now(),
  };
  const nextResolved = [
    resolvedItem,
    ...snapshot.resolvedToday.filter((m) => m.id !== messageId),
  ];
  persistCache(nextOpen, nextResolved);
  emit({
    open: nextOpen,
    resolvedToday: nextResolved,
    hydrated: true,
    error: null,
  });
}

export function useInboxStore() {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const data = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const refresh = useCallback(() => {
    if (inFlight) return inFlight;
    const p = rpc
      .call("inbox_list", { includeResolvedToday: true })
      .then((res) => {
        persistCache(res.open, res.resolvedToday);
        emit({
          open: res.open,
          resolvedToday: res.resolvedToday,
          hydrated: true,
          error: null,
        });
      })
      .catch((err) => {
        emit({
          ...snapshot,
          hydrated: true,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = p;
    return p;
  }, [rpc]);

  useEffect(() => {
    void refresh();
  }, [refresh, connectionState]);

  useRealtime(INBOX_REALTIME_CHANNEL, () => {
    void refresh();
  });

  return {
    ...data,
    refresh,
  };
}
