import { useSyncExternalStore } from "react";
import type { UISink } from "../runtime.js";
import type { PermAnswer } from "../permissions.js";
import type { BgShell } from "../shells.js";

export type Status = "idle" | "thinking" | "streaming" | "tool";
export type ToolStatus = "running" | "done" | "error";

export interface ToolItem {
  id: string;
  name: string;
  detail: string;
  status: ToolStatus;
  result?: string;
  durationMs?: number;
  startedAt: number;
}

export interface SystemOutput {
  title?: string;
  body: string;
  tone?: "info" | "error";
}

export type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string }
  | { kind: "tool"; id: string; tool: ToolItem }
  | ({ kind: "system"; id: string } & SystemOutput);

interface State {
  transcript: TranscriptItem[];
  liveText: string;
  liveTools: ToolItem[];
  status: Status;
  busy: boolean;
  pendingPermission: { id: string; summary: string } | null;
  shells: BgShell[];
  model: string;
  thread: string;
}

let state: State = {
  transcript: [],
  liveText: "",
  liveTools: [],
  status: "idle",
  busy: false,
  pendingPermission: null,
  shells: [],
  model: "",
  thread: "",
};

const listeners = new Set<() => void>();
function set(partial: Partial<State>): void {
  state = { ...state, ...partial };
  for (const l of listeners) l();
}

let counter = 0;
const nextId = () => String(++counter);

const permResolvers = new Map<string, (a: PermAnswer) => void>();

/** Move any buffered live assistant text into the transcript as one message. */
function flushLiveText(): void {
  if (state.liveText.trim()) {
    set({
      transcript: [
        ...state.transcript,
        { kind: "assistant", id: nextId(), text: state.liveText },
      ],
      liveText: "",
    });
  } else if (state.liveText) {
    set({ liveText: "" });
  }
}

export const store = {
  subscribe(l: () => void): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  getSnapshot(): State {
    return state;
  },

  init(model: string, thread: string): void {
    set({ model, thread });
  },

  setShells(shells: BgShell[]): void {
    set({ shells });
  },

  addUser(text: string): void {
    set({
      transcript: [...state.transcript, { kind: "user", id: nextId(), text }],
    });
  },

  beginTurn(): void {
    set({ busy: true, status: "thinking", liveText: "" });
  },

  appendDelta(delta: string): void {
    set({ liveText: state.liveText + delta, status: "streaming" });
  },

  endTurn(): void {
    flushLiveText();
    set({ busy: false, status: "idle" });
  },

  pushSystem(out: SystemOutput): void {
    set({
      transcript: [...state.transcript, { kind: "system", id: nextId(), ...out }],
    });
  },

  // --- UISink (called by tools/mcp via runtime.ui) ---
  toolStart(name: string, detail: string): string {
    flushLiveText();
    const id = nextId();
    const tool: ToolItem = {
      id,
      name,
      detail,
      status: "running",
      startedAt: Date.now(),
    };
    set({ liveTools: [...state.liveTools, tool], status: "tool" });
    return id;
  },

  toolEnd(id: string, status: "done" | "error", result: string): void {
    const tool = state.liveTools.find((t) => t.id === id);
    if (!tool) return;
    const finished: ToolItem = {
      ...tool,
      status,
      result,
      durationMs: Date.now() - tool.startedAt,
    };
    set({
      liveTools: state.liveTools.filter((t) => t.id !== id),
      transcript: [...state.transcript, { kind: "tool", id, tool: finished }],
    });
  },

  // --- permissions ---
  requestPermission(summary: string): Promise<PermAnswer> {
    const id = nextId();
    return new Promise<PermAnswer>((resolve) => {
      permResolvers.set(id, resolve);
      set({ pendingPermission: { id, summary } });
    });
  },

  resolvePermission(id: string, answer: PermAnswer): void {
    const resolve = permResolvers.get(id);
    permResolvers.delete(id);
    set({ pendingPermission: null });
    resolve?.(answer);
  },
};

// Compile-time check that the store can serve as the tools' UI sink.
const _uiSinkCheck: UISink = store;
void _uiSinkCheck;

export function useStore(): State {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
