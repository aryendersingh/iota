import { PermissionManager } from "./permissions.js";

/**
 * A renderer-agnostic sink for tool activity. The Ink store implements this
 * (so tool calls become live spinner rows); the headless runner implements a
 * plain-text version. Tools never write stdout directly.
 */
export interface UISink {
  /** Announce a tool starting; returns an id to pass to toolEnd. */
  toolStart(name: string, detail: string): string;
  toolEnd(id: string, status: "done" | "error", result: string): void;
}

const noopUI: UISink = {
  toolStart: () => "",
  toolEnd: () => {},
};

/**
 * Module-level state that tools read at execution time. Mastra hands tools only
 * their validated input, so the working directory, permission prompt, and UI
 * sink live here and are populated once at startup by index.ts.
 */
export interface Runtime {
  cwd: string;
  permissions: PermissionManager;
  ui: UISink;
}

export const runtime: Runtime = {
  cwd: process.cwd(),
  permissions: new PermissionManager(false),
  ui: noopUI,
};
