import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { glob } from "glob";
import { z } from "zod";
import { createTool } from "@mastra/core/tools";
import { runtime } from "./runtime.js";
import * as ui from "./ui/render.js";

/**
 * Across Mastra versions, execute has received its validated input either
 * directly or wrapped under `.context`. Read it defensively so we don't care.
 */
function readInput<A>(raw: any): A {
  return (raw && typeof raw === "object" && "context" in raw ? raw.context : raw) as A;
}

function resolvePath(p: string): string {
  return path.resolve(runtime.cwd, p);
}

type Risk = "safe" | "dangerous";

interface Def<A> {
  id: string;
  description: string;
  risk?: Risk;
  schema: z.ZodType<A>;
  summarize: (a: A) => string;
  /** allowlist key for "always"; defaults to the tool id */
  permKey?: (a: A) => string;
  run: (a: A) => Promise<string>;
}

/**
 * Wrap shared concerns once: print a banner, gate dangerous calls through the
 * permission manager, run, preview the result, and never throw out of the loop.
 */
function defineTool<A>(def: Def<A>) {
  return createTool({
    id: def.id,
    description: def.description,
    inputSchema: def.schema as z.ZodType<A>,
    outputSchema: z.object({ result: z.string() }),
    execute: async (raw: any) => {
      const args = readInput<A>(raw);
      ui.renderToolCall(def.summarize(args));

      if (def.risk === "dangerous") {
        const key = def.permKey ? def.permKey(args) : def.id;
        if (!(await runtime.permissions.check(key, def.summarize(args)))) {
          ui.renderError("Denied by user.");
          return { result: "User denied permission to run this tool." };
        }
      }

      try {
        const result = await def.run(args);
        ui.renderToolResult(result, false);
        return { result };
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        ui.renderToolResult(msg, true);
        return { result: `Error: ${msg}` };
      }
    },
  });
}

const readTool = defineTool({
  id: "read",
  description: "Read a text file and return its contents with line numbers.",
  schema: z.object({
    path: z.string().describe("Path to the file, relative to cwd or absolute."),
    offset: z.number().int().optional().describe("1-based line to start from."),
    limit: z.number().int().optional().describe("Maximum number of lines."),
  }),
  summarize: (a) => `read(${a.path})`,
  async run(a) {
    const data = await fs.readFile(resolvePath(a.path), "utf8");
    const lines = data.split("\n");
    const start = a.offset && a.offset > 0 ? a.offset - 1 : 0;
    const end = a.limit ? start + a.limit : lines.length;
    const slice = lines.slice(start, end);
    if (slice.length === 0) return "(no lines in range)";
    const width = String(start + slice.length).length;
    return slice
      .map((l, i) => `${String(start + i + 1).padStart(width)}\t${l}`)
      .join("\n");
  },
});

const writeTool = defineTool({
  id: "write",
  description: "Write a file, creating it or overwriting it entirely.",
  risk: "dangerous",
  schema: z.object({
    path: z.string().describe("File path to write."),
    content: z.string().describe("Full contents to write."),
  }),
  summarize: (a) => `write(${a.path})`,
  async run(a) {
    const abs = resolvePath(a.path);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, a.content, "utf8");
    return `Wrote ${a.content.split("\n").length} line(s) to ${a.path}`;
  },
});

const editTool = defineTool({
  id: "edit",
  description:
    "Replace an exact string in a file. old_string must match exactly and appear once, unless replace_all is set.",
  risk: "dangerous",
  schema: z.object({
    path: z.string().describe("File to edit."),
    old_string: z.string().describe("Exact text to replace."),
    new_string: z.string().describe("Replacement text."),
    replace_all: z.boolean().optional().describe("Replace every occurrence."),
  }),
  summarize: (a) => `edit(${a.path})`,
  async run(a) {
    const abs = resolvePath(a.path);
    const data = await fs.readFile(abs, "utf8");
    const count = data.split(a.old_string).length - 1;
    if (count === 0) throw new Error("old_string not found in file");
    if (count > 1 && !a.replace_all)
      throw new Error(
        `old_string appears ${count} times; add context or set replace_all`
      );
    const updated = a.replace_all
      ? data.split(a.old_string).join(a.new_string)
      : data.replace(a.old_string, a.new_string);
    await fs.writeFile(abs, updated, "utf8");
    return `Edited ${a.path} (${a.replace_all ? count : 1} replacement(s))`;
  },
});

