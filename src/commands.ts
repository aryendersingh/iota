import { tools as builtinTools } from "./tools.js";
import { listShells } from "./shells.js";
import type { McpServerInfo } from "./mcp.js";
import type { SystemOutput } from "./ui/store.js";

/** State the slash commands can read. */
export interface CommandContext {
  mcpServers: McpServerInfo[];
}

export type CommandResult =
  | { action: "passthrough" }
  | { action: "quit" }
  | { action: "handled"; output: SystemOutput };

const HELP_BODY = [
  "/help    show this help",
  "/tools   list all available tools (built-in + MCP)",
  "/mcp     list connected MCP servers and their tools",
  "/jobs    list background shells",
  "/quit    quit iota (aliases: /exit, /q, exit, quit)",
].join("\n");

/** Handle a slash command. Non-slash input returns `passthrough`. */
export function runCommand(input: string, ctx: CommandContext): CommandResult {
  if (!input.startsWith("/")) return { action: "passthrough" };
  const [cmd] = input.slice(1).trim().split(/\s+/);
  switch (cmd) {
    case "help":
      return { action: "handled", output: { title: "commands", body: HELP_BODY } };
    case "tools":
      return { action: "handled", output: { title: "tools", body: toolsBody(ctx) } };
    case "mcp":
      return { action: "handled", output: { title: "mcp servers", body: mcpBody(ctx) } };
    case "jobs":
    case "shells":
      return { action: "handled", output: { title: "background shells", body: jobsBody() } };
    case "quit":
    case "exit":
    case "q":
      return { action: "quit" };
    default:
      return {
        action: "handled",
        output: { title: `unknown command: /${cmd}`, body: HELP_BODY, tone: "error" },
      };
  }
}

function toolsBody(ctx: CommandContext): string {
  const lines = [`built-in: ${Object.keys(builtinTools).join(", ")}`];
  const mcp = ctx.mcpServers.flatMap((s) => s.tools);
  if (mcp.length) lines.push(`mcp: ${mcp.join(", ")}`);
  return lines.join("\n");
}

function jobsBody(): string {
  const shells = listShells();
  if (shells.length === 0) {
    return "No background shells. Start one with bash(background=true).";
  }
  return shells
    .map((s) => {
      const status =
        s.status === "running" ? "running" : `${s.status} (exit ${s.exitCode})`;
      return `${s.id}  [${status}]  ${s.command}`;
    })
    .join("\n");
}

function mcpBody(ctx: CommandContext): string {
  if (ctx.mcpServers.length === 0) {
    return "No MCP servers configured. Add one with: iota mcp add …";
  }
  const lines: string[] = [];
  for (const s of ctx.mcpServers) {
    const tag = s.trusted ? " (trusted)" : "";
    if (s.error) {
      lines.push(`${s.name}${tag}  ✗ ${s.error}`);
      continue;
    }
    lines.push(`${s.name}${tag}  ${s.tools.length} tool(s)`);
    for (const t of s.tools) lines.push(`  - ${t}`);
  }
  return lines.join("\n");
}
