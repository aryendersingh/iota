import { PermissionManager } from "./permissions.js";

/**
 * Mastra tools run inside the agent loop and only receive their validated
 * input — they have no handle to our CLI state. This module-level singleton is
 * how tools reach the working directory and the permission prompt. It is
 * populated once at startup by index.ts before the agent runs.
 */
export interface Runtime {
  cwd: string;
  permissions: PermissionManager;
}

export const runtime: Runtime = {
  cwd: process.cwd(),
  permissions: new PermissionManager(false),
};