const MAX_OUTPUT = 30000;

const bashTool = defineTool({
  id: "bash",
  description: "Run a shell command in the working directory and return its output.",
  risk: "dangerous",
  schema: z.object({
    command: z.string().describe("Shell command to run."),
    timeout_ms: z.number().int().optional().describe("Timeout in ms (default 120000)."),
  }),
  summarize: (a) => `bash(${a.command})`,
  permKey: (a) => `bash:${a.command.trim().split(/\s+/)[0] ?? ""}`,
  run(a) {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(a.command, { cwd: runtime.cwd, shell: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), a.timeout_ms ?? 120000);
      child.stdout?.on("data", (d) => (out += d.toString()));
      child.stderr?.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        let body = out + (err ? (out ? "\n" : "") + err : "");
        body = body.trim() || "(no output)";
        if (body.length > MAX_OUTPUT) body = body.slice(0, MAX_OUTPUT) + "\n... (truncated)";
        resolve(`exit code: ${code}\n${body}`);
      });
    });
  },
});

const MAX_MATCHES = 200;

function hasRipgrep(): Promise<boolean> {
  return new Promise((res) => {
    const c = spawn("rg", ["--version"]);
    c.on("error", () => res(false));
    c.on("close", (code) => res(code === 0));
  });
}

const grepTool = defineTool({
  id: "grep",
  description: "Search file contents for a regex. Returns matches as path:line:text.",
  schema: z.object({
    pattern: z.string().describe("Regular expression to search for."),
    path: z.string().optional().describe("Directory or file to search (default cwd)."),
    glob: z.string().optional().describe("Only search files matching this glob."),
  }),
  summarize: (a) => `grep(${a.pattern})`,
  async run(a) {
    const searchPath = resolvePath(a.path ?? ".");
    if (await hasRipgrep()) {
      const rgArgs = ["--line-number", "--no-heading", "--color=never"];
      if (a.glob) rgArgs.push("--glob", a.glob);
      rgArgs.push("--", a.pattern, searchPath);
      return new Promise<string>((resolve, reject) => {
        const c = spawn("rg", rgArgs, { cwd: runtime.cwd });
        let out = "";
        c.stdout?.on("data", (d) => (out += d.toString()));
        c.on("error", reject);
        c.on("close", () => resolve(out.trim() || "(no matches)"));
      });
    }
    const re = new RegExp(a.pattern);
    const files = await glob(a.glob ?? "**/*", {
      cwd: searchPath,
      nodir: true,
      absolute: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    const results: string[] = [];
    for (const f of files) {
      let content: string;
      try {
        content = await fs.readFile(f, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          results.push(`${path.relative(runtime.cwd, f)}:${i + 1}:${lines[i]}`);
          if (results.length >= MAX_MATCHES) return results.join("\n") + "\n... (truncated)";
        }
      }
    }
    return results.join("\n") || "(no matches)";
  },
});

const globTool = defineTool({
  id: "glob",
  description: "Find files by glob pattern. Returns matching paths, one per line.",
  schema: z.object({
    pattern: z.string().describe("Glob pattern, e.g. src/**/*.ts"),
    path: z.string().optional().describe("Base directory (default cwd)."),
  }),
  summarize: (a) => `glob(${a.pattern})`,
  async run(a) {
    const matches = await glob(a.pattern, {
      cwd: resolvePath(a.path ?? "."),
      nodir: true,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    return matches.length ? matches.sort().join("\n") : "(no files matched)";
  },
});

const lsTool = defineTool({
  id: "ls",
  description: "List the contents of a directory.",
  schema: z.object({
    path: z.string().optional().describe("Directory to list (default cwd)."),
  }),
  summarize: (a) => `ls(${a.path ?? "."})`,
  async run(a) {
    const entries = await fs.readdir(resolvePath(a.path ?? "."), { withFileTypes: true });
    const formatted = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return formatted.length ? formatted.join("\n") : "(empty)";
  },
});

/** Keyed object passed to the Agent; keys become the tool names the model sees. */
export const tools = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  bash: bashTool,
  grep: grepTool,
  glob: globTool,
  ls: lsTool,
};
