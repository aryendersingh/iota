import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Builds the agent's system prompt from a default base plus pi-style context
 * files, so projects can carry their own standing instructions:
 *
 *   - AGENTS.md / CLAUDE.md  — loaded from the global dir (~/.iota), then every
 *     ancestor directory down to the cwd, then the cwd. All matches are
 *     concatenated, most-specific last, and treated as authoritative.
 *   - .iota/SYSTEM.md        — replaces the default base prompt entirely
 *     (project dir takes precedence over global).
 *   - .iota/APPEND_SYSTEM.md — appended after everything (global then project).
 */

const GLOBAL_DIR = path.join(os.homedir(), ".iota");
const MEMORY_FILES = ["AGENTS.md", "CLAUDE.md"];

export interface LoadedContext {
  systemPrompt: string;
  /** Paths actually loaded, for display in the banner. */
  files: string[];
}

function defaultInstructions(cwd: string): string {
  return [
    "You are iota, a terminal-based coding assistant working inside a user's project.",
    `The working directory is: ${cwd}`,
    "",
    "You have these tools: read, write, edit, bash, grep, glob, ls.",
    "Prefer reading and searching before editing. Make focused changes with edit;",
    "use write only for new files or full rewrites. Use bash to run commands and tests.",
    "",
    "Be concise — the user is in a terminal. Say what you're about to do in a sentence,",
    "act with a tool, then briefly report the result. Stop and summarize when done.",
    "",
    "Use working memory to retain durable facts about the user and project (their name,",
    "preferences, the stack, conventions, current goals) so they persist across sessions.",
  ].join("\n");
}

function tryRead(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text || null;
  } catch {
    return null;
  }
}

function pretty(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Directories from filesystem root down to cwd (root first, cwd last). */
function ancestry(cwd: string): string[] {
  const dirs: string[] = [];
  let dir = path.resolve(cwd);
  while (true) {
    dirs.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs.reverse();
}

export function loadContext(cwd: string): LoadedContext {
  const files: string[] = [];

  // Base: a SYSTEM.md override (project, then global) or the built-in default.
  let base: string;
  const projectSystem = tryRead(path.join(cwd, ".iota", "SYSTEM.md"));
  const globalSystem = tryRead(path.join(GLOBAL_DIR, "SYSTEM.md"));
  if (projectSystem) {
    base = projectSystem;
    files.push(pretty(path.join(cwd, ".iota", "SYSTEM.md")));
  } else if (globalSystem) {
    base = globalSystem;
    files.push(pretty(path.join(GLOBAL_DIR, "SYSTEM.md")));
  } else {
    base = defaultInstructions(cwd);
  }

  const sections = [base];

  // Memory files: global first, then root→cwd so the nearest one wins (last).
  const memoryBlocks: string[] = [];
  for (const dir of [GLOBAL_DIR, ...ancestry(cwd)]) {
    for (const name of MEMORY_FILES) {
      const full = path.join(dir, name);
      const content = tryRead(full);
      if (content) {
        memoryBlocks.push(`<!-- ${pretty(full)} -->\n${content}`);
        files.push(pretty(full));
      }
    }
  }
  if (memoryBlocks.length) {
    sections.push(
      "The following project memory files were loaded (most specific last). Treat " +
        "them as authoritative project instructions and conventions:\n\n" +
        memoryBlocks.join("\n\n")
    );
  }

  // Appends: global first, then project (project has the last word).
  for (const full of [
    path.join(GLOBAL_DIR, "APPEND_SYSTEM.md"),
    path.join(cwd, ".iota", "APPEND_SYSTEM.md"),
  ]) {
    const content = tryRead(full);
    if (content) {
      sections.push(content);
      files.push(pretty(full));
    }
  }

  return { systemPrompt: sections.join("\n\n---\n\n"), files };
}
