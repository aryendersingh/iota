import { spawn, type ChildProcess } from "node:child_process";

/**
 * Registry of background shells started via bash(background=true). Each keeps a
 * rolling output buffer the agent can poll with bash_output, and can be killed
 * with kill_shell. All are torn down when iota exits.
 */

export type ShellStatus = "running" | "exited" | "killed";

export interface BgShell {
  id: string;
  command: string;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
}

interface Entry extends BgShell {
  child: ChildProcess;
  buffer: string;
  /** chars dropped off the front of `buffer` to stay under MAX_BUFFER */
  dropped: number;
  /** absolute read position in the logical stream */
  cursor: number;
}

const MAX_BUFFER = 200_000;
const shells = new Map<string, Entry>();
const listeners = new Set<() => void>();
let counter = 0;

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to start/exit/kill changes (used to mirror state into the UI). */
export function onShellsChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function startShell(command: string, cwd: string): string {
  const id = `bg_${++counter}`;
  const child = spawn(command, { cwd, shell: true });
  const entry: Entry = {
    id,
    command,
    status: "running",
    exitCode: null,
    startedAt: Date.now(),
    child,
    buffer: "",
    dropped: 0,
    cursor: 0,
  };

  const append = (d: Buffer) => {
    entry.buffer += d.toString();
    if (entry.buffer.length > MAX_BUFFER) {
      const over = entry.buffer.length - MAX_BUFFER;
      entry.buffer = entry.buffer.slice(over);
      entry.dropped += over;
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (e) => {
    entry.buffer += `\n[spawn error: ${e.message}]`;
    entry.status = "exited";
    entry.exitCode = -1;
    notify();
  });
  child.on("close", (code) => {
    if (entry.status === "running") {
      entry.status = "exited";
      entry.exitCode = code;
    }
    notify();
  });

  shells.set(id, entry);
  notify();
  return id;
}

export interface ReadResult {
  ok: boolean;
  output?: string;
  status?: ShellStatus;
  exitCode?: number | null;
  error?: string;
}

/** Return output produced since the last read, advancing the cursor. */
export function readShell(id: string): ReadResult {
  const e = shells.get(id);
  if (!e) return { ok: false, error: `No background shell '${id}'` };
  const start = Math.max(0, e.cursor - e.dropped);
  const output = e.buffer.slice(start);
  e.cursor = e.dropped + e.buffer.length;
  return { ok: true, output, status: e.status, exitCode: e.exitCode };
}

export function killShell(id: string): { ok: boolean; error?: string } {
  const e = shells.get(id);
  if (!e) return { ok: false, error: `No background shell '${id}'` };
  if (e.status === "running") {
    e.child.kill("SIGKILL");
    e.status = "killed";
    notify();
  }
  return { ok: true };
}

export function listShells(): BgShell[] {
  return [...shells.values()].map(
    ({ id, command, status, exitCode, startedAt }) => ({
      id,
      command,
      status,
      exitCode,
      startedAt,
    })
  );
}

/** Kill every still-running shell (called on exit). */
export function killAll(): void {
  for (const e of shells.values()) {
    if (e.status === "running") e.child.kill("SIGKILL");
  }
}
